import { configuredFetch } from "./network.js";
// providers.ts — the lead-gen seam behind gather('find_companies'). Discovery is
// multi-provider by design (dev handoff §5): a provider turns an applicant query into
// a list of { name, domain } companies; tools.ts then resolves slugs (ats.ts) and
// persists (db.ts). Providers are SENSES — they reach the outside world and return
// data; they never write the DB and never call the model. Stage 1–2 (resume → query)
// is the agent's job (it brings the model + key); a provider receives the built query.
//
// DEFAULT IS FREE. The reachable universe for the apply arm is "companies on the four
// ATSes", so a free provider reaches everyone reachable; a paid one only PRE-RANKS them
// by live relevance. So the registry defaults to the free curated-seed provider, and
// TheirStack is opt-in behind its key — selected only when the user asks for it.
//   • curated      — FREE, default. A local seed roster (career-ops portals.yml style);
//                    slug-complete entries skip resolution. Zero key, zero infra.
//   • theirstack   — TARGETED (paid, opt-in via THEIRSTACK_API_KEY). Returns name+domain;
//                    the slug is resolved for free downstream. Pre-ranks by who's hiring now.
//   • common_crawl — BREADTH (free; slug-complete, skips resolution). A follow-up drop-in
//                    behind this same interface, for when curated recall proves too thin.
// (The zero-config "name a company → resolve → fetch" on-demand path lives in tools.ts,
// not here — it takes explicit input rather than discovering.)

import { readFileSync } from "node:fs";
import type { FetchFn } from "./ats.js";

export interface DiscoverQuery {
  titles?: string[];           // → job_title_or
  technologies?: string[];     // TheirStack technology slugs → technology_slug_or
  seniority?: string | null;   // junior | mid_level | senior | staff | c_level → job_seniority
  locations?: string[];        // → job_location_pattern_or
  posted_within_days?: number; // → posted_at_max_age_days (a required-filter; defaulted if absent)
  limit?: number;              // spend bound — a run bills ≤ limit records
  seen_job_ids?: (string | number)[]; // re-run saver → job_id_not (bill only net-new postings)
}

export interface DiscoveredCompany {
  name: string;
  domain: string | null;
  tags: string[];
  source: string;
  // Slug-complete providers (e.g. Common Crawl) supply these so the orchestrator skips
  // ATS resolution. Targeted providers (TheirStack) leave them undefined → resolve downstream.
  ats_platform?: string | null;
  ats_slug?: string | null;
}

// Free pre-flight result. `projected_credits` is the WORST-CASE spend for a real pull
// at the given limit (records_returned × rate), the number the confirmation gate checks.
export interface CostEstimate {
  total_matches: number;
  projected_records: number;
  rate: number;
  projected_credits: number;
  free: true;
}

export interface ProviderContext {
  apiKey?: string;
  fetchFn?: FetchFn;
  baseUrl?: string;
}

export interface DiscoverResult { companies: DiscoveredCompany[]; records_billed: number }

export interface LeadProvider {
  name: string;
  requiresKey: boolean;
  available(ctx: ProviderContext): boolean;
  estimate(q: DiscoverQuery, ctx: ProviderContext): Promise<CostEstimate>;
  discover(q: DiscoverQuery, ctx: ProviderContext, opts?: { maxPages?: number }): Promise<DiscoverResult>;
}

const DEFAULT_LIMIT = 25;          // free-tier page size
const DEFAULT_MAX_AGE_DAYS = 30;   // jobs/search needs ≥1 recency/company filter
const THEIRSTACK_RATE = 1;         // 1 API credit per job returned (jobs/search)
const THEIRSTACK_BASE = "https://api.theirstack.com";

const normDomain = (d?: string | null): string | null =>
  d ? (d.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "") || null) : null;

