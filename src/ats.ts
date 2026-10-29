import { parseSmartRecruiters, parseWorkday, type WorkdayId } from "./board-id.js";
import { configuredFetch } from "./network.js";
// ats.ts — free, keyless ATS-slug resolution (Tool 1, stage 4). Given a company's
// name + domain, find which public ATS board it runs and its slug. Every endpoint is
// a keyless GET keyed on a per-company slug; there is NO cross-company search, so we
// derive candidate slugs and probe. Endpoints per ats_endpoint_verification.md (see
// the dev handoff §5). An EMPTY-but-valid board counts as RESOLVED (the company uses
// that ATS; it just has no live postings right now) — only a 404/garbage board is a
// miss. This module never writes the DB and holds no key; tools.ts persists the result.
//
// VERIFICATION STATUS (checked against live boards):
//   • Greenhouse, Ashby, Lever — VERIFIED live (real boards: stripe/gitlab/figma,
//     ramp/linear, ro). Field paths below match real responses.
//   • Workable — VERIFIED live. The widget endpoint is correct and returns ALL postings in
//     one call (mcfarlane-aviation→8, walter-careers→74, workable's own→7); it beats the
//     paginated v3 jobs API. Field paths fixed against those boards (city/state/country +
//     telecommuting are top-level). CAVEAT: the widget returns 200 + { jobs:[] } for DORMANT/
//     parked accounts (`deel`, `bolt`, `scale`, … — registered but 0 active jobs), so an empty
//     Workable board is treated as a false positive — resolveAts won't resolve on it (see its
//     WORKABLE CAVEAT). Workable only counts when it actually returns postings.

export const SLUG_ATS_PLATFORMS = ["ashby", "greenhouse", "lever", "workable"] as const;
export const FETCHABLE_ATS_PLATFORMS = ["ashby", "greenhouse", "lever", "workable", "workday", "smartrecruiters"] as const;
export type AtsPlatform = (typeof FETCHABLE_ATS_PLATFORMS)[number];
type SlugPlatform = (typeof SLUG_ATS_PLATFORMS)[number];

export interface AtsResolution {
  platform: AtsPlatform;
  slug: string;
  job_count: number;
  via: "domain" | "name"; // which candidate hit — domain-derived is higher-confidence
}

export type FetchFn = typeof fetch;

// Resolution order: Ashby → Greenhouse → Lever → Workable (handoff §5 / tool1_build stage 4).
const ORDER: SlugPlatform[] = ["ashby", "greenhouse", "lever", "workable"];

// ── slug candidates ─────────────────────────────────────────────────────────
// Domain-derived slugs are primary (trusted); name-derived are the fallback and get
// corroborated by the caller's collision guard (db.ts resolveCompany is collision-safe).
const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "").trim();

export function slugCandidates(name: string, domain?: string | null): { slug: string; via: "domain" | "name" }[] {
  const out: { slug: string; via: "domain" | "name" }[] = [];
  const seen = new Set<string>();
  const add = (slug: string, via: "domain" | "name") => {
    if (slug && !seen.has(slug)) { seen.add(slug); out.push({ slug, via }); }
  };
  // domain → second-level label (acme.com → "acme"; jobs.acme.io → "acme")
  if (domain) {
    const host = domain.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
    const labels = host.split(".").filter(Boolean);
    if (labels.length >= 2) add(slugify(labels[labels.length - 2]), "domain");
    else if (labels.length === 1) add(slugify(labels[0]), "domain");
  }
  // name → compact slug, and a dash-joined variant some boards use
  const words = name.toLowerCase().replace(/\b(inc|llc|ltd|corp|co|the)\b/g, "").split(/[^a-z0-9]+/).filter(Boolean);
  add(slugify(words.join("")), "name");
  add(slugify(name), "name");
  return out;
}

// ── board endpoints + fetch/normalize ────────────────────────────────────────
// One keyless GET per (platform, slug). Shared by resolution (which only needs the
// count) and fetch_jobs (which needs the normalized postings) so the endpoint knowledge
// lives in one place.
const ENDPOINTS: Record<SlugPlatform, (slug: string) => string> = {
  ashby: (s) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(s)}?includeCompensation=true`,
  greenhouse: (s) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(s)}/jobs?content=true`,
  lever: (s) => `https://api.lever.co/v0/postings/${encodeURIComponent(s)}?mode=json`,
  workable: (s) => `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(s)}?details=true`,
};

