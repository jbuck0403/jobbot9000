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

export type AtsPlatform = "ashby" | "greenhouse" | "lever" | "workable";

export interface AtsResolution {
  platform: AtsPlatform;
  slug: string;
  job_count: number;
  via: "domain" | "name"; // which candidate hit — domain-derived is higher-confidence
}

export type FetchFn = typeof fetch;

// Resolution order: Ashby → Greenhouse → Lever → Workable (handoff §5 / tool1_build stage 4).
const ORDER: AtsPlatform[] = ["ashby", "greenhouse", "lever", "workable"];

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
const ENDPOINTS: Record<AtsPlatform, (slug: string) => string> = {
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
const NORMALIZERS: Record<AtsPlatform, (j: any) => RawJob[] | null> = {
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
  return NORMALIZERS[platform](payload);
}

/**
 * Fetch + normalize one ATS board. Returns the postings (possibly empty for a live but
 * vacant board), or null if the board is unreachable / not that platform (404, network
 * error, garbage payload). The null-vs-[] distinction matters for liveness: [] means
 * "valid board, nothing open" (close everything), null means "couldn't reach" (leave as-is).
 */
export async function fetchBoard(platform: AtsPlatform, slug: string, fetchFn: FetchFn = configuredFetch): Promise<RawJob[] | null> {
  let res: Response;
  try { res = await fetchFn(ENDPOINTS[platform](slug)); } catch { return null; }
  if (!res.ok) return null;
  let json: unknown;
  try { json = await res.json(); } catch { return null; }
  return normalizeAtsBoard(platform, json);
}

export interface ResolveOpts {
  fetchFn?: FetchFn;
  order?: AtsPlatform[]; // override probe order (tests / tuning)
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
