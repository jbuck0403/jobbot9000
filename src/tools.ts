// tools.ts — the MCP surface (v2: the readiness loop). The agent calls these in any order.
// Three doors over uniform data (orient / look / gather) plus the writes. Invariants hold:
// the agent never writes the DB (db.ts does); judgment enters only through a named write whose
// closed vocabularies are z.enums built from a grading mode (the mode is the single source of
// truth); no union input schemas; every tool degrades with an honest note rather than throwing.
// New in v2: a multi-dimensional competency profile (fair to no-portfolio candidates — absence
// lowers CONFIDENCE, not the level), a repeatable interview that assesses + verifies + upskills,
// fitness×desire matching, a tracked upskilling plan, resume-building, and a durable journal so a
// months-long search resumes from the DB after any session ends.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { NETWORK_DISABLED, networkEnabled } from "./network.js";
import * as DB from "./db.js";
import { reviewBatch } from "./review-queue.js";
import { readJourneyState } from "./state.js";
import { FETCHABLE_ATS_PLATFORMS, resolveAts, fetchBoard, type AtsPlatform } from "./ats.js";
import { detectBoard } from "./board-id.js";
import { fetchUserRepos, enrichRepo, type RepoFacts } from "./github.js";
import { PROVIDERS, type DiscoverQuery, type DiscoveredCompany, type ProviderContext } from "./providers.js";

type State = ReturnType<typeof readJourneyState>;

// Per-run spend ceiling for paid discovery (the gate TheirStack itself doesn't provide).
const MAX_CREDITS_PER_RUN = Number(process.env.THEIRSTACK_MAX_CREDITS_PER_RUN ?? 150);

// ── grading modes — the single source of truth for the closed vocabularies ──
interface ModeConstraints { [key: string]: unknown }
interface Mode { mode: string; rubric?: string; output_schema?: Record<string, unknown>; constraints: ModeConstraints }
function loadMode(name: string): Mode {
  return JSON.parse(readFileSync(new URL(`../modes/${name}.json`, import.meta.url), "utf8")) as Mode;
}
const MODE = {
  competency: loadMode("competency_profile"),
  interview: loadMode("interview"),
  roleFit: loadMode("role_fit"),
  job: loadMode("job_intrinsic"),
  letter: loadMode("cover_letter"),
  portfolio: loadMode("portfolio_relevance"),
  plan: loadMode("upskilling_plan"),
  resume: loadMode("resume_revision"),
};
const vocab = (m: Mode, key: string): string[] => {
  const v = m.constraints[key];
  if (!Array.isArray(v)) throw new Error(`mode ${m.mode}: missing closed vocabulary '${key}'`); // loud startup failure
  return v as string[];
};
const SENIORITY = vocab(MODE.competency, "level_must_be_one_of");
const DIMENSION = vocab(MODE.competency, "dimension_must_be_one_of");
const CONFIDENCE = vocab(MODE.competency, "confidence_must_be_one_of");
const PROVENANCE = vocab(MODE.competency, "provenance_must_be_one_of");
const SCORE = vocab(MODE.interview, "score_must_be_one_of");
const OWNERSHIP = vocab(MODE.interview, "ownership_must_be_one_of");
const UNDERSTANDING = vocab(MODE.interview, "understanding_must_be_one_of");
const INTERVIEW_CEILING = vocab(MODE.interview, "verified_ceiling_must_be_one_of");
const FITBAND = vocab(MODE.roleFit, "band_must_be_one_of");
const DESIRE_ALIGN = vocab(MODE.roleFit, "desire_alignment_must_be_one_of");
const MARKET = vocab(MODE.job, "market_signal_must_be_one_of");
const RELEVANCE = vocab(MODE.portfolio, "relevance_must_be_one_of");
const PLAN_TYPE = vocab(MODE.plan, "type_must_be_one_of");
const PLAN_STATUS = ["suggested", "in_progress", "done"];
const APP_STATUS = ["interested", "applied", "interviewing", "offer", "rejected", "withdrawn"];
const INTERVIEW_TYPE = ["competency", "role_fit"];
const enumOf = (v: string[]) => z.enum(v as [string, ...string[]]);
const ladder = SENIORITY.join(" → ");

// The ladder order the band math indexes into (DB.LADDER, via DB.bandFor/deriveBand) and the
// vocabulary the tool enums are built from (the mode) must be the SAME ladder — divergence
// would silently mis-band. Fail loudly at startup, like vocab() does for a missing key.
if (SENIORITY.join("|") !== DB.LADDER.join("|"))
  throw new Error("mode competency_profile: level_must_be_one_of must equal db.ts LADDER (same levels, same order)");

const json = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }] });
const noJob = (id: number) => json({ ok: false, error: `no job ${id} — find a valid job_id via look({ at: 'jobs' })` });
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const DESC_MAX = 1000;
export function compactDescription(rawJson: string | null): string | null {
  if (!rawJson) return null;
  let p: any; try { p = JSON.parse(rawJson); } catch { return null; }
  const raw = p?.descriptionPlain ?? p?.content ?? p?.description ?? p?.jobDescription ?? null;
  if (typeof raw !== "string" || !raw) return null;
  const text = raw.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, DESC_MAX) : null;
}

// Portfolio repos + relevance, ranked strong→moderate→weak→ungraded; spreads facts (incl. the
// verify signals + source) so the skeptical picture travels everywhere it's read.
export function rankedPortfolio(): Array<Record<string, unknown> & { relevance: { band: string; demonstrates: unknown[]; gaps: unknown[]; rationale: string | null } | null }> {
  const rank = (b?: string | null) => (b ? RELEVANCE.indexOf(b) : RELEVANCE.length);
  return DB.getPortfolio().map((r) => {
    const facts = r.facts_json ? JSON.parse(r.facts_json) : { repo: r.repo };
    const rel = DB.getPortfolioRelevance(r.repo);
    return { ...facts, source: r.source, fetched_at: r.fetched_at, relevance: rel ? { band: rel.relevance, demonstrates: rel.demonstrates, gaps: rel.gaps, rationale: rel.rationale } : null };
  }).sort((a, b) => rank(a.relevance?.band) - rank(b.relevance?.band));
}

// The market-demand overlay — computed skill demand from graded jobs in the band. Grounds both
// the resume/portfolio coaching and the upskilling plan's 'build'/'learn' items.
export function marketOverlay(s: State) {
  if (s.catalog.jobs === 0)
    return { computed: false, note: "no market data yet — discover companies (gather 'find_companies') and pull boards (gather 'fetch_jobs'); until then coach on resume structure/clarity and don't fabricate demand." };
  if (s.catalog.jobs - s.catalog.ungraded_jobs === 0)
    return { computed: false, note: `${s.catalog.jobs} jobs but none graded — run grade_job (look scope:'worklist') so demand can be computed.` };
  const band = DB.bandFor(s.assessed_level);
  const demand = DB.marketSkillDemand(band, 20);
  return {
    computed: true,
    basis: band ? `${demand.total_jobs} graded job(s) in your band (${band.join("/")})` : `${demand.total_jobs} graded job(s) (whole catalog — assess your level for a banded view)`,
    top_skills: demand.skills,
    note: "what the market asks for — the in-demand skills the user can't yet evidence are the gap to coach and to target with build/learn plan items.",
  };
}

export interface JobFilterArgs { query?: string; titles_any?: string[]; location?: string; remote?: boolean }
export function jobFilters(a: JobFilterArgs): { where: string[]; args: (string | number)[] } {
  const where: string[] = []; const args: (string | number)[] = [];
  if (a.query) { where.push("(j.title LIKE ? OR c.name LIKE ?)"); args.push(`%${a.query}%`, `%${a.query}%`); }
  if (a.titles_any?.length) {
    where.push("(" + a.titles_any.map(() => "j.title LIKE ?").join(" OR ") + ")");
    for (const t of a.titles_any) args.push(`%${t}%`);
  }
  if (a.location) { where.push("j.location LIKE ?"); args.push(`%${a.location}%`); }
  if (a.remote === true) where.push("j.remote = 1");
  return { where, args };
}

// Prep steps the user hasn't done — so a prepped/opted-out user is never told to redo them.
const prepHint = (s: State) => {
  const steps: string[] = [];
  if (!s.dimensions.onboarded) steps.push("onboard");
  if (!s.dimensions.profiled) steps.push("assess your competency profile");
  else if (!s.dimensions.verified) steps.push("verify it in a competency interview");
  if (s.profile?.no_resume) steps.push("build a resume from your real experience");
  else if (!s.has_resume) steps.push("capture your resume");
  return steps.length ? steps.join(", ") : "sharpen your resume and portfolio against real demand";
};
const emptyCatalogNote = (s: State) =>
  s.catalog.companies === 0
    ? `no jobs yet — discover companies with gather({ step: 'find_companies' }), then pull boards with gather({ step: 'fetch_jobs' }). You can also ${prepHint(s)} now.`
    : `${s.catalog.companies} companies discovered but no jobs pulled — run gather({ step: 'fetch_jobs' })${s.catalog.unresolved > 0 ? ` (${s.catalog.unresolved} unresolved)` : ""}. You can also ${prepHint(s)} now.`;

