// Offline test for find_companies — the ATS resolver, the TheirStack provider, the
// curated (free, default) provider, the on-demand path, and the gather orchestration —
// all against a MOCKED fetch: no network, no API key, no spend. Run via `npm test`
// (tsx executes it against src/ directly; no build step needed).
//
// State is isolated to a temp STATE_DIR and a temp JOBBOT_SEEDS_FILE, both set BEFORE
// the modules load (db.ts opens its SQLite DB on import), so this never touches the real
// database or the tracked seeds/companies.json. Dynamic imports are used for that reason.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TMP = mkdtempSync(join(tmpdir(), "jbdisc-"));
process.env.JOBBOT_NETWORK = "off";
process.env.JOBBOT_PRIVATE_DIR = join(TMP, ".private");
process.env.STATE_DIR = join(TMP, ".private", "state");
const SEEDS = join(TMP, "seeds.json");
process.env.JOBBOT_SEEDS_FILE = SEEDS;
writeFileSync(SEEDS, "[]"); // start empty

const src = (f) => new URL(`../src/${f}`, import.meta.url).href;
const ats = await import(src("ats.ts"));
const prov = await import(src("providers.ts"));
const rawTools = await import(src("tools.ts"));
// Existing execution fixtures opt in explicitly; dry-run defaults have dedicated tests.
const tools = { ...rawTools };
for (const name of ["findCompanies", "fetchJobs", "ingestPortfolio"]) {
  tools[name] = (args, deps) => rawTools[name]({ dry_run: false, ...args }, deps);
}
const DB = await import(src("db.ts"));

let pass = 0, fail = 0;
const eq = (got, want, msg) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"} ${msg}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};
const jres = (r) => JSON.parse(r.content[0].text);

// ── mock fetch builders ──────────────────────────────────────────────────────
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const notFound = () => ({ ok: false, status: 404, json: async () => ({}) });
// ATS mock: greenhouse 'acme' valid (2 jobs); ashby 'emptyco' empty-but-valid; else 404.
const atsFetch = async (url) => {
  if (url.includes("boards-api.greenhouse.io/v1/boards/acme/")) return ok({ jobs: [{ absolute_url: "https://acme/1", title: "A" }, { absolute_url: "https://acme/2", title: "B" }] });
  if (url.includes("api.ashbyhq.com/posting-api/job-board/emptyco")) return ok({ jobs: [] });
  return notFound();
};
const atsResolve = (c) => ats.resolveAts(c, { fetchFn: atsFetch });

// ── A. ATS resolver + slug candidates ────────────────────────────────────────
eq(ats.slugCandidates("Acme Inc", "https://www.acme.com/careers").map((c) => `${c.slug}:${c.via}`),
   ["acme:domain", "acmeinc:name"], "slugCandidates: domain first; name fallback deduped");
eq(await atsResolve({ name: "Acme", domain: "acme.com" }),
   { platform: "greenhouse", slug: "acme", job_count: 2, via: "domain" }, "resolveAts: greenhouse hit via domain");
eq(await atsResolve({ name: "EmptyCo", domain: "emptyco.com" }),
   { platform: "ashby", slug: "emptyco", job_count: 0, via: "domain" }, "resolveAts: empty-but-valid = resolved");
eq(await atsResolve({ name: "Ghost", domain: "ghost.com" }), null, "resolveAts: miss -> null (not throw)");

// resolver preference: an empty/false-positive board must never mask a populated real one
const prefFetch = async (url) => {
  if (url.includes("ashbyhq.com/posting-api/job-board/vercel")) return ok({ jobs: [] });                       // empty (non-workable)
  if (url.includes("greenhouse.io/v1/boards/vercel/")) return ok({ jobs: [{ absolute_url: "https://v/1" }, { absolute_url: "https://v/2" }] }); // populated
  if (url.includes("apply.workable.com/api/v1/widget/accounts/onlyworkable")) return ok({ name: "x", jobs: [] }); // workable false-positive empty
  if (url.includes("apply.workable.com/api/v1/widget/accounts/realworkable")) return ok({ jobs: [{ url: "https://w/1" }] }); // real workable postings
  return notFound();
};
eq(await ats.resolveAts({ name: "Vercel", domain: "vercel.com" }, { fetchFn: prefFetch }),
   { platform: "greenhouse", slug: "vercel", job_count: 2, via: "domain" }, "resolveAts: populated board beats an earlier EMPTY board (no masking)");
eq(await ats.resolveAts({ name: "OnlyWorkable", domain: "onlyworkable.com" }, { fetchFn: prefFetch }),
   null, "resolveAts: empty Workable board is a false positive -> unresolved (not workable)");
eq(await ats.resolveAts({ name: "RealWorkable", domain: "realworkable.com" }, { fetchFn: prefFetch }),
   { platform: "workable", slug: "realworkable", job_count: 1, via: "domain" }, "resolveAts: Workable WITH postings still resolves");

// ── B. TheirStack provider direct (estimate free + discover paid) ─────────────
let lastBody = null;
const tsFetch = async (url, init) => {
  const body = JSON.parse(init.body); lastBody = body;
  if (body.limit === 0) return ok({ data: [], metadata: { total_results: 120 } }); // free count
  return ok({ data: [
    { company: "Acme", company_domain: "acme.com" },
    { company: "Acme", company_domain: "acme.com" },   // dup posting
    { company: "Beta", company_domain: "beta.io" },
    { company: "NoDomainCo" },                          // name only
  ] });
};
const tsCtx = { apiKey: "test-key", fetchFn: tsFetch };
const est = await prov.theirstackProvider.estimate({ titles: ["SWE"], limit: 25 }, tsCtx);
eq([est.total_matches, est.projected_records, est.projected_credits, est.free], [120, 25, 25, true], "ts.estimate: free count, spend bounded by limit");
eq(lastBody.property_exists_or, ["domain"], "ts.estimate: always requires domain");
eq(lastBody.limit, 0, "ts.estimate: zero-record (free) call");
const disc = await prov.theirstackProvider.discover({ titles: ["SWE"], limit: 25 }, tsCtx);
eq([disc.records_billed, disc.companies.map((c) => c.domain).sort().join("|")], [4, "acme.com|beta.io|"], "ts.discover: billed per record; deduped to unique companies");

