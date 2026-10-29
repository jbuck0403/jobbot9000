// Board identifiers for the public ATSes gather can read, plus a URL detector.
// Parsing only: no fetch and no database. Workday needs tenant + wd host number +
// site, so its key is `tenant.wdN.site` (the careers URL is accepted and parsed).
import { linkedInHost } from "./network.js";

const SLUG = /^[a-z0-9][a-z0-9_-]{0,80}$/;
const SR_ID = /^[a-z0-9][a-z0-9_-]{0,100}$/;
const WD_HOST = /^([a-z0-9](?:[a-z0-9-]{0,62}))\.wd(\d{1,3})\.myworkdayjobs\.com$/i;
const WD_KEY = /^([a-z0-9](?:[a-z0-9-]{0,62}))\.wd(\d{1,3})\.([a-z0-9](?:[a-z0-9_-]{0,80}))$/i;

export interface WorkdayId {
  tenant: string;
  wd: string;
  site: string;
  key: string;
  host: string;
  careersUrl: string;
}

export interface BoardDetection {
  board_type: "ashby" | "greenhouse" | "lever" | "workable" | "workday" | "smartrecruiters" | "custom";
  board_key: string | null;
  careers_url: string;
  note?: string;
}

function httpsUrl(input: string): URL {
  let parsed: URL;
  try { parsed = new URL(input.trim()); }
  catch { throw new Error("careers URL must be an https URL"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    throw new Error("careers URL must be an https URL without credentials");
  if (linkedInHost(parsed.hostname)) throw new Error("careers URL cannot be a LinkedIn host");
  parsed.hash = "";
  return parsed;
}

function slug(value: string | undefined): string | null {
  if (!value) return null;
  const key = value.trim().toLowerCase();
  return SLUG.test(key) ? key : null;
}
// Lever's postings path is case-sensitive (Convai is not convai). The other
// public boards accept any case, so those keys stay lowercase and re-imports
// do not fork a second row.
function preserveSlug(value: string | undefined): string | null {
  if (!value) return null;
  const key = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,120}$/.test(key) ? key : null;
}

function isLocale(segment: string): boolean {
  return /^[a-z]{2}-[a-z]{2}$/i.test(segment);
}

export function parseWorkday(input: string): WorkdayId | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw) || /myworkdayjobs\.com/i.test(raw)) {
    let url: URL;
    try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); }
    catch { return null; }
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (linkedInHost(url.hostname)) return null;
    const host = WD_HOST.exec(url.hostname);
    if (!host) return null;
    const tenant = host[1].toLowerCase();
    const wd = host[2];
    const parts = url.pathname.split("/").filter(Boolean);
    let siteSegment: string | undefined;
    if (parts[0]?.toLowerCase() === "wday" && parts[1]?.toLowerCase() === "cxs") {
      if (parts[2]?.toLowerCase() !== tenant) return null;
      siteSegment = parts[3];
    } else {
      let index = 0;
      if (parts[0] && isLocale(parts[0])) index = 1;
      siteSegment = parts[index];
    }
    if (!siteSegment || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(siteSegment)) return null;
    if (siteSegment.toLowerCase() === "wday" || siteSegment.toLowerCase() === "job") return null;
    const site = siteSegment.toLowerCase();
    const key = `${tenant}.wd${wd}.${site}`;
    if (key.length > 121) return null;
    return {
      tenant, wd, site, key,
      host: `${tenant}.wd${wd}.myworkdayjobs.com`,
      careersUrl: `https://${tenant}.wd${wd}.myworkdayjobs.com/${siteSegment}`,
    };
  }
  const match = WD_KEY.exec(raw);
  if (!match) return null;
  const tenant = match[1].toLowerCase();
  const wd = match[2];
  const site = match[3].toLowerCase();
  const key = `${tenant}.wd${wd}.${site}`;
  if (key.length > 121) return null;
  return {
    tenant, wd, site, key,
    host: `${tenant}.wd${wd}.myworkdayjobs.com`,
    careersUrl: `https://${tenant}.wd${wd}.myworkdayjobs.com/${site}`,
  };
}

export function parseSmartRecruiters(input: string): { key: string; careersUrl: string } | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw) || /smartrecruiters\.com/i.test(raw)) {
    let url: URL;
    try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); }
    catch { return null; }
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (linkedInHost(url.hostname)) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const parts = url.pathname.split("/").filter(Boolean);
    let id: string | undefined;
    if (host === "jobs.smartrecruiters.com" || host === "careers.smartrecruiters.com") id = parts[0];
    else if (host === "api.smartrecruiters.com" && parts[0] === "v1" && parts[1] === "companies") id = parts[2];
    else return null;
    const key = id?.toLowerCase() ?? "";
    if (!SR_ID.test(key)) return null;
    return { key, careersUrl: `https://jobs.smartrecruiters.com/${key}` };
  }
  const key = raw.toLowerCase();
  if (!SR_ID.test(key)) return null;
  return { key, careersUrl: `https://jobs.smartrecruiters.com/${key}` };
}

