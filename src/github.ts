import { configuredFetch } from "./network.js";
// github.ts — the GitHub sense behind gather('ingest_portfolio'). Fetches a user's
// PUBLIC repos and returns structured facts; it never writes the DB and never calls the
// model. The deep judgment — which project to feature, architecture read, relevance to a
// role — is the agent's (the brain); this only supplies the raw facts to judge.
//
// Keyless by default (GitHub's unauthenticated REST API allows ~60 req/hr). The repo LIST
// is one call; ENRICHMENT (languages + README, so the grade isn't blind to the actual work)
// is ~2 calls/repo, so it's bounded by enrichMax and best run with GITHUB_TOKEN (raises the
// limit). Enrichment degrades gracefully — a rate-limit/error on a repo just leaves it at
// basic facts. Still no DB writes, no model calls: this only supplies raw facts to judge.

import type { FetchFn } from "./ats.js";

const README_MAX = 1500; // README excerpt length — enough to judge substance, not the whole file

// Verification signals — the SKEPTICAL half of the portfolio sense. A resume/README is a
// CLAIM; these are the cheap, keyless checks that separate a builder from a confident
// description. Populated by enrichRepo; absent (undefined) when unenriched or rate-limited
// (which the grader must read as "unverified", never as "fine"). See modes/level_assessment.
export interface RepoVerify {
  contributors: number;         // distinct contributors (capped at 100/page) — 1 = solo
  solo: boolean;                // <=1 contributor with real commits — a solo project
  authored_commits: number | null;     // the profile owner's own commits (null if handle unknown)
  total_commits: number;        // sum of contributions across contributors (approx, page-capped)
  authored_share: number | null;       // authored_commits / total_commits — how much is actually theirs
  self_applied_badges: number;  // hand-authored shields.io/badge/ vanity badges in the README (claims)
  dynamic_badges: number;       // real CI/coverage badges wired to a live source (corroboration)
}

export interface RepoFacts {
  repo: string;                 // full_name ("owner/name") — the portfolio PK
  name: string;
  description: string | null;
  language: string | null;      // GitHub's primary-language guess
  languages?: string[];         // full stack by bytes desc (enrichment) — undefined if not enriched
  readme_excerpt?: string | null; // first ~1500 chars of the README (enrichment)
  stars: number;
  forks: number;
  topics: string[];
  is_fork: boolean;
  is_archived: boolean;
  is_template?: boolean;        // a template/scaffold repo — weak ownership signal
  created_at?: string | null;   // repo creation — age/recency (a wall of brand-new repos reads junior)
  pushed_at: string | null;     // last push — recency/activity signal
  url: string;
  homepage: string | null;
  verify?: RepoVerify;          // verification signals (enrichment) — undefined = unverified, not clean
}

export interface GithubOpts {
  fetchFn?: FetchFn;
  token?: string;               // optional — raises the rate limit
  maxPages?: number;            // pagination cap (100 repos/page)
  baseUrl?: string;             // test override
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const ghHeaders = (opts: GithubOpts): Record<string, string> => ({
  Accept: "application/vnd.github+json", "User-Agent": "jobbot9000",
  ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
});

function toFacts(r: any): RepoFacts | null {
  const repo = str(r?.full_name);
  if (!repo) return null;
  return {
    repo,
    name: str(r?.name) ?? repo,
    description: str(r?.description),
    language: str(r?.language),
    stars: num(r?.stargazers_count),
    forks: num(r?.forks_count),
    topics: Array.isArray(r?.topics) ? r.topics.filter((t: unknown) => typeof t === "string") : [],
    is_fork: !!r?.fork,
    is_archived: !!r?.archived,
    is_template: !!r?.is_template,
    created_at: str(r?.created_at),
    pushed_at: str(r?.pushed_at),
    url: str(r?.html_url) ?? `https://github.com/${repo}`,
    homepage: str(r?.homepage),
  };
}

/**
 * Fetch a user's public repos, most-recently-pushed first, as structured facts. Paginates
 * up to maxPages (100/page). Throws on an HTTP error (404 unknown user, 403 rate-limit,
 * …) with a readable message so the caller can return an honest note. Forks/archived are
 * returned as-is (flagged) — filtering is the caller's call.
 */
export async function fetchUserRepos(handle: string, opts: GithubOpts = {}): Promise<RepoFacts[]> {
  const f = opts.fetchFn ?? configuredFetch;
  const base = opts.baseUrl ?? "https://api.github.com";
  const maxPages = opts.maxPages ?? 3;
  const headers = ghHeaders(opts);

  const out: RepoFacts[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `${base}/users/${encodeURIComponent(handle)}/repos?per_page=100&sort=pushed&type=owner&page=${page}`;
    const res = await f(url, { headers });
    if (!res.ok) {
      if (res.status === 404) throw new Error(`no public GitHub user '${handle}'`);
      if (res.status === 403) throw new Error("GitHub rate limit hit (set GITHUB_TOKEN to raise it)");
      throw new Error(`GitHub HTTP ${res.status}`);
    }
    const page_data = await res.json();
    if (!Array.isArray(page_data) || page_data.length === 0) break;
    for (const r of page_data) { const facts = toFacts(r); if (facts) out.push(facts); }
    if (page_data.length < 100) break; // last page
  }
  return out;
}

// Count README badges, split by trust. A hand-authored static badge (img.shields.io/badge/
// LABEL-MESSAGE) is a CLAIM the author typed (e.g. a static "speed-blazing" or "coverage-100%" badge),
// so it corroborates nothing. A DYNAMIC badge wired to a live source (a GitHub Actions
// workflow badge, or a shields endpoint that queries a real service) reflects something real.
function countBadges(readme: string): { self_applied: number; dynamic: number } {
  const dynamic =
    (readme.match(/github\.com\/[^)\s]+\/actions\/workflows\/[^)\s]+badge\.svg/gi)?.length ?? 0) +
    (readme.match(/img\.shields\.io\/(?:github|endpoint|codecov|coveralls)[^)\s]*/gi)?.length ?? 0);
  // static vanity badges: shields.io/badge/... that are NOT one of the dynamic forms above
  const allShields = readme.match(/img\.shields\.io\/[^)\s]+/gi) ?? [];
  const self_applied = allShields.filter((b) => /img\.shields\.io\/badge\//i.test(b)).length;
  return { self_applied, dynamic };
}