// A normalized posting. `source_url` is the per-company dedup key (UNIQUE(company_id,
// source_url) in db.ts); a posting without one is dropped (can't dedup/track liveness).
export interface RawJob {
  source_url: string;
  title: string | null;
  location: string | null;
  remote: number | null;       // 1 | null
  comp_min: number | null;     // left null for now — comp shapes vary and aren't verified
  comp_max: number | null;     // live; raw_json carries the source data for later extraction
  raw: unknown;                // the full posting (→ raw_json)
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

// Ashby (with includeCompensation=true) exposes structured salary: compensation.
// compensationTiers[].components[] where compensationType==="Salary" carries numeric
// min/maxValue. A posting can have several tiers (e.g. "SF/NY" vs "Nationwide"); take the
// overall advertised range — min of mins, max of maxes — ignoring equity/null components.
function ashbySalary(comp: any): { min: number | null; max: number | null } {
  const sal = (Array.isArray(comp?.compensationTiers) ? comp.compensationTiers : [])
    .flatMap((t: any) => (Array.isArray(t?.components) ? t.components : []))
    .filter((c: any) => c?.compensationType === "Salary");
  const mins = sal.map((c: any) => c?.minValue).filter((v: any) => typeof v === "number");
  const maxs = sal.map((c: any) => c?.maxValue).filter((v: any) => typeof v === "number");
  return { min: mins.length ? Math.min(...mins) : null, max: maxs.length ? Math.max(...maxs) : null };
}

// Per-platform normalizers. Return null when the payload isn't a valid board of that
// platform (wrong shape) — that's a resolution miss. Return [] for a valid EMPTY board.
// Extraction is tolerant (defensive field reads) since the live shapes can't be pinned
// in the sandbox; whatever isn't mapped survives in raw_json.
const NORMALIZERS: Record<SlugPlatform, (j: any) => RawJob[] | null> = {
  greenhouse: (j) => Array.isArray(j?.jobs)
    ? j.jobs.map((p: any): RawJob => ({ source_url: str(p?.absolute_url) ?? "", title: str(p?.title), location: str(p?.location?.name), remote: /remote/i.test(p?.location?.name ?? "") ? 1 : null, comp_min: null, comp_max: null, raw: p })).filter((x: RawJob) => x.source_url)
    : null,
  lever: (j) => Array.isArray(j)
    ? j.map((p: any): RawJob => ({ source_url: str(p?.hostedUrl) ?? str(p?.applyUrl) ?? "", title: str(p?.text), location: str(p?.categories?.location), remote: (p?.workplaceType ?? "").toLowerCase() === "remote" ? 1 : null, comp_min: null, comp_max: null, raw: p })).filter((x: RawJob) => x.source_url)
    : null,
  ashby: (j) => Array.isArray(j?.jobs)
    ? j.jobs.map((p: any): RawJob => { const sal = ashbySalary(p?.compensation); return { source_url: str(p?.jobUrl) ?? str(p?.applyUrl) ?? "", title: str(p?.title), location: str(p?.location) ?? str(p?.locationName), remote: p?.isRemote ? 1 : null, comp_min: sal.min, comp_max: sal.max, raw: p }; }).filter((x: RawJob) => x.source_url)
    : null,
  // Workable widget job: city/state/country and telecommuting are TOP-LEVEL (verified
  // against live boards mcfarlane-aviation / walter-careers), not nested under `location`.
  workable: (j) => Array.isArray(j?.jobs)
    ? j.jobs.map((p: any): RawJob => ({ source_url: str(p?.url) ?? str(p?.shortlink) ?? str(p?.application_url) ?? "", title: str(p?.title), location: [p?.city, p?.state, p?.country].filter(Boolean).join(", ") || null, remote: p?.telecommuting ? 1 : null, comp_min: null, comp_max: null, raw: p })).filter((x: RawJob) => x.source_url)
    : null,
};

// Pure parser shared with the offline discovery adapter. No source reads occur here.
export function normalizeAtsBoard(platform: AtsPlatform, payload: unknown): RawJob[] | null {
  if (platform === "workday" || platform === "smartrecruiters") return null;
  return NORMALIZERS[platform](payload);
}

export class BoardUnreachable extends Error {
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "BoardUnreachable";
    this.status = status;
  }
}