// ── C. Curated provider (FREE, default) ──────────────────────────────────────
eq(Object.keys(prov.PROVIDERS)[0], "curated", "registry: default provider is 'curated' (free)");
eq((await prov.curatedProvider.discover({}, {})).companies.length, 0, "curated: empty roster -> no companies");
eq((await prov.curatedProvider.estimate({}, {})).projected_credits, 0, "curated: estimate is free (0 credits)");
writeFileSync(SEEDS, JSON.stringify([
  { name: "Acme", domain: "acme.com", ats_platform: "greenhouse", ats_slug: "acme", tags: ["industry:fintech"] },
  { name: "Delta", domain: "delta.io" },
]));
const seeded = await prov.curatedProvider.discover({}, {});
eq(seeded.companies.map((c) => `${c.name}:${c.ats_slug ?? "-"}`), ["Acme:acme", "Delta:-"], "curated: maps seeds (slug-complete + domain-only)");
writeFileSync(SEEDS, "[]"); // back to empty for the orchestration tests

// ── D. On-demand path (free, zero-config) ─────────────────────────────────────
const od = jres(await tools.findCompanies({ companies: [{ name: "Acme", domain: "acme.com" }, { name: "Ghost", domain: "ghost.com" }] }, { resolve: atsResolve }));
eq([od.ok, od.mode, od.credits_spent], [true, "on_demand", 0], "on-demand: free, no provider/key");
eq(od.persisted, { inserted: 2, resolved: 1, unresolved: 1, skipped: 0 }, "on-demand: acme resolved, ghost unresolved");
eq([DB.counts().companies, DB.counts().unresolved], [2, 1], "on-demand: persisted 2 (1 unresolved)");

// ── E. Default-is-free: no provider, empty roster -> free no-op with guidance ──
const def = jres(await tools.findCompanies({ titles: ["SWE"] }, { resolve: atsResolve }));
eq([def.ok, def.provider, def.credits_spent, def.discovered], [true, "curated", 0, 0], "default: free curated, no spend");
eq(typeof def.note === "string" && def.note.includes("live discovery remains disabled"), true, "default: empty roster -> local seed guidance and network-disabled notice");
eq(DB.counts().companies, 2, "default: empty roster persisted nothing");

// ── F. TheirStack is now opt-in (not default) ─────────────────────────────────
eq(jres(await tools.findCompanies({ provider: "theirstack", titles: ["SWE"] }, { ctx: { apiKey: undefined, fetchFn: tsFetch }, resolve: atsResolve })).ok, false, "theirstack: explicit + no synthetic key -> ok:false (honest)");
const dry = jres(await tools.findCompanies({ provider: "theirstack", titles: ["SWE"], dry_run: true }, { ctx: tsCtx, resolve: atsResolve }));
eq([dry.dry_run, dry.estimate], [true, undefined], "theirstack: dry_run -> local preview without estimate request");

// ── G. Confirmation gate: projected > ceiling without confirm -> no spend ─────
const gated = jres(await tools.findCompanies({ provider: "theirstack", titles: ["SWE"], limit: 25, max_credits: 10 }, { ctx: tsCtx, resolve: atsResolve }));
eq([gated.ok, gated.confirmation_required], [false, true], "ceiling: over-budget pull blocked pending confirm");
eq(DB.counts().companies, 2, "ceiling: blocked run persisted nothing");

// ── H. Paid pull (opt-in) resolves + persists; idempotent on re-run ───────────
const run = jres(await tools.findCompanies({ provider: "theirstack", titles: ["SWE"], limit: 25, confirm: true }, { ctx: tsCtx, resolve: atsResolve }));
eq([run.ok, run.credits_spent], [true, 4], "paid pull: ok, reports real spend");
eq(run.persisted, { inserted: 1, resolved: 1, unresolved: 1, skipped: 1 }, "paid pull: beta inserted, acme re-resolved, no-domain skipped");
eq([DB.counts().companies, DB.counts().unresolved], [3, 2], "paid pull: now 3 companies (ghost+beta unresolved)");
const rerun = jres(await tools.findCompanies({ provider: "theirstack", titles: ["SWE"], limit: 25, confirm: true }, { ctx: tsCtx, resolve: atsResolve }));
eq(rerun.persisted.inserted, 0, "re-run: 0 net-new (idempotent persist, dedup-before-fetch)");
eq(DB.counts().companies, 3, "re-run: still 3 companies");

// ════════════════════ fetch_jobs ════════════════════
const live = (cid) => DB.db.prepare("SELECT count(*) c FROM jobs WHERE company_id=? AND still_live=1").get(cid).c;