const WORKDAY_HINT = "workday board_key must be tenant.wdN.site (for example nature.wd108.externalcareers) or an https://{tenant}.wd{N}.myworkdayjobs.com/{site} URL";
const SR_HINT = "smartrecruiters board_key must be the company identifier or a jobs.smartrecruiters.com / api.smartrecruiters.com postings URL";

export function registrationIdentity(
  boardType: string,
  boardKey: string | null | undefined,
  careersUrl: string | null | undefined,
): { key: string; careers_url: string } | null {
  if (boardType !== "workday" && boardType !== "smartrecruiters") return null;
  if (boardKey === undefined && careersUrl === undefined) return null;
  const hint = boardType === "workday" ? WORKDAY_HINT : SR_HINT;
  const parse = boardType === "workday" ? parseWorkday : parseSmartRecruiters;
  const fromKey = boardKey ? parse(boardKey) : null;
  if (typeof boardKey === "string" && boardKey.trim() && !fromKey) throw new Error(hint);
  const fromUrl = careersUrl ? parse(careersUrl) : null;
  if (typeof careersUrl === "string" && careersUrl.trim() && !fromUrl)
    throw new Error(boardType === "workday"
      ? "workday careers_url must be an https myworkdayjobs.com career site"
      : "smartrecruiters careers_url must be a jobs.smartrecruiters.com or api.smartrecruiters.com postings URL");
  if (fromKey && fromUrl && fromKey.key !== fromUrl.key)
    throw new Error(`${boardType} board_key and careers_url identify different boards`);
  const id = fromKey ?? fromUrl;
  if (!id) throw new Error(hint);
  return { key: id.key, careers_url: id.careersUrl };
}

function greenhouseKey(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  if (host === "boards-api.greenhouse.io")
    return parts[0] === "v1" && parts[1] === "boards" ? slug(parts[2]) : null;
  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") {
    const pinned = slug(url.searchParams.get("for") ?? undefined);
    if (pinned) return pinned;
    if (!parts[0] || parts[0] === "embed") return null;
    return slug(parts[0]);
  }
  if (host.endsWith(".greenhouse.io")) {
    const labels = host.split(".");
    if (labels.length === 3 && !["www", "api", "boards", "job-boards", "boards-api"].includes(labels[0]))
      return slug(labels[0]);
  }
  return null;
}

function ashbyKey(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  if (host === "jobs.ashbyhq.com") return slug(parts[0]);
  if (host === "api.ashbyhq.com" && parts[0] === "posting-api" && parts[1] === "job-board") return slug(parts[2]);
  return null;
}

function leverKey(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  if (host === "jobs.lever.co") return preserveSlug(parts[0]);
  if (host === "api.lever.co" && parts[0] === "v0" && parts[1] === "postings") return preserveSlug(parts[2]);
  return null;
}

function workableKey(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  if (host !== "apply.workable.com") return null;
  if (parts[0] === "api" && parts[1] === "v1" && parts[2] === "widget" && parts[3] === "accounts") return slug(parts[4]);
  if (parts[0] && parts[0] !== "api" && parts[0] !== "j") return slug(parts[0]);
  return null;
}

export function detectBoard(input: string): BoardDetection {
  const url = httpsUrl(input);
  const workday = parseWorkday(url.href);
  if (workday) return { board_type: "workday", board_key: workday.key, careers_url: workday.careersUrl };
  const smartrecruiters = parseSmartRecruiters(url.href);
  if (smartrecruiters && /smartrecruiters\.com$/i.test(url.hostname.replace(/^www\./, "").split(".").slice(-2).join(".")))
    return { board_type: "smartrecruiters", board_key: smartrecruiters.key, careers_url: smartrecruiters.careersUrl };
  const greenhouse = greenhouseKey(url);
  if (greenhouse) return { board_type: "greenhouse", board_key: greenhouse, careers_url: `https://boards.greenhouse.io/${greenhouse}` };
  const ashby = ashbyKey(url);
  if (ashby) return { board_type: "ashby", board_key: ashby, careers_url: `https://jobs.ashbyhq.com/${ashby}` };
  const lever = leverKey(url);
  if (lever) return { board_type: "lever", board_key: lever, careers_url: `https://jobs.lever.co/${lever}` };
  const workable = workableKey(url);
  if (workable) return { board_type: "workable", board_key: workable, careers_url: `https://apply.workable.com/${workable}` };
  return {
    board_type: "custom",
    board_key: null,
    careers_url: url.toString(),
    note: "No Greenhouse, Ashby, Lever, Workable, Workday, or SmartRecruiters board was detected. Register as custom, or as browser if a person will check the page.",
  };
}
