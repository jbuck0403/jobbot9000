// Workday + SmartRecruiters fetchers and the careers-URL detector. HTTP is mocked.
import assert from "node:assert/strict";
import { describe, test, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "jobbot-ats-boards-"));
const privateDir = join(root, ".private");
const priorEnv = Object.fromEntries(["STATE_DIR", "JOBBOT_PRIVATE_DIR", "JOBBOT_NETWORK"].map((key) => [key, process.env[key]]));
process.env.JOBBOT_NETWORK = "off";
process.env.JOBBOT_PRIVATE_DIR = privateDir;
process.env.STATE_DIR = join(privateDir, "state");

let globalCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { globalCalls++; throw new Error("global fetch must not run"); };

const ats = await import("../src/ats.ts");
const ids = await import("../src/board-id.ts");
const DB = await import("../src/db.ts");
const tools = await import("../src/tools.ts");
const { runBoardCli } = await import("../src/board-cli.ts");
const unpack = (result) => JSON.parse(result.content[0].text);

function jsonResponse(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => text,
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  };
}

function workdayPostings(count) {
  return Array.from({ length: count }, (_, i) => ({
    title: `Role ${i}`,
    externalPath: `/job/Place/Role-${i}_JR${i}`,
    locationsText: i % 2 ? "Remote, USA" : "Austin, TX",
    postedOn: "Posted Today",
    bulletFields: [`JR${i}`],
  }));
}

function workdayFetch(handlers) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), init });
    return handlers(String(url), init, calls);
  };
  return { calls, fetchFn };
}

