// Foundation safety tests use synthetic fixtures and injected offline adapters only.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = mkdtempSync(join(tmpdir(), "jobbot-dry-run-"));
const privateRoot = join(fixture, ".private");
const stateDir = join(privateRoot, "state");
mkdirSync(stateDir, { recursive: true });
const priorEnv = Object.fromEntries(["STATE_DIR", "JOBBOT_PRIVATE_DIR", "JOBBOT_SEEDS_FILE", "JOBBOT_NETWORK"].map((key) => [key, process.env[key]]));
process.env.STATE_DIR = stateDir;
process.env.JOBBOT_PRIVATE_DIR = privateRoot;
process.env.JOBBOT_SEEDS_FILE = join(fixture, "synthetic-seeds.json");
process.env.JOBBOT_NETWORK = "off";
writeFileSync(process.env.JOBBOT_SEEDS_FILE, "[]");
const originalFetch = globalThis.fetch;
let globalCalls = 0;
globalThis.fetch = async () => { globalCalls++; throw new Error("global fetch must never be called"); };
const DB = await import("../src/db.ts");
const tools = await import("../src/tools.ts");
const ats = await import("../src/ats.ts");
const github = await import("../src/github.ts");
const providers = await import("../src/providers.ts");
const { disabledFetch } = await import("../src/network.ts");
const unpack = (result) => JSON.parse(result.content[0].text);
const snapshot = () => JSON.stringify(DB.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
  .map(({ name }) => [name, DB.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
after(() => {
  DB.db.close();
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(fixture, { recursive: true, force: true });
});

test("explicit dry_run previews every gather path without reading injected credentials or adapters", async () => {
  const cases = [
    [tools.findCompanies, { companies: [{ name: "Synthetic Co", domain: "example.invalid" }] }],
    [tools.findCompanies, { companies: [{ name: "Synthetic Co", ats_platform: "ashby", ats_slug: "synthetic" }] }],
    [tools.findCompanies, { provider: "curated" }],
    [tools.findCompanies, { provider: "theirstack" }],
    [tools.fetchJobs, { ats_platform: "greenhouse", ats_slug: "synthetic" }],
    [tools.ingestPortfolio, { github_handle: "synthetic-user" }],
  ];
  const unreadableDeps = new Proxy({}, { get() { throw new Error("preview accessed adapter/credentials"); } });
  const before = snapshot();
  for (const [fn, args] of cases) {
    const result = unpack(await fn({ ...args, dry_run: true }, unreadableDeps));
    assert.equal(result.ok, true);
    assert.equal(result.dry_run, true);
    assert.equal(result.estimate, undefined, "preview must not estimate with a remote adapter");
    assert.equal(snapshot(), before);
  }
  assert.equal(globalCalls, 0);
});

test("omitted dry_run executes, and network-off runs fail closed without a global fetch", async () => {
  const before = snapshot();
  const blocked = [
    [tools.findCompanies, { companies: [{ name: "Synthetic Co", domain: "example.invalid" }] }],
    [tools.findCompanies, { provider: "theirstack" }],
    [tools.fetchJobs, { ats_platform: "greenhouse", ats_slug: "synthetic-omitted" }],
    [tools.ingestPortfolio, { github_handle: "synthetic-user" }],
  ];
  for (const [fn, args] of blocked) {
    const result = unpack(await fn(args, {}));
    assert.equal(result.ok, false);
    assert.equal(result.code, "network_disabled");
    assert.equal(snapshot(), before);
  }
  const pinned = unpack(await tools.findCompanies({ companies: [{ name: "Synthetic Omitted", ats_platform: "ashby", ats_slug: "synthetic-omitted" }] }));
  assert.equal(pinned.ok, true);
  assert.equal(pinned.dry_run, undefined);
  assert.equal(globalCalls, 0);
});

test("explicit execution without complete offline adapters fails closed before mutations", async () => {
  let calls = 0;
  const fake = async () => { calls++; return []; };
  const before = snapshot();
  const cases = [
    [tools.findCompanies, { companies: [{ name: "Synthetic Co", domain: "example.invalid" }] }, {}],
    [tools.findCompanies, { provider: "theirstack" }, { ctx: { apiKey: "synthetic" }, resolve: fake }],
    [tools.findCompanies, { provider: "theirstack" }, { ctx: { apiKey: "synthetic", fetchFn: fake } }],
    [tools.fetchJobs, { ats_platform: "ashby", ats_slug: "synthetic" }, {}],
    [tools.ingestPortfolio, { github_handle: "synthetic-user" }, {}],
    [tools.ingestPortfolio, { github_handle: "synthetic-user" }, { fetchReposFn: fake }],
    [tools.ingestPortfolio, { github_handle: "synthetic-user", enrich_max: 0 }, { enrichFn: fake }],
  ];
  for (const [fn, args, deps] of cases) {
    const result = unpack(await fn({ ...args, dry_run: false }, deps));
    assert.equal(result.ok, false);
    assert.equal(result.code, "network_disabled");
    assert.match(result.error, /network disabled/i);
    assert.equal(snapshot(), before);
  }
  assert.equal(calls, 0);
  assert.equal(globalCalls, 0);
});

test("all default adapters disable global fetch, including direct provider estimates", async () => {
  await assert.rejects(disabledFetch("https://example.invalid"), /network disabled/i);
  assert.equal(await ats.fetchBoard("ashby", "synthetic"), null);
  assert.equal(await ats.resolveAts({ name: "Synthetic Co", domain: "example.invalid" }), null);
  await assert.rejects(github.fetchUserRepos("synthetic-user"), /network disabled/i);
  assert.deepEqual(await github.enrichRepo("synthetic-user/synthetic"), { languages: [], readme_excerpt: null, verify: undefined });
  await assert.rejects(providers.theirstackProvider.estimate({}, { apiKey: "synthetic" }), /network disabled/i);
  await assert.rejects(providers.theirstackProvider.discover({}, { apiKey: "synthetic" }), /network disabled/i);
  assert.equal(globalCalls, 0);
});

test("explicit manual resolution uses the injected adapter", async () => {
  let calls = 0;
  const result = unpack(await tools.findCompanies({ dry_run: false, companies: [{ name: "Synthetic Co", domain: "example.invalid" }] }, {
    resolve: async () => { calls++; return { platform: "ashby", slug: "synthetic", job_count: 1, via: "domain" }; },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.persisted.inserted, 1);
  assert.equal(calls, 1);
});

test("fully pinned manual and curated company fixtures may execute locally", async () => {
  const pin = { name: "Synthetic Pinned", ats_platform: "lever", ats_slug: "synthetic-pinned" };
  assert.equal(unpack(await tools.findCompanies({ dry_run: false, companies: [pin] })).ok, true);
  writeFileSync(process.env.JOBBOT_SEEDS_FILE, JSON.stringify([{ ...pin, ats_slug: "synthetic-seed" }]));
  assert.equal(unpack(await tools.findCompanies({ dry_run: false, provider: "curated" })).ok, true);
  writeFileSync(process.env.JOBBOT_SEEDS_FILE, JSON.stringify([{ name: "Synthetic Unresolved", domain: "other.invalid" }]));
  const before = snapshot();
  assert.equal(unpack(await tools.findCompanies({ dry_run: false, provider: "curated" })).code, "network_disabled");
  assert.equal(snapshot(), before);
  writeFileSync(process.env.JOBBOT_SEEDS_FILE, "[]");
});

test("explicit paid fixture execution estimates then discovers through injected fetch only", async () => {
  const limits = [];
  let resolutions = 0;
  const result = unpack(await tools.findCompanies({ dry_run: false, provider: "theirstack", limit: 1 }, {
    ctx: { apiKey: "synthetic-offline-key", fetchFn: async (_url, init) => {
      const body = JSON.parse(init.body);
      limits.push(body.limit);
      return { ok: true, json: async () => body.limit === 0 ? { total_results: 1 } : { data: [{ company: "Synthetic Paid Fixture", company_domain: "paid.invalid" }] } };
    } },
    resolve: async () => { resolutions++; return { platform: "greenhouse", slug: "synthetic-paid", job_count: 1, via: "domain" }; },
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(limits, [0, 1]);
  assert.equal(resolutions, 1);
  assert.equal(globalCalls, 0);
});

test("explicit board and portfolio execution retain injected fixture behavior", async () => {
  let boards = 0, repositories = 0, enrichment = 0;
  const fetched = unpack(await tools.fetchJobs({ dry_run: false, ats_platform: "ashby", ats_slug: "synthetic" }, {
    fetchBoardFn: async () => { boards++; return [{ source_url: "https://example.invalid/role", title: "Synthetic role", location: null, remote: null, comp_min: null, comp_max: null, raw: {} }]; },
  }));
  assert.equal(fetched.ok, true);
  assert.equal(fetched.jobs.inserted, 1);
  const ingested = unpack(await tools.ingestPortfolio({ dry_run: false, github_handle: "synthetic-user" }, {
    fetchReposFn: async () => { repositories++; return [{ repo: "synthetic-user/synthetic", name: "synthetic", description: null, language: "TypeScript", stars: 0, forks: 0, topics: [], is_fork: false, is_archived: false, pushed_at: null, url: "https://example.invalid/repo", homepage: null }]; },
    enrichFn: async () => { enrichment++; return { languages: ["TypeScript"], readme_excerpt: "Synthetic fixture" }; },
  }));
  assert.equal(ingested.ok, true);
  assert.deepEqual([boards, repositories, enrichment], [1, 1, 1]);
  assert.equal(globalCalls, 0);
});