export type DetailMode = "none" | "new" | "all";
export interface FetchBoardOptions {
  sleep?: (ms: number) => Promise<void>;
  pageDelayMs?: number;
  detailDelayMs?: number;
  /** List fields only unless this asks for detail pages. Default is none. */
  details?: DetailMode;
  /** Stop after this many postings and report truncation instead of closing the rest. */
  maxPostings?: number;
  /** source_urls already stored; used when details is "new". */
  knownUrls?: ReadonlySet<string>;
}
export interface BoardPage { jobs: RawJob[]; truncated: boolean; cap: number }

export function postingCap(explicit?: number, env: NodeJS.ProcessEnv = process.env): number {
  if (explicit !== undefined) {
    if (!Number.isFinite(explicit) || explicit < 1) throw new Error("maxPostings must be a positive number");
    return Math.floor(explicit);
  }
  const raw = env.JOBBOT_MAX_POSTINGS;
  if (raw === undefined || raw.trim() === "") return 500;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) throw new Error("JOBBOT_MAX_POSTINGS must be a positive number");
  return Math.floor(value);
}

const PAGE_LIMIT = 20;
const SR_PAGE_LIMIT = 100;
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function pacing(fetchFn: FetchFn, opts: FetchBoardOptions): { sleep: (ms: number) => Promise<void>; pageDelayMs: number; detailDelayMs: number } {
  const live = fetchFn === configuredFetch;
  return {
    sleep: opts.sleep ?? realSleep,
    pageDelayMs: opts.pageDelayMs ?? (live ? 200 : 0),
    detailDelayMs: opts.detailDelayMs ?? (live ? 100 : 0),
  };
}

function netCode(error: unknown): string {
  const cause = (error as { cause?: { code?: string }; code?: string })?.cause;
  const code = cause?.code ?? (error as { code?: string })?.code;
  return typeof code === "string" ? code : "";
}

function describeNet(error: unknown, host: string): string {
  const code = netCode(error);
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ENOTFOUND" || /ENOTFOUND|getaddrinfo/i.test(message))
    return `host ${host} could not be reached (check the tenant and wd number)`;
  return message;
}

function rethrowDisabled(error: unknown): void {
  if (error instanceof BoardUnreachable) throw error;
  if (error instanceof Error && /network disabled/i.test(error.message)) throw error;
}

async function readPayload(res: Response): Promise<{ json: any; text: string }> {
  const text = typeof res.text === "function" ? await res.text() : "";
  if (!text) return { json: null, text: "" };
  try { return { json: JSON.parse(text), text }; }
  catch { return { json: null, text }; }
}

function apiMessage(json: any, text: string): string {
  if (json && typeof json === "object") {
    const message = typeof json.message === "string" ? json.message.trim() : "";
    const code = typeof json.errorCode === "string" ? json.errorCode : (typeof json.code === "string" ? json.code : "");
    if (message) return message.slice(0, 300);
    if (code) return code;
  }
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed && !trimmed.startsWith("<")) return trimmed.slice(0, 300);
  return "";
}

function remoteFrom(location: string | null, hint: unknown): number | null {
  if (hint === true) return 1;
  if (typeof hint === "string" && /remote/i.test(hint)) return 1;
  if (location && /\bremote\b/i.test(location)) return 1;
  return null;
}

function clip(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 100_000) : null;
}

async function requestJson(fetchFn: FetchFn, url: string, init: RequestInit | undefined, host: string, label: string): Promise<{ status: number; json: any; text: string }> {
  let res: Response;
  try { res = await fetchFn(url, init); }
  catch (error) {
    rethrowDisabled(error);
    throw new BoardUnreachable(`${label}: ${describeNet(error, host)}`);
  }
  const payload = await readPayload(res);
  return { status: res.status, ...payload };
}