// ── I. Board fetch + normalize (real fetchBoard, mocked HTTP) ──────────────────
const boardFetch = (frag, body) => async (url) => (url.includes(frag) ? ok(body) : notFound());
const gh = await ats.fetchBoard("greenhouse", "acmeco", boardFetch("boards/acmeco/", { jobs: [
  { absolute_url: "https://gh/1", title: "Eng", location: { name: "Remote - US" } },
  { absolute_url: "https://gh/2", title: "PM", location: { name: "NYC" } },
] }));
eq([gh.length, gh[0].source_url, gh[0].remote, gh[1].remote], [2, "https://gh/1", 1, null], "fetchBoard greenhouse: normalize + remote-from-location");
const lv = await ats.fetchBoard("lever", "x", boardFetch("api.lever.co/v0/postings/x", [
  { hostedUrl: "https://lv/1", text: "SRE", categories: { location: "Berlin" }, workplaceType: "remote" },
]));
eq([lv.length, lv[0].title, lv[0].remote], [1, "SRE", 1], "fetchBoard lever: array shape, remote flag");
// Workable widget shape (verified live): city/state/country + telecommuting are top-level
const wk = await ats.fetchBoard("workable", "wco", boardFetch("widget/accounts/wco", { name: "WCo", jobs: [
  { url: "https://apply.workable.com/j/AAA", title: "Analyst", city: "", state: "", country: "Mexico", telecommuting: true },
  { shortlink: "https://apply.workable.com/j/BBB", title: "Onsite Role", city: "Austin", state: "TX", country: "United States", telecommuting: false },
] }));
eq([wk[0].source_url, wk[0].location, wk[0].remote], ["https://apply.workable.com/j/AAA", "Mexico", 1], "fetchBoard workable: top-level country + telecommuting -> location/remote");
eq([wk[1].location, wk[1].remote], ["Austin, TX, United States", null], "fetchBoard workable: city/state/country joined; non-telecommuting -> remote null");
eq((await ats.fetchBoard("ashby", "empty", boardFetch("job-board/empty", { jobs: [] }))).length, 0, "fetchBoard: empty-but-valid board -> []");
eq(await ats.fetchBoard("greenhouse", "nope", boardFetch("never", {})), null, "fetchBoard: 404 -> null");
eq((await ats.fetchBoard("greenhouse", "d", boardFetch("boards/d/", { jobs: [{ title: "NoUrl" }, { absolute_url: "https://d/1", title: "Ok" }] }))).length, 1, "fetchBoard: postings without source_url dropped");

// Ashby structured-comp extraction (multi-tier: overall min-of-mins, max-of-maxes; equity/null ignored)
const acomp = await ats.fetchBoard("ashby", "compco", boardFetch("job-board/compco", { jobs: [
  { jobUrl: "https://a/1", title: "Eng", location: "NYC", isRemote: true, compensation: { compensationTiers: [
    { components: [{ compensationType: "Salary", minValue: 212000, maxValue: 291000 }, { compensationType: "EquityCashValue", minValue: null, maxValue: null }] },
    { components: [{ compensationType: "Salary", minValue: 191000, maxValue: 262000 }] },
  ] } },
  { jobUrl: "https://a/2", title: "PM", location: "SF" }, // no compensation
] }));
eq([acomp[0].comp_min, acomp[0].comp_max], [191000, 291000], "ashby: extracts overall salary range across tiers");
eq([acomp[1].comp_min, acomp[1].comp_max], [null, null], "ashby: no comp -> nulls");

// ── J. upsertJobs liveness (direct) ───────────────────────────────────────────
const cid = DB.upsertCompany({ name: "LiveCo", domain: "liveco.com", ats_platform: "greenhouse", ats_slug: "liveco" }).id;
const insertedJobs = DB.upsertJobs(cid, [{ source_url: "u1", title: "A" }, { source_url: "u2", title: "B" }]);
eq([insertedJobs.inserted, insertedJobs.updated, insertedJobs.closed, insertedJobs.seen, insertedJobs.new_postings.length], [2, 0, 0, 2, 2], "upsertJobs: initial insert");
const closedJobs = DB.upsertJobs(cid, [{ source_url: "u1", title: "A2" }]);
eq([closedJobs.inserted, closedJobs.updated, closedJobs.closed, closedJobs.seen, closedJobs.closed_postings.length], [0, 1, 1, 1, 1], "upsertJobs: update u1, close vanished u2 (liveness)");
eq(live(cid), 1, "upsertJobs: only u1 live after u2 closed");
eq([DB.upsertJobs(cid, [{ source_url: "u1" }, { source_url: "u2" }]).inserted, live(cid)], [0, 2], "upsertJobs: u2 reopens (update, not insert)");
eq(DB.upsertJobs(cid, []).closed, 2, "upsertJobs: empty feed closes all live");
eq(live(cid), 0, "upsertJobs: nothing live after empty feed");

// ── K. fetchJobs orchestration (injected boards) ──────────────────────────────
const boards = { "greenhouse:newco": [{ source_url: "n1", title: "Eng" }, { source_url: "n2", title: "PM" }], "ashby:deadco": null };
const fbf = async (platform, slug) => (`${platform}:${slug}` in boards ? boards[`${platform}:${slug}`] : null);
const noSleep = async () => {};
const fd = { fetchBoardFn: fbf, sleep: noSleep, politeDelayMs: 0 };

const f1 = jres(await tools.fetchJobs({ ats_platform: "greenhouse", ats_slug: "newco" }, fd));
eq([f1.ok, f1.boards_fetched, f1.jobs.inserted], [true, 1, 2], "fetchJobs: one board by slug -> 2 jobs inserted");
eq(!!DB.getCompanyByAts("greenhouse", "newco"), true, "fetchJobs: auto-created company for a new slug");
eq(typeof f1.next === "string" && f1.next.includes("worklist"), true, "fetchJobs: next points at grading");

DB.upsertCompany({ name: "DeadCo", ats_platform: "ashby", ats_slug: "deadco" });
const f2 = jres(await tools.fetchJobs({ ats_platform: "ashby", ats_slug: "deadco" }, fd));
eq([f2.boards_fetched, f2.unreachable, f2.jobs.inserted], [0, 1, 0], "fetchJobs: unreachable board skipped, nothing persisted");