/**
 * Enrich one repo so the grade isn't blind to the actual work AND isn't fooled by it: the
 * full LANGUAGE breakdown, a README excerpt, and VERIFICATION signals (authorship via the
 * contributor graph, repo age, vanity-vs-real badges) that distinguish a built thing from a
 * described one. ~3 keyless calls; errors/rate-limits are swallowed per-call (returns
 * whatever it got — a missing `verify` reads downstream as "unverified"), so enrichment
 * never aborts ingest. Pass `handle` to compute the owner's authored share of the commits.
 */
export async function enrichRepo(
  repo: string,
  opts: GithubOpts & { handle?: string } = {},
): Promise<{ languages: string[]; readme_excerpt: string | null; verify?: RepoVerify }> {
  const f = opts.fetchFn ?? configuredFetch;
  const base = opts.baseUrl ?? "https://api.github.com";
  const headers = ghHeaders(opts);

  let languages: string[] = [];
  try {
    const r = await f(`${base}/repos/${repo}/languages`, { headers });
    if (r.ok) {
      const j = await r.json();
      languages = Object.entries(j as Record<string, number>).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    }
  } catch { /* leave empty */ }

  let readme_excerpt: string | null = null;
  let badges = { self_applied: 0, dynamic: 0 };
  try {
    const r = await f(`${base}/repos/${repo}/readme`, { headers: { ...headers, Accept: "application/vnd.github.raw+json" } });
    if (r.ok) {
      let text = await r.text();
      // Tolerate either raw markdown or the base64-JSON envelope (depends on proxy honoring the raw accept).
      if (text.startsWith("{")) { try { const j = JSON.parse(text); if (j?.content && j?.encoding === "base64") text = Buffer.from(j.content, "base64").toString("utf8"); } catch { /* keep raw */ } }
      badges = countBadges(text);
      readme_excerpt = text.slice(0, README_MAX).trim() || null;
    }
  } catch { /* leave null */ }

  // Authorship via the contributor graph — the single highest-signal check. ?anon=1 includes
  // anonymous (email-only) contributors so the count isn't undercounted. The page is capped at
  // 100; total_commits is therefore a floor, fine for "solo vs. team" and "is it even theirs".
  let verify: RepoVerify | undefined;
  try {
    const r = await f(`${base}/repos/${repo}/contributors?per_page=100&anon=1`, { headers });
    if (r.ok) {
      const arr = await r.json();
      if (Array.isArray(arr)) {
        const contribs = arr.map((c: any) => ({ login: str(c?.login), commits: num(c?.contributions) }));
        const total_commits = contribs.reduce((s, c) => s + c.commits, 0);
        const real = contribs.filter((c) => c.commits > 1);                 // ignore drive-by 1-commit noise
        const mine = opts.handle ? contribs.find((c) => c.login?.toLowerCase() === opts.handle!.toLowerCase()) : undefined;
        const authored_commits = opts.handle ? (mine?.commits ?? 0) : null;
        verify = {
          contributors: contribs.length,
          solo: real.length <= 1,
          authored_commits,
          total_commits,
          authored_share: authored_commits != null && total_commits > 0 ? Math.round((authored_commits / total_commits) * 100) / 100 : null,
          self_applied_badges: badges.self_applied,
          dynamic_badges: badges.dynamic,
        };
      }
    }
  } catch { /* leave verify undefined — reads as unverified downstream */ }

  return { languages, readme_excerpt, verify };
}