function workdayFailure(status: number, json: any, text: string, id: WorkdayId): string {
  const detail = apiMessage(json, text);
  if (status === 404)
    return `workday site '${id.site}' was not found on ${id.host}${detail ? ` (${detail})` : " (the site may have been renamed)"}`;
  if (status === 422)
    return `workday rejected ${id.key} (HTTP 422${detail ? `: ${detail}` : ""}). The wd number is often wrong, or this is not a public career site.`;
  if (status === 401 || status === 403)
    return `workday refused ${id.key} (HTTP ${status}${detail ? `: ${detail}` : ""}). This is not a public career site.`;
  if (status >= 500)
    return `workday jobs search failed (HTTP ${status}) on ${id.host}${detail ? `: ${detail}` : ""}.`;
  return `workday jobs search returned HTTP ${status}${detail ? `: ${detail}` : ""} for ${id.key}.`;
}

async function fetchWorkday(slug: string, fetchFn: FetchFn, opts: FetchBoardOptions): Promise<BoardPage> {
  const id = parseWorkday(slug);
  if (!id) throw new BoardUnreachable("workday board identifier must be tenant.wdN.site or a https://{tenant}.wd{N}.myworkdayjobs.com/{site} URL");
  const pace = pacing(fetchFn, opts);
  const cap = postingCap(opts.maxPostings);
  const jobsUrl = `https://${id.host}/wday/cxs/${encodeURIComponent(id.tenant)}/${encodeURIComponent(id.site)}/jobs`;
  const collected: { path: string; title: string | null; location: string | null; raw: Record<string, unknown> }[] = [];
  const seenPaths = new Set<string>();
  let truncated = false;
  let offset = 0;
  // The first page reports the real total. Later pages often report total 0 while
  // still returning postings, and the offset wraps back to the start past the end.
  let total: number | null = null;
  let page = 0;
  while (total === null || offset < total) {
    if (page > 0 && pace.pageDelayMs > 0) await pace.sleep(pace.pageDelayMs);
    page++;
    if (collected.length >= cap) { truncated = true; break; }
    const response = await requestJson(fetchFn, jobsUrl, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ appliedFacets: {}, limit: PAGE_LIMIT, offset, searchText: "" }),
    }, id.host, `workday ${id.key}`);
    if (response.status < 200 || response.status >= 300)
      throw new BoardUnreachable(workdayFailure(response.status, response.json, response.text, id), response.status);
    const postings = response.json?.jobPostings;
    const reported = response.json?.total;
    if (!Array.isArray(postings) || typeof reported !== "number")
      throw new BoardUnreachable(`workday ${id.key} returned an unexpected jobs payload (HTTP ${response.status})`);
    if (total === null && reported > 0) total = reported;
    if (postings.length === 0) break;
    const before = collected.length;
    for (const posting of postings) {
      const path = typeof posting?.externalPath === "string" ? posting.externalPath : "";
      if (!path.startsWith("/job/") || path.includes("..") || seenPaths.has(path)) continue;
      if (collected.length >= cap) { truncated = true; break; }
      seenPaths.add(path);
      const location = str(posting?.locationsText);
      collected.push({
        path,
        title: str(posting?.title),
        location,
        raw: {
          title: posting?.title ?? null,
          externalPath: path,
          locationsText: posting?.locationsText ?? null,
          postedOn: posting?.postedOn ?? null,
          bulletFields: posting?.bulletFields ?? null,
        },
      });
    }
    if (collected.length === before) break;
    if (truncated || collected.length >= cap) { truncated = collected.length >= cap || truncated; break; }
    offset += postings.length;
    if (total !== null && offset >= total) break;
    if (postings.length < PAGE_LIMIT) break;
  }
  const detailMode = opts.details ?? "none";
  const jobs: RawJob[] = [];
  for (let i = 0; i < collected.length; i++) {
    const item = collected[i];
    const source_url = `https://${id.host}/${id.site}${item.path}`;
    const wantDetail = detailMode === "all" || (detailMode === "new" && !opts.knownUrls?.has(source_url));
    if (!wantDetail) {
      jobs.push({
        source_url, title: item.title, location: item.location, remote: remoteFrom(item.location, null),
        comp_min: null, comp_max: null, raw: item.raw,
      });
      continue;
    }
    if (i > 0 && pace.detailDelayMs > 0) await pace.sleep(pace.detailDelayMs);
    const detailUrl = `https://${id.host}/wday/cxs/${encodeURIComponent(id.tenant)}/${encodeURIComponent(id.site)}${item.path}`;
    let info: any = null;
    let detailError: string | null = null;
    try {
      const detail = await requestJson(fetchFn, detailUrl, { method: "GET", headers: { accept: "application/json" } }, id.host, `workday ${id.key}`);
      if (detail.status >= 200 && detail.status < 300 && detail.json?.jobPostingInfo) info = detail.json.jobPostingInfo;
      else detailError = `detail HTTP ${detail.status}${apiMessage(detail.json, detail.text) ? `: ${apiMessage(detail.json, detail.text)}` : ""}`;
    } catch (error) {
      if (error instanceof Error && /network disabled/i.test(error.message)) throw error;
      detailError = error instanceof Error ? error.message : "detail fetch failed";
    }
    const location = str(info?.location) ?? item.location;
    const description = clip(info?.jobDescription);
    jobs.push({
      source_url,
      title: str(info?.title) ?? item.title,
      location,
      remote: remoteFrom(location, info?.remoteType),
      comp_min: null,
      comp_max: null,
      raw: { ...item.raw, ...(description ? { jobDescription: description } : {}), ...(info ? { jobReqId: info.jobReqId ?? null, timeType: info.timeType ?? null, externalUrl: info.externalUrl ?? null, remoteType: info.remoteType ?? null } : {}), ...(detailError ? { detail_error: detailError } : {}) },
    });
  }
  return { jobs, truncated, cap };
}