const noslug = DB.upsertCompany({ name: "NoSlug", domain: "noslug.com" }).id;
eq(jres(await tools.fetchJobs({ company_id: noslug }, fd)).ok, false, "fetchJobs: unresolved company_id -> honest error");
eq(jres(await tools.fetchJobs({ company_id: 999999 }, fd)).ok, false, "fetchJobs: missing company_id -> honest error");

const fc = jres(await tools.fetchJobs({ company_id: DB.getCompanyByAts("greenhouse", "newco").id }, fd));
eq([fc.ok, fc.jobs.updated], [true, 2], "fetchJobs: by company_id refetches (idempotent update)");

const fb = jres(await tools.fetchJobs({}, fd));
eq([fb.ok, fb.boards_fetched >= 1], [true, true], "fetchJobs: batch-all refreshes resolved companies");

// ════════════════════ ingest_portfolio ════════════════════
const githubMod = await import(src("github.ts"));

// ── L. fetchUserRepos (real, mocked HTTP) ─────────────────────────────────────
const ghRepos = [
  { full_name: "u/alpha", name: "alpha", description: "a cli", language: "TypeScript", stargazers_count: 10, forks_count: 2, topics: ["cli"], fork: false, archived: false, pushed_at: "2026-01-01T00:00:00Z", html_url: "https://github.com/u/alpha", homepage: "https://alpha.dev" },
  { full_name: "u/forked", name: "forked", language: "Go", stargazers_count: 0, forks_count: 0, fork: true, pushed_at: "2025-01-01T00:00:00Z", html_url: "https://github.com/u/forked" },
];
const ghFetch = async (url) => (url.includes("/users/u/repos") ? ok(ghRepos) : notFound());
const facts = await githubMod.fetchUserRepos("u", { fetchFn: ghFetch });
eq([facts.length, facts[0].repo, facts[0].language, facts[0].stars, facts[0].is_fork], [2, "u/alpha", "TypeScript", 10, false], "fetchUserRepos: normalize facts");
eq([facts[1].is_fork, facts[0].topics.join(",")], [true, "cli"], "fetchUserRepos: fork flag + topics");
let threw = false; try { await githubMod.fetchUserRepos("nobody", { fetchFn: async () => notFound() }); } catch (e) { threw = /no public GitHub user/.test(e.message); }
eq(threw, true, "fetchUserRepos: 404 -> throws unknown-user");

// injectable mock returning RepoFacts directly (orchestration deps)
const mkFacts = (o) => ({ repo: "u/x", name: "x", description: null, language: "TS", stars: 0, forks: 0, topics: [], is_fork: false, is_archived: false, pushed_at: "2026-01-01", url: "u", homepage: null, ...o });
const fr = async () => [mkFacts({ repo: "u/alpha", language: "TypeScript", stars: 10 }), mkFacts({ repo: "u/forked", is_fork: true })];
const noEnrich = async () => ({ languages: [], readme_excerpt: null }); // offline: don't hit the real GitHub enrich endpoints

// ── M. no handle (profile has none) -> honest error ───────────────────────────
eq(jres(await tools.ingestPortfolio({}, { fetchReposFn: fr, enrichFn: noEnrich })).ok, false, "ingest: no handle -> ok:false");

// ── N. no_github opt-out -> honest error, then clear ──────────────────────────
DB.upsertProfile({ no_github: 1 });
eq(jres(await tools.ingestPortfolio({ github_handle: "u" }, { fetchReposFn: fr, enrichFn: noEnrich })).ok, false, "ingest: no_github opt-out -> ok:false");
DB.upsertProfile({ no_github: 0 });

// ── O. happy path: forks skipped, snapshot stored, handle persisted ───────────
const ing = jres(await tools.ingestPortfolio({ github_handle: "u" }, { fetchReposFn: fr, enrichFn: noEnrich }));
eq([ing.ok, ing.fetched, ing.kept, ing.forks_skipped, ing.portfolio_count], [true, 2, 1, 1, 1], "ingest: fork skipped, 1 kept");
eq(DB.getPortfolio()[0].repo, "u/alpha", "ingest: stored the non-fork repo");
eq(DB.getProfile()?.github_handle, "u", "ingest: persisted the handle to the profile");

// ── P. include_forks keeps forks ─────────────────────────────────────────────
const ing2 = jres(await tools.ingestPortfolio({ github_handle: "u", include_forks: true }, { fetchReposFn: fr, enrichFn: noEnrich }));
eq([ing2.kept, ing2.portfolio_count], [2, 2], "ingest: include_forks keeps the fork");

// ── Q. replace semantics: re-ingest is a fresh snapshot (dropped repo leaves) ──
const ing3 = jres(await tools.ingestPortfolio({ github_handle: "u" }, { fetchReposFn: async () => [mkFacts({ repo: "u/alpha" })], enrichFn: noEnrich }));
eq([ing3.portfolio_count, DB.getPortfolio().length], [1, 1], "ingest: snapshot replaces prior (fork dropped)");