// ── curated provider (FREE, default) ─────────────────────────────────────────
// A local seed roster, career-ops portals.yml style. Entries carrying ats_platform +
// ats_slug arrive slug-complete (skip resolution); name/domain-only entries resolve
// downstream. The roster is returned whole — relevance is filtered for free at fetch +
// grade time, not here (the "brute-fetch the roster, filter mechanically" model). Zero
// key, zero credits, zero infra; ships empty so we never fabricate unverified slugs.
interface SeedCompany { name: string; domain?: string | null; ats_platform?: string | null; ats_slug?: string | null; tags?: string[] }
function loadSeeds(): SeedCompany[] {
  // Optional file (unlike modes, which fail loud) — a missing/empty/corrupt roster just
  // means "no seeds configured", not a crash. Re-read each call so edits land without a
  // restart. JOBBOT_SEEDS_FILE points at a user-maintained roster outside the plugin dir
  // (so it survives plugin updates); otherwise the bundled seeds/companies.json is used.
  const src: URL | string = process.env.JOBBOT_SEEDS_FILE ?? new URL("../seeds/companies.json", import.meta.url);
  try {
    const arr = JSON.parse(readFileSync(src, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
export const curatedProvider: LeadProvider = {
  name: "curated",
  requiresKey: false,
  available: () => true,
  async estimate() {
    const n = loadSeeds().length;
    return { total_matches: n, projected_records: n, rate: 0, projected_credits: 0, free: true };
  },
  async discover() {
    const seeds = loadSeeds();
    return {
      companies: seeds.map((s) => ({
        name: s.name, domain: normDomain(s.domain), tags: s.tags ?? [], source: "curated",
        ats_platform: s.ats_platform ?? null, ats_slug: s.ats_slug ?? null,
      })),
      records_billed: 0,
    };
  },
};

// Map the agent-built query → a jobs/search request body. `property_exists_or:["domain"]`
// is ALWAYS set so we never pay for a record we can't resolve. The body is shared between
// the free count (limit:0) and the real pull, so the count reflects the real query exactly.
function jobsSearchBody(q: DiscoverQuery, limit: number): Record<string, unknown> {
  const body: Record<string, unknown> = {
    limit,
    page: 0,
    include_total_results: true,
    blur_company_data: limit === 0,                 // masked preview is free; only matters for the count call
    property_exists_or: ["domain"],
    posted_at_max_age_days: q.posted_within_days ?? DEFAULT_MAX_AGE_DAYS,
  };
  if (q.titles?.length) body.job_title_or = q.titles;
  if (q.technologies?.length) body.technology_slug_or = q.technologies;
  if (q.seniority) body.job_seniority = [q.seniority];
  if (q.locations?.length) body.job_location_pattern_or = q.locations;
  if (q.seen_job_ids?.length) body.job_id_not = q.seen_job_ids; // re-run saver
  return body;
}

async function theirstackPost(path: string, body: unknown, ctx: ProviderContext): Promise<any> {
  const f = ctx.fetchFn ?? configuredFetch;
  const res = await f(`${ctx.baseUrl ?? THEIRSTACK_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.apiKey ?? ""}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`TheirStack ${path} → HTTP ${res.status}`);
  return res.json();
}

// Total-match count lives in metadata across a couple of shapes; read defensively since
// we can't pin the exact field live in the sandbox.
const readTotal = (j: any): number =>
  j?.metadata?.total_results ?? j?.metadata?.total_count ?? j?.total_results ?? (Array.isArray(j?.data) ? j.data.length : 0);

// A posting carries the company name + domain under a few possible keys — extract tolerantly.
function postingToCompany(p: any): DiscoveredCompany | null {
  const name = p?.company ?? p?.company_name ?? p?.company_object?.name ?? null;
  const domain = normDomain(p?.company_domain ?? p?.company_object?.domain ?? p?.domain ?? null);
  if (!name && !domain) return null;
  return { name: name ?? domain!, domain, tags: [], source: "theirstack" };
}

export const theirstackProvider: LeadProvider = {
  name: "theirstack",
  requiresKey: true,
  available: (ctx) => !!ctx.apiKey,

  // FREE: limit:0 + include_total_results returns the match count with no billed records.
  async estimate(q, ctx) {
    const j = await theirstackPost("/v1/jobs/search", jobsSearchBody(q, 0), ctx);
    const total = readTotal(j);
    const projected_records = Math.min(total, q.limit ?? DEFAULT_LIMIT);
    return {
      total_matches: total,
      projected_records,
      rate: THEIRSTACK_RATE,
      projected_credits: projected_records * THEIRSTACK_RATE,
      free: true,
    };
  },

  // PAID: pull up to `limit` postings (≤ limit records billed), dedup to unique companies
  // by domain. records_billed is the real spend the caller reports back to the user.
  async discover(q, ctx, opts) {
    const limit = q.limit ?? DEFAULT_LIMIT;
    const maxPages = opts?.maxPages ?? 1;
    const byDomain = new Map<string, DiscoveredCompany>();
    const noDomain: DiscoveredCompany[] = [];
    let billed = 0;
    for (let page = 0; page < maxPages; page++) {
      const body = { ...jobsSearchBody(q, limit), page };
      const j = await theirstackPost("/v1/jobs/search", body, ctx);
      const data: any[] = Array.isArray(j?.data) ? j.data : [];
      billed += data.length; // billed per record returned
      for (const p of data) {
        const c = postingToCompany(p);
        if (!c) continue;
        if (c.domain) { if (!byDomain.has(c.domain)) byDomain.set(c.domain, c); }
        else noDomain.push(c);
      }
      if (data.length < limit) break; // last page
    }
    return { companies: [...byDomain.values(), ...noDomain], records_billed: billed };
  },
};

// Registry — insertion order IS the default provider order. curated (free) is first, so
// a no-arg find_companies stays free; theirstack is reached only when asked for by name.
export const PROVIDERS: Record<string, LeadProvider> = {
  curated: curatedProvider,
  theirstack: theirstackProvider,
  // common_crawl: commonCrawlProvider, // ← follow-up build (free breadth, slug-complete)
};