function srFailure(status: number, json: any, text: string, key: string): string {
  const detail = apiMessage(json, text);
  if (status === 404) return `smartrecruiters company '${key}' was not found (HTTP 404${detail ? `: ${detail}` : ""}).`;
  if (status >= 500) return `smartrecruiters company '${key}' failed (HTTP ${status}${detail ? `: ${detail}` : ""}).`;
  return `smartrecruiters company '${key}' returned HTTP ${status}${detail ? `: ${detail}` : ""}.`;
}

function srLocation(location: any): { text: string | null; remote: number | null } {
  if (!location || typeof location !== "object") return { text: null, remote: null };
  const joined = [location.city, location.region, location.country].filter((part) => typeof part === "string" && part.trim()).join(", ");
  const text = str(location.fullLocation) ?? (joined || null);
  return { text, remote: location.remote === true ? 1 : remoteFrom(text, null) };
}

async function fetchSmartRecruiters(slug: string, fetchFn: FetchFn, opts: FetchBoardOptions): Promise<BoardPage> {
  const id = parseSmartRecruiters(slug);
  if (!id) throw new BoardUnreachable("smartrecruiters board identifier must be the company identifier or a jobs.smartrecruiters.com URL");
  const pace = pacing(fetchFn, opts);
  const cap = postingCap(opts.maxPostings);
  const host = "api.smartrecruiters.com";
  const listed: { id: string; title: string | null; location: string | null; remote: number | null; raw: Record<string, unknown> }[] = [];
  const seen = new Set<string>();
  let truncated = false;
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  let page = 0;
  while (offset < total && listed.length < cap) {
    if (page > 0 && pace.pageDelayMs > 0) await pace.sleep(pace.pageDelayMs);
    page++;
    const url = `https://${host}/v1/companies/${encodeURIComponent(id.key)}/postings?limit=${SR_PAGE_LIMIT}&offset=${offset}`;
    const response = await requestJson(fetchFn, url, { method: "GET", headers: { accept: "application/json" } }, host, `smartrecruiters ${id.key}`);
    if (response.status < 200 || response.status >= 300)
      throw new BoardUnreachable(srFailure(response.status, response.json, response.text, id.key), response.status);
    const content = response.json?.content;
    const reported = response.json?.totalFound;
    if (!Array.isArray(content) || typeof reported !== "number")
      throw new BoardUnreachable(`smartrecruiters ${id.key} returned an unexpected postings payload (HTTP ${response.status})`, response.status);
    total = reported;
    if (content.length === 0) break;
    for (const posting of content) {
      const postingId = typeof posting?.id === "string" ? posting.id : "";
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(postingId) || seen.has(postingId)) continue;
      if (listed.length >= cap) { truncated = true; break; }
      seen.add(postingId);
      const place = srLocation(posting?.location);
      listed.push({
        id: postingId,
        title: str(posting?.name),
        location: place.text,
        remote: place.remote,
        raw: {
          id: postingId,
          name: posting?.name ?? null,
          refNumber: posting?.refNumber ?? null,
          releasedDate: posting?.releasedDate ?? null,
          location: posting?.location ?? null,
          department: posting?.department ?? null,
          typeOfEmployment: posting?.typeOfEmployment ?? null,
        },
      });
    }
    if (truncated) break;
    offset += content.length;
    if (content.length < SR_PAGE_LIMIT) break;
  }
  if (!truncated && Number.isFinite(total) && offset < total) truncated = true;
  const detailMode = opts.details ?? "none";
  const jobs: RawJob[] = [];
  for (let i = 0; i < listed.length; i++) {
    const item = listed[i];
    const source_url = `https://jobs.smartrecruiters.com/${id.key}/${item.id}`;
    const wantDetail = detailMode === "all" || (detailMode === "new" && !opts.knownUrls?.has(source_url));
    if (!wantDetail) {
      jobs.push({
        source_url, title: item.title, location: item.location, remote: item.remote,
        comp_min: null, comp_max: null, raw: item.raw,
      });
      continue;
    }
    if (jobs.length > 0 && pace.detailDelayMs > 0) await pace.sleep(pace.detailDelayMs);
    const detailUrl = `https://${host}/v1/companies/${encodeURIComponent(id.key)}/postings/${encodeURIComponent(item.id)}`;
    let detail: any = null;
    let detailError: string | null = null;
    try {
      const response = await requestJson(fetchFn, detailUrl, { method: "GET", headers: { accept: "application/json" } }, host, `smartrecruiters ${id.key}`);
      if (response.status >= 200 && response.status < 300 && response.json && typeof response.json === "object") detail = response.json;
      else detailError = `detail HTTP ${response.status}${apiMessage(response.json, response.text) ? `: ${apiMessage(response.json, response.text)}` : ""}`;
    } catch (error) {
      if (error instanceof Error && /network disabled/i.test(error.message)) throw error;
      detailError = error instanceof Error ? error.message : "detail fetch failed";
    }
    const sections = detail?.jobAd?.sections;
    const description = clip([sections?.jobDescription?.text, sections?.qualifications?.text, sections?.additionalInformation?.text]
      .filter((part) => typeof part === "string" && part.trim()).join("\n\n"));
    const place = detail ? srLocation(detail.location) : { text: item.location, remote: item.remote };
    jobs.push({
      source_url,
      title: str(detail?.name) ?? item.title,
      location: place.text ?? item.location,
      remote: place.remote ?? item.remote,
      comp_min: null,
      comp_max: null,
      raw: { ...item.raw, ...(description ? { jobDescription: description } : {}), ...(detail?.postingUrl ? { postingUrl: detail.postingUrl } : {}), ...(detailError ? { detail_error: detailError } : {}) },
    });
  }
  return { jobs, truncated, cap };
}