// ── enrichment: languages + README excerpt (the deep-ingest fix) ──────────────
const enrFetch = async (url) => {
  if (url.endsWith("/repos/u/alpha/languages")) return ok({ TypeScript: 9000, Python: 3000, CSS: 500 });
  if (url.endsWith("/repos/u/alpha/readme")) return { ok: true, status: 200, text: async () => "# Alpha\n\nA 158-test inference engine." };
  if (url.endsWith("/repos/u/b64/readme")) return { ok: true, status: 200, text: async () => JSON.stringify({ content: Buffer.from("# B64 readme", "utf8").toString("base64"), encoding: "base64" }) };
  return notFound();
};
const enr = await githubMod.enrichRepo("u/alpha", { fetchFn: enrFetch });
eq(enr.languages, ["TypeScript", "Python", "CSS"], "enrichRepo: languages by bytes desc (full stack, not just primary)");
eq(enr.readme_excerpt.includes("158-test inference engine"), true, "enrichRepo: README excerpt captured");
eq((await githubMod.enrichRepo("u/b64", { fetchFn: enrFetch })).readme_excerpt, "# B64 readme", "enrichRepo: decodes base64 README envelope");
eq(await githubMod.enrichRepo("u/missing", { fetchFn: enrFetch }), { languages: [], readme_excerpt: null }, "enrichRepo: missing repo -> empty (no throw)");
// ingest attaches enrichment to the stored facts
const enrichingFn = async (repo) => ({ languages: ["TypeScript", "Python"], readme_excerpt: `readme of ${repo}` });
await tools.ingestPortfolio({ github_handle: "u" }, { fetchReposFn: async () => [mkFacts({ repo: "u/alpha" })], enrichFn: enrichingFn });
const af = JSON.parse(DB.getPortfolio().find((p) => p.repo === "u/alpha").facts_json);
eq([af.languages, af.readme_excerpt], [["TypeScript", "Python"], "readme of u/alpha"], "ingest: enrichment attached to stored facts");
await tools.ingestPortfolio({ github_handle: "u", enrich_max: 0 }, { fetchReposFn: async () => [mkFacts({ repo: "u/alpha" })], enrichFn: enrichingFn });
eq(JSON.parse(DB.getPortfolio()[0].facts_json).readme_excerpt ?? null, null, "ingest: enrich_max:0 -> metadata only (no enrichment)");

// ── compactDescription: clean gradeable text from raw_json (worklist/packet) ───
eq(tools.compactDescription(JSON.stringify({ content: "<p>Build <b>LLM</b> systems.</p>" })), "Build LLM systems.", "compactDescription: strips HTML (greenhouse content)");
eq(tools.compactDescription(JSON.stringify({ descriptionPlain: "Plain text role." })), "Plain text role.", "compactDescription: prefers plain text (ashby)");
eq([tools.compactDescription(null), tools.compactDescription("not json")], [null, null], "compactDescription: null/garbage -> null");
eq(tools.compactDescription(JSON.stringify({ description: "x".repeat(2000) })).length, 1000, "compactDescription: truncated to DESC_MAX");

// ════════════════════ look(jobs) filters (triage + location/remote) ════════════════════
// clause/param building (injection-safe — values go through params, not interpolation)
const jf = tools.jobFilters({ titles_any: ["Applied AI", "Data Engineer"], location: "US", remote: true });
eq(jf.args, ["%Applied AI%", "%Data Engineer%", "%US%"], "jobFilters: OR-title + location params (remote is paramless)");
eq(jf.where[0], "(j.title LIKE ? OR j.title LIKE ?)", "jobFilters: titles_any OR-matched");
eq(jf.where.includes("j.remote = 1"), true, "jobFilters: remote -> j.remote = 1");
eq(tools.jobFilters({}).where.length, 0, "jobFilters: no filters -> empty");

// end-to-end against real SQLite
const fcid = DB.upsertCompany({ name: "FilterCo", ats_platform: "greenhouse", ats_slug: "filterco" }).id;
DB.upsertJobs(fcid, [
  { source_url: "fj1", title: "Applied AI Engineer", location: "Remote, US", remote: 1 },
  { source_url: "fj2", title: "Sales Director", location: "New York, NY", remote: null },
  { source_url: "fj3", title: "Data Engineer", location: "London, UK", remote: null },
]);
const runFilter = (a) => {
  const f = tools.jobFilters(a);
  return DB.db.prepare(`SELECT j.title FROM jobs j JOIN companies c ON c.id=j.company_id WHERE j.company_id=${fcid}${f.where.length ? " AND " + f.where.join(" AND ") : ""} ORDER BY j.title`).all(...f.args).map((r) => r.title);
};
eq(runFilter({ titles_any: ["Applied AI", "Data Engineer"] }), ["Applied AI Engineer", "Data Engineer"], "jobFilters e2e: titles_any OR-matches (excludes Sales)");
eq(runFilter({ remote: true }), ["Applied AI Engineer"], "jobFilters e2e: remote keeps only remote-flagged");
eq(runFilter({ location: "US" }), ["Applied AI Engineer"], "jobFilters e2e: location substring");
eq(runFilter({ titles_any: ["Engineer"], location: "London" }), ["Data Engineer"], "jobFilters e2e: title + location combined");

// ════════════════════ on-demand PIN: explicit ats_platform/ats_slug ════════════════════
// A company carrying both ats_platform + ats_slug is taken slug-complete, skipping the
// resolver — for boards whose slug isn't derivable (e.g. Glean → greenhouse:gleanwork).
let pinResolveCalls = 0;
const countingResolve = async (c) => { pinResolveCalls++; return atsResolve(c); };
const pin = jres(await tools.findCompanies({ companies: [{ name: "Glean", ats_platform: "greenhouse", ats_slug: "gleanwork" }] }, { resolve: countingResolve }));
eq([pin.ok, pin.persisted.resolved], [true, 1], "pin: persisted as resolved");
eq(pinResolveCalls, 0, "pin: skips the resolver entirely");
eq(typeof pin.note === "string" && pin.note.includes("pinned"), true, "pin: notes the pinned board");
const gleanCo = DB.getCompanyByAts("greenhouse", "gleanwork");
eq([!!gleanCo, gleanCo?.ats_slug, gleanCo?.resolved], [true, "gleanwork", 1], "pin: stored slug-complete (resolved=1)");
// a lone ats_slug (no platform) is NOT a pin — it falls through to normal resolution
pinResolveCalls = 0;
await tools.findCompanies({ companies: [{ name: "PartialCo", domain: "partialco.com", ats_slug: "partialco" }] }, { resolve: countingResolve });
eq(pinResolveCalls, 1, "pin: lone ats_slug (no platform) falls through to resolution");