// The router — one priority-ordered read of the whole loop, pure over JourneyState (exported
// for tests). Every state has an exit edge back into the cycle; there is no terminal "done":
// apply → rejection → upskill → item done → re-assess → re-match → apply. Order: resume an
// open thread, then the onboarding gates, then the loop edges (progress to re-assess, plan to
// work, outcomes to feed back), then market work.
export function recommendNext(s: State): string {
  if (!s.dimensions.onboarded) return "coach — onboard (profile + desires) first";
  if (s.open_interview) return `verify — resume the open ${s.open_interview.type} interview (record_interview), then complete it`;
  if (!s.dimensions.profiled) return "coach — assess the competency profile (skeptically; absence ≠ low level)";
  if (!s.dimensions.verified) return "verify — run a competency interview to establish/verify the profile (this is also how no-portfolio candidates are assessed)";
  const planOpen = (s.plan.suggested ?? 0) + (s.plan.in_progress ?? 0);
  if (s.catalog.jobs === 0)
    return `job-search — gather('find_companies') + gather('fetch_jobs') to populate the market${planOpen > 0 ? `; the ${planOpen} open plan item(s) (look at:'plan') are workable meanwhile` : `; meanwhile you can ${prepHint(s)}`}`;
  if (s.signals.plan_done_since_assess > 0)
    return `verify — ${s.signals.plan_done_since_assess} plan item(s) closed since the last assessment: re-assess the dimensions they addressed (assess_competency), then re-match (look jobs scope:'relevant')`;
  if (planOpen > 0) return "upskill — work the open plan items (look at:'plan'); closing them raises fitness and re-opens higher-band roles";
  if (s.signals.rejections_since_plan > 0)
    return `upskill — ${s.signals.rejections_since_plan} rejection(s) since the plan last changed: turn the gaps they expose into new plan items (recommend_upskilling)`;
  if (s.catalog.ungraded_jobs >= s.catalog.jobs)
    return "job-search — jobs fetched but none graded: work the grading queue (look jobs scope:'worklist', then grade_job)";
  if ((s.catalog.live_in_band ?? 0) > 0)
    return "application — pursue the best-fit roles (look jobs scope:'relevant', then the packet); or job-search to widen the market";
  return "job-search — no live graded roles in your band: refresh boards (gather 'fetch_jobs'), widen discovery (gather 'find_companies'), grade the worklist, and re-match";
}

// Open threads a fresh session should resume (the durability payoff): an unfinished interview,
// in-progress plan items, applications with a pending next action.
function openThreads(s: State): string[] {
  const t: string[] = [];
  if (s.open_interview) t.push(`an unfinished ${s.open_interview.type} interview (id ${s.open_interview.id}) — resume it with record_interview, then complete it.`);
  if ((s.plan.in_progress ?? 0) > 0) t.push(`${s.plan.in_progress} upskilling item(s) in progress — see look({ at: 'plan' }); mark progress with update_plan_progress.`);
  const nextActions = DB.getApplications().filter((a) => a.next_action && !["offer", "rejected", "withdrawn"].includes(a.status));
  if (nextActions.length) t.push(`${nextActions.length} application(s) with a pending next action — see look({ at: 'applications' }).`);
  return t;
}