function fetchFailure(platform: string, slug: string, error: unknown, status: number | null = null): BoardUnreachable {
  if (error instanceof BoardUnreachable) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/network disabled/i.test(message)) return new BoardUnreachable(message);
  if (/timed out|timeout/i.test(message) || (error as { name?: string }).name === "TimeoutError")
    return new BoardUnreachable(`${platform} board '${slug}' timed out: ${message}`, status);
  return new BoardUnreachable(`${platform} board '${slug}' fetch failed: ${message}`, status);
}

async function fetchSlugBoard(platform: SlugPlatform, slug: string, fetchFn: FetchFn, opts: FetchBoardOptions): Promise<BoardPage> {
  const cap = postingCap(opts.maxPostings);
  let res: Response;
  try { res = await fetchFn(ENDPOINTS[platform](slug)); }
  catch (error) { throw fetchFailure(platform, slug, error); }
  if (!res.ok) throw new BoardUnreachable(`${platform} board '${slug}' returned HTTP ${res.status}`, res.status);
  let json: unknown;
  try { json = await res.json(); }
  catch { throw new BoardUnreachable(`${platform} board '${slug}' returned a non-JSON body (HTTP ${res.status})`, res.status); }
  const jobs = normalizeAtsBoard(platform, json);
  if (jobs === null) throw new BoardUnreachable(`${platform} board '${slug}' returned an unexpected payload (HTTP ${res.status})`, res.status);
  const truncated = jobs.length > cap;
  return { jobs: truncated ? jobs.slice(0, cap) : jobs, truncated, cap };
}