// ════════════════════ application tracking ════════════════════
const state = await import(src("state.ts"));
const appCo = DB.upsertCompany({ name: "AppCo", ats_platform: "greenhouse", ats_slug: "appco" }).id;
DB.upsertJobs(appCo, [{ source_url: "ja1", title: "Eng" }, { source_url: "ja2", title: "PM" }]);
const j1 = DB.db.prepare("SELECT id FROM jobs WHERE source_url='ja1'").get().id;
const j2 = DB.db.prepare("SELECT id FROM jobs WHERE source_url='ja2'").get().id;

DB.recordApplication(j1, { status: "applied", applied_at: "2026-06-20", notes: "referred by X" });
eq([DB.getApplication(j1).status, DB.getApplication(j1).applied_at, DB.getApplication(j1).notes], ["applied", "2026-06-20", "referred by X"], "recordApplication: stored");
// a status update preserves the fields not passed (applied_at, notes)
DB.recordApplication(j1, { status: "interviewing" });
eq([DB.getApplication(j1).status, DB.getApplication(j1).applied_at, DB.getApplication(j1).notes], ["interviewing", "2026-06-20", "referred by X"], "recordApplication: status update preserves applied_at/notes");
DB.recordApplication(j2, { status: "interested" });
eq([DB.applicationCounts().interviewing, DB.applicationCounts().interested, DB.applicationCounts().applied ?? 0], [1, 1, 0], "applicationCounts: funnel by status");
eq([DB.getApplications().length, DB.getApplications()[0].company], [2, "AppCo"], "getApplications: lists tracked apps, joined to company");
// journey state surfaces it
eq([state.readJourneyState().dimensions.has_applications, state.readJourneyState().pipeline.interviewing], [true, 1], "state: has_applications dimension + pipeline counts");

// ════════════════════ portfolio relevance (the join point) ════════════════════
DB.replacePortfolio([{ repo: "u/strong", facts: { repo: "u/strong" } }, { repo: "u/weak", facts: { repo: "u/weak" } }, { repo: "u/ungraded", facts: { repo: "u/ungraded" } }]);
DB.setPortfolioRelevance("u/strong", "strong", ["go", "distributed systems"], [], "core to the target role");
DB.setPortfolioRelevance("u/weak", "weak", [], ["off-target"], "tangential to the role");
eq([DB.getPortfolioRelevance("u/strong").relevance, DB.getPortfolioRelevance("u/strong").demonstrates], ["strong", ["go", "distributed systems"]], "setPortfolioRelevance: stored + parsed");
eq([DB.counts().portfolio, DB.counts().portfolio_graded], [3, 2], "counts: portfolio_graded tracks graded repos");
eq(state.readJourneyState().dimensions.portfolio_graded, true, "state: portfolio_graded dimension flips");
eq(tools.rankedPortfolio().map((p) => `${p.repo}:${p.relevance?.band ?? "-"}`), ["u/strong:strong", "u/weak:weak", "u/ungraded:-"], "rankedPortfolio: strong → weak → ungraded last");
// re-ingest prunes grades for dropped repos but KEEPS them for repos that persist
DB.replacePortfolio([{ repo: "u/strong", facts: { repo: "u/strong" } }, { repo: "u/new", facts: { repo: "u/new" } }]);
eq([!!DB.getPortfolioRelevance("u/strong"), !!DB.getPortfolioRelevance("u/weak")], [true, false], "re-ingest: keeps persisting repo's grade, prunes dropped repo's");
eq(DB.counts().portfolio_graded, 1, "re-ingest: only the persisting grade remains");

// ════════════════════ gap #6: manual projects (resume↔repo reconciliation) ════════════════════
await tools.ingestPortfolio({ github_handle: "u" }, { fetchReposFn: async () => [mkFacts({ repo: "u/alpha" })], enrichFn: noEnrich });
DB.setPortfolioRelevance("u/alpha", "moderate", [], [], "r");                 // grade the github repo
DB.addPortfolioProject("AcmeService", { repo: "AcmeService", name: "AcmeService", description: "multi-agent orchestration", languages: ["TypeScript", "Python"], source: "manual" });
DB.setPortfolioRelevance("AcmeService", "strong", ["multi-agent"], [], "flagship");  // grade the manual project
eq(DB.getPortfolio().map((p) => `${p.repo}:${p.source}`).sort(), ["AcmeService:manual", "u/alpha:github"], "add: manual project sits alongside github repos");
// re-ingest: github repos replaced (u/alpha gone), manual project + its grade SURVIVE
await tools.ingestPortfolio({ github_handle: "u" }, { fetchReposFn: async () => [mkFacts({ repo: "u/beta" })], enrichFn: noEnrich });
eq(DB.getPortfolio().map((p) => `${p.repo}:${p.source}`).sort(), ["AcmeService:manual", "u/beta:github"], "re-ingest: keeps the manual project, replaces github repos");
eq([!!DB.getPortfolioRelevance("AcmeService"), !!DB.getPortfolioRelevance("u/alpha")], [true, false], "re-ingest: keeps manual grade, prunes the dropped github repo's grade");
const rp = tools.rankedPortfolio();
eq([rp[0].repo, rp.find((p) => p.repo === "AcmeService").source], ["AcmeService", "manual"], "rankedPortfolio: manual project surfaces source + ranks by its strong grade");