export function registerTools(server: McpServer): void {
  // Stage c audited private preview. No approval or executor capability is exposed.
  server.registerTool("review_batch", {
    description: "Display a complete, untruncated, integrity-checked private review revision and record a private review audit. Synthetic inputs only until transcript retention is resolved. No approval or send capability.",
    inputSchema: { batch_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/) },
  }, async ({ batch_id }) => {
    try {
      const reviewed = reviewBatch(DB.privateStorageRoot, batch_id, { now: Date.now(), isSuppressed: DB.isPrivatePersonSuppressed });
      return json({ ok: true, preview: reviewed.preview });
    } catch { return json({ ok: false, error: "Private review denied by integrity, freshness, honesty or suppression checks." }); }
  });

  // ── orient: the one state door (loop-aware + resume-first) ─────────────────
  server.registerTool("orient", {
    description:
      "Start EVERY session here. Where the user is in the readiness loop, the single next best action (recommended_skill — follow it; this is the router), OPEN THREADS to resume (an unfinished interview, in-progress plan items), and the recent journal — because the whole journey persists in the DB and spans weeks/months, this is how a fresh session picks up where the last left off. detail: 'recommend' (default), 'dashboard' (fitness profile, market gap, upskilling plan, notes). Safe as the first call; no required args.",
    inputSchema: { detail: enumOf(["recommend", "dashboard"]).optional() },
  }, async (a) => {
    const detail = a.detail ?? "recommend";
    const s = readJourneyState();

    const base: Record<string, unknown> = { server: "jobbot9000", state: s, open_threads: openThreads(s) };
    if (s.dimensions.has_applications) {
      const total = Object.values(s.pipeline).reduce((x, y) => x + y, 0);
      base.pipeline_summary = `${total} application(s): ${Object.entries(s.pipeline).map(([k, v]) => `${v} ${k}`).join(", ")}.`;
    }

    if (detail === "recommend") {
      base.recommended_skill = recommendNext(s);
      base.recent_history = DB.getEvents(10);
      base.loop_note = "the loop: profile⇅desires → match → interview (assess+verify+upskill) → plan (learn/resume/build) → apply → re-match. Closing gaps re-opens higher-band roles; rejections feed the plan. Resume open threads first, then follow recommended_skill.";
      return json(base);
    }

    // dashboard — the counts themselves live in state.catalog (live_in_band vs jobs is the
    // band-vs-market read); this block adds the band and the honest caveat, not a second copy.
    const band = DB.bandFor(s.assessed_level);
    let gap: Record<string, unknown> = { note: "assess the competency profile to compute the relevant band" };
    if (band) {
      gap = { band, note: "read state.catalog: live_in_band (your band ±1) vs jobs is the band-vs-market gap." };
      if (s.catalog.jobs === 0) gap.note = "zeros in state.catalog reflect an unpopulated catalog, not measured demand";
      else if (s.catalog.ungraded_jobs > 0) gap.note = `${s.catalog.ungraded_jobs} jobs ungraded — grade them before reading live_in_band as final`;
    }
    const notes: string[] = [];
    if (s.catalog.jobs === 0) notes.push(emptyCatalogNote(s));
    if (s.profile?.no_resume || s.profile?.no_github) notes.push("the user opted out of a resume/GitHub — the interview is the primary evidence; assess from it, don't penalize absence.");
    if (s.dimensions.portfolio_fetched && !s.dimensions.portfolio_graded) notes.push("portfolio fetched but ungraded — score each project's relevance with grade_portfolio_project.");
    // Assessment integrity — the profile, its confidence, and whether it's verified.
    if (s.dimensions.profiled) {
      base.competency_profile = s.competency;
      base.assessment = s.assessment;
      if (!s.dimensions.verified) notes.push(`profile band '${s.assessed_level}' is UNVERIFIED (no interview) — confidence is capped low. Run a competency interview to establish it; treat the floor '${s.assessment?.floor}' as the honest read until then.`);
    } else {
      notes.push("no competency profile yet — assess_competency per dimension (then verify in an interview).");
    }
    if (Object.keys(s.plan).length) base.upskilling_plan = s.plan;
    base.market_readiness_gap = gap;
    base.market_demand = marketOverlay(s);
    base.notes = notes;
    base.summary_note = "the honest read is yours to deliver — this surfaces the numbers.";
    return json(base);
  });

  // ── look: the one read door (never fetches, never writes) ──────────────────
  server.registerTool("look", {
    description:
      `The one read door — never fetches, never writes, safe in any order. at='jobs' lists by scope: 'market' (whole catalog), 'relevant' (your band ±1 with role fit; levels ${ladder}), 'worklist' (the grading queue). Filters apply to all scopes: titles_any (string[] OR-match title), location (substring), remote (true), query (title/company), grading_status. at='companies'. at='boards' lists the job-board ledger (optional stale_hours: active boards not checked in that many hours, including never-checked). at='board' needs board_id and returns that company's stats. at='board_events' is the append-only feed (optional board_id, limit). at='resume' (with_market_overlay adds computed demand; revision history is in at='history'). at='portfolio' (ranked by relevance + verification signals + overlay). at='profile' (identity + desires). at='competency' (the multi-dimensional profile + derived band + gaps — the assessment). at='interview' (open/latest session, scoped to job_id when supplied, or exact interview_id; explicit IDs never fall back, both IDs must match; includes Q/A/exemplars/deltas and all_sessions for selection). at='plan' (the upskilling plan by status). at='packet' (needs job_id: job+grade+skills+resume+role_fit+ranked portfolio+letter+application+honesty gating). at='applications' (the funnel). at='history' (the journal timeline — what happened, when). Returns JSON to interpret.`,
    inputSchema: {
      at: enumOf(["jobs", "companies", "boards", "board", "board_events", "resume", "portfolio", "profile", "competency", "interview", "plan", "packet", "applications", "history"]),
      scope: enumOf(["relevant", "market", "worklist"]).optional(),
      query: z.string().optional(),
      titles_any: z.array(z.string()).optional(),
      location: z.string().optional(),
      remote: z.boolean().optional(),
      grading_status: enumOf(["ungraded", "graded", "any"]).optional(),
      job_id: z.number().int().optional(),
      interview_id: z.number().int().optional(),
      board_id: z.number().int().optional(),
      stale_hours: z.number().nonnegative().optional(),
      with_market_overlay: z.boolean().optional(),
      limit: z.number().int().positive().optional(),
    },
  }, async (a) => {
    const s = readJourneyState();

    if (a.at === "companies") {
      const companies = DB.getCompanies(a.limit ?? 200).map((c) => ({ ...c, tags: c.tags ? c.tags.split(",").filter(Boolean) : [], ats_status: c.resolved ? "resolved" : "unresolved" }));
      const out: Record<string, unknown> = { companies };
      if (companies.length === 0) out.note = "no companies yet — run gather({ step: 'find_companies' }).";
      return json(out);
    }

    if (a.at === "boards" || a.at === "board" || a.at === "board_events") {
      try {
        if (a.at === "board_events") {
          const events = DB.recentBoardEvents({ board_id: a.board_id, limit: a.limit });
          const out: Record<string, unknown> = { events };
          if (events.length === 0) out.note = "no board events yet — register_board, then gather fetch_jobs or record_board_event.";
          return json(out);
        }
        if (a.at === "board") {
          if (a.board_id === undefined) return json({ ok: false, error: "look({ at: 'board' }) needs a board_id." });
          const stats = DB.boardStats(a.board_id);
          if (!stats) return json({ ok: false, error: `no board ${a.board_id}.` });
          return json({ stats });
        }
        const boards = a.stale_hours !== undefined ? DB.staleBoards(a.stale_hours) : DB.listBoardStats();
        const limited = boards.slice(0, a.limit ?? 500);
        const out: Record<string, unknown> = { boards: limited };
        if (a.stale_hours !== undefined) out.older_than_hours = a.stale_hours;
        if (limited.length === 0) out.note = "no boards registered. The ledger is empty — register_board, or `jobbot boards add` from a shell. seeds/companies.json is not copied in.";
        return json(out);
      } catch (e) { return json({ ok: false, error: errMsg(e) }); }
    }

    if (a.at === "profile") {
      if (!s.profile) return json({ note: "not onboarded — capture identity + desires via capture_profile." });
      return json({ profile: s.profile, note: s.profile.desires ? undefined : "no desires captured — capture_profile({ desires: {...} }) so matching can weigh what the user WANTS, not just what they can do." });
    }

    if (a.at === "resume") {
      const resume = DB.getMasterResume();
      if (!resume) {
        if (s.profile?.no_resume) return json({ opted_out: true, note: "The user opted out of a resume — coach from the interview + described experience. Build one anytime via set_resume." });
        return json({ note: "no resume yet — capture via capture_profile, or build one via set_resume." });
      }
      const out: Record<string, unknown> = { resume: resume.content, updated_at: resume.updated_at };
      if (a.with_market_overlay) out.market_overlay = marketOverlay(s);
      return json(out);
    }

    if (a.at === "portfolio") {
      const repos = DB.getPortfolio();
      if (repos.length === 0) {
        if (s.profile?.no_github) return json({ opted_out: true, note: "The user opted out of GitHub — no portfolio penalty; the interview is the evidence. Coach from projects they describe." });
        return json({ note: "no portfolio yet — run gather({ step: 'ingest_portfolio' }), or add described work via add_portfolio_project." });
      }
      const portfolio = rankedPortfolio();
      const ungraded = portfolio.filter((p) => !p.relevance).length;
      const withV = portfolio.filter((p) => (p as any).verify) as any[];
      const manual = portfolio.filter((p) => p.source === "manual");
      const verification = {
        competency_interview: s.dimensions.verified ? "on file" : "NONE — claims unverified",
        solo_projects: withV.filter((p) => p.verify.solo).length,
        max_stars: portfolio.reduce((m, p) => Math.max(m, (p as any).stars ?? 0), 0),
        self_applied_badges: withV.reduce((n, p) => n + (p.verify.self_applied_badges ?? 0), 0),
        claimed_no_repo: manual.length,
      };
      const out: Record<string, unknown> = { portfolio, verification, market_overlay: marketOverlay(s) };
      const notes: string[] = [];
      if (ungraded) notes.push(`${ungraded}/${portfolio.length} ungraded — score relevance to the target role with grade_portfolio_project.`);
      if (s.has_resume) notes.push("a resume flagship with no repo here can be added via add_portfolio_project, but as an UNVERIFIED claim — probe it in the interview before featuring.");
      if (!s.dimensions.verified && (manual.length || verification.solo_projects > 0)) notes.push("no competency interview yet — solo/claimed projects are unverified; verify ownership + understanding before treating them as senior evidence.");
      if (notes.length) out.note = notes.join(" ");
      return json(out);
    }

    if (a.at === "competency") {
      const profile = DB.getCompetencyProfile();
      const derived = DB.deriveBand(profile);
      const assessed = new Set(profile.map((p) => p.dimension));
      const missing = DIMENSION.filter((d) => !assessed.has(d));
      const out: Record<string, unknown> = { profile, band: DB.assessmentSummary() ?? derived, dimensions_missing: missing };
      const notes: string[] = [];
      if (profile.length === 0) notes.push("no competency profile yet — assess each dimension with assess_competency (skeptically; absence ≠ low level).");
      else if (missing.length) notes.push(`${missing.join(", ")} not yet assessed.`);
      if (profile.length && !s.dimensions.verified) notes.push("profile is UNVERIFIED — confidence is capped low until a competency interview demonstrates it. Run one (record_interview).");
      if (notes.length) out.note = notes.join(" ");
      return json(out);
    }

    if (a.at === "interview") {
      const sessions = DB.getInterviews();
      const all_sessions = sessions.map((x) => ({ id: x.id, type: x.type, status: x.status, job_id: x.job_id }));
      const scoped = a.job_id !== undefined ? sessions.filter((x) => x.job_id === a.job_id) : sessions;
      const iv = a.interview_id !== undefined
        ? DB.getInterview(a.interview_id)
        : scoped.find((x) => x.status === "in_progress") ?? scoped[0];
      if (!iv) return json({
        note: a.interview_id !== undefined
          ? `no interview ${a.interview_id} — choose an interview_id from all_sessions.`
          : a.job_id !== undefined
            ? `no interviews for job ${a.job_id} — start a role-fit interview with record_interview.`
            : "no interviews yet — run a competency interview (record_interview) to assess + verify + learn the bar.",
        all_sessions,
      });
      if (a.job_id !== undefined && iv.job_id !== a.job_id)
        return json({ ok: false, error: `interview ${iv.id} belongs to job ${iv.job_id ?? "none"}, not job ${a.job_id}.`, all_sessions });
      return json({ interview: iv, items: DB.getInterviewItems(iv.id), all_sessions });
    }

    if (a.at === "plan") {
      const plan = DB.getPlan();
      const out: Record<string, unknown> = { plan, counts: DB.planCounts() };
      if (plan.length === 0) out.note = "no upskilling plan yet — after an interview/assessment, turn the gaps into items with recommend_upskilling (learn/resume/build, market-grounded).";
      else out.note = "mark progress with update_plan_progress; closing items raises fitness and re-opens higher-band roles (re-match).";
      return json(out);
    }

    if (a.at === "history") {
      return json({ history: DB.getEvents(a.limit ?? 50), note: "the journal — append-only, persists across sessions. The full timeline of the search." });
    }

    if (a.at === "packet") {
      if (a.job_id === undefined) return json({ ok: false, error: "look({ at: 'packet' }) needs a job_id." });
      const job = DB.getJob(a.job_id);
      if (!job) return noJob(a.job_id);
      const master_resume = DB.getMasterResume()?.content ?? null;
      const fit = DB.getRoleFit(a.job_id) ?? null;
      const saved = DB.getCoverLetter(a.job_id);
      const missing: string[] = [];
      if (!master_resume) missing.push("master_resume");
      if (!fit) missing.push("role_fit");
      if (job.grade_seniority == null) missing.push("job_grade");
      const conf = s.assessment?.confidence ?? null;
      const verified = s.dimensions.verified;
      const featuredUnverified = rankedPortfolio()
        .filter((p) => p.relevance?.band === "strong" && p.source === "manual"
          && !DB.getInterviews().some((iv) => DB.getInterviewItems(iv.id).some((it) => (it.claim ?? "").toLowerCase().includes(String(p.repo).toLowerCase()))))
        .map((p) => p.repo);
      const { raw_json, ...jobLean } = job;
      const honesty: string[] = [];
      if (!verified || (conf && conf !== "high")) honesty.push(`the assessment is ${conf ?? "unrecorded"}${verified ? "" : "/unverified"} — write to the floor (${s.assessment?.floor ?? "?"}); don't assert seniority the user hasn't demonstrated.`);
      if (featuredUnverified.length) honesty.push(`do NOT feature ${featuredUnverified.join(", ")} — graded 'strong' but unverified. Verify in an interview first or leave out.`);
      const slotBase = missing.length
        ? `write the cover letter, then record_cover_letter — generic/ungrounded without: ${missing.join(", ")}.`
        : saved ? "a letter is saved — refine only if the packet changed." : "write the cover letter, then record_cover_letter.";
      return json({
        job: { ...jobLean, description: compactDescription(raw_json) },
        job_skills: DB.getJobSkills(a.job_id), master_resume, role_fit: fit, portfolio: rankedPortfolio(),
        saved_cover_letter: saved, application: DB.getApplication(a.job_id) ?? null, missing,
        readiness: { assessment_confidence: conf, assessment_floor: s.assessment?.floor ?? null, competency_verified: verified, featured_unverified_projects: featuredUnverified },
        cover_letter_slot: honesty.length ? `${slotBase} HONESTY: ${honesty.join(" ")}` : slotBase,
      });
    }

    if (a.at === "applications") {
      const applications = DB.getApplications();
      const out: Record<string, unknown> = { pipeline: DB.applicationCounts(), applications };
      if (applications.length === 0) out.note = "no applications tracked yet — record one after the user applies.";
      return json(out);
    }

    // a.at === "jobs"
    const scope = a.scope ?? "market";
    if (scope === "relevant") {
      const limit = a.limit ?? 25;
      if (s.catalog.jobs === 0) return json({ band: DB.bandFor(s.assessed_level), jobs: [], catalog_empty: true, note: emptyCatalogNote(s) });
      const band = DB.bandFor(s.assessed_level);
      if (!band) {
        const rows = DB.db.prepare("SELECT j.id, c.name AS company, j.title, j.grade_seniority FROM jobs j JOIN companies c ON c.id=j.company_id WHERE j.still_live=1 ORDER BY j.last_seen_at DESC LIMIT ?").all(limit);
        return json({ band: null, low_confidence: true, jobs: rows, note: "no competency profile yet — assess it for a real band." });
      }
      const flt = jobFilters(a);
      const rows = DB.db.prepare(
        `SELECT j.id, c.name AS company, j.title, j.location, j.remote, j.comp_min, j.comp_max, j.grade_seniority, j.grade_market_signal,
                f.band AS fit, f.desire_alignment, f.gaps_json AS fit_gaps_json
         FROM jobs j JOIN companies c ON c.id=j.company_id
         LEFT JOIN role_fit f ON f.job_id=j.id
         WHERE j.still_live=1 AND j.grade_seniority IN (${band.map(() => "?").join(",")})${flt.where.length ? " AND " + flt.where.join(" AND ") : ""}
         ORDER BY j.last_seen_at DESC LIMIT ?`,
      ).all(...band, ...flt.args, limit) as any[];
      const jobs = rows.map(({ fit_gaps_json, ...r }) => ({ ...r, fit_gaps: fit_gaps_json ? JSON.parse(fit_gaps_json) : null }));
      return json({ band, jobs, note: "fit (over/exact/under) + desire_alignment are your judgment via assess_role_fit — grade them to surface the real tension (fitness vs. desire). The user's desires are in look({ at: 'profile' })." });
    }

    if (scope === "worklist") {
      const flt = jobFilters(a);
      const where = ["j.still_live=1", "(j.grade_seniority IS NULL OR j.graded_at < j.fetched_at)", ...flt.where];
      const rows = DB.db.prepare(
        `SELECT j.id, c.name AS company, j.title, j.location, j.remote, j.raw_json, j.fetched_at, j.graded_at,
                CASE WHEN j.grade_seniority IS NULL THEN 'never_graded' ELSE 'stale' END AS reason
         FROM jobs j JOIN companies c ON c.id=j.company_id
         WHERE ${where.join(" AND ")} ORDER BY j.fetched_at ASC LIMIT ?`,
      ).all(...flt.args, a.limit ?? 25) as any[];
      const jobs = rows.map(({ raw_json, ...r }) => ({ ...r, description: compactDescription(raw_json) }));
      const out: Record<string, unknown> = { count: jobs.length, jobs };
      if (jobs.length === 0) out.note = s.catalog.jobs === 0 ? emptyCatalogNote(s) : "no ungraded jobs match.";
      return json(out);
    }

    // market
    const limit = a.limit ?? 100;
    const flt = jobFilters(a);
    const where = ["j.still_live=1", ...flt.where];
    if (a.grading_status === "ungraded") where.push("j.grade_seniority IS NULL");
    if (a.grading_status === "graded") where.push("j.grade_seniority IS NOT NULL");
    const whereSql = where.join(" AND ");
    const total = (DB.db.prepare(`SELECT count(*) c FROM jobs j JOIN companies c ON c.id=j.company_id WHERE ${whereSql}`).get(...flt.args) as { c: number }).c;
    const rows = DB.db.prepare(
      `SELECT j.id, c.name AS company, j.title, j.location, j.remote, j.comp_min, j.comp_max, j.grade_seniority
       FROM jobs j JOIN companies c ON c.id=j.company_id WHERE ${whereSql} ORDER BY j.last_seen_at DESC LIMIT ?`,
    ).all(...flt.args, limit);
    const out: Record<string, unknown> = { count: rows.length, total, jobs: rows };
    if (s.catalog.jobs === 0) out.note = emptyCatalogNote(s);
    else if (rows.length < total) out.note = `showing ${rows.length} of ${total} — raise limit or narrow with filters.`;
    return json(out);
  });

  // ── onboarding & profile (personal, mechanical) ────────────────────────────
  server.registerTool("capture_profile", {
    description: "Front door: capture identity, the resume, GitHub, the target work, and DESIRES (what the user WANTS — the other half of matching). Idempotent; partial is fine; desires merge (pass only what changed). Record 'no resume'/'no github' explicitly — absence is never penalized.",
    inputSchema: {
      resume: z.string().optional(), no_resume: z.boolean().optional(),
      github_handle: z.string().optional(), no_github: z.boolean().optional(),
      target_role: z.string().optional(), target_niche: z.string().optional(), location_pref: z.string().optional(),
      desires: z.object({
        role_types: z.array(z.string()).optional(),
        domains: z.array(z.string()).optional(),
        locations: z.array(z.string()).optional(),
        comp_floor: z.number().optional(),
        work_style: z.string().optional(),
        freetext: z.string().optional(),
        priorities: z.array(z.string()).optional(),
      }).optional(),
    },
  }, async (a) => {
    if (a.resume) DB.setMasterResume(a.resume);
    const patch: any = {};
    for (const k of ["target_role", "target_niche", "location_pref", "github_handle"] as const) if (a[k] !== undefined) patch[k] = a[k];
    if (a.no_resume !== undefined) patch.no_resume = a.no_resume ? 1 : 0;
    if (a.no_github !== undefined) patch.no_github = a.no_github ? 1 : 0;
    if (a.desires !== undefined) patch.desires = a.desires;
    DB.upsertProfile(patch);
    DB.logEvent("profile", "profile/desires updated");
    return json({ ok: true, state: readJourneyState() });
  });

  server.registerTool("set_resume", {
    description: `Set the master resume. → personal. Without a rationale it's the user's own wholesale edit, landing as-is. WITH a rationale it's a COACHED revision (Mode: resume_revision) — journaled to the history (look at:'history'). ALLOWED when revising: restructure, sharpen, quantify REAL impact, surface buried strengths, tailor to a role. BLOCKED: invent jobs/titles/dates/metrics or inflate scope (the no-invention guardrail) — route unbacked-but-strong claims to the competency interview instead. Read back via look({ at: 'resume' }).`,
    inputSchema: { content: z.string().min(1), rationale: z.string().optional() },
  }, async (a) => {
    DB.setMasterResume(a.content, a.rationale);
    const out: Record<string, unknown> = { ok: true, updated: DB.getMasterResume()?.updated_at };
    if (a.rationale) out.note = "coached revision journaled. Only real, defensible claims — anything unbacked belongs in the interview, not the resume.";
    return json(out);
  });

  server.registerTool("add_portfolio_project", {
    description: "Add a project ingest_portfolio can't see — a private/absent repo the user describes. → personal. With no public code there's nothing to inspect, so it's an UNVERIFIED CLAIM (could be someone else's product, a clone, or aspirational): added as 'claimed', and must NOT be featured as strong until a competency interview confirms ownership + understanding. A missing flagship lowers confidence; it doesn't auto-promote.",
    inputSchema: { name: z.string(), description: z.string().min(1), languages: z.array(z.string()).optional(), url: z.string().optional() },
  }, async (a) => {
    DB.addPortfolioProject(a.name, { repo: a.name, name: a.name, description: a.description, languages: a.languages ?? [], url: a.url ?? null, source: "manual", provenance: "claimed" });
    return json({ ok: true, repo: a.name, provenance: "claimed", note: "added as an UNVERIFIED claim — probe ownership + understanding in a competency interview before grading 'strong' or featuring it." });
  });

  // ── competency profile (judgment, mode-governed) ───────────────────────────
  server.registerTool("assess_competency", {
    description: `Assess ONE competency dimension (${DIMENSION.join(" | ")}) on the ladder ${ladder}. → personal. The keystone, multi-dimensional and SKEPTICAL: a resume/portfolio is a CLAIM (tag evidence with provenance ${PROVENANCE.join(" | ")}). CRITICAL: absence of public evidence is NOT weakness — set confidence low and let the interview establish the level; do NOT default the level down for a missing portfolio. confidence='high' needs demonstrated/corroborated evidence (an interview). Call once per dimension; the overall band is derived. Mode: competency_profile.`,
    inputSchema: {
      dimension: enumOf(DIMENSION),
      level: enumOf(SENIORITY),
      confidence: enumOf(CONFIDENCE),
      evidence: z.array(z.object({ claim: z.string(), provenance: enumOf(PROVENANCE), verified: z.boolean().optional() })).optional(),
      rationale: z.string().min(1),
    },
  }, async (a) => {
    DB.setCompetency(a.dimension, a.level, a.confidence, a.evidence ?? [], a.rationale);
    const out: Record<string, unknown> = { ok: true, dimension: a.dimension, level: a.level, confidence: a.confidence, derived_band: DB.deriveBand() };
    const s = readJourneyState();
    if (a.confidence === "high" && !s.dimensions.verified) out.note = "confidence='high' without a competency interview on file — high confidence needs demonstrated/corroborated evidence. Run record_interview or lower confidence.";
    const ev = a.evidence ?? [];
    if (ev.length && ev.every((e) => e.provenance === "claimed" || e.provenance === "self_published") && !s.dimensions.verified)
      out.note = "all evidence is claimed/self-published (unverified) — fine to set the level low-confidence, but verify in an interview before trusting it. Absence of proof ≠ low ability; don't over- OR under-rate.";
    return json(out);
  });

  // ── interview (the engine: assess + verify + upskill; repeatable, resumable) ─
  server.registerTool("record_interview", {
    description: `Record a competency or role-fit interview — the engine that ASSESSES (primary evidence for no-portfolio candidates), VERIFIES (catches over-claiming), and UPSKILLS (each item carries a grounded exemplar — 'what a great candidate would have said' — and the delta). → personal. type: ${INTERVIEW_TYPE.join(" | ")}; role_fit requires an existing job_id and exemplars anchored to that posting's bar. An explicit interview_id resumes only an in_progress session matching type and job_id (or no job). Without it, resume the unique matching open session or start when none match; multiple matches return candidate_interview_ids for explicit selection. done:true requires a nonblank summary before any write. Start/items/completion and their journal events persist atomically. verified_ceiling caps/establishes the level. Mode: interview. After completing, re-run assess_competency with demonstrated evidence and turn deltas into plan items (recommend_upskilling).`,
    inputSchema: {
      type: enumOf(INTERVIEW_TYPE),
      job_id: z.number().int().positive().safe().optional(),
      interview_id: z.number().int().positive().safe().optional(),
      items: z.array(z.object({
        dimension: enumOf(DIMENSION).optional(),
        claim: z.string().optional(),
        question: z.string(),
        answer_summary: z.string().optional(),
        exemplar: z.string().optional(),
        score: enumOf(SCORE).optional(),
        ownership: enumOf(OWNERSHIP).optional(),
        understanding: enumOf(UNDERSTANDING).optional(),
        delta_notes: z.string().optional(),
      })).min(1),
      verified_ceiling: enumOf(INTERVIEW_CEILING).optional(),
      summary: z.string().optional(),
      done: z.boolean().optional(),
    },
  }, async (a) => {
    let result: DB.RecordInterviewResult;
    try {
      result = DB.recordInterview(a);
    } catch (e) {
      return json({ ok: false, error: `interview was not recorded: ${errMsg(e)}` });
    }
    if (!result.ok) return json(result);
    const out: Record<string, unknown> = { ...result };
    if (result.completed) {
      const weak = a.items.filter((i) => i.score === "weak" || i.understanding === "shallow" || i.understanding === "cannot_explain" || i.ownership === "observer").length;
      out.note = `completed. ${weak}/${a.items.length} item(s) were weak/unverified. Now: re-run assess_competency per dimension with the demonstrated evidence (level ≤ verified_ceiling ${a.verified_ceiling ?? "?"}), and recommend_upskilling for each delta.`;
    } else {
      out.note = "appended. Continue using this interview_id and the same type/job_id, or call again with done:true + a nonblank summary to complete it.";
    }
    return json(out);
  });

  // ── job grade (catalog) ─────────────────────────────────────────────────────
  server.registerTool("grade_job", {
    description: `A job's intrinsic grade: seniority (${ladder}), market signal (${MARKET.join(" | ")}), required-vs-preferred skills. → catalog. Mode: job_intrinsic.`,
    inputSchema: { job_id: z.number().int(), seniority: enumOf(SENIORITY), market_signal: enumOf(MARKET), skills: z.array(z.object({ skill: z.string(), kind: enumOf(["required", "preferred"]) })) },
  }, async (a) => {
    if (!DB.getJob(a.job_id)) return noJob(a.job_id);
    DB.setJobGrade(a.job_id, a.seniority, a.market_signal, a.skills);
    return json({ ok: true, job_id: a.job_id });
  });

  // ── role fit (judgment, per-dimension + desire alignment) ──────────────────
  server.registerTool("assess_role_fit", {
    description: `The user's fit on a job: band (${FITBAND.join(" | ")}) PER DIMENSION + desire_alignment (${DESIRE_ALIGN.join(" | ")}) vs. their stated desires. → personal. This is the hermeneutic join: surface the tension (fitness vs. desire — e.g. 'a fit but onsite when you want remote', or 'you want it but you're a level under'). Mode: role_fit. Requires a competency profile.`,
    inputSchema: {
      job_id: z.number().int(),
      band: enumOf(FITBAND),
      dim_deltas: z.object({ technical_depth: z.string().optional(), system_design: z.string().optional(), communication: z.string().optional(), ownership: z.string().optional() }).optional(),
      desire_alignment: enumOf(DESIRE_ALIGN),
      gaps: z.array(z.string()).optional(),
      rationale: z.string().min(1),
    },
  }, async (a) => {
    if (!DB.getJob(a.job_id)) return noJob(a.job_id);
    if (!readJourneyState().dimensions.profiled) return json({ ok: false, error: "assess the competency profile first (assess_competency) — role fit is measured against it." });
    DB.setRoleFit(a.job_id, a.band, a.dim_deltas ?? null, a.desire_alignment, a.gaps ?? [], a.rationale);
    return json({ ok: true, job_id: a.job_id, band: a.band, desire_alignment: a.desire_alignment });
  });

  // ── portfolio relevance (judgment) ─────────────────────────────────────────
  server.registerTool("grade_portfolio_project", {
    description: `A portfolio project's relevance to the TARGET ROLE (${RELEVANCE.join(" | ")}). → personal. Grounds which projects to feature/anchor/deep-dive. Mode: portfolio_relevance. repo = full_name from look({ at: 'portfolio' }).`,
    inputSchema: { repo: z.string(), relevance: enumOf(RELEVANCE), demonstrates: z.array(z.string()), gaps: z.array(z.string()).optional(), rationale: z.string().min(1) },
  }, async (a) => {
    const proj = DB.getPortfolio().find((p) => p.repo === a.repo);
    if (!proj) return json({ ok: false, error: `no repo '${a.repo}' — list via look({ at: 'portfolio' }).` });
    const out: Record<string, unknown> = { ok: true, repo: a.repo, relevance: a.relevance };
    const notes: string[] = [];
    if (!readJourneyState().profile?.target_role) notes.push("no target_role on file — capture it via capture_profile so the judgment is anchored.");
    const verifiedInInterview = DB.getInterviews().some((iv) => DB.getInterviewItems(iv.id).some((it) => (it.claim ?? "").toLowerCase().includes(a.repo.toLowerCase())));
    if (a.relevance === "strong" && !verifiedInInterview) {
      if (proj.source === "manual") notes.push(`'${a.repo}' is a manual/claimed project with no public code and no interview finding — grading it 'strong' features an UNVERIFIED claim. Verify in an interview first, or grade lower.`);
      else {
        const v = proj.facts_json ? (JSON.parse(proj.facts_json).verify ?? null) : null;
        if (v && v.solo === true && v.authored_share != null && v.authored_share < 0.5) notes.push(`'${a.repo}' shows low authored_share (${v.authored_share}) — confirm it's the user's work before featuring 'strong'.`);
      }
    }
    if (notes.length) out.note = notes.join(" ");
    DB.setPortfolioRelevance(a.repo, a.relevance, a.demonstrates, a.gaps ?? [], a.rationale);
    return json(out);
  });

  // ── upskilling plan (judgment) ─────────────────────────────────────────────
  server.registerTool("recommend_upskilling", {
    description: `Turn assessed gaps into a tracked plan that raises REAL fitness. → personal. Mode: upskilling_plan. Each item: gap (a dimension or skill), type (${PLAN_TYPE.join(" | ")}), spec (concrete — 'learn' = what to do, 'resume' = a specific honest change, 'build' = a project to ship), market_demand (which in-demand skill it closes — ground 'build'/'learn' in the market overlay). Tracked suggested→in_progress→done; closing items re-opens higher-band roles.`,
    inputSchema: { items: z.array(z.object({ gap: z.string(), type: enumOf(PLAN_TYPE), spec: z.string().min(1), market_demand: z.string().optional() })).min(1) },
  }, async (a) => {
    const ids = a.items.map((it) => DB.addPlanItem(it.gap, it.type, it.spec, it.market_demand));
    return json({ ok: true, added: ids.length, item_ids: ids, note: "tracked. Mark progress with update_plan_progress; when items close, re-match (look jobs scope:'relevant') — the band may have moved." });
  });

  server.registerTool("update_plan_progress", {
    description: `Update an upskilling-plan item's status (${PLAN_STATUS.join(" | ")}) and/or notes. → personal, mechanical. Marking items 'done' raises fitness — re-assess the relevant dimension (assess_competency) and re-match. Find item ids via look({ at: 'plan' }).`,
    inputSchema: { item_id: z.number().int(), status: enumOf(PLAN_STATUS).optional(), progress_notes: z.string().optional() },
  }, async (a) => {
    if (!DB.updatePlanItem(a.item_id, a.status ?? null, a.progress_notes ?? null)) return json({ ok: false, error: `no plan item ${a.item_id} — list via look({ at: 'plan' }).` });
    const out: Record<string, unknown> = { ok: true, item_id: a.item_id, plan: DB.planCounts() };
    if (a.status === "done") out.note = "closed — re-assess the dimension it addressed (assess_competency) and re-run look({ at: 'jobs', scope: 'relevant' }); a higher band may now be in reach.";
    return json(out);
  });

  // ── cover letter (judgment) ────────────────────────────────────────────────
  server.registerTool("record_cover_letter", {
    description: "Persist the cover letter + talking points for a role. → personal. Mode: cover_letter — lead with a real angle, no invented experience. Gated on the verified assessment: write to the floor, don't assert seniority the user hasn't demonstrated. Read back via look({ at: 'packet' }).",
    inputSchema: { job_id: z.number().int(), content: z.string().min(1), talking_points: z.array(z.string()).optional() },
  }, async (a) => {
    const job = DB.getJob(a.job_id);
    if (!job) return noJob(a.job_id);
    DB.recordCoverLetter(a.job_id, a.content, a.talking_points ?? []);
    const missing: string[] = [];
    if (!DB.getMasterResume()?.content) missing.push("master_resume");
    if (!DB.getRoleFit(a.job_id)) missing.push("role_fit");
    if (job.grade_seniority == null) missing.push("job_grade");
    const s = readJourneyState();
    const notes: string[] = [];
    if (missing.length) notes.push(`missing ${missing.join(", ")} — the letter may be ungrounded; don't fabricate.`);
    if (!s.dimensions.verified || (s.assessment?.confidence && s.assessment.confidence !== "high")) notes.push(`the assessment is ${s.assessment?.confidence ?? "unrecorded"}${s.dimensions.verified ? "" : "/unverified"} — claim only what's demonstrated (write to floor ${s.assessment?.floor ?? "?"}).`);
    const out: Record<string, unknown> = { ok: true, job_id: a.job_id, next: "when the user applies, track it with record_application." };
    if (notes.length) out.note = "saved — " + notes.join(" ");
    return json(out);
  });

  // ── application tracking (personal, mechanical) ────────────────────────────
  server.registerTool("record_application", {
    description: `Track the user's application (they apply; this records it). → personal. status: ${APP_STATUS.join(" | ")}. Optional applied_at / next_action / next_action_at / notes: omit to preserve, null to clear, text (including empty strings) is stored verbatim. Status transitions journal as applied; same-status metadata changes journal as application_updated with from/to values. Exact repeats are no-ops. Returns changed / transitioned / changed_fields. updated_at marks only status transitions, so metadata edits don't replay rejection signals. Read the funnel via look({ at: 'applications' }) and the journal via look({ at: 'history' }).`,
    inputSchema: { job_id: z.number().int(), status: enumOf(APP_STATUS), applied_at: z.string().nullable().optional(), next_action: z.string().nullable().optional(), next_action_at: z.string().nullable().optional(), notes: z.string().nullable().optional() },
  }, async (a) => {
    if (!DB.getJob(a.job_id)) return noJob(a.job_id);
    const result = DB.recordApplication(a.job_id, { status: a.status, applied_at: a.applied_at, next_action: a.next_action, next_action_at: a.next_action_at, notes: a.notes });
    const out: Record<string, unknown> = { ok: true, job_id: a.job_id, status: a.status, ...result, pipeline: DB.applicationCounts() };
    if (a.status === "rejected" && result.transitioned) out.note = "rejection recorded — signal, not verdict: orient now routes to upskill until the plan absorbs the gaps it exposes.";
    return json(out);
  });

  server.registerTool("register_board", {
    description:
      "Register or update one company job board in the ledger. Does not fetch, seed, apply, or send. " +
      "board_type is an open slug. gather fetches greenhouse, ashby, lever, workable, workday, and smartrecruiters. custom and browser stay manual. " +
      "workday board_key is tenant.wdN.site, or pass a myworkdayjobs.com careers URL and the key is parsed. smartrecruiters board_key is the company identifier. " +
      "The same type+key updates mutable fields (name, domain, careers URL, tags, notes, active) and does not rewrite events. " +
      "A registered board gets a check event automatically the next time gather fetch_jobs pulls that slug. Ships with no companies.",
    inputSchema: {
      name: z.string(),
      board_type: z.string(),
      board_key: z.string().nullable().optional(),
      domain: z.string().nullable().optional(),
      careers_url: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(),
      notes: z.string().nullable().optional(),
      active: z.boolean().optional(),
    },
  }, async (a) => {
    try {
      const saved = DB.registerBoard(a);
      return json({ ok: true, ...saved, stats: DB.boardStats(saved.id) });
    } catch (e) { return json({ ok: false, error: errMsg(e) }); }
  });

  server.registerTool("record_board_event", {
    description:
      "Append one ledger event for a registered board. Append-only: events are never updated or deleted. " +
      "kind is a short snake_case slug. Known kinds: board_checked (manual or browser; method defaults to manual), posting_seen, posting_gone, posting_returned, application_submitted, application_status, note, contact. " +
      "Other kinds are stored and show up in the feed. Pass job_id only when that job already exists; it is copied onto the event. Does not fetch or send.",
    inputSchema: {
      board_id: z.number().int(),
      kind: z.string(),
      summary: z.string(),
      payload: z.record(z.string(), z.unknown()).optional(),
      job_id: z.number().int().optional(),
      ts: z.string().optional(),
    },
  }, async (a) => {
    try {
      const event = DB.appendBoardEvent(a);
      return json({ ok: true, event, stats: DB.boardStats(a.board_id) });
    } catch (e) { return json({ ok: false, error: errMsg(e) }); }
  });

  server.registerTool("detect_board", {
    description:
      "Detect which public ATS a careers URL uses and return the board identifier. " +
      "Recognizes greenhouse, ashby, lever, workable, workday (tenant + wd number + site), and smartrecruiters. " +
      "Anything else is custom — register it as browser if a person will open the page. Does not fetch, register, apply, or send. LinkedIn hosts are rejected.",
    inputSchema: { url: z.string() },
  }, async (a) => {
    try { return json({ ok: true, ...detectBoard(a.url) }); }
    catch (e) { return json({ ok: false, error: errMsg(e) }); }
  });

  // ── gather: the one door to the outside world (sync cut in v2) ─────────────
  server.registerTool("gather", {
    description:
      "Fetch public data and persist it. dry_run:true previews with no requests or writes; omit dry_run (or pass false) to run. " +
      "step: 'find_companies' (resolve ATS slugs for named companies, or read the local curated roster; provider:'theirstack' is opt-in via THEIRSTACK_API_KEY), " +
      "'fetch_jobs' (pull live Greenhouse, Ashby, Lever, Workable, Workday, or SmartRecruiters boards; a registered ledger board records a check event), " +
      "'ingest_portfolio' (public GitHub repos). " +
      "Workday keys are tenant.wdN.site. SmartRecruiters keys are the company identifier. " +
      "JOBBOT_NETWORK=off refuses live calls unless an offline adapter was injected. LinkedIn hosts are refused. Nothing is auto-applied and no message is sent.",
    inputSchema: {
      step: enumOf(["find_companies", "fetch_jobs", "ingest_portfolio"]),
      companies: z.array(z.object({ name: z.string(), domain: z.string().optional(), ats_platform: enumOf([...FETCHABLE_ATS_PLATFORMS]).optional(), ats_slug: z.string().optional() })).optional(),
      titles: z.array(z.string()).optional(), technologies: z.array(z.string()).optional(),
      seniority: enumOf(["junior", "mid_level", "senior", "staff", "c_level"]).optional(),
      locations: z.array(z.string()).optional(), posted_within_days: z.number().int().positive().optional(),
      provider: z.string().optional(), max_credits: z.number().int().positive().optional(), confirm: z.boolean().optional(), niche: z.string().optional(),
      ats_platform: enumOf([...FETCHABLE_ATS_PLATFORMS]).optional(), ats_slug: z.string().optional(), company_id: z.number().int().optional(),
      github_handle: z.string().optional(), include_forks: z.boolean().optional(), enrich_max: z.number().int().nonnegative().optional(),
      dry_run: z.boolean().optional(), limit: z.number().int().positive().optional(),
    },
  }, async (a) => {
    switch (a.step) {
      case "find_companies": return findCompanies(a);
      case "fetch_jobs": return fetchJobs(a);
      case "ingest_portfolio": return ingestPortfolio(a);
      default: return json({ ok: false, error: `unknown gather step '${a.step}'` });
    }
  });
}