/**
 * Fetch one board and report truncation. Throws BoardUnreachable with the HTTP
 * status or timeout text. An empty jobs array is a live board with nothing open.
 */
export async function fetchBoardPage(platform: AtsPlatform, slug: string, fetchFn: FetchFn = configuredFetch, opts: FetchBoardOptions = {}): Promise<BoardPage> {
  if (platform === "workday") return fetchWorkday(slug, fetchFn, opts);
  if (platform === "smartrecruiters") return fetchSmartRecruiters(slug, fetchFn, opts);
  return fetchSlugBoard(platform, slug, fetchFn, opts);
}

/**
 * Fetch + normalize one ATS board. Returns the postings (possibly empty for a live but
 * vacant board), or null if the board is unreachable / not that platform (404, network
 * error, garbage payload). The null-vs-[] distinction matters for liveness: [] means
 * "valid board, nothing open" (close everything), null means "couldn't reach" (leave as-is).
 * Workday and SmartRecruiters still throw BoardUnreachable so callers can record the reason.
 */
export async function fetchBoard(platform: AtsPlatform, slug: string, fetchFn: FetchFn = configuredFetch, opts: FetchBoardOptions = {}): Promise<RawJob[] | null> {
  try {
    return (await fetchBoardPage(platform, slug, fetchFn, opts)).jobs;
  } catch (error) {
    if (error instanceof BoardUnreachable && (platform === "workday" || platform === "smartrecruiters")) throw error;
    return null;
  }
}

export interface ResolveOpts {
  fetchFn?: FetchFn;
  order?: SlugPlatform[]; // override probe order (tests / tuning)
}

/**
 * Resolve a company to its ATS board. Walks domain-derived slugs before name-derived ones,
 * each across the platform order. PREFERS A NON-EMPTY BOARD: returns the first board that
 * has live postings (a populated real board is the company's board), short-circuiting once
 * found. An empty-but-valid board is only a FALLBACK — kept if nothing populated turns up —
 * so a stale/empty board can't mask a populated one (e.g. Vercel's empty Ashby board vs its
 * 75-job Greenhouse board). Returns null if nothing resolves. Network errors on a probe are
 * swallowed (a dead slug 404s and is skipped, never fatal — handoff §5).
 *
 * WORKABLE CAVEAT: its widget endpoint returns 200+empty for slugs that aren't real accounts
 * (`deel`, `bolt`, `scale`, … all false-positive), so an EMPTY Workable board is NOT accepted
 * as a resolution (it would mask the real board on another ATS, or false-resolve a company
 * that's on no ATS). Workable only counts when it actually has postings.
 */
export async function resolveAts(
  company: { name: string; domain?: string | null },
  opts: ResolveOpts = {},
): Promise<AtsResolution | null> {
  const f = opts.fetchFn ?? configuredFetch;
  const order = opts.order ?? ORDER;
  const candidates = slugCandidates(company.name, company.domain);
  let fallbackEmpty: AtsResolution | null = null; // first non-Workable empty board, used only if nothing populated
  // domain candidates first across all platforms, then name candidates — domain is primary.
  for (const via of ["domain", "name"] as const) {
    for (const cand of candidates.filter((c) => c.via === via)) {
      for (const platform of order) {
        const board = await fetchBoard(platform, cand.slug, f); // null = miss, [] = empty-but-valid
        if (board === null) continue;
        if (board.length > 0) return { platform, slug: cand.slug, job_count: board.length, via }; // populated → done
        // empty board: a fallback only, and never from Workable (its empties are false positives)
        if (platform !== "workable" && fallbackEmpty === null)
          fallbackEmpty = { platform, slug: cand.slug, job_count: 0, via };
      }
    }
  }
  return fallbackEmpty;
}