// ════════════════════ market-demand overlay (gap #2) ════════════════════
// Unique skill names so the aggregation is deterministic despite graded jobs from earlier sections.
const mdCo = DB.upsertCompany({ name: "MDCo", ats_platform: "greenhouse", ats_slug: "mdco" }).id;
DB.upsertJobs(mdCo, [{ source_url: "md1" }, { source_url: "md2" }, { source_url: "md3" }]);
const [m1, m2, m3] = ["md1", "md2", "md3"].map((u) => DB.db.prepare("SELECT id FROM jobs WHERE source_url=?").get(u).id);
DB.setJobGrade(m1, "mid", "A", [{ skill: "Pymdx", kind: "required" }, { skill: "Sqlmdx", kind: "required" }]);
DB.setJobGrade(m2, "mid", "A", [{ skill: "pymdx", kind: "required" }]);                                  // lowercase -> merges with Pymdx
DB.setJobGrade(m3, "senior", "B", [{ skill: "Pymdx", kind: "preferred" }, { skill: "Gomdx", kind: "required" }]);
const dAll = DB.marketSkillDemand(null, 50);
const py = dAll.skills.find((x) => x.skill.toLowerCase() === "pymdx");
eq([py.total, py.required, py.preferred], [3, 2, 1], "marketSkillDemand: skill aggregated case-insensitively across required+preferred");
const dMid = DB.marketSkillDemand(["mid"], 50);
eq(dMid.skills.find((x) => x.skill.toLowerCase() === "pymdx").total, 2, "marketSkillDemand: band filter (mid) -> demand from 2 jobs");
eq(dMid.skills.find((x) => x.skill.toLowerCase() === "gomdx"), undefined, "marketSkillDemand: band filter excludes a senior-only skill");
const ov = tools.marketOverlay(state.readJourneyState());
eq([ov.computed, ov.top_skills.length > 0, typeof ov.basis === "string"], [true, true, true], "marketOverlay: computed (top_skills + basis) once jobs are graded");

// ════════════════════ v2: competency profile + derived band ════════════════════
DB.setCompetency("technical_depth", "senior", "high", [{ claim: "x", provenance: "corroborated" }], "r");
DB.setCompetency("system_design", "junior", "low", [], "r");
DB.setCompetency("communication", "mid", "medium", [], "r");
DB.setCompetency("ownership", "mid", "low", [], "r"); // mean rank (3+1+2+2)/4 = 2 -> mid
const band = DB.deriveBand();
eq(band.floor, "junior", "deriveBand: floor = lowest dimension");
eq(band.confidence, "low", "deriveBand: overall confidence = lowest (skeptical)");
eq(band.band, "mid", "deriveBand: band = floor of mean rank");
eq(DB.assessmentSummary().band, "mid", "assessmentSummary: band derived on read");
eq(state.readJourneyState().dimensions.profiled, true, "state: profiled dimension flips");
eq(state.readJourneyState().dimensions.verified, false, "state: unverified until an interview completes");

// a role_fit rehearsal for one posting does NOT verify the whole competency profile
const rfIv = DB.startInterview("role_fit", null);
DB.completeInterview(rfIv, null, "rehearsal only");
eq(DB.assessmentSummary().verified, false, "verified: a completed role_fit interview does NOT verify the profile");

// ════════════════════ v2: interview verifies (resumable) ════════════════════
const ivId = DB.startInterview("competency", null);
DB.addInterviewItems(ivId, [{ question: "explain X", answer_summary: "weak", score: "weak", ownership: "observer", understanding: "cannot_explain", claim: "AcmeService" }]);
eq(DB.getOpenInterview().id, ivId, "interview: open session resumable");
eq(state.readJourneyState().open_interview.id, ivId, "state: surfaces open interview to resume");
DB.completeInterview(ivId, "junior", "did not hold up");
eq([DB.getInterview(ivId).status, DB.assessmentSummary().verified], ["complete", true], "interview: complete flips verified");
eq(state.readJourneyState().dimensions.verified, true, "state: verified after interview completes");

// ════════════════════ v2: upskilling plan (tracked, drives re-match) ════════════════════
const pid = DB.addPlanItem("system_design", "build", "ship a sharded KV store", "system design (high demand)");
eq([DB.getPlan().length, DB.getPlan()[0].status], [1, "suggested"], "plan: item added as suggested");
DB.updatePlanItem(pid, "in_progress", "started");
eq(state.readJourneyState().plan.in_progress, 1, "state: in_progress plan count");
DB.updatePlanItem(pid, "done", null);
eq(DB.planCounts().done, 1, "plan: marked done");

// ════════════════════ v2.1: loop signals (the edges that make the loop TURN) ════════════════════
// SQLite timestamps are second-resolution and everything above ran in the same second, so
// order the comparisons explicitly by nudging rows into the future.
DB.db.prepare("UPDATE upskilling_plan SET updated_at = datetime('now', '+1 hour') WHERE id=?").run(pid);
eq(DB.planDoneSinceAssess(), 1, "signal: plan item closed since the last assessment -> re-assess");
eq(state.readJourneyState().signals.plan_done_since_assess, 1, "state: surfaces plan_done_since_assess");
DB.db.prepare("UPDATE competency_profile SET updated_at = datetime('now', '+2 hours') WHERE dimension='system_design'").run();
eq(DB.planDoneSinceAssess(), 0, "signal: clears once a dimension is re-assessed");

const rejJob = DB.db.prepare("SELECT id FROM jobs WHERE source_url='ja2'").get().id;
DB.recordApplication(rejJob, { status: "rejected" });
DB.db.prepare("UPDATE applications SET updated_at = datetime('now', '+1 hour') WHERE job_id=?").run(rejJob);
eq(DB.rejectionsSincePlan(), 1, "signal: rejection since the plan last grew -> feed it back");
eq(state.readJourneyState().signals.rejections_since_plan, 1, "state: surfaces rejections_since_plan");
const pid2 = DB.addPlanItem("communication", "learn", "run a mock behavioural loop", null);
DB.db.prepare("UPDATE upskilling_plan SET created_at = datetime('now', '+2 hours') WHERE id=?").run(pid2);
eq(DB.rejectionsSincePlan(), 0, "signal: clears once the plan absorbs the rejection");