// ── find_companies orchestration ─────────────────────────────────────────────
interface FindArgs {
  titles?: string[]; technologies?: string[]; seniority?: string; locations?: string[]; posted_within_days?: number;
  companies?: { name: string; domain?: string; ats_platform?: string; ats_slug?: string }[];
  provider?: string; max_credits?: number; confirm?: boolean; dry_run?: boolean; limit?: number;
}
interface FindDeps { ctx?: ProviderContext; resolve?: typeof resolveAts }

async function persistDiscovered(companies: DiscoveredCompany[], resolve: typeof resolveAts) {
  let inserted = 0, resolved = 0, unresolved = 0, skipped = 0;
  for (const c of companies) {
    if (c.ats_platform && c.ats_slug) {
      const up = DB.upsertCompany({ name: c.name, domain: c.domain, source: c.source, tags: c.tags, ats_platform: c.ats_platform, ats_slug: c.ats_slug });
      if (up.inserted) inserted++; resolved++; continue;
    }
    const hit = await resolve({ name: c.name, domain: c.domain });
    if (hit) {
      const up = DB.upsertCompany({ name: c.name, domain: c.domain, source: c.source, tags: c.tags, ats_platform: hit.platform, ats_slug: hit.slug });
      if (up.inserted) inserted++; resolved++;
    } else if (c.domain) {
      const up = DB.upsertCompany({ name: c.name, domain: c.domain, source: c.source, tags: c.tags });
      if (up.inserted) inserted++; DB.bumpResolveAttempt(up.id); unresolved++;
    } else skipped++;
  }
  return { inserted, resolved, unresolved, skipped };
}

