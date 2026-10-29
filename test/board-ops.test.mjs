// Board check, import, tags, compact stats, timeouts. Hermetic: JOBBOT_NETWORK=off.
import assert from "node:assert/strict";
import { describe, test, after } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "jobbot-ops-"));
const privateDir = join(root, ".private");
const stateDir = join(privateDir, "state");
mkdirSync(stateDir, { recursive: true });
const priorEnv = Object.fromEntries(["STATE_DIR", "JOBBOT_PRIVATE_DIR", "JOBBOT_NETWORK", "JOBBOT_FETCH_TIMEOUT_MS", "JOBBOT_FETCH_RETRIES", "JOBBOT_FETCH_BACKOFF_MS", "JOBBOT_MAX_POSTINGS"].map((key) => [key, process.env[key]]));
process.env.JOBBOT_NETWORK = "off";
process.env.JOBBOT_PRIVATE_DIR = privateDir;
process.env.STATE_DIR = stateDir;

const originalFetch = globalThis.fetch;
let globalCalls = 0;
globalThis.fetch = async () => { globalCalls++; throw new Error("global fetch must not run"); };

const DB = await import("../src/db.ts");
const ats = await import("../src/ats.ts");
const network = await import("../src/network.ts");
const tools = await import("../src/tools.ts");
const { runBoardCli } = await import("../src/board-cli.ts");
const { checkBoards } = await import("../src/board-check.ts");
const { boardsEnv } = await import("../src/cli.ts");
const NOW = new Date("2026-10-29T11:00:00Z");
const unpack = (result) => JSON.parse(result.content[0].text);

function io() {
  const output = [];
  const errors = [];
  return { out: (text) => output.push(text), error: (text) => errors.push(text), output, errors };
}
const job = (url, title) => ({ source_url: url, title, location: null, remote: null, comp_min: null, comp_max: null, raw: { title } });

