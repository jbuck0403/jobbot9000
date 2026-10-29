// Ledger schema, append-only events, stats, and CLI. No live network.
import assert from "node:assert/strict";
import { describe, test, after } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "jobbot-ledger-"));
const privateDir = join(root, ".private");
const stateDir = join(privateDir, "state");
mkdirSync(stateDir, { recursive: true });
const priorEnv = Object.fromEntries(["STATE_DIR", "JOBBOT_PRIVATE_DIR", "JOBBOT_NETWORK"].map((key) => [key, process.env[key]]));
process.env.JOBBOT_NETWORK = "off";
process.env.JOBBOT_PRIVATE_DIR = privateDir;
process.env.STATE_DIR = stateDir;

const { default: Database } = await import("../src/sqlite.ts");
const preexisting = new Database(join(stateDir, "jobbot.db"));
preexisting.exec(`CREATE TABLE companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  domain TEXT,
  tags TEXT,
  source TEXT,
  ats_platform TEXT,
  ats_slug TEXT,
  resolved INTEGER NOT NULL DEFAULT 1,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_fetched_at TEXT
);
INSERT INTO companies (name, domain, ats_platform, ats_slug) VALUES ('Preexisting', 'pre.example', 'greenhouse', 'preexisting');`);
preexisting.close();

const originalFetch = globalThis.fetch;
let globalCalls = 0;
globalThis.fetch = async () => { globalCalls++; throw new Error("global fetch must not run"); };

const DB = await import("../src/db.ts");
const tools = await import("../src/tools.ts");
const { runBoardCli } = await import("../src/board-cli.ts");
const { main } = await import("../src/cli.ts");
const unpack = (result) => JSON.parse(result.content[0].text);
const NOW = new Date("2026-10-29T11:00:00Z");