const nextNote = () => "resolved companies are ready — pull their live boards with gather({ step: 'fetch_jobs' }).";

const networkDisabled = () => json({ ok: false, code: "network_disabled", error: NETWORK_DISABLED });
const preview = (step: string, input: unknown) => json({
  ok: true, dry_run: true, step, preview: input,
  note: "Local preview only: no requests, credential reads, or writes. Omit dry_run or pass dry_run:false to fetch. JOBBOT_NETWORK=off keeps a run hermetic.",
});
const needsResolve = (companies: { ats_platform?: string | null; ats_slug?: string | null }[]) =>
  companies.some((c) => !(c.ats_platform && c.ats_slug));

export async function findCompanies(a: FindArgs, deps: FindDeps = {}) {
  if (a.dry_run === true) return preview("find_companies", a);
  const resolve = deps.resolve ?? resolveAts;
  if (a.companies?.length) {
    if (!networkEnabled() && !deps.resolve && needsResolve(a.companies)) return networkDisabled();
    const discovered: DiscoveredCompany[] = a.companies.map((c) => ({
      name: c.name, domain: c.domain ?? null, tags: [], source: "manual",
      ats_platform: (c.ats_platform && c.ats_slug) ? c.ats_platform : null,
      ats_slug: (c.ats_platform && c.ats_slug) ? c.ats_slug : null,
    }));
    const persisted = await persistDiscovered(discovered, resolve);
    const pinned = a.companies.filter((c) => c.ats_platform && c.ats_slug).length;
    const out: Record<string, unknown> = { ok: true, mode: "on_demand", credits_spent: 0, discovered: discovered.length, persisted, catalog: readJourneyState().catalog, next: nextNote() };
    if (pinned) out.note = `${pinned} board(s) pinned (slug-complete; gather('fetch_jobs') confirms them).`;
    return json(out);
  }
  const providerName = a.provider ?? Object.keys(PROVIDERS)[0];
  const provider = PROVIDERS[providerName];
  if (!provider) return json({ ok: false, error: `unknown provider '${providerName}' — available: ${Object.keys(PROVIDERS).join(", ")}` });
  if (provider.requiresKey && !networkEnabled() && (!deps.ctx?.fetchFn || !deps.resolve)) return networkDisabled();
  const ctx = { ...(networkEnabled() ? { apiKey: process.env.THEIRSTACK_API_KEY } : {}), ...deps.ctx };
  if (!provider.available(ctx)) return json({ ok: false, error: `provider '${provider.name}' is unavailable${provider.requiresKey ? " — set THEIRSTACK_API_KEY to opt in. With JOBBOT_NETWORK=off, pass an injected offline context instead. The free curated roster and pinned companies need no key." : "."}` });
  const q: DiscoverQuery = { titles: a.titles, technologies: a.technologies, seniority: a.seniority ?? null, locations: a.locations, posted_within_days: a.posted_within_days, limit: a.limit };
  let est; try { est = await provider.estimate(q, ctx); } catch (e) { return json({ ok: false, error: `discovery pre-flight failed: ${errMsg(e)}` }); }
  const ceiling = a.max_credits ?? MAX_CREDITS_PER_RUN;
  if (est.projected_credits > ceiling && !a.confirm) return json({ ok: false, confirmation_required: true, provider: provider.name, estimate: est, ceiling, note: `projected ~${est.projected_credits} credits exceeds the ceiling (${ceiling}). Re-run with confirm:true, or lower limit / raise max_credits.` });
  let result; try { result = await provider.discover(q, ctx); } catch (e) { return json({ ok: false, error: `discovery failed: ${errMsg(e)}` }); }
  if (!networkEnabled() && !deps.resolve && needsResolve(result.companies)) return networkDisabled();
  const persisted = await persistDiscovered(result.companies, resolve);
  const out: Record<string, unknown> = { ok: true, provider: provider.name, estimate: est, credits_spent: result.records_billed, discovered: result.companies.length, persisted, catalog: readJourneyState().catalog, next: nextNote() };
  if (result.companies.length === 0 && provider.name === "curated") {
    out.note = networkEnabled()
      ? "the curated seed roster is empty. Name companies directly — gather({ step: 'find_companies', companies: [{ name, domain }] }) — or add to seeds/companies.json, or set THEIRSTACK_API_KEY."
      : "the curated seed roster is empty. Preview company inputs, or configure local slug-complete seeds; live discovery remains disabled (JOBBOT_NETWORK=off).";
  }
  return json(out);
}