after(() => {
  DB.db.close();
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("board ledger operations", { concurrency: false }, () => {
  test("preserves Lever case and folds a re-import onto the same row", () => {
    const first = DB.registerBoard({ name: "Convai", board_type: "lever", board_key: "Convai", tags: ["game-studio"] });
    assert.equal(DB.boardStats(first.id).board_key, "Convai");
    const company = DB.upsertCompany({ name: "Convai", ats_platform: "lever", ats_slug: "convai", resolved: true });
    const saved = DB.upsertJobs(company.id, [{ source_url: "https://jobs.lever.co/Convai/role", title: "Animator" }]);
    DB.recordApplication(saved.new_postings[0].job_id, { status: "applied" });
    assert.equal(DB.boardStats(first.id).applications_submitted, 1);
    const again = DB.registerBoard({ name: "Convai", board_type: "lever", board_key: "convai", notes: "same board" });
    assert.equal(again.inserted, false);
    assert.equal(again.id, first.id);
    assert.equal(DB.boardStats(first.id).board_key, "convai");
    assert.equal(DB.boardStats(first.id).notes, "same board");
    const greenhouse = DB.registerBoard({ name: "Riot", board_type: "greenhouse", board_key: "RiotGames" });
    assert.equal(DB.boardStats(greenhouse.id).board_key, "riotgames");
    const ashby = DB.registerBoard({ name: "Linear", board_type: "ashby", board_key: "Linear" });
    assert.equal(DB.boardStats(ashby.id).board_key, "linear");
    assert.equal(globalCalls, 0);
  });

  test("a failed check keeps the last success clock and stores the real error", () => {
    const board = DB.registerBoard({ name: "Clock Studio", board_type: "greenhouse", board_key: "clockstudio", tags: ["game-studio"] });
    DB.appendBoardEvent({
      board_id: board.id, kind: "board_checked", summary: "ok",
      payload: { method: "manual", postings_found: 3 }, ts: "2026-10-28T11:00:00Z",
    });
    DB.recordBoardFetch({
      board_type: "greenhouse", board_key: "clockstudio", company_id: 0, unreachable: true,
      error: "greenhouse board 'clockstudio' returned HTTP 503", http_status: 503,
      seen: 0, updated: 0, new_postings: [], returned_postings: [], closed_postings: [],
    });
    const stats = DB.boardStats(board.id, NOW);
    assert.equal(stats.last_success_at, "2026-10-28T11:00:00Z");
    assert.equal(stats.last_checked_at, "2026-10-28T11:00:00Z");
    assert.notEqual(stats.last_attempt_at, stats.last_success_at);
    assert.equal(stats.hours_since_last_check, 24);
    assert.equal(stats.consecutive_failures, 1);
    assert.match(stats.last_error, /HTTP 503/);
    assert.equal(stats.last_check.http_status, 503);
    assert.equal(stats.total_checks, 2);
    assert.equal(stats.open_postings_seen, 3);
    assert.equal(DB.staleBoards(48, NOW).some((row) => row.id === board.id), false);
    const summary = DB.db.prepare("SELECT total_checks, consecutive_failures, last_error FROM board_summary WHERE board_id=?").get(board.id);
    assert.equal(summary.total_checks, 2);
    assert.equal(summary.consecutive_failures, 1);
    const names = DB.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((row) => row.name);
    assert.equal(names.includes("idx_board_events_kind"), true);
    assert.equal(names.includes("idx_board_summary_success"), true);
  });

  test("check stores postings, skips browser boards, and does not close jobs on a truncated page", async () => {
    const live = DB.registerBoard({ name: "Fetchable", board_type: "greenhouse", board_key: "fetchable", tags: ["game-studio"] });
    const browser = DB.registerBoard({ name: "By Hand", board_type: "browser", tags: ["game-studio"], careers_url: "https://careers.example.test/hand" });
    const company = DB.upsertCompany({ name: "Fetchable", ats_platform: "greenhouse", ats_slug: "fetchable", resolved: true });
    DB.upsertJobs(company.id, [job("https://example.invalid/a", "A"), job("https://example.invalid/b", "B"), job("https://example.invalid/c", "C")]);
    let seenOpts;
    const result = await checkBoards({ ids: [live.id, browser.id], details: "new", maxPostings: 1 }, {
      fetchPage: async (platform, slug, opts) => {
        seenOpts = { platform, slug, opts };
        return { jobs: [job("https://example.invalid/a", "A")], truncated: true, cap: 1 };
      },
    });
    assert.equal(result.checked, 1);
    assert.equal(result.skipped, 1);
    assert.equal(seenOpts.opts.details, "new");
    assert.equal(seenOpts.opts.knownUrls.has("https://example.invalid/b"), true);
    assert.equal(seenOpts.opts.maxPostings, 1);
    const still = DB.db.prepare("SELECT COUNT(*) c FROM jobs WHERE company_id=? AND still_live=1").get(company.id).c;
    assert.equal(still, 3);
    const stats = DB.boardStats(live.id);
    assert.equal(stats.last_check.truncated, true);
    assert.equal(stats.last_check.error, null);
    assert.equal(stats.consecutive_failures, 0);
    const missed = await checkBoards({ ids: [live.id] }, {
      fetchPage: async () => { throw new ats.BoardUnreachable("greenhouse board 'fetchable' timed out", null); },
    });
    assert.equal(missed.failed, 1);
    const afterFail = DB.boardStats(live.id, NOW);
    assert.equal(afterFail.last_success_at, stats.last_success_at);
    assert.equal(afterFail.consecutive_failures, 1);
    assert.match(afterFail.last_error, /timed out/);
    assert.equal(globalCalls, 0);
  });

  test("CLI check stays hermetic and the other commands cover tags, import, apply, and manual checks", async () => {
    const tagged = DB.registerBoard({ name: "Tagged", board_type: "ashby", board_key: "taggedco", tags: ["game-studio"] });
    const other = DB.registerBoard({ name: "Other", board_type: "lever", board_key: "OtherCo" });
    const checked = io();
    assert.equal(await runBoardCli(["check", "--tag", "game-studio", "--json"], checked), 0);
    const body = JSON.parse(checked.output[0]);
    assert.equal(body.results.some((row) => row.board_id === tagged.id && row.ok === false), true);
    assert.equal(body.results.some((row) => row.board_id === other.id), false);
    assert.match(body.results.find((row) => row.board_id === tagged.id).error, /Network disabled/);
    assert.equal(globalCalls, 0);

    const updated = io();
    assert.equal(await runBoardCli(["update", "--id", String(other.id), "--tags", "game-studio,remote", "--json"], updated), 0);
    assert.deepEqual(JSON.parse(updated.output[0]).stats.tags, ["game-studio", "remote"]);

    const file = join(root, "boards.json");
    writeFileSync(file, JSON.stringify([
      { name: "Imported", board_type: "greenhouse", board_key: "importedco", tags: ["game-studio"] },
      { name: "Tagged", board_type: "ashby", board_key: "taggedco", notes: "reimported" },
    ]));
    const imported = io();
    assert.equal(await runBoardCli(["import", file, "--json"], imported), 0);
    const importBody = JSON.parse(imported.output[0]);
    assert.equal(importBody.boards.find((row) => row.name === "Tagged").inserted, false);
    assert.equal(importBody.boards.find((row) => row.name === "Imported").inserted, true);
    assert.equal(DB.boardStats(tagged.id).notes, "reimported");
    const csv = join(root, "boards.csv");
    writeFileSync(csv, "name,board_type,board_key,tags\nImported,greenhouse,importedco,game-studio;remote\n");
    const csvOut = io();
    assert.equal(await runBoardCli(["import", csv, "--json"], csvOut), 0);
    assert.equal(JSON.parse(csvOut.output[0]).boards[0].inserted, false);
    assert.deepEqual(DB.listBoardStats().find((row) => row.board_key === "importedco").tags, ["game-studio", "remote"]);

    const listed = io();
    assert.equal(await runBoardCli(["list", "--tag", "remote", "--limit", "1", "--json"], listed), 0);
    const listBody = JSON.parse(listed.output[0]);
    assert.equal(listBody.boards.length, 1);
    assert.equal("open_positions" in listBody.boards[0], false);
    assert.equal(listBody.boards[0].board_key === "importedco" || listBody.boards[0].board_key === "OtherCo", true);
    const full = io();
    assert.equal(await runBoardCli(["list", "--tag", "remote", "--full", "--fields", "id,name", "--json"], full), 0);
    assert.deepEqual(Object.keys(JSON.parse(full.output[0]).boards[0]).sort(), ["id", "name"]);

    const stale = io();
    assert.equal(await runBoardCli(["stale", "--hours", "1", "--tag", "remote", "--json"], stale), 0);
    assert.equal(JSON.parse(stale.output[0]).boards.length >= 1, true);

    const applied = io();
    assert.equal(await runBoardCli(["apply", String(tagged.id), "--title", "Gameplay Engineer", "--note", "submitted on the site", "--json"], applied), 0);
    const statsOut = io();
    assert.equal(await runBoardCli(["stats", "--id", String(tagged.id)], statsOut), 0);
    assert.match(statsOut.output.join("\n"), /Gameplay Engineer \[applied\]/);
    assert.equal(statsOut.output.join("\n").includes("positions: none"), false);
    const byTag = io();
    assert.equal(await runBoardCli(["stats", "--tag", "game-studio", "--json"], byTag), 0);
    assert.equal(JSON.parse(byTag.output[0]).boards.some((row) => row.positions_applied_to?.some((position) => position.title === "Gameplay Engineer")), true);

    const manual = io();
    const hand = DB.registerBoard({ name: "Hand", board_type: "custom" });
    assert.equal(await runBoardCli(["record-manual-check", String(hand.id), "--postings", "7", "--note", "counted in the browser", "--json"], manual), 0);
    const handStats = DB.boardStats(hand.id);
    assert.equal(handStats.open_postings_seen, 7);
    assert.equal(handStats.consecutive_failures, 0);
    assert.equal(handStats.last_check.method, "manual");
    assert.notEqual(handStats.last_success_at, null);
    assert.equal(globalCalls, 0);
  });

  test("gather fetch_jobs returns a resume cursor and list fields stay bounded", async () => {
    for (let i = 0; i < 6; i++) DB.upsertCompany({ name: `Batch ${i}`, ats_platform: "greenhouse", ats_slug: `batch${i}`, resolved: true });
    const deps = { sleep: async () => {}, politeDelayMs: 0, fetchBoardFn: async () => [job("https://example.invalid/only", "Only")] };
    const first = unpack(await tools.fetchJobs({}, deps));
    assert.equal(first.boards_fetched, 5);
    assert.equal(typeof first.next_cursor, "number");
    const second = unpack(await tools.fetchJobs({ cursor: first.next_cursor }, deps));
    assert.equal(second.boards_fetched >= 1, true);
    const handlers = new Map();
    tools.registerTools({ registerTool: (name, _schema, handler) => handlers.set(name, handler) });
    const looked = unpack(await handlers.get("look")({ at: "boards", tag: "game-studio", limit: 1 }));
    assert.equal(looked.boards.length, 1);
    assert.equal("open_positions" in looked.boards[0], false);
    assert.equal(typeof looked.next_offset, "number");
    assert.equal(globalCalls, 0);
  });

  test("list fetches time out and retry GET failures without replaying a refusal", async () => {
    process.env.JOBBOT_FETCH_TIMEOUT_MS = "40";
    process.env.JOBBOT_FETCH_RETRIES = "0";
    process.env.JOBBOT_FETCH_BACKOFF_MS = "0";
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      const fail = () => {
        const error = new Error("The operation was aborted");
        error.name = "TimeoutError";
        reject(error);
      };
      if (init?.signal?.aborted) fail();
      else init?.signal?.addEventListener("abort", fail);
    });
    await assert.rejects(network.liveFetch("https://boards-api.greenhouse.io/v1/boards/riotgames/jobs"), /timed out after 40ms/);

    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return new Response("no", { status: 503 });
      return new Response("ok", { status: 200 });
    };
    process.env.JOBBOT_FETCH_RETRIES = "1";
    const ok = await network.liveFetch("https://example.com/board");
    assert.equal(ok.status, 200);
    assert.equal(calls, 2);
    calls = 0;
    const posted = await network.liveFetch("https://example.com/search", { method: "POST", body: "{}" });
    assert.equal(posted.status, 503);
    assert.equal(calls, 1);
    await assert.rejects(network.liveFetch("https://www.linkedin.com/jobs"), /linkedin/i);
    assert.equal(calls, 1);

    const page = await ats.fetchBoardPage("workday", "nature.wd108.externalcareers", async (url) => {
      assert.equal(url.includes("/job/"), false);
      return new Response(JSON.stringify({ total: 2, jobPostings: [
        { title: "One", externalPath: "/job/Place/One_JR1", locationsText: "Remote" },
        { title: "Two", externalPath: "/job/Place/Two_JR2", locationsText: "Austin" },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    }, { maxPostings: 1 });
    assert.equal(page.jobs.length, 1);
    assert.equal(page.truncated, true);
    assert.equal(page.jobs[0].raw.jobDescription, undefined);
    globalThis.fetch = async () => { globalCalls++; throw new Error("global fetch must not run"); };
    delete process.env.JOBBOT_FETCH_TIMEOUT_MS;
    delete process.env.JOBBOT_FETCH_RETRIES;
    delete process.env.JOBBOT_FETCH_BACKOFF_MS;
  });

  test("CLI and MCP share the state env and do not invent a second default", () => {
    const kept = boardsEnv(["list", "--json"], { STATE_DIR: stateDir, JOBBOT_PRIVATE_DIR: privateDir });
    assert.equal(kept.stateDir, undefined);
    assert.deepEqual(kept.args, ["list", "--json"]);
    const picked = boardsEnv(["check", "--state-dir", join(privateDir, "state"), "--tag", "game-studio"], {});
    assert.equal(picked.stateDir, stateDir);
    assert.deepEqual(picked.args, ["check", "--tag", "game-studio"]);
    const unset = boardsEnv(["list"], {});
    assert.equal(unset.stateDir, undefined);
  });
});
