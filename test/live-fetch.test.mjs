// Live fetch is the default. HTTP is mocked here; a real Greenhouse call is not part of npm test.
import assert from "node:assert/strict";
import { describe, test, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "jobbot-live-"));
const privateDir = join(root, ".private");
const priorEnv = Object.fromEntries(["STATE_DIR", "JOBBOT_PRIVATE_DIR", "JOBBOT_NETWORK", "THEIRSTACK_API_KEY", "GITHUB_TOKEN"].map((key) => [key, process.env[key]]));
process.env.JOBBOT_PRIVATE_DIR = privateDir;
process.env.STATE_DIR = join(privateDir, "state");
delete process.env.JOBBOT_NETWORK;
delete process.env.THEIRSTACK_API_KEY;
delete process.env.GITHUB_TOKEN;

const calls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = String(url);
  calls.push({ url: href, init });
  if (/linkedin|lnkd\.in/i.test(href)) throw new Error("linkedin must not be requested");
  if (href.includes("boards-api.greenhouse.io/v1/boards/riotgames/")) {
    return {
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => ({ jobs: [{ absolute_url: "https://boards.greenhouse.io/riotgames/jobs/1", title: "Engineer", location: { name: "Los Angeles" } }] }),
    };
  }
  if (href.includes("boards-api.greenhouse.io/v1/boards/redirect/")) {
    return { ok: false, status: 302, headers: { get: (name) => name === "location" ? "https://www.linkedin.com/jobs" : null }, json: async () => ({}) };
  }
  throw new Error(`unexpected fetch ${href}`);
};

const ats = await import("../src/ats.ts");
const network = await import("../src/network.ts");
const tools = await import("../src/tools.ts");
const DB = await import("../src/db.ts");
const unpack = (result) => JSON.parse(result.content[0].text);

after(() => {
  DB.db.close();
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("live public fetch", { concurrency: false }, () => {
  test("default fetch reads a Greenhouse board and refuses LinkedIn", async () => {
    assert.equal(network.networkEnabled(), true);
    const jobs = await ats.fetchBoard("greenhouse", "riotgames");
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].title, "Engineer");
    assert.match(calls[0].url, /^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/riotgames\/jobs/);
    assert.equal(calls[0].init.redirect, "manual");
    const before = calls.length;
    await assert.rejects(network.liveFetch("https://www.linkedin.com/jobs/view/1"), /linkedin/i);
    await assert.rejects(network.liveFetch("https://lnkd.in/example"), /linkedin/i);
    await assert.rejects(network.liveFetch("http://boards-api.greenhouse.io/v1/boards/riotgames/jobs"), /https/i);
    assert.equal(calls.length, before);
    assert.equal(await ats.fetchBoard("greenhouse", "redirect"), null);
    assert.equal(calls.every((call) => !/linkedin/i.test(call.url)), true);
  });

  test("dry_run previews and JOBBOT_NETWORK=off does not call fetch", async () => {
    const before = calls.length;
    const preview = unpack(await tools.fetchJobs({ ats_platform: "greenhouse", ats_slug: "riotgames", dry_run: true }));
    assert.equal(preview.dry_run, true);
    assert.equal(calls.length, before);
    process.env.JOBBOT_NETWORK = "off";
    const blocked = unpack(await tools.fetchJobs({ ats_platform: "greenhouse", ats_slug: "riotgames" }));
    assert.equal(blocked.code, "network_disabled");
    assert.equal(calls.length, before);
    await assert.rejects(network.configuredFetch("https://boards-api.greenhouse.io/v1/boards/riotgames/jobs"), /network disabled/i);
    assert.equal(calls.length, before);
  });

  test("omitted dry_run fetches and records a check for a registered board", async () => {
    delete process.env.JOBBOT_NETWORK;
    const board = DB.registerBoard({ name: "Riot Games", board_type: "greenhouse", board_key: "riotgames", tags: ["game-studio"] });
    const before = calls.length;
    const fetched = unpack(await tools.fetchJobs({ ats_platform: "greenhouse", ats_slug: "riotgames" }));
    assert.equal(fetched.ok, true);
    assert.equal(fetched.jobs.inserted, 1);
    assert.equal(fetched.per_company[0].ledger.board_id, board.id);
    assert.equal(calls.length, before + 1);
    assert.match(calls.at(-1).url, /boards\/riotgames\/jobs/);
    const stats = DB.boardStats(board.id);
    assert.equal(stats.total_checks, 1);
    assert.equal(stats.open_postings_seen, 1);
    assert.equal(stats.last_check.new_positions[0].title, "Engineer");
    assert.equal(stats.last_check.method, "ats_api");
  });
});