// ── fetch_jobs orchestration ──────────────────────────────────────────────────
interface FetchArgs { dry_run?: boolean; ats_platform?: string; ats_slug?: string; company_id?: number; limit?: number }
interface FetchTarget { company_id: number; platform: AtsPlatform; slug: string; name: string }
interface FetchDeps { fetchBoardFn?: typeof fetchBoard; sleep?: (ms: number) => Promise<void>; politeDelayMs?: number }
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function rememberCheck(entry: Record<string, unknown>, input: Parameters<typeof DB.recordBoardFetch>[0]): void {
  try {
    const ledger = DB.recordBoardFetch(input);
    if (ledger.recorded) entry.ledger = ledger;
  } catch (e) { entry.ledger_error = errMsg(e); }
}

export async function fetchJobs(a: FetchArgs, deps: FetchDeps = {}) {
  if (a.dry_run === true) return preview("fetch_jobs", a);
  if (!networkEnabled() && !deps.fetchBoardFn) return networkDisabled();
  const fetchBoardFn = deps.fetchBoardFn ?? fetchBoard;
  const sleep = deps.sleep ?? realSleep;
  const politeDelayMs = deps.politeDelayMs ?? 1000;
  const targets: FetchTarget[] = [];
  if (a.ats_platform && a.ats_slug) {
    const platform = a.ats_platform as AtsPlatform;
    const existing = DB.getCompanyByAts(platform, a.ats_slug);
    const id = existing?.id ?? DB.upsertCompany({ name: a.ats_slug, ats_platform: platform, ats_slug: a.ats_slug, source: "manual" }).id;
    targets.push({ company_id: id, platform, slug: a.ats_slug, name: existing?.name ?? a.ats_slug });
  } else if (a.company_id !== undefined) {
    const c = DB.db.prepare("SELECT id, name, ats_platform, ats_slug FROM companies WHERE id=?").get(a.company_id) as { id: number; name: string; ats_platform: string | null; ats_slug: string | null } | undefined;
    if (!c) return json({ ok: false, error: `no company ${a.company_id}.` });
    if (!c.ats_platform || !c.ats_slug) return json({ ok: false, error: `company ${a.company_id} (${c.name}) has no ATS slug — resolve via gather('find_companies') first.` });
    targets.push({ company_id: c.id, platform: c.ats_platform as AtsPlatform, slug: c.ats_slug, name: c.name });
  } else {
    for (const c of DB.getResolvedCompanies(a.limit ?? 25)) targets.push({ company_id: c.id, platform: c.ats_platform as AtsPlatform, slug: c.ats_slug!, name: c.name });
  }
  if (targets.length === 0) return json({ ok: true, boards_fetched: 0, note: "no resolved companies — discover some via gather('find_companies'), or target a board with ats_platform + ats_slug." });

  const totals = { inserted: 0, updated: 0, closed: 0 };
  const per_company: Record<string, unknown>[] = [];
  let unreachable = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (i > 0 && politeDelayMs > 0) await sleep(politeDelayMs);
    let board: Awaited<ReturnType<typeof fetchBoard>> = null;
    let failure: string | undefined;
    try { board = await fetchBoardFn(t.platform, t.slug); }
    catch (e) { board = null; failure = errMsg(e); }
    if (board === null) {
      unreachable++;
      const entry: Record<string, unknown> = { company_id: t.company_id, name: t.name, platform: t.platform, slug: t.slug, unreachable: true, error: failure ?? "unreachable" };
      rememberCheck(entry, { board_type: t.platform, board_key: t.slug, company_id: t.company_id, unreachable: true, error: failure, seen: 0, updated: 0, new_postings: [], returned_postings: [], closed_postings: [] });
      per_company.push(entry);
      continue;
    }
    const r = DB.upsertJobs(t.company_id, board);
    totals.inserted += r.inserted; totals.updated += r.updated; totals.closed += r.closed;
    const entry: Record<string, unknown> = { company_id: t.company_id, name: t.name, platform: t.platform, slug: t.slug, ...r };
    rememberCheck(entry, {
      board_type: t.platform, board_key: t.slug, company_id: t.company_id, seen: r.seen, updated: r.updated,
      new_postings: r.new_postings, returned_postings: r.returned_postings, closed_postings: r.closed_postings,
    });
    per_company.push(entry);
  }
  return json({
    ok: true, boards_fetched: targets.length - unreachable, unreachable, jobs: totals, per_company, catalog: readJourneyState().catalog,
    next: totals.inserted + totals.updated > 0 ? "grade the new jobs — look({ at: 'jobs', scope: 'worklist' }), then grade_job." : "no live postings found (or all unreachable).",
  });
}