describe("workday and smartrecruiters", () => {
  after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("detector and registration identifiers", async () => {
    assert.deepEqual(ids.detectBoard("https://nature.wd108.myworkdayjobs.com/en-US/ExternalCareers/job/Remote/Role_JR1"), {
      board_type: "workday", board_key: "nature.wd108.externalcareers",
      careers_url: "https://nature.wd108.myworkdayjobs.com/ExternalCareers",
    });
    assert.equal(ids.parseWorkday("https://nature.wd108.myworkdayjobs.com/wday/cxs/nature/ExternalCareers/jobs")?.key, "nature.wd108.externalcareers");
    assert.equal(ids.parseWorkday("Nature.wd108.ExternalCareers")?.key, "nature.wd108.externalcareers");
    assert.equal(ids.detectBoard("https://jobs.smartrecruiters.com/SmartRecruiters/744000158320111-role").board_key, "smartrecruiters");
    assert.equal(ids.detectBoard("https://api.smartrecruiters.com/v1/companies/SmartRecruiters/postings").board_type, "smartrecruiters");
    assert.equal(ids.detectBoard("https://boards.greenhouse.io/riotgames").board_key, "riotgames");
    assert.equal(ids.detectBoard("https://job-boards.greenhouse.io/embed/job_board?for=riotgames").board_key, "riotgames");
    assert.equal(ids.detectBoard("https://jobs.ashbyhq.com/linear/abc").board_type, "ashby");
    assert.equal(ids.detectBoard("https://jobs.lever.co/spotify/123").board_type, "lever");
    assert.equal(ids.detectBoard("https://apply.workable.com/api/v1/widget/accounts/mcfarlane-aviation?details=true").board_key, "mcfarlane-aviation");
    const custom = ids.detectBoard("https://careers.example.com/jobs");
    assert.equal(custom.board_type, "custom");
    assert.equal(custom.board_key, null);
    assert.match(custom.note, /browser/);
    assert.throws(() => ids.detectBoard("https://www.linkedin.com/company/acme"), /linkedin/i);
    assert.throws(() => ids.detectBoard("http://nature.wd108.myworkdayjobs.com/ExternalCareers"), /https/i);

    const fromUrl = DB.registerBoard({ name: "Nature", board_type: "workday", careers_url: "https://nature.wd108.myworkdayjobs.com/en-US/ExternalCareers", tags: ["game-studio"] });
    const stats = DB.boardStats(fromUrl.id);
    assert.equal(stats.board_key, "nature.wd108.externalcareers");
    assert.equal(stats.careers_url, "https://nature.wd108.myworkdayjobs.com/ExternalCareers");
    assert.throws(() => DB.registerBoard({ name: "Bad", board_type: "workday", board_key: "neverstudio" }), /tenant\.wdN\.site/);
    assert.throws(() => DB.registerBoard({
      name: "Mismatch", board_type: "workday", board_key: "nature.wd108.externalcareers",
      careers_url: "https://other.wd5.myworkdayjobs.com/External",
    }), /different boards/);
    const sr = DB.registerBoard({ name: "SR", board_type: "smartrecruiters", careers_url: "https://jobs.smartrecruiters.com/SmartRecruiters" });
    assert.equal(DB.boardStats(sr.id).board_key, "smartrecruiters");
    assert.throws(() => DB.registerBoard({ name: "No Key", board_type: "smartrecruiters" }), /company identifier/);

    const out = [];
    const code = await runBoardCli(["detect", "https://boards.greenhouse.io/riotgames", "--json"], { out: (line) => out.push(line), error: () => {} });
    assert.equal(code, 0);
    assert.equal(JSON.parse(out.join("\n")).board_key, "riotgames");
    assert.equal(globalCalls, 0);
  });

  test("workday paginates, fetches details, and records a ledger check", async () => {
    const all = workdayPostings(41);
    const { calls, fetchFn } = workdayFetch((url, init) => {
      if (url.endsWith("/jobs")) {
        const body = JSON.parse(init.body);
        assert.equal(body.limit, 20);
        assert.equal(body.searchText, "");
        assert.equal(init.method, "POST");
        // Later Workday pages report total 0 even when jobPostings is full.
        const slice = all.slice(body.offset, body.offset + body.limit);
        return jsonResponse(200, { total: body.offset === 0 ? all.length : 0, jobPostings: slice });
      }
      const id = /_JR(\d+)$/.exec(url)?.[1];
      return jsonResponse(200, { jobPostingInfo: {
        title: `Role ${id}`, jobDescription: `<p>Build ${id}</p>`, location: Number(id) % 2 ? "Remote, USA" : "Austin, TX",
        remoteType: Number(id) % 2 ? "Remote" : "On-site", jobReqId: `JR${id}`,
        externalUrl: `https://nature.wd108.myworkdayjobs.com/ExternalCareers/job/Role_JR${id}`,
      } });
    });
    let slept = 0;
    const jobs = await ats.fetchBoard("workday", "nature.wd108.externalcareers", fetchFn, {
      sleep: async () => { slept++; }, pageDelayMs: 5, detailDelayMs: 5, details: "all",
    });
    assert.equal(jobs.length, 41);
    assert.equal(calls.filter((call) => call.url.endsWith("/jobs")).length, 3);
    assert.equal(calls.filter((call) => call.url.includes("/job/")).length, 41);
    assert.equal(jobs[1].source_url, "https://nature.wd108.myworkdayjobs.com/externalcareers/job/Place/Role-1_JR1");
    assert.equal(jobs[1].remote, 1);
    assert.equal(jobs[0].remote, null);
    assert.equal(jobs[1].raw.jobDescription, "<p>Build 1</p>");
    assert.equal(slept, 2 + 40);
    assert.match(calls[0].url, /^https:\/\/nature\.wd108\.myworkdayjobs\.com\/wday\/cxs\/nature\/externalcareers\/jobs$/);

    const saved = unpack(await tools.fetchJobs({ ats_platform: "workday", ats_slug: "nature.wd108.externalcareers" }, {
      sleep: async () => {}, politeDelayMs: 0,
      fetchBoardFn: (platform, slug) => ats.fetchBoard(platform, slug, fetchFn),
    }));
    assert.equal(saved.ok, true);
    assert.equal(saved.jobs.inserted, 41);
    const check = DB.boardStats(DB.listBoardStats().find((board) => board.board_key === "nature.wd108.externalcareers").id);
    assert.equal(check.total_checks, 1);
    assert.equal(check.last_check.error, null);
    assert.equal(check.last_check.postings_found, 41);
    assert.equal(check.last_check.method, "ats_api");
    assert.equal(globalCalls, 0);
  });

  test("workday failures name the wd number, a renamed site, and a later page error", async () => {
    const renamed = workdayFetch(() => jsonResponse(404, { errorCode: "S21", message: "not found: Job_Posting_Site_ID=missing", httpStatus: 404 }));
    await assert.rejects(ats.fetchBoard("workday", "nature.wd108.missing", renamed.fetchFn), /site may have been renamed|Job_Posting_Site_ID=missing/);

    const wrongWd = workdayFetch(() => jsonResponse(422, { errorCode: "HTTP_422", message: "", httpStatus: 422 }));
    await assert.rejects(ats.fetchBoard("workday", "nature.wd1.externalcareers", wrongWd.fetchFn), /wd number is often wrong/);

    const refused = workdayFetch(() => jsonResponse(401, { message: "Unable to verify credentials for system account" }));
    await assert.rejects(ats.fetchBoard("workday", "nature.wd108.externalcareers", refused.fetchFn), /HTTP 401/);

    const all = workdayPostings(21);
    const dropped = workdayFetch((url, init) => {
      if (!url.endsWith("/jobs")) return jsonResponse(200, { jobPostingInfo: { title: "x", jobDescription: "d", location: "Austin" } });
      const body = JSON.parse(init.body);
      if (body.offset > 0) return jsonResponse(500, { message: "unavailable" });
      return jsonResponse(200, { total: all.length, jobPostings: all.slice(0, 20) });
    });
    await assert.rejects(ats.fetchBoard("workday", "nature.wd108.externalcareers", dropped.fetchFn), /HTTP 500/);

    const down = workdayFetch(() => { const error = new TypeError("fetch failed"); error.cause = { code: "ENOTFOUND" }; throw error; });
    await assert.rejects(ats.fetchBoard("workday", "nature.wd99.externalcareers", down.fetchFn), /could not be reached/);

    await assert.rejects(ats.fetchBoard("workday", "not-a-workday-key"), /tenant\.wdN\.site|myworkdayjobs/);
    assert.equal(globalCalls, 0);

    DB.registerBoard({ name: "Missing Site", board_type: "workday", board_key: "nature.wd108.missing" });
    const recorded = unpack(await tools.fetchJobs({ ats_platform: "workday", ats_slug: "nature.wd108.missing" }, {
      sleep: async () => {}, politeDelayMs: 0,
      fetchBoardFn: (platform, slug) => ats.fetchBoard(platform, slug, renamed.fetchFn),
    }));
    assert.equal(recorded.unreachable, 1);
    assert.match(recorded.per_company[0].error, /Job_Posting_Site_ID=missing/);
    const stats = DB.boardStats(DB.listBoardStats().find((board) => board.board_key === "nature.wd108.missing").id);
    assert.match(stats.last_check.error, /Job_Posting_Site_ID=missing/);
    assert.equal(stats.open_postings_seen, 0);
  });

  test("smartrecruiters paginates and keeps a detail failure on the list row", async () => {
    const { calls, fetchFn } = workdayFetch((url) => {
      const list = /\/postings\?/.exec(url);
      if (list) {
        const offset = Number(new URL(url).searchParams.get("offset"));
        const all = Array.from({ length: 101 }, (_, i) => ({
          id: `p${i}`, name: `Opening ${i}`, refNumber: `R${i}`,
          location: { city: "Krakow", region: "Remote", country: "pl", remote: true, fullLocation: "Krakow, Remote, Poland" },
        }));
        return jsonResponse(200, { offset, limit: 100, totalFound: all.length, content: all.slice(offset, offset + 100) });
      }
      const id = url.split("/").pop();
      if (id === "p0") return jsonResponse(404, { message: "Resource not found" });
      return jsonResponse(200, {
        id, name: `Opening ${id.slice(1)}`, postingUrl: `https://jobs.smartrecruiters.com/smartrecruiters/${id}-slug`,
        location: { city: "Krakow", remote: true, fullLocation: "Krakow, Remote, Poland" },
        jobAd: { sections: { jobDescription: { text: `<p>Desc ${id}</p>` }, qualifications: { text: "<p>Bar</p>" } } },
      });
    });
    const jobs = await ats.fetchBoard("smartrecruiters", "https://jobs.smartrecruiters.com/SmartRecruiters", fetchFn, { details: "all" });
    assert.equal(jobs.length, 101);
    assert.equal(calls.filter((call) => call.url.includes("/postings?")).length, 2);
    assert.equal(jobs[0].source_url, "https://jobs.smartrecruiters.com/smartrecruiters/p0");
    assert.match(jobs[0].raw.detail_error, /HTTP 404/);
    assert.equal(jobs[1].raw.jobDescription.includes("Desc p1"), true);
    assert.equal(jobs[1].remote, 1);
    assert.equal(calls[0].init.method, "GET");

    const empty = await ats.fetchBoard("smartrecruiters", "quiet-co", async () => jsonResponse(200, { offset: 0, limit: 100, totalFound: 0, content: [] }));
    assert.deepEqual(empty, []);
    await assert.rejects(
      ats.fetchBoard("smartrecruiters", "broken-co", async () => jsonResponse(503, { message: "down" })),
      /HTTP 503/,
    );
    const blocked = unpack(await tools.fetchJobs({ ats_platform: "smartrecruiters", ats_slug: "quiet-co" }));
    assert.equal(blocked.code, "network_disabled");
    assert.equal(globalCalls, 0);
  });
});