function io() {
  const output = [];
  const errors = [];
  return { out: (text) => output.push(text), error: (text) => errors.push(text), output, errors };
}
async function capture(args) {
  const output = [];
  const errors = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { output.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { errors.push(String(chunk)); return true; };
  try { return { code: await main(args), output: output.join(""), errors: errors.join("") }; }
  finally { process.stdout.write = stdout; process.stderr.write = stderr; }
}

after(() => {
  DB.db.close();
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("board ledger", { concurrency: false }, () => {
  test("migrates an existing state db and stays empty", async () => {
    const preexisting = DB.getCompanyByAts("greenhouse", "preexisting");
    assert.equal(preexisting?.name, "Preexisting");
    assert.equal(DB.db.prepare("SELECT COUNT(*) c FROM board_registry").get().c, 0);
    assert.equal(DB.db.prepare("SELECT COUNT(*) c FROM board_events").get().c, 0);
    assert.equal(readFileSync(new URL("../seeds/companies.json", import.meta.url), "utf8").trim(), "[]");
    const handlers = new Map();
    tools.registerTools({ registerTool: (name, _schema, handler) => handlers.set(name, handler) });
    const looked = unpack(await handlers.get("look")({ at: "boards" }));
    assert.deepEqual(looked.boards, []);
    assert.match(looked.note, /empty/);
    const listed = await capture(["boards", "list", "--json"]);
    assert.equal(listed.code, 0);
    assert.deepEqual(JSON.parse(listed.output).boards, []);
    assert.equal(globalCalls, 0);
  });

  test("registers extensible board types and answers hours, checks, and stale", () => {
    const never = DB.registerBoard({ name: "Never Studio", board_type: "workday", board_key: "never.wd5.external", tags: ["game-studio"] });
    const paused = DB.registerBoard({ name: "Paused Studio", board_type: "custom", active: false, notes: "paused" });
    const stale = DB.registerBoard({ name: "Stale Studio", board_type: "smartrecruiters", board_key: "stalestudio", tags: ["game-studio"] });
    const fresh = DB.registerBoard({ name: "Fresh Studio", board_type: "browser", careers_url: "https://careers.example.test/fresh" });
    assert.equal(never.inserted, true);
    assert.throws(() => DB.registerBoard({ name: "Linked", board_type: "custom", careers_url: "https://www.linkedin.com/company/linked" }), /linkedin/i);
    DB.appendBoardEvent({
      board_id: stale.id, kind: "board_checked", summary: "old check",
      payload: { method: "manual", postings_found: 4, new_postings: 4 }, ts: "2026-10-27T09:00:00Z",
    });
    DB.appendBoardEvent({
      board_id: fresh.id, kind: "board_checked", summary: "browser pass",
      payload: { method: "browser", postings_found: 10, new_postings: 10 }, ts: "2026-10-29T10:00:00Z",
    });
    const staleStats = DB.boardStats(stale.id, NOW);
    const freshStats = DB.boardStats(fresh.id, NOW);
    const neverStats = DB.boardStats(never.id, NOW);
    assert.equal(staleStats.hours_since_last_check, 50);
    assert.equal(staleStats.total_checks, 1);
    assert.equal(staleStats.open_postings_seen, 4);
    assert.equal(staleStats.last_check.method, "manual");
    assert.equal(freshStats.hours_since_last_check, 1);
    assert.equal(freshStats.open_postings_seen, 10);
    assert.equal(freshStats.last_check.method, "browser");
    assert.equal(neverStats.last_checked_at, null);
    assert.equal(neverStats.hours_since_last_check, null);
    assert.equal(neverStats.total_checks, 0);
    assert.deepEqual(neverStats.tags, ["game-studio"]);
    const staleList = DB.staleBoards(48, NOW);
    assert.deepEqual(staleList.map((board) => board.name), ["Never Studio", "Stale Studio"]);
    assert.equal(staleList.some((board) => board.name === "Paused Studio"), false);
    const again = DB.registerBoard({ name: "Stale Studio Renamed", board_type: "smartrecruiters", board_key: "stalestudio", notes: "still tracking" });
    assert.equal(again.inserted, false);
    assert.equal(again.id, stale.id);
    assert.equal(DB.boardStats(stale.id, NOW).notes, "still tracking");
    assert.equal(DB.boardStats(stale.id, NOW).total_checks, 1);
    assert.equal(DB.hoursSince("2026-10-27 09:00:00", NOW), 50);
  });

  test("events are append-only", () => {
    const board = DB.registerBoard({ name: "Immutable", board_type: "custom" });
    const first = DB.appendBoardEvent({ board_id: board.id, kind: "note", summary: "first note", ts: "2026-10-29T01:00:00Z" });
    const second = DB.appendBoardEvent({ board_id: board.id, kind: "contact", summary: "recruiter intro", payload: { name: "Ada" } });
    assert.notEqual(first.id, second.id);
    assert.throws(() => DB.db.prepare("UPDATE board_events SET summary='rewritten' WHERE id=?").run(first.id), /append-only/);
    assert.throws(() => DB.db.prepare("DELETE FROM board_events WHERE id=?").run(first.id), /append-only/);
    assert.equal(DB.db.prepare("SELECT summary FROM board_events WHERE id=?").get(first.id).summary, "first note");
    assert.throws(() => DB.db.prepare("DELETE FROM board_registry WHERE id=?").run(board.id));
    assert.equal(DB.db.prepare("SELECT summary FROM board_events WHERE id=?").get(second.id).summary, "recruiter intro");
    assert.throws(() => DB.appendBoardEvent({ board_id: 999999, kind: "note", summary: "missing" }), /no board/);
  });

  test("links application status to a registered board and an existing job", () => {
    const board = DB.registerBoard({ name: "Applied Co", board_type: "greenhouse", board_key: "appliedco", tags: ["game-studio"] });
    const company = DB.upsertCompany({ name: "Applied Co", domain: "applied.example", ats_platform: "greenhouse", ats_slug: "appliedco" });
    const saved = DB.upsertJobs(company.id, [{ source_url: "https://example.invalid/role", title: "Gameplay Engineer" }]);
    const jobId = saved.new_postings[0].job_id;
    const other = DB.upsertCompany({ name: "Untracked", ats_platform: "lever", ats_slug: "untrackedco" });
    const otherJob = DB.upsertJobs(other.id, [{ source_url: "https://example.invalid/other", title: "Other" }]).new_postings[0].job_id;
    const before = DB.db.prepare("SELECT COUNT(*) c FROM board_events").get().c;
    DB.recordApplication(otherJob, { status: "applied" });
    assert.equal(DB.db.prepare("SELECT COUNT(*) c FROM board_events").get().c, before);
    DB.recordApplication(jobId, { status: "interested" });
    assert.equal(DB.boardStats(board.id).applications_submitted, 0);
    DB.recordApplication(jobId, { status: "applied" });
    let stats = DB.boardStats(board.id);
    assert.equal(stats.applications_submitted, 1);
    assert.deepEqual(stats.positions_applied_to.map((position) => [position.title, position.status, position.job_id]), [["Gameplay Engineer", "applied", jobId]]);
    const count = DB.recentBoardEvents({ board_id: board.id, limit: 100 }).length;
    DB.recordApplication(jobId, { status: "applied", notes: "same status" });
    assert.equal(DB.recentBoardEvents({ board_id: board.id, limit: 100 }).length, count);
    DB.recordApplication(jobId, { status: "interviewing" });
    stats = DB.boardStats(board.id);
    assert.equal(stats.applications_submitted, 1);
    assert.equal(stats.positions_applied_to[0].status, "interviewing");
    assert.throws(() => DB.appendBoardEvent({ board_id: board.id, kind: "note", summary: "bad job", job_id: 999999 }), /no job/);
  });

  test("gather records a check only for a registered board", async () => {
    const board = DB.registerBoard({ name: "New Co", board_type: "greenhouse", board_key: "newco", tags: ["game-studio"] });
    const deps = {
      sleep: async () => {},
      politeDelayMs: 0,
      fetchBoardFn: async () => [
        { source_url: "https://example.invalid/1", title: "Eng", location: null, remote: null, comp_min: null, comp_max: null, raw: {} },
        { source_url: "https://example.invalid/2", title: "PM", location: null, remote: null, comp_min: null, comp_max: null, raw: {} },
      ],
    };
    const first = unpack(await tools.fetchJobs({ dry_run: false, ats_platform: "greenhouse", ats_slug: "newco" }, deps));
    assert.equal(first.ok, true);
    assert.equal(first.per_company[0].ledger.recorded, true);
    assert.equal(first.per_company[0].ledger.board_id, board.id);
    let stats = DB.boardStats(board.id);
    assert.equal(stats.total_checks, 1);
    assert.equal(stats.open_postings_seen, 2);
    assert.equal(stats.last_check.new_positions.length, 2);
    assert.equal(stats.last_check.method, "ats_api");
    assert.equal(typeof stats.company_id, "number");
    await tools.fetchJobs({ dry_run: false, ats_platform: "greenhouse", ats_slug: "newco" }, {
      sleep: async () => {}, politeDelayMs: 0,
      fetchBoardFn: async () => [
        { source_url: "https://example.invalid/1", title: "Eng", location: null, remote: null, comp_min: null, comp_max: null, raw: {} },
        { source_url: "https://example.invalid/2", title: "PM", location: null, remote: null, comp_min: null, comp_max: null, raw: {} },
      ],
    });
    stats = DB.boardStats(board.id);
    assert.equal(stats.total_checks, 2);
    assert.equal(stats.open_postings_seen, 2);
    assert.equal(stats.last_check.new_positions.length, 0);
    const seenBefore = DB.recentBoardEvents({ board_id: board.id, limit: 100 }).filter((event) => event.kind === "posting_seen");
    await tools.fetchJobs({ dry_run: false, ats_platform: "greenhouse", ats_slug: "newco" }, {
      sleep: async () => {}, politeDelayMs: 0,
      fetchBoardFn: async () => [{ source_url: "https://example.invalid/1", title: "Eng", location: null, remote: null, comp_min: null, comp_max: null, raw: {} }],
    });
    stats = DB.boardStats(board.id);
    assert.equal(stats.open_postings_seen, 1);
    assert.equal(stats.last_check.closed_positions.length, 1);
    const seenAfter = DB.recentBoardEvents({ board_id: board.id, limit: 100 }).filter((event) => event.kind === "posting_seen");
    assert.equal(seenAfter.length, seenBefore.length);
    assert.deepEqual(seenAfter.map((event) => event.summary), seenBefore.map((event) => event.summary));
    const before = DB.db.prepare("SELECT COUNT(*) c FROM board_events").get().c;
    const unregistered = unpack(await tools.fetchJobs({ dry_run: false, ats_platform: "lever", ats_slug: "notregistered" }, {
      sleep: async () => {}, politeDelayMs: 0,
      fetchBoardFn: async () => [{ source_url: "https://example.invalid/x", title: "X", location: null, remote: null, comp_min: null, comp_max: null, raw: {} }],
    }));
    assert.equal(unregistered.ok, true);
    assert.equal(unregistered.per_company[0].ledger, undefined);
    assert.equal(DB.db.prepare("SELECT COUNT(*) c FROM board_events").get().c, before);
    const unreachable = unpack(await tools.fetchJobs({ dry_run: false, ats_platform: "greenhouse", ats_slug: "newco" }, {
      sleep: async () => {}, politeDelayMs: 0, fetchBoardFn: async () => null,
    }));
    assert.equal(unreachable.per_company[0].unreachable, true);
    assert.equal(unreachable.per_company[0].ledger.recorded, true);
    stats = DB.boardStats(board.id);
    assert.equal(stats.total_checks, 4);
    assert.equal(stats.last_check.error, "unreachable");
    assert.equal(stats.open_postings_seen, 1);
    assert.equal(globalCalls, 0);
  });

  test("CLI adds, lists, and appends JSON for a shell assistant", async () => {
    const added = io();
    assert.equal(await runBoardCli(["add", "--name", "CLI Studio", "--type", "smartrecruiters", "--key", "clistudio", "--tags", "game-studio", "--json"], added), 0);
    const body = JSON.parse(added.output[0]);
    assert.equal(body.inserted, true);
    assert.equal(body.stats.board_type, "smartrecruiters");
    assert.equal(body.stats.total_checks, 0);
    assert.deepEqual(body.stats.tags, ["game-studio"]);
    const noted = io();
    assert.equal(await runBoardCli(["event", "--id", String(body.id), "--kind", "note", "--summary", "recruiter intro", "--json"], noted), 0);
    assert.equal(JSON.parse(noted.output[0]).event.kind, "note");
    const feed = io();
    assert.equal(await runBoardCli(["events", "--id", String(body.id), "--json"], feed), 0);
    assert.equal(JSON.parse(feed.output[0]).events[0].summary, "recruiter intro");
    const stale = io();
    assert.equal(await runBoardCli(["stale", "--hours", "24", "--json"], stale), 0);
    const names = JSON.parse(stale.output[0]).boards.map((board) => board.name);
    assert.equal(names.includes("CLI Studio"), true);
    const usage = io();
    assert.equal(await runBoardCli(["nope"], usage), 2);
    assert.match(usage.errors.join("\n"), /jobbot boards/);
    const help = io();
    assert.equal(await runBoardCli(["--help"], help), 0);
    assert.match(help.output.join("\n"), /jobbot boards add/);
    assert.equal(globalCalls, 0);
  });
});