// ── ingest_portfolio orchestration (with verification signals) ────────────────
const ENRICH_MAX_DEFAULT = 20;
interface IngestArgs { dry_run?: boolean; github_handle?: string; include_forks?: boolean; enrich_max?: number }
interface IngestDeps { fetchReposFn?: typeof fetchUserRepos; enrichFn?: typeof enrichRepo; token?: string }

export async function ingestPortfolio(a: IngestArgs, deps: IngestDeps = {}) {
  if (a.dry_run === true) return preview("ingest_portfolio", a);
  if (!networkEnabled() && (!deps.fetchReposFn || !deps.enrichFn)) return networkDisabled();
  const s = readJourneyState();
  if (s.profile?.no_github) return json({ ok: false, error: "the user opted out of GitHub (no_github) — coach from the interview + described projects; absence is not penalized." });
  const handle = a.github_handle ?? s.profile?.github_handle ?? undefined;
  if (!handle) return json({ ok: false, error: "no github_handle — pass one, or capture it via capture_profile." });
  const token = deps.token !== undefined ? deps.token : (!deps.fetchReposFn && !deps.enrichFn && networkEnabled() ? process.env.GITHUB_TOKEN : undefined);
  const fetchReposFn = deps.fetchReposFn ?? fetchUserRepos;
  let repos: RepoFacts[];
  try { repos = await fetchReposFn(handle, { token }); } catch (e) { return json({ ok: false, error: `GitHub fetch failed: ${errMsg(e)}` }); }
  const kept = a.include_forks ? repos : repos.filter((r) => !r.is_fork);
  const enrichFn = deps.enrichFn ?? enrichRepo;
  const enrichMax = a.enrich_max ?? ENRICH_MAX_DEFAULT;
  const toEnrich = kept.slice(0, enrichMax);
  for (const r of toEnrich) {
    const e = await enrichFn(r.repo, { token, handle });
    r.languages = e.languages; r.readme_excerpt = e.readme_excerpt; r.verify = e.verify;
  }
  DB.replacePortfolio(kept.map((r) => ({ repo: r.repo, facts: r })));
  if (a.github_handle && a.github_handle !== s.profile?.github_handle) DB.upsertProfile({ github_handle: a.github_handle });
  const verified = toEnrich.filter((r) => r.verify);
  const max_stars = kept.reduce((m, r) => Math.max(m, r.stars), 0);
  const verification = {
    enriched_with_signals: verified.length,
    solo_projects: verified.filter((r) => r.verify!.solo).length,
    low_traction: kept.filter((r) => r.stars < 2 && r.forks < 2).length,
    self_applied_badges: verified.reduce((n, r) => n + r.verify!.self_applied_badges, 0),
    max_stars,
    not_sole_author: verified.filter((r) => r.verify!.authored_share != null && r.verify!.authored_share < 0.5).length,
  };
  return json({
    ok: true, github_handle: handle, fetched: repos.length, kept: kept.length, enriched: toEnrich.length,
    forks_skipped: a.include_forks ? 0 : repos.length - kept.length,
    top_by_recent: kept.slice(0, 5).map((r) => ({ repo: r.repo, languages: r.languages ?? (r.language ? [r.language] : []), stars: r.stars, pushed_at: r.pushed_at, solo: r.verify?.solo ?? null })),
    verification, portfolio_count: DB.counts().portfolio,
    next: kept.length === 0
      ? "no public repos found (or all forks). Coach from the interview + described projects — no portfolio penalty."
      : `read look({ at: 'portfolio' }) — but VERIFY before grading: mostly-solo, low-traction repos (max_stars=${max_stars}) are UNVERIFIED until a competency interview confirms the user built and understands them. Assess skeptically; claimed ≠ demonstrated.${toEnrich.length < kept.length ? ` (${kept.length - toEnrich.length} beyond enrich_max kept at basic facts.)` : ""}`,
  });
}