// updated_at means STATUS TRANSITION, not any touch — a notes-only edit or same-status
// re-record must not re-fire a settled signal. (Clocks set so a spurious bump WOULD fire.)
DB.db.prepare("UPDATE competency_profile SET updated_at = datetime('now', '-1 hour')").run();
DB.db.prepare("UPDATE upskilling_plan SET updated_at = datetime('now', '-2 hours') WHERE id=?").run(pid);
eq(DB.planDoneSinceAssess(), 0, "signal: item closed before the last assessment -> quiet");
DB.updatePlanItem(pid, null, "wrote a retro");
eq(DB.planDoneSinceAssess(), 0, "signal: notes-only plan edit is not a transition (no re-fire)");
DB.updatePlanItem(pid, "done", null);
eq(DB.planDoneSinceAssess(), 0, "signal: same-status re-set is not a transition (no re-fire)");
DB.db.prepare("UPDATE applications SET updated_at = datetime('now', '-2 hours') WHERE job_id=?").run(rejJob);
DB.db.prepare("UPDATE upskilling_plan SET created_at = datetime('now', '-1 hour') WHERE id=?").run(pid2);
eq(DB.rejectionsSincePlan(), 0, "signal: absorbed rejection -> quiet");
DB.recordApplication(rejJob, { status: "rejected", notes: "saved the feedback email" });
eq([DB.rejectionsSincePlan(), DB.getApplication(rejJob).notes], [0, "saved the feedback email"], "signal: same-status re-record updates fields but is not a transition (no re-fire)");

// ════════════════════ v2.1: the recommender is a LOOP (priority-ordered, no dead end) ════════════════════
const mkS = (o = {}) => ({
  dimensions: { onboarded: true, profiled: true, verified: true, portfolio_fetched: false, portfolio_graded: false, jobs_discovered: true, has_applications: false, ...(o.dimensions ?? {}) },
  assessed_level: "mid",
  assessment: { band: "mid", confidence: "medium", floor: "junior", verified: true },
  competency: [], open_interview: o.open_interview ?? null, has_resume: true,
  profile: { target_role: "swe", target_niche: null, location_pref: null, github_handle: null, desires: null, no_resume: false, no_github: false },
  catalog: { companies: 3, unresolved: 0, jobs: 10, ungraded_jobs: 2, live_in_band: 4, ...(o.catalog ?? {}) },
  plan: o.plan ?? {}, pipeline: o.pipeline ?? {},
  signals: { plan_done_since_assess: 0, rejections_since_plan: 0, ...(o.signals ?? {}) },
});
const skillOf = (s) => tools.recommendNext(s).split(" ")[0];
eq(skillOf(mkS({ dimensions: { onboarded: false } })), "coach", "recommend: not onboarded -> coach");
eq(skillOf(mkS({ open_interview: { id: 1, type: "competency", job_id: null } })), "verify", "recommend: open interview -> verify (resume the thread)");
eq(skillOf(mkS({ dimensions: { profiled: false } })), "coach", "recommend: not profiled -> coach");
eq(skillOf(mkS({ dimensions: { verified: false } })), "verify", "recommend: unverified -> verify");
eq(skillOf(mkS({ catalog: { companies: 0, jobs: 0, ungraded_jobs: 0, live_in_band: null } })), "job-search", "recommend: empty market -> job-search (populate)");
eq(skillOf(mkS({ signals: { plan_done_since_assess: 1 } })), "verify", "recommend: plan item closed -> re-assess + re-match (the loop turns)");
eq(skillOf(mkS({ plan: { suggested: 2 } })), "upskill", "recommend: FRESH (suggested) plan -> upskill, not a dead end");
eq(skillOf(mkS({ plan: { in_progress: 1 } })), "upskill", "recommend: in-progress plan -> upskill");
eq(skillOf(mkS({ signals: { rejections_since_plan: 2 } })), "upskill", "recommend: rejections feed back -> upskill");
eq(skillOf(mkS({ catalog: { ungraded_jobs: 10, live_in_band: 0 } })), "job-search", "recommend: all jobs ungraded -> job-search (grade the worklist)");
eq(skillOf(mkS()), "application", "recommend: verified + graded in-band roles -> application");
eq(skillOf(mkS({ catalog: { live_in_band: 0 } })), "job-search", "recommend: nothing live in band -> job-search (refresh + re-match), never a dead end");

// ════════════════════ v2: role fit (per-dimension + desire alignment) ════════════════════
const rfJob = DB.db.prepare("SELECT id FROM jobs LIMIT 1").get().id;
DB.setRoleFit(rfJob, "under", { system_design: "needs scale" }, "mixed", ["distributed systems"], "a level under; remote-only conflict");
eq([DB.getRoleFit(rfJob).band, DB.getRoleFit(rfJob).desire_alignment], ["under", "mixed"], "role_fit: stored band + desire alignment");

// ════════════════════ v2: resume revision journaled (history via events) ════════════════════
DB.setMasterResume("v1 resume");                            // initial: no rationale -> not journaled
DB.setMasterResume("v2 resume", "quantified real impact");  // coached: journaled
eq(DB.getEvents(50).some((e) => e.kind === "resume_revised" && e.summary === "quantified real impact"), true, "resume: coached revision journaled to events");

// ════════════════════ v2: durability journal ════════════════════
const evKinds = new Set(DB.getEvents(200).map((e) => e.kind));
for (const k of ["assessed", "interviewed", "planned", "plan_progress", "resume_revised", "role_fit"])
  eq(evKinds.has(k), true, `journal: '${k}' event recorded (persists across sessions)`);

// ── cleanup ───────────────────────────────────────────────────────────────────
try { DB.db.close(); } catch {}
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
