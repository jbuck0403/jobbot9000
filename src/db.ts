// db.ts — the SQLite layer and the ONLY code that writes the database.
// Two planes: `personal` (local always, never shared) and `catalog` (public market
// data). Tools call these helpers; the agent never issues a raw write. v2: the model is
// the readiness LOOP (profile⇅desires → match → interview → upskill → apply → re-match),
// state is multi-dimensional and DURABLE — versioned history + an append-only journal so a
// search that spans months never loses progress and any new session resumes from the DB.
import Database from "./sqlite.js";
import { linkedInHost } from "./network.js";
import { prepareStorage } from "./storage.js";
import { resolveInterviewRequest, type InterviewRequest, type InterviewError } from "./interview.js";

// All personal state and SQLite sidecars stay in .private. Legacy state is never
// opened, moved or deleted implicitly; configure an explicit private state root.
const storage = prepareStorage();
export const privateStorageRoot = storage.privateDir;
export const db = new Database(storage.databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000"); // wait (don't throw SQLITE_BUSY) if another session holds the write lock

// The competency/seniority ladder — the single canonical order, mirrored by the grading
// modes (modes/*.json). Index = rank. Kept here too because db derives the overall band.
export const LADDER = ["intern", "junior", "mid", "senior", "staff", "principal"] as const;
const CONFIDENCE_ORDER = ["low", "medium", "high"] as const;
// The four competency dimensions (Leaner-4). The profile carries one row per dimension.
export const DIMENSIONS = ["technical_depth", "system_design", "communication", "ownership"] as const;

db.exec(`
-- ── personal plane — local always; never shared ──────────────────────────
CREATE TABLE IF NOT EXISTS profile (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  target_role   TEXT,
  target_niche  TEXT,
  location_pref TEXT,
  github_handle TEXT,
  desires_json  TEXT,                                 -- {role_types, domains, locations, comp_floor, work_style, freetext, priorities} — evolvable
  no_resume     INTEGER NOT NULL DEFAULT 0,
  no_github     INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS master_resume (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  content    TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS portfolio_projects (
  repo       TEXT PRIMARY KEY,                         -- github: "owner/name"; manual: a bare name (no slash)
  facts_json TEXT,
  source     TEXT NOT NULL DEFAULT 'github',           -- 'github' (ingested) | 'manual' (described, unverified)
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS portfolio_relevance (       -- a project's relevance to the target role (judgment)
  repo              TEXT PRIMARY KEY,
  relevance         TEXT NOT NULL,                      -- strong | moderate | weak
  demonstrates_json TEXT,
  gaps_json         TEXT,
  rationale         TEXT,
  graded_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
-- The multi-dimensional competency profile (replaces the single-ladder assessment). One row
-- per dimension; the overall band is DERIVED (deriveBand). Absence of evidence → low
-- CONFIDENCE, never a low level (fair to candidates with no public portfolio).
CREATE TABLE IF NOT EXISTS competency_profile (
  dimension     TEXT PRIMARY KEY,                       -- one of DIMENSIONS
  level         TEXT NOT NULL,                          -- one of LADDER
  confidence    TEXT NOT NULL,                          -- low | medium | high (high needs demonstrated/corroborated)
  evidence_json TEXT,                                   -- [{ claim, provenance, verified }]
  rationale     TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS interviews (                 -- a competency or role-fit interview SESSION (resumable)
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  type             TEXT NOT NULL,                        -- competency | role_fit
  job_id           INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'in_progress',  -- in_progress | complete
  verified_ceiling TEXT,                                 -- highest level the interview supports (caps an over-claim)
  summary          TEXT,
  started_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS interview_items (            -- per-question: answer + grounded exemplar + the delta
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id  INTEGER NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  dimension     TEXT,                                    -- which competency (or null)
  claim         TEXT,                                    -- claim probed (or null)
  question      TEXT NOT NULL,
  answer_summary TEXT,
  exemplar      TEXT,                                    -- role+rubric-grounded "what a great candidate would say"
  score         TEXT,                                    -- weak | adequate | strong
  ownership     TEXT,                                    -- sole_author | contributor | user | observer
  understanding TEXT,                                    -- deep | working | shallow | cannot_explain
  delta_notes   TEXT,                                    -- the gap → upskilling target
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS upskilling_plan (            -- the tracked plan: learn / resume / build
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  gap            TEXT NOT NULL,                           -- dimension or skill being closed
  type           TEXT NOT NULL,                           -- learn | resume | build
  spec           TEXT NOT NULL,                           -- the concrete recommendation
  market_demand  TEXT,                                    -- which in-demand skill it closes (grounding)
  status         TEXT NOT NULL DEFAULT 'suggested',       -- suggested | in_progress | done
  progress_notes TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS role_fit (                   -- the user's fit on a job (judgment, personal)
  job_id           INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  band             TEXT NOT NULL,                         -- over | exact | under
  dim_deltas_json  TEXT,                                  -- per-dimension gap vs the role
  desire_alignment TEXT,                                  -- strong | mixed | weak (vs the user's desires)
  gaps_json        TEXT,
  rationale        TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS cover_letters (              -- the per-role deliverable
  job_id              INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  content             TEXT NOT NULL,
  talking_points_json TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS applications (               -- the user's application to a job (personal)
  job_id         INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  status         TEXT NOT NULL,                           -- interested | applied | interviewing | offer | rejected | withdrawn
  applied_at     TEXT,
  next_action    TEXT,
  next_action_at TEXT,
  notes          TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (                     -- APPEND-ONLY journal — the narrative timeline; never mutated/pruned
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL DEFAULT (datetime('now')),
  kind    TEXT NOT NULL,                                  -- assessed | interviewed | graded_job | role_fit | planned | plan_progress | resume_revised | applied | application_updated | profile | matched
  summary TEXT NOT NULL,
  ref     TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ── catalog plane — public market data (no longer synced) ─────────────────
CREATE TABLE IF NOT EXISTS companies (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  name                    TEXT NOT NULL,
  domain                  TEXT,
  tags                    TEXT,
  source                  TEXT,
  ats_platform            TEXT,
  ats_slug                TEXT,
  resolved                INTEGER NOT NULL DEFAULT 1,
  resolve_attempts        INTEGER NOT NULL DEFAULT 0,
  last_resolve_attempt_at TEXT,
  added_at                TEXT NOT NULL DEFAULT (datetime('now')),
  last_fetched_at         TEXT,
  UNIQUE (ats_platform, ats_slug)
);
CREATE INDEX IF NOT EXISTS idx_companies_domain ON companies(domain);
CREATE TABLE IF NOT EXISTS jobs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_url          TEXT NOT NULL,
  title               TEXT,
  location            TEXT,
  remote              INTEGER,
  comp_min            REAL,
  comp_max            REAL,
  raw_json            TEXT,
  grade_seniority     TEXT,
  grade_market_signal TEXT,
  graded_at           TEXT,
  fetched_at          TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at        TEXT NOT NULL DEFAULT (datetime('now')),
  still_live          INTEGER NOT NULL DEFAULT 1,
  UNIQUE (company_id, source_url)
);
CREATE TABLE IF NOT EXISTS job_skills (
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  skill  TEXT NOT NULL,
  kind   TEXT NOT NULL CHECK (kind IN ('required','preferred')),
  UNIQUE (job_id, skill, kind)
);
`);

// ── guarded migrations — additive columns for DBs created before they existed. No-ops on a
// fresh DB. ALTER ADD COLUMN is the only safe in-place change.
function ensureColumn(table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn("companies", "resolve_attempts", "resolve_attempts INTEGER NOT NULL DEFAULT 0");
ensureColumn("companies", "last_resolve_attempt_at", "last_resolve_attempt_at TEXT");
ensureColumn("portfolio_projects", "source", "source TEXT NOT NULL DEFAULT 'github'");
ensureColumn("profile", "desires_json", "desires_json TEXT");

// ── the journal (durability) ────────────────────────────────────────────────
// Every meaningful step appends here so the months-long journey is always reconstructable.
// Judgment writes call this internally; it's also the timeline look(at:'history') reads.
export interface EventRow { id: number; ts: string; kind: string; summary: string; ref: string | null }
export const logEvent = (kind: string, summary: string, ref?: string | null): void => {
  db.prepare("INSERT INTO events (kind, summary, ref) VALUES (?, ?, ?)").run(kind, summary, ref ?? null);
};
export const getEvents = (limit = 50): EventRow[] =>
  db.prepare("SELECT id, ts, kind, summary, ref FROM events ORDER BY id DESC LIMIT ?").all(limit) as EventRow[];

// ── personal accessors ─────────────────────────────────────────────────────
export interface Desires {
  role_types?: string[]; domains?: string[]; locations?: string[];
  comp_floor?: number | null; work_style?: string | null; freetext?: string | null; priorities?: string[];
}
export interface Profile {
  target_role: string | null; target_niche: string | null; location_pref: string | null;
  github_handle: string | null; desires: Desires | null; no_resume: number; no_github: number;
}
export const getProfile = (): Profile | undefined => {
  const r = db.prepare("SELECT target_role, target_niche, location_pref, github_handle, desires_json, no_resume, no_github FROM profile WHERE id = 1")
    .get() as (Omit<Profile, "desires"> & { desires_json: string | null }) | undefined;
  if (!r) return undefined;
  const { desires_json, ...rest } = r;
  return { ...rest, desires: desires_json ? JSON.parse(desires_json) : null };
};

export function upsertProfile(p: Partial<Omit<Profile, "desires">> & { desires?: Desires | null }): void {
  const cur = getProfile();
  const desires = p.desires !== undefined
    ? (p.desires ? { ...(cur?.desires ?? {}), ...p.desires } : null) // merge desires, don't clobber
    : (cur?.desires ?? null);
  const m = {
    target_role: p.target_role !== undefined ? p.target_role : cur?.target_role ?? null,
    target_niche: p.target_niche !== undefined ? p.target_niche : cur?.target_niche ?? null,
    location_pref: p.location_pref !== undefined ? p.location_pref : cur?.location_pref ?? null,
    github_handle: p.github_handle !== undefined ? p.github_handle : cur?.github_handle ?? null,
    no_resume: p.no_resume !== undefined ? p.no_resume : cur?.no_resume ?? 0,
    no_github: p.no_github !== undefined ? p.no_github : cur?.no_github ?? 0,
    desires_json: desires ? JSON.stringify(desires) : null,
  };
  db.prepare(
    `INSERT INTO profile (id, target_role, target_niche, location_pref, github_handle, desires_json, no_resume, no_github, updated_at)
     VALUES (1, @target_role, @target_niche, @location_pref, @github_handle, @desires_json, @no_resume, @no_github, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       target_role=excluded.target_role, target_niche=excluded.target_niche,
       location_pref=excluded.location_pref, github_handle=excluded.github_handle,
       desires_json=excluded.desires_json, no_resume=excluded.no_resume, no_github=excluded.no_github,
       updated_at=datetime('now')`,
  ).run(m);
}

export const getMasterResume = (): { content: string; updated_at: string } | undefined =>
  db.prepare("SELECT content, updated_at FROM master_resume WHERE id = 1").get() as { content: string; updated_at: string } | undefined;
// Set the master resume. A `rationale` marks a COACHED revision (vs. the user's own wholesale
// edit) and is journaled to events — that journal IS the resume-revision history.
export const setMasterResume = (content: string, rationale?: string | null): void => {
  db.prepare(
    `INSERT INTO master_resume (id, content, updated_at) VALUES (1, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET content=excluded.content, updated_at=datetime('now')`,
  ).run(content);
  if (rationale !== undefined) logEvent("resume_revised", rationale ?? "resume revised");
};

// ── portfolio ────────────────────────────────────────────────────────────────
export interface PortfolioProject { repo: string; facts_json: string | null; source: string; fetched_at: string }
export const getPortfolio = (): PortfolioProject[] =>
  db.prepare("SELECT repo, facts_json, source, fetched_at FROM portfolio_projects ORDER BY fetched_at DESC, repo").all() as PortfolioProject[];

export function replacePortfolio(projects: { repo: string; facts: unknown }[]): number {
  const tx = db.transaction((): number => {
    db.prepare("DELETE FROM portfolio_projects WHERE source='github'").run();
    const ins = db.prepare("INSERT INTO portfolio_projects (repo, facts_json, source) VALUES (?, ?, 'github')");
    for (const p of projects) ins.run(p.repo, JSON.stringify(p.facts ?? null));
    const keep = [...projects.map((p) => p.repo), ...(db.prepare("SELECT repo FROM portfolio_projects WHERE source='manual'").all() as { repo: string }[]).map((r) => r.repo)];
    if (keep.length === 0) db.prepare("DELETE FROM portfolio_relevance").run();
    else db.prepare(`DELETE FROM portfolio_relevance WHERE repo NOT IN (${keep.map(() => "?").join(",")})`).run(...keep);
    return projects.length;
  });
  return tx();
}

export function addPortfolioProject(name: string, facts: unknown): void {
  db.prepare(
    `INSERT INTO portfolio_projects (repo, facts_json, source, fetched_at) VALUES (?, ?, 'manual', datetime('now'))
     ON CONFLICT(repo) DO UPDATE SET facts_json=excluded.facts_json, source='manual', fetched_at=datetime('now')`,
  ).run(name, JSON.stringify(facts ?? null));
}

export interface PortfolioRelevance {
  repo: string; relevance: string; demonstrates: unknown[]; gaps: unknown[]; rationale: string | null; graded_at: string;
}
export const getPortfolioRelevance = (repo: string): PortfolioRelevance | undefined => {
  const r = db.prepare("SELECT repo, relevance, demonstrates_json, gaps_json, rationale, graded_at FROM portfolio_relevance WHERE repo = ?")
    .get(repo) as { repo: string; relevance: string; demonstrates_json: string | null; gaps_json: string | null; rationale: string | null; graded_at: string } | undefined;
  return r ? { repo: r.repo, relevance: r.relevance, demonstrates: r.demonstrates_json ? JSON.parse(r.demonstrates_json) : [], gaps: r.gaps_json ? JSON.parse(r.gaps_json) : [], rationale: r.rationale, graded_at: r.graded_at } : undefined;
};
export const setPortfolioRelevance = (repo: string, relevance: string, demonstrates: unknown, gaps: unknown, rationale: string): void => {
  db.prepare(
    `INSERT INTO portfolio_relevance (repo, relevance, demonstrates_json, gaps_json, rationale, graded_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(repo) DO UPDATE SET relevance=excluded.relevance, demonstrates_json=excluded.demonstrates_json,
       gaps_json=excluded.gaps_json, rationale=excluded.rationale, graded_at=datetime('now')`,
  ).run(repo, relevance, JSON.stringify(demonstrates ?? []), JSON.stringify(gaps ?? []), rationale);
};

// ── competency profile + derived band (the assessment, multi-dimensional) ────
export interface Competency { dimension: string; level: string; confidence: string; evidence: unknown; rationale: string | null; updated_at: string }
export const getCompetencyProfile = (): Competency[] =>
  (db.prepare("SELECT dimension, level, confidence, evidence_json, rationale, updated_at FROM competency_profile").all() as
    { dimension: string; level: string; confidence: string; evidence_json: string | null; rationale: string | null; updated_at: string }[])
    .map((r) => ({ dimension: r.dimension, level: r.level, confidence: r.confidence, evidence: r.evidence_json ? JSON.parse(r.evidence_json) : [], rationale: r.rationale, updated_at: r.updated_at }));

// Set one dimension's judgment and journal it (the 'assessed' events ARE the fitness
// trajectory — read them via look(history)). The overall band is derived, not cached.
export function setCompetency(dimension: string, level: string, confidence: string, evidence: unknown, rationale: string): void {
  db.prepare(
    `INSERT INTO competency_profile (dimension, level, confidence, evidence_json, rationale, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(dimension) DO UPDATE SET level=excluded.level, confidence=excluded.confidence,
       evidence_json=excluded.evidence_json, rationale=excluded.rationale, updated_at=datetime('now')`,
  ).run(dimension, level, confidence, JSON.stringify(evidence ?? []), rationale);
  logEvent("assessed", `${dimension} → ${level} (confidence ${confidence})`, dimension);
}

// Derive the overall band from the dimensions: band = conservative (floor of the mean rank),
// floor = the lowest dimension, overall confidence = the LOWEST (skeptical — a profile is only
// as trustworthy as its weakest-supported part). null until at least one dimension is set.
export interface DerivedBand { band: string; floor: string; confidence: string; dims: number }
export function deriveBand(profile: Competency[] = getCompetencyProfile()): DerivedBand | null {
  if (profile.length === 0) return null;
  const idxs = profile.map((d) => LADDER.indexOf(d.level as typeof LADDER[number])).filter((i) => i >= 0);
  if (idxs.length === 0) return null;
  const band = LADDER[Math.floor(idxs.reduce((a, b) => a + b, 0) / idxs.length)];
  const floor = LADDER[Math.min(...idxs)];
  const confIdx = Math.min(...profile.map((d) => Math.max(0, CONFIDENCE_ORDER.indexOf(d.confidence as typeof CONFIDENCE_ORDER[number]))));
  return { band, floor, confidence: CONFIDENCE_ORDER[confIdx], dims: profile.length };
}

// The level ±1 band around a ladder level — the window matching and the "relevant" job
// scope read from. null when unassessed (or the level isn't on the ladder).
export function bandFor(level: string | null): string[] | null {
  if (!level) return null;
  const r = LADDER.indexOf(level as typeof LADDER[number]);
  if (r < 0) return null;
  return LADDER.slice(Math.max(0, r - 1), r + 2) as unknown as string[];
}

// The overall assessment, DERIVED on read (no cache): band/floor/confidence from the
// dimensions, `verified` true once a COMPETENCY interview is complete (what earns the profile
// beyond self-report — a role_fit rehearsal for one posting doesn't verify the whole profile).
// null until at least one dimension is assessed.
export interface AssessmentSummary { band: string | null; confidence: string | null; floor: string | null; verified: boolean }
export function assessmentSummary(): AssessmentSummary | null {
  const d = deriveBand();
  if (!d) return null;
  const verified = countOf("SELECT count(*) c FROM interviews WHERE status='complete' AND type='competency'") > 0;
  return { band: d.band, confidence: d.confidence, floor: d.floor, verified };
}

// ── interviews (resumable; the assess + verify + upskill engine) ─────────────
export interface Interview { id: number; type: string; job_id: number | null; status: string; verified_ceiling: string | null; summary: string | null; started_at: string; updated_at: string }
export const getInterview = (id: number): Interview | undefined =>
  db.prepare("SELECT * FROM interviews WHERE id = ?").get(id) as Interview | undefined;
export const getOpenInterview = (): Interview | undefined =>
  db.prepare("SELECT * FROM interviews WHERE status='in_progress' ORDER BY id DESC LIMIT 1").get() as Interview | undefined;
export const getInterviews = (): Interview[] =>
  db.prepare("SELECT * FROM interviews ORDER BY id DESC").all() as Interview[];
export function startInterview(type: string, jobId?: number | null): number {
  const info = db.prepare("INSERT INTO interviews (type, job_id) VALUES (?, ?)").run(type, jobId ?? null);
  logEvent("interviewed", `started ${type} interview${jobId ? ` for job ${jobId}` : ""}`, String(info.lastInsertRowid));
  return Number(info.lastInsertRowid);
}
export interface InterviewItemInput { dimension?: string | null; claim?: string | null; question: string; answer_summary?: string | null; exemplar?: string | null; score?: string | null; ownership?: string | null; understanding?: string | null; delta_notes?: string | null }
export function addInterviewItems(interviewId: number, items: InterviewItemInput[]): void {
  const tx = db.transaction(() => {
    const ins = db.prepare(
      `INSERT INTO interview_items (interview_id, dimension, claim, question, answer_summary, exemplar, score, ownership, understanding, delta_notes)
       VALUES (@interview_id, @dimension, @claim, @question, @answer_summary, @exemplar, @score, @ownership, @understanding, @delta_notes)`);
    for (const it of items) ins.run({
      interview_id: interviewId, dimension: it.dimension ?? null, claim: it.claim ?? null, question: it.question,
      answer_summary: it.answer_summary ?? null, exemplar: it.exemplar ?? null, score: it.score ?? null,
      ownership: it.ownership ?? null, understanding: it.understanding ?? null, delta_notes: it.delta_notes ?? null,
    });
    db.prepare("UPDATE interviews SET updated_at=datetime('now') WHERE id=?").run(interviewId);
  });
  tx();
}
export interface InterviewItem extends InterviewItemInput { id: number; interview_id: number; created_at: string }
export const getInterviewItems = (interviewId: number): InterviewItem[] =>
  db.prepare("SELECT * FROM interview_items WHERE interview_id = ? ORDER BY id").all(interviewId) as InterviewItem[];
export function completeInterview(interviewId: number, verifiedCeiling: string | null, summary: string): void {
  db.prepare("UPDATE interviews SET status='complete', verified_ceiling=?, summary=?, updated_at=datetime('now') WHERE id=?")
    .run(verifiedCeiling, summary, interviewId);
  logEvent("interviewed", `completed interview ${interviewId}${verifiedCeiling ? ` (verified_ceiling ${verifiedCeiling})` : ""}`, String(interviewId));
}

export type RecordInterviewResult = InterviewError | {
  ok: true;
  interview_id: number;
  items_recorded: number;
  completed: boolean;
};

// Resolve the target and preconditions before the first mutation. The outer transaction
// includes session creation, every item, completion, and their journal events; the existing
// item helper's nested transaction uses the driver's SAVEPOINT support.
export function recordInterview(request: InterviewRequest): RecordInterviewResult {
  return db.transaction((): RecordInterviewResult => {
    const choice = resolveInterviewRequest(request, {
      sessions: getInterviews(),
      jobExists: request.job_id === undefined ? undefined : !!getJob(request.job_id),
    });
    if (!choice.ok) return choice;
    const id = choice.action === "resume"
      ? choice.interview_id!
      : startInterview(choice.type, choice.job_id);
    addInterviewItems(id, choice.items);
    if (choice.done) completeInterview(id, choice.verified_ceiling ?? null, choice.summary!);
    return { ok: true, interview_id: id, items_recorded: choice.items.length, completed: choice.done };
  })();
}

// ── upskilling plan (learn / resume / build — tracked, drives re-match) ──────
export interface PlanItem { id: number; gap: string; type: string; spec: string; market_demand: string | null; status: string; progress_notes: string | null; created_at: string; updated_at: string }
export const getPlan = (status?: string): PlanItem[] =>
  status
    ? db.prepare("SELECT * FROM upskilling_plan WHERE status = ? ORDER BY id").all(status) as PlanItem[]
    : db.prepare("SELECT * FROM upskilling_plan ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'suggested' THEN 1 ELSE 2 END, id").all() as PlanItem[];
export function addPlanItem(gap: string, type: string, spec: string, marketDemand?: string | null): number {
  const info = db.prepare("INSERT INTO upskilling_plan (gap, type, spec, market_demand) VALUES (?, ?, ?, ?)").run(gap, type, spec, marketDemand ?? null);
  logEvent("planned", `${type} · ${gap}: ${spec}`, String(info.lastInsertRowid));
  return Number(info.lastInsertRowid);
}
// updated_at marks the last STATUS TRANSITION, not any touch — planDoneSinceAssess reads it
// as "when did this item close", so a notes-only edit (or re-setting the same status) must
// not bump it and falsely re-fire the re-assess signal.
export function updatePlanItem(id: number, status?: string | null, progressNotes?: string | null): boolean {
  const cur = db.prepare("SELECT id, gap, type, status FROM upskilling_plan WHERE id = ?").get(id) as { id: number; gap: string; type: string; status: string } | undefined;
  if (!cur) return false;
  const transitioned = status != null && status !== cur.status;
  db.prepare(
    `UPDATE upskilling_plan SET status = COALESCE(?, status), progress_notes = COALESCE(?, progress_notes),
       updated_at = CASE WHEN ? THEN datetime('now') ELSE updated_at END WHERE id = ?`,
  ).run(status ?? null, progressNotes ?? null, transitioned ? 1 : 0, id);
  if (transitioned) logEvent("plan_progress", `${cur.type} · ${cur.gap} → ${status}`, String(id));
  return true;
}
export const planCounts = (): Record<string, number> =>
  Object.fromEntries((db.prepare("SELECT status, count(*) c FROM upskilling_plan GROUP BY status").all() as { status: string; c: number }[]).map((r) => [r.status, r.c]));

// ── role fit (the user's fit on a specific job) ──────────────────────────────
export interface RoleFit { band: string; dim_deltas: unknown; desire_alignment: string | null; gaps: unknown[]; rationale: string | null }
export const getRoleFit = (jobId: number): RoleFit | undefined => {
  const r = db.prepare("SELECT band, dim_deltas_json, desire_alignment, gaps_json, rationale FROM role_fit WHERE job_id = ?")
    .get(jobId) as { band: string; dim_deltas_json: string | null; desire_alignment: string | null; gaps_json: string | null; rationale: string | null } | undefined;
  return r ? { band: r.band, dim_deltas: r.dim_deltas_json ? JSON.parse(r.dim_deltas_json) : null, desire_alignment: r.desire_alignment, gaps: r.gaps_json ? JSON.parse(r.gaps_json) : [], rationale: r.rationale } : undefined;
};
export function setRoleFit(jobId: number, band: string, dimDeltas: unknown, desireAlignment: string | null, gaps: unknown, rationale: string): void {
  db.prepare(
    `INSERT INTO role_fit (job_id, band, dim_deltas_json, desire_alignment, gaps_json, rationale)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET band=excluded.band, dim_deltas_json=excluded.dim_deltas_json,
       desire_alignment=excluded.desire_alignment, gaps_json=excluded.gaps_json, rationale=excluded.rationale`,
  ).run(jobId, band, JSON.stringify(dimDeltas ?? null), desireAlignment, JSON.stringify(gaps ?? []), rationale);
  logEvent("role_fit", `job ${jobId} → ${band}${desireAlignment ? ` (desire ${desireAlignment})` : ""}`, String(jobId));
}

export interface CoverLetter { content: string; talking_points: unknown[]; created_at: string }
export const getCoverLetter = (jobId: number): CoverLetter | null => {
  const r = db.prepare("SELECT content, talking_points_json, created_at FROM cover_letters WHERE job_id = ?")
    .get(jobId) as { content: string; talking_points_json: string | null; created_at: string } | undefined;
  return r ? { content: r.content, talking_points: r.talking_points_json ? JSON.parse(r.talking_points_json) : [], created_at: r.created_at } : null;
};
export const recordCoverLetter = (jobId: number, content: string, points: unknown): void => {
  db.prepare(
    `INSERT INTO cover_letters (job_id, content, talking_points_json) VALUES (?, ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET content=excluded.content, talking_points_json=excluded.talking_points_json`,
  ).run(jobId, content, JSON.stringify(points ?? null));
};

// ── application tracking (personal) ──────────────────────────────────────────
export interface Application {
  job_id: number; status: string; applied_at: string | null;
  next_action: string | null; next_action_at: string | null; notes: string | null; updated_at: string;
}
export const getApplication = (jobId: number): Application | undefined =>
  db.prepare("SELECT * FROM applications WHERE job_id = ?").get(jobId) as Application | undefined;

export interface ApplicationInput {
  status: string; applied_at?: string | null; next_action?: string | null;
  next_action_at?: string | null; notes?: string | null;
}
const APPLICATION_FIELDS = ["status", "applied_at", "next_action", "next_action_at", "notes"] as const;
export interface ApplicationWriteResult {
  changed: boolean;
  transitioned: boolean;
  changed_fields: (typeof APPLICATION_FIELDS[number])[];
}

// updated_at marks the last STATUS TRANSITION, not any touch — rejectionsSincePlan reads it
// as "when was this rejected". Metadata edits have their own journal event and must not
// re-fire that signal. Omission preserves a field; null clears it; text is kept verbatim.
// Compare, persist, and journal together so failed writes leave neither a partial row nor
// a stray event. Exact repeats don't touch the application row or append to the journal.
export function recordApplication(
  jobId: number,
  fields: ApplicationInput,
): ApplicationWriteResult {
  return db.transaction((): ApplicationWriteResult => {
    const cur = getApplication(jobId);
    const pick = (key: Exclude<typeof APPLICATION_FIELDS[number], "status">): string | null =>
      fields[key] !== undefined ? fields[key] : cur?.[key] ?? null;
    const next = {
      status: fields.status, applied_at: pick("applied_at"), next_action: pick("next_action"),
      next_action_at: pick("next_action_at"), notes: pick("notes"),
    };
    const changed_fields = APPLICATION_FIELDS.filter((key) => (cur?.[key] ?? null) !== next[key]);
    const transitioned = cur?.status !== next.status;
    if (!changed_fields.length) return { changed: false, transitioned: false, changed_fields };

    db.prepare(
      `INSERT INTO applications (job_id, status, applied_at, next_action, next_action_at, notes, updated_at)
       VALUES (@job_id, @status, @applied_at, @next_action, @next_action_at, @notes, datetime('now'))
       ON CONFLICT(job_id) DO UPDATE SET status=excluded.status, applied_at=excluded.applied_at,
         next_action=excluded.next_action, next_action_at=excluded.next_action_at, notes=excluded.notes,
         updated_at=CASE WHEN excluded.status != applications.status THEN datetime('now') ELSE applications.updated_at END`,
    ).run({ job_id: jobId, ...next });
    // Keep old and new values in the existing local journal, including cleared values.
    // One call emits one event even when status and multiple metadata fields change.
    const changes = Object.fromEntries(changed_fields.map((key) => [key, { from: cur?.[key] ?? null, to: next[key] }]));
    logEvent(
      transitioned ? "applied" : "application_updated",
      `${transitioned ? `job ${jobId} → ${next.status}` : `job ${jobId} application updated (${next.status})`}; changes ${JSON.stringify(changes)}`,
      String(jobId),
    );
    if (transitioned) noteApplicationOnLedger(jobId, cur?.status ?? null, next.status);
    return { changed: true, transitioned, changed_fields };
  })();
}

export interface ApplicationRow extends Application { title: string | null; company: string }
export const getApplications = (): ApplicationRow[] =>
  db.prepare(
    `SELECT a.*, j.title, c.name AS company FROM applications a
     JOIN jobs j ON j.id = a.job_id JOIN companies c ON c.id = j.company_id
     ORDER BY a.updated_at DESC`,
  ).all() as ApplicationRow[];

export const applicationCounts = (): Record<string, number> =>
  Object.fromEntries((db.prepare("SELECT status, count(*) c FROM applications GROUP BY status").all() as { status: string; c: number }[])
    .map((r) => [r.status, r.c]));

export const getMeta = (key: string): string | null =>
  (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
export const setMeta = (key: string, value: string): void => {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
};

// ── catalog accessors ──────────────────────────────────────────────────────
export interface Job {
  id: number; company_id: number; source_url: string; title: string | null; location: string | null;
  remote: number | null; comp_min: number | null; comp_max: number | null; raw_json: string | null;
  grade_seniority: string | null; grade_market_signal: string | null; graded_at: string | null;
  fetched_at: string; last_seen_at: string; still_live: number;
}
export const getJob = (id: number): Job | undefined =>
  db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Job | undefined;

export function setJobGrade(jobId: number, seniority: string, signal: string,
                            skills: { skill: string; kind: string }[]): void {
  const tx = db.transaction(() => {
    db.prepare("UPDATE jobs SET grade_seniority=?, grade_market_signal=?, graded_at=datetime('now') WHERE id=?")
      .run(seniority, signal, jobId);
    db.prepare("DELETE FROM job_skills WHERE job_id=?").run(jobId);
    const ins = db.prepare("INSERT OR IGNORE INTO job_skills (job_id, skill, kind) VALUES (?, ?, ?)");
    for (const s of skills) ins.run(jobId, s.skill, s.kind);
  });
  tx();
  logEvent("graded_job", `job ${jobId} → ${seniority}/${signal}`, String(jobId));
}

export interface JobSkill { skill: string; kind: string }
export const getJobSkills = (jobId: number): JobSkill[] =>
  db.prepare(
    "SELECT skill, kind FROM job_skills WHERE job_id = ? ORDER BY CASE kind WHEN 'required' THEN 0 ELSE 1 END, skill",
  ).all(jobId) as JobSkill[];

// Live MARKET skill demand — aggregate required/preferred skills across live, graded jobs
// (optionally narrowed to a seniority band). Grounds the upskilling plan's 'build' recs.
export interface SkillDemand { skill: string; required: number; preferred: number; total: number }
export function marketSkillDemand(band?: string[] | null, limit = 20): { total_jobs: number; skills: SkillDemand[] } {
  const where = ["j.still_live=1", "j.grade_seniority IS NOT NULL"];
  const args: string[] = [];
  if (band && band.length) { where.push(`j.grade_seniority IN (${band.map(() => "?").join(",")})`); args.push(...band); }
  const clause = where.join(" AND ");
  const total_jobs = countOf(`SELECT count(*) c FROM jobs j WHERE ${clause}`, ...args);
  const skills = db.prepare(
    `SELECT s.skill,
            SUM(CASE WHEN s.kind='required' THEN 1 ELSE 0 END) AS required,
            SUM(CASE WHEN s.kind='preferred' THEN 1 ELSE 0 END) AS preferred,
            COUNT(DISTINCT s.job_id) AS total
     FROM job_skills s JOIN jobs j ON j.id=s.job_id
     WHERE ${clause}
     GROUP BY lower(s.skill)
     ORDER BY total DESC, required DESC, s.skill LIMIT ?`,
  ).all(...args, limit) as SkillDemand[];
  return { total_jobs, skills };
}

// ── job fetch write path (gather('fetch_jobs') calls this — db.ts is the sole writer) ──
export interface RawJobInput {
  source_url: string; title?: string | null; location?: string | null;
  remote?: number | null; comp_min?: number | null; comp_max?: number | null; raw?: unknown;
}
export interface PostingChange { job_id: number; source_url: string; title: string | null }
export interface FetchJobsResult {
  inserted: number; updated: number; closed: number; seen: number;
  new_postings: PostingChange[]; returned_postings: PostingChange[]; closed_postings: PostingChange[];
}
export function upsertJobs(companyId: number, jobs: RawJobInput[], opts: { closeMissing?: boolean } = {}): FetchJobsResult {
  const closeMissing = opts.closeMissing !== false;
  const tx = db.transaction((): FetchJobsResult => {
    const upsert = db.prepare(
      `INSERT INTO jobs (company_id, source_url, title, location, remote, comp_min, comp_max, raw_json, fetched_at, last_seen_at, still_live)
       VALUES (@company_id, @source_url, @title, @location, @remote, @comp_min, @comp_max, @raw_json, datetime('now'), datetime('now'), 1)
       ON CONFLICT(company_id, source_url) DO UPDATE SET
         title=excluded.title, location=excluded.location, remote=excluded.remote,
         comp_min=excluded.comp_min, comp_max=excluded.comp_max, raw_json=excluded.raw_json,
         last_seen_at=datetime('now'), still_live=1`);
    const priorRows = db.prepare("SELECT id, source_url, title, still_live FROM jobs WHERE company_id=?").all(companyId) as { id: number; source_url: string; title: string | null; still_live: number }[];
    const prior = new Map(priorRows.map((row) => [row.source_url, row]));
    const idOf = db.prepare("SELECT id, title FROM jobs WHERE company_id=? AND source_url=?");
    const seen: string[] = [];
    const seenSet = new Set<string>();
    const new_postings: PostingChange[] = [];
    const returned_postings: PostingChange[] = [];
    let inserted = 0, updated = 0;
    for (const j of jobs) {
      if (!j.source_url || seenSet.has(j.source_url)) continue;
      seenSet.add(j.source_url);
      const had = prior.get(j.source_url);
      upsert.run({
        company_id: companyId, source_url: j.source_url, title: j.title ?? null, location: j.location ?? null,
        remote: j.remote ?? null, comp_min: j.comp_min ?? null, comp_max: j.comp_max ?? null,
        raw_json: j.raw != null ? JSON.stringify(j.raw) : null,
      });
      const saved = idOf.get(companyId, j.source_url) as { id: number; title: string | null };
      const change = { job_id: saved.id, source_url: j.source_url, title: saved.title };
      if (!had) { inserted++; new_postings.push(change); }
      else {
        updated++;
        if (had.still_live === 0) returned_postings.push(change);
      }
      seen.push(j.source_url);
    }
    const closed_postings = closeMissing
      ? priorRows
        .filter((row) => row.still_live === 1 && !seenSet.has(row.source_url))
        .map((row) => ({ job_id: row.id, source_url: row.source_url, title: row.title }))
      : [];
    const closed = !closeMissing
      ? 0
      : seen.length === 0
        ? db.prepare("UPDATE jobs SET still_live=0 WHERE company_id=? AND still_live=1").run(companyId).changes
        : db.prepare(`UPDATE jobs SET still_live=0 WHERE company_id=? AND still_live=1 AND source_url NOT IN (${seen.map(() => "?").join(",")})`).run(companyId, ...seen).changes;
    db.prepare("UPDATE companies SET last_fetched_at=datetime('now') WHERE id=?").run(companyId);
    return { inserted, updated, closed, seen: seen.length, new_postings, returned_postings, closed_postings };
  });
  return tx();
}

export interface Company {
  id: number; name: string; domain: string | null; tags: string | null; source: string | null;
  ats_platform: string | null; ats_slug: string | null; resolved: number;
  resolve_attempts: number; last_resolve_attempt_at: string | null;
  added_at: string; last_fetched_at: string | null;
}
const COMPANY_COLS = "id, name, domain, tags, source, ats_platform, ats_slug, resolved, resolve_attempts, last_resolve_attempt_at, added_at, last_fetched_at";
export const getCompanies = (limit = 200): Company[] =>
  db.prepare(`SELECT ${COMPANY_COLS} FROM companies ORDER BY added_at DESC LIMIT ?`).all(limit) as Company[];
export const getCompanyByAts = (platform: string, slug: string): Company | undefined =>
  db.prepare(`SELECT ${COMPANY_COLS} FROM companies WHERE ats_platform=? AND ats_slug=?`).get(platform, slug) as Company | undefined;
export const getResolvedCompanies = (limit = 200): Company[] =>
  db.prepare(
    `SELECT ${COMPANY_COLS} FROM companies WHERE resolved=1 AND ats_platform IS NOT NULL AND ats_slug IS NOT NULL ORDER BY last_fetched_at ASC, added_at ASC LIMIT ?`,
  ).all(limit) as Company[];
export function getResolvedCompaniesPage(afterId = 0, limit = 5): { companies: Company[]; next_cursor: number | null } {
  const rows = db.prepare(
    `SELECT ${COMPANY_COLS} FROM companies
     WHERE resolved=1 AND ats_platform IS NOT NULL AND ats_slug IS NOT NULL AND id > ?
     ORDER BY id ASC LIMIT ?`,
  ).all(afterId, limit + 1) as Company[];
  const more = rows.length > limit;
  const companies = more ? rows.slice(0, limit) : rows;
  return { companies, next_cursor: more && companies.length ? companies[companies.length - 1].id : null };
}
export function jobSourceUrls(companyId: number): string[] {
  return (db.prepare("SELECT source_url FROM jobs WHERE company_id=? AND still_live=1").all(companyId) as { source_url: string }[])
    .map((row) => row.source_url);
}

const normalizeDomain = (d?: string | null): string | null => {
  if (!d) return null;
  const s = d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
  return s || null;
};
const parseTags = (s: string | null | undefined): string[] =>
  s ? s.split(",").map((t) => t.trim()).filter(Boolean) : [];
const serializeTags = (tags: string[]): string | null => {
  const u = [...new Set(tags.map((t) => t.trim()).filter(Boolean))].sort();
  return u.length ? u.join(",") : null;
};

export interface CompanyInput {
  name: string; domain?: string | null; source?: string | null; tags?: string[];
  ats_platform?: string | null; ats_slug?: string | null; resolved?: boolean;
}
export interface UpsertResult { id: number; inserted: boolean }
export interface ResolveResult { id: number; merged: boolean }

const findBySlug = (platform: string, slug: string): Company | undefined =>
  db.prepare("SELECT * FROM companies WHERE ats_platform = ? AND ats_slug = ?").get(platform, slug) as Company | undefined;
const findByDomain = (domain: string): Company | undefined =>
  db.prepare("SELECT * FROM companies WHERE domain = ? ORDER BY id LIMIT 1").get(domain) as Company | undefined;

export function upsertCompany(input: CompanyInput): UpsertResult {
  const platform = input.ats_platform ?? null;
  const slug = input.ats_slug ?? null;
  const domain = normalizeDomain(input.domain);
  const resolved = input.resolved ?? !!(platform && slug);

  const bySlug = platform && slug ? findBySlug(platform, slug) : undefined;
  const byDomain = domain ? findByDomain(domain) : undefined;
  const matches: Company[] = [];
  if (bySlug) matches.push(bySlug);
  if (byDomain && !matches.some((m) => m.id === byDomain.id)) matches.push(byDomain);

  if (matches.length === 0) {
    const info = db.prepare(
      `INSERT INTO companies (name, domain, tags, source, ats_platform, ats_slug, resolved)
       VALUES (@name, @domain, @tags, @source, @ats_platform, @ats_slug, @resolved)`,
    ).run({
      name: input.name, domain, tags: serializeTags(input.tags ?? []),
      source: input.source ?? null, ats_platform: platform, ats_slug: slug, resolved: resolved ? 1 : 0,
    });
    return { id: Number(info.lastInsertRowid), inserted: true };
  }

  const primary = matches[0];
  for (const m of matches.slice(1)) {
    const folded = { domain: m.domain, source: m.source, tags: parseTags(m.tags),
                     ats_platform: m.ats_platform, ats_slug: m.ats_slug, resolved: m.resolved === 1 };
    db.prepare("DELETE FROM companies WHERE id = ?").run(m.id);
    mergeFields(primary.id, folded);
  }
  mergeFields(primary.id, { domain, source: input.source, tags: input.tags, ats_platform: platform, ats_slug: slug, resolved });
  return { id: primary.id, inserted: false };
}

function mergeFields(
  id: number,
  input: { domain?: string | null; source?: string | null; tags?: string[]; ats_platform?: string | null; ats_slug?: string | null; resolved?: boolean },
): void {
  const row = db.prepare("SELECT tags, ats_platform, ats_slug, resolved FROM companies WHERE id = ?")
    .get(id) as { tags: string | null; ats_platform: string | null; ats_slug: string | null; resolved: number } | undefined;
  if (!row) return;
  const tags = serializeTags([...parseTags(row.tags), ...(input.tags ?? [])]);
  const platform = row.ats_platform ?? input.ats_platform ?? null;
  const slug = row.ats_slug ?? input.ats_slug ?? null;
  const resolved = row.resolved === 1 || input.resolved === true || (!!platform && !!slug) ? 1 : 0;
  db.prepare(
    `UPDATE companies SET
       domain       = COALESCE(domain, @domain),
       tags         = @tags,
       source       = COALESCE(source, @source),
       ats_platform = COALESCE(ats_platform, @ats_platform),
       ats_slug     = COALESCE(ats_slug, @ats_slug),
       resolved     = @resolved
     WHERE id = @id`,
  ).run({
    id, domain: normalizeDomain(input.domain), tags, source: input.source ?? null,
    ats_platform: input.ats_platform ?? null, ats_slug: input.ats_slug ?? null, resolved,
  });
}

export function resolveCompany(id: number, platform: string, slug: string): ResolveResult {
  const owner = findBySlug(platform, slug);
  if (owner && owner.id !== id) {
    const cand = db.prepare("SELECT * FROM companies WHERE id = ?").get(id) as Company | undefined;
    if (cand) {
      mergeFields(owner.id, { domain: cand.domain, source: cand.source, tags: parseTags(cand.tags), resolved: true });
      db.prepare("DELETE FROM companies WHERE id = ?").run(id);
    }
    return { id: owner.id, merged: true };
  }
  db.prepare("UPDATE companies SET ats_platform = ?, ats_slug = ?, resolved = 1 WHERE id = ?").run(platform, slug, id);
  return { id, merged: false };
}

export const bumpResolveAttempt = (id: number): void => {
  db.prepare(
    "UPDATE companies SET resolve_attempts = resolve_attempts + 1, last_resolve_attempt_at = datetime('now') WHERE id = ?",
  ).run(id);
};

const countOf = (sql: string, ...args: unknown[]): number => (db.prepare(sql).get(...args) as { c: number }).c;
export interface Counts {
  companies: number; unresolved: number; jobs: number; ungraded: number;
  portfolio: number; portfolio_graded: number; dimensions_assessed: number;
}
export const counts = (): Counts => ({
  companies: countOf("SELECT count(*) c FROM companies"),
  unresolved: countOf("SELECT count(*) c FROM companies WHERE resolved = 0"),
  jobs: countOf("SELECT count(*) c FROM jobs"),
  ungraded: countOf("SELECT count(*) c FROM jobs WHERE grade_seniority IS NULL"),
  portfolio: countOf("SELECT count(*) c FROM portfolio_projects"),
  portfolio_graded: countOf("SELECT count(*) c FROM portfolio_relevance"),
  dimensions_assessed: countOf("SELECT count(*) c FROM competency_profile"),
});

// Live, graded jobs inside a band — the "is there anything to pursue" read.
export const liveJobsInBand = (band: string[]): number =>
  band.length
    ? countOf(`SELECT count(*) c FROM jobs WHERE still_live=1 AND grade_seniority IN (${band.map(() => "?").join(",")})`, ...band)
    : 0;

// ── loop signals — the edges that make the readiness loop TURN (not just fill) ──
// Plan items closed since the competency profile was last touched: the user genuinely
// improved, so re-assess the dimensions those items addressed and re-match. Clears once
// any dimension is re-assessed (the re-assessment acknowledges the progress).
export const planDoneSinceAssess = (): number =>
  countOf(`SELECT count(*) c FROM upskilling_plan p WHERE p.status='done'
           AND p.updated_at > COALESCE((SELECT max(updated_at) FROM competency_profile), p.updated_at)`);

// Rejections recorded since the plan last grew: outcomes not yet fed back into upskilling
// items. Clears once a new plan item is added (the plan absorbed the signal).
export const rejectionsSincePlan = (): number =>
  countOf(`SELECT count(*) c FROM applications a WHERE a.status='rejected'
           AND a.updated_at > COALESCE((SELECT max(created_at) FROM upskilling_plan), '')`);

export const nowStr = (): string => (db.prepare("SELECT datetime('now') t").get() as { t: string }).t;

// Discovery checkpoints share the existing private DB and its transaction boundary.
// Serial owner use only: worker leases/cross-process scheduling belong to stage e.
// Payloads contain candidate-specific findings and must never be exported to git.
db.exec(`CREATE TABLE IF NOT EXISTS discovery_runs (
  id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
const discoveryId = (id: string): void => {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("invalid discovery run ID");
};
export function loadDiscoveryRun<T>(id: string): T | undefined {
  discoveryId(id);
  const row = db.prepare("SELECT payload_json FROM discovery_runs WHERE id=?").get(id) as { payload_json: string } | undefined;
  return row ? JSON.parse(row.payload_json) as T : undefined;
}
export function saveDiscoveryRun<T extends { id: string }>(run: T): void {
  discoveryId(run.id);
  const payload = JSON.stringify(run);
  db.transaction(() => {
    db.prepare(`INSERT INTO discovery_runs(id,payload_json) VALUES (?,?)
      ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,
      revision=discovery_runs.revision+1, updated_at=datetime('now')`).run(run.id, payload);
    logEvent("discovery_checkpoint", "discovery checkpoint saved", run.id);
  })();
}

// Durable read reservations for a SERIAL owner. These counters survive restart;
// they are not cross-process inflight locks or worker leases.
db.exec(`CREATE TABLE IF NOT EXISTS discovery_read_days (
  day TEXT PRIMARY KEY, requests INTEGER NOT NULL CHECK(requests >= 0)
);
CREATE TABLE IF NOT EXISTS discovery_read_hosts (
  host TEXT PRIMARY KEY, last_started_ms INTEGER NOT NULL
)`);
/** Return a required wait without consuming budget, or 0 after reserving a read. */
export function reserveDiscoveryRead(host: string, timestamp: number, dailyLimit: number): number {
  if (typeof host !== "string" || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || !host.includes("."))
    throw new Error("invalid discovery read host");
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 8640000000000000)
    throw new Error("invalid discovery read timestamp");
  if (!Number.isSafeInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 500)
    throw new Error("invalid discovery daily request bound");
  const day = new Date(timestamp).toISOString().split("T")[0];
  return db.transaction(() => {
    const row = db.prepare("SELECT requests FROM discovery_read_days WHERE day=?").get(day) as { requests: number } | undefined;
    if ((row?.requests ?? 0) >= dailyLimit) throw new Error("daily request budget exhausted");
    const previous = db.prepare("SELECT last_started_ms FROM discovery_read_hosts WHERE host=?").get(host) as { last_started_ms: number } | undefined;
    const wait = Math.max(0, (previous?.last_started_ms ?? -Infinity) + 1000 - timestamp);
    if (wait) return wait;
    db.prepare(`INSERT INTO discovery_read_days(day,requests) VALUES (?,1)
      ON CONFLICT(day) DO UPDATE SET requests=requests+1`).run(day);
    db.prepare(`INSERT INTO discovery_read_hosts(host,last_started_ms) VALUES (?,?)
      ON CONFLICT(host) DO UPDATE SET last_started_ms=excluded.last_started_ms`).run(host, timestamp);
    logEvent("discovery_read_reserved", "discovery read reserved");
    return 0;
  })();
}

// Stage b private people collection. The queue is a view of retained findings,
// never an outreach draft or executor queue. All SQL writes remain in this file.
// secure_delete overwrites SQLite cells going forward; WAL/backups may retain
// historical pages and require a separate operator retention policy.
import { createHash as peopleHash } from "node:crypto";
import type { PersonFinding, PeopleReviewItem } from "./people-types.js";
import { validatePersonFinding } from "./people-sources.js";
db.pragma("secure_delete = ON");
db.exec(`CREATE TABLE IF NOT EXISTS people_findings (
  id_hash TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  expires_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_people_expiry ON people_findings(expires_at);
CREATE TABLE IF NOT EXISTS people_tombstones (
  id_hash TEXT PRIMARY KEY,
  reason TEXT NOT NULL CHECK(reason IN ('suppressed','deleted'))
);
CREATE TABLE IF NOT EXISTS people_blocked_channels (
  channel_hash TEXT PRIMARY KEY,
  reason TEXT NOT NULL CHECK(reason IN ('suppressed','deleted'))
)`);
function peopleIdentity(id: string): string {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("invalid people ID");
  return peopleHash("sha256").update(id).digest("hex");
}
function peopleTime(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000) throw new Error("invalid people timestamp");
}
function peopleChannelHashes(person: PersonFinding): string[] {
  return person.channels.map((channel) => peopleHash("sha256").update(JSON.stringify(["channel", channel.kind, channel.value.trim().toLowerCase()])).digest("hex"));
}
export function collectPrivatePerson(person: PersonFinding): boolean {
  validatePersonFinding(person);
  const hash = peopleIdentity(person.id);
  const payload = JSON.stringify(person);
  return db.transaction(() => {
    if (db.prepare("SELECT 1 FROM people_tombstones WHERE id_hash=?").get(hash) ||
        peopleChannelHashes(person).some((channel) => db.prepare("SELECT 1 FROM people_blocked_channels WHERE channel_hash=?").get(channel))) return false;
    db.prepare(`INSERT INTO people_findings(id_hash,payload_json,expires_at) VALUES (?,?,?)
      ON CONFLICT(id_hash) DO UPDATE SET payload_json=excluded.payload_json, expires_at=excluded.expires_at`)
      .run(hash, payload, person.provenance.expiresAt);
    logEvent("people_collected", "private review finding retained", hash);
    return true;
  })();
}
export function purgeExpiredPeople(now: number): number {
  peopleTime(now);
  return db.transaction(() => {
    const result = db.prepare("DELETE FROM people_findings WHERE expires_at<=?").run(now);
    if (result.changes) logEvent("people_expired", `private findings expired: ${result.changes}`);
    return result.changes;
  })();
}
export function reviewPrivatePeople(now: number): PeopleReviewItem[] {
  peopleTime(now);
  return db.transaction(() => {
    // Expiration physically removes payloads, rather than merely hiding them.
    purgeExpiredPeople(now);
    const rows = db.prepare("SELECT payload_json FROM people_findings ORDER BY id_hash").all() as { payload_json: string }[];
    try {
      return rows.flatMap(({ payload_json }): PeopleReviewItem[] => {
        const person: unknown = JSON.parse(payload_json);
        validatePersonFinding(person);
        return person.provenance.fetchedAt > now ? [] : [{ person, stale: false, needsReview: true }];
      });
    } catch {
      // Native JSON errors may include a payload excerpt. Never let private
      // content escape into harness/server error logs on a corrupt record.
      throw new Error("private people review data is invalid");
    }
  })();
}
function removePrivatePerson(id: string, reason: "suppressed" | "deleted"): void {
  const hash = peopleIdentity(id);
  db.transaction(() => {
    const rows = db.prepare("SELECT id_hash,payload_json FROM people_findings").all() as { id_hash: string; payload_json: string }[];
    const identities = new Set([hash]);
    const channels = new Set<string>();
    // Conservative alias handling: a shared published channel also removes
    // other queued identities. Only channel-kind fingerprints survive.
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        let person: PersonFinding;
        try { const value: unknown = JSON.parse(row.payload_json); validatePersonFinding(value); person = value; }
        catch { continue; } // Target corruption still gets removed by its ID.
        const hashes = peopleChannelHashes(person);
        if (!identities.has(row.id_hash) && !hashes.some((channel) => channels.has(channel))) continue;
        if (!identities.has(row.id_hash)) { identities.add(row.id_hash); changed = true; }
        for (const channel of hashes) if (!channels.has(channel)) { channels.add(channel); changed = true; }
      }
    }
    for (const identity of identities) {
      db.prepare("DELETE FROM people_findings WHERE id_hash=?").run(identity);
      // Minimal opaque tombstones prevent automatic recollection after deletion.
      db.prepare(`INSERT INTO people_tombstones(id_hash,reason) VALUES (?,?)
        ON CONFLICT(id_hash) DO UPDATE SET reason=excluded.reason`).run(identity, reason);
    }
    for (const channel of channels) db.prepare(`INSERT INTO people_blocked_channels(channel_hash,reason) VALUES (?,?)
      ON CONFLICT(channel_hash) DO UPDATE SET reason=excluded.reason`).run(channel, reason);
    logEvent(`people_${reason}`, `private findings removed: ${identities.size}; opaque tombstones retained`, hash);
  })();
}
export const suppressPrivatePerson = (id: string): void => removePrivatePerson(id, "suppressed");
export const deletePrivatePerson = (id: string): void => removePrivatePerson(id, "deleted");

// Stage c read-only suppression admission check, reusing stage b tombstones.
export function isPrivatePersonSuppressed(id: string, destination: string): boolean {
  if (typeof destination !== "string" || !destination.trim()) throw new Error("suppression destination required");
  if (id && db.prepare("SELECT 1 FROM people_tombstones WHERE id_hash=?").get(peopleIdentity(id))) return true;
  return ["email", "professional_url"].some((kind) => {
    const fingerprint = peopleHash("sha256").update(JSON.stringify(["channel", kind, destination.trim().toLowerCase()])).digest("hex");
    return !!db.prepare("SELECT 1 FROM people_blocked_channels WHERE channel_hash=?").get(fingerprint);
  });
}

// Stage d: a private, opaque execution ledger. Begin commits before transport.
// A single active effect is intentional; cross-company scheduling is stage e.
import type { ExecutionIntent, ExecutionRecord, ExecutionState } from "./execution-types.js";
db.exec(`CREATE TABLE IF NOT EXISTS execution_consumptions (
  approval_id TEXT PRIMARY KEY, nonce TEXT NOT NULL UNIQUE, consumed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS execution_revocations (
  approval_id TEXT PRIMARY KEY, revoked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS execution_intents (
  execution_id TEXT PRIMARY KEY, approval_id TEXT NOT NULL UNIQUE,
  nonce TEXT NOT NULL UNIQUE, principal TEXT NOT NULL, batch_digest TEXT NOT NULL, item_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('intent','succeeded','rejected','unknown')),
  receipt_id TEXT, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS execution_one_active
  ON execution_intents((1)) WHERE state IN ('intent','unknown');
CREATE TABLE IF NOT EXISTS execution_receipts (
  id INTEGER PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES execution_intents(execution_id),
  state TEXT NOT NULL CHECK(state IN ('succeeded','rejected','unknown')),
  receipt_id TEXT, recorded_at INTEGER NOT NULL
)`);
// Upgrading an interrupted local stage-d run cannot invent a deciding principal.
// Blank legacy values are deliberately rejected by the read validator.
if (!(db.prepare("PRAGMA table_info(execution_intents)").all() as { name: string }[]).some(column => column.name === "principal"))
  db.exec("ALTER TABLE execution_intents ADD COLUMN principal TEXT NOT NULL DEFAULT ''");
function executionOpaque(value: string): void {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{32,128}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(value))
    throw new Error("invalid opaque execution identifier");
}
function executionApprovalToken(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value))
    throw new Error("invalid opaque approval identifier");
}
function executionTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000)
    throw new Error("invalid execution timestamp");
}
function validateExecutionIntent(intent: ExecutionIntent): void {
  if (typeof intent.principal !== "string" || intent.principal.trim() !== intent.principal || !intent.principal ||
      intent.principal.length > 256 || /[\x00-\x1f\x7f]/.test(intent.principal))
    throw new Error("invalid deciding principal");
  for (const value of [intent.executionId, intent.itemId, intent.idempotencyKey]) executionOpaque(value);
  executionApprovalToken(intent.approvalId); executionApprovalToken(intent.nonce);
  if (!/^[a-f0-9]{64}$/.test(intent.batchDigest)) throw new Error("invalid execution digest");
  executionTimestamp(intent.createdAt);
}
export function isExecutionApprovalRevoked(approvalId: string): boolean {
  executionApprovalToken(approvalId);
  return !!db.prepare("SELECT 1 FROM execution_revocations WHERE approval_id=?").get(approvalId);
}
export function beginPrivateExecution(intent: ExecutionIntent): void {
  validateExecutionIntent(intent);
  db.transaction(() => {
    if (isExecutionApprovalRevoked(intent.approvalId)) throw new Error("execution approval revoked");
    if (db.prepare("SELECT 1 FROM execution_intents WHERE state IN ('intent','unknown')").get())
      throw new Error("unresolved execution requires reconciliation");
    if (db.prepare("SELECT 1 FROM execution_consumptions WHERE approval_id=? OR nonce=?").get(intent.approvalId, intent.nonce))
      throw new Error("execution approval already consumed");
    db.prepare("INSERT INTO execution_consumptions(approval_id,nonce,consumed_at) VALUES (?,?,?)")
      .run(intent.approvalId, intent.nonce, intent.createdAt);
    db.prepare(`INSERT INTO execution_intents(execution_id,approval_id,nonce,principal,batch_digest,item_id,idempotency_key,created_at,state,updated_at)
      VALUES (?,?,?,?,?,?,?,?,'intent',?)`).run(intent.executionId, intent.approvalId, intent.nonce, intent.principal,
      intent.batchDigest, intent.itemId, intent.idempotencyKey, intent.createdAt, intent.createdAt);
    logEvent("execution_intent", "private execution intent committed", intent.executionId);
  })();
}
export function getPrivateExecution(executionId: string): ExecutionRecord | undefined {
  executionOpaque(executionId);
  const row = db.prepare("SELECT * FROM execution_intents WHERE execution_id=?").get(executionId) as {
    execution_id: string; approval_id: string; nonce: string; principal: string; batch_digest: string; item_id: string;
    idempotency_key: string; created_at: number; state: ExecutionState; receipt_id: string | null; updated_at: number;
  } | undefined;
  if (!row) return undefined;
  const record: ExecutionRecord = { executionId: row.execution_id, approvalId: row.approval_id, nonce: row.nonce, principal: row.principal,
    batchDigest: row.batch_digest, itemId: row.item_id, idempotencyKey: row.idempotency_key,
    createdAt: row.created_at, state: row.state, updatedAt: row.updated_at,
    ...(row.receipt_id === null ? {} : { receiptId: row.receipt_id }) };
  validateExecutionIntent(record);
  executionTimestamp(record.updatedAt);
  if (!["intent", "succeeded", "rejected", "unknown"].includes(record.state) || record.updatedAt < record.createdAt)
    throw new Error("invalid private execution state");
  if (record.receiptId !== undefined) executionOpaque(record.receiptId);
  return record;
}
function writePrivateExecutionResult(executionId: string, state: "succeeded" | "rejected" | "unknown", receiptId: string | undefined, now: number, reconcile: boolean): void {
  executionOpaque(executionId); executionTimestamp(now);
  if (!["succeeded", "rejected", "unknown"].includes(state) || (reconcile && state === "unknown")) throw new Error("invalid execution result");
  if (receiptId !== undefined) executionOpaque(receiptId);
  if (state !== "unknown" && receiptId === undefined) throw new Error("terminal execution receipt required");
  db.transaction(() => {
    const record = getPrivateExecution(executionId);
    if (!record || !(reconcile ? ["intent", "unknown"] : ["intent"]).includes(record.state))
      throw new Error("execution state cannot be reopened");
    if (now < record.updatedAt) throw new Error("execution timestamp regressed");
    db.prepare("UPDATE execution_intents SET state=?,receipt_id=?,updated_at=? WHERE execution_id=?")
      .run(state, receiptId ?? null, now, executionId);
    db.prepare("INSERT INTO execution_receipts(execution_id,state,receipt_id,recorded_at) VALUES (?,?,?,?)")
      .run(executionId, state, receiptId ?? null, now);
    logEvent(reconcile ? "execution_reconciled" : "execution_receipt", `private execution ${state}`, executionId);
  })();
}
export const finishPrivateExecution = (executionId: string, state: "succeeded" | "rejected" | "unknown", receiptId: string | undefined, now: number): void =>
  writePrivateExecutionResult(executionId, state, receiptId, now, false);
export const reconcilePrivateExecution = (executionId: string, state: "succeeded" | "rejected", receiptId: string, now: number): void =>
  writePrivateExecutionResult(executionId, state, receiptId, now, true);
export function revokePrivateExecutionApproval(approvalId: string, now: number): void {
  executionApprovalToken(approvalId); executionTimestamp(now);
  db.transaction(() => {
    db.prepare("INSERT INTO execution_revocations(approval_id,revoked_at) VALUES (?,?) ON CONFLICT(approval_id) DO NOTHING").run(approvalId, now);
    logEvent("execution_approval_revoked", "private approval revoked", approvalId);
  })();
}

// Company/board ledger. Schema and writes live in board-ledger.ts; db.ts is still
// the only module tools and the CLI import to persist state. The personal `events`
// journal stays the candidate's journey — board checks do not flood it.
import { createBoardLedger } from "./board-ledger.js";
const ledgerApi = createBoardLedger(db);
export const {
  KNOWN_BOARD_TYPES,
  BOARD_EVENT_KINDS,
  registerBoard,
  updateBoard,
  appendBoardEvent,
  listBoardStats,
  boardStats,
  staleBoards,
  recentBoardEvents,
  recordBoardFetch,
  recordManualCheck,
  hoursSince,
  nowIso,
  parseEventTime,
} = ledgerApi;
export type {
  BoardStats, BoardEvent, RegisterBoardInput, RegisterBoardResult, AppendBoardEventInput,
  BoardFetchInput, BoardFetchRecord, PositionApplied, OpenPosition, LastCheck,
  UpdateBoardInput, ManualCheckInput, BoardListOptions,
} from "./board-ledger.js";

function noteApplicationOnLedger(jobId: number, from: string | null, to: string): void {
  ledgerApi.recordApplicationOnLedger(jobId, from, to);
}

const FETCHABLE_BOARD = new Set(["ashby", "greenhouse", "lever", "workable", "workday", "smartrecruiters"]);

export function applyOnBoard(input: { board_id: number; title: string; url?: string | null; posting_id?: string | null; note?: string | null }): { board_id: number; job_id: number; company_id: number } {
  const board = boardStats(input.board_id);
  if (!board) throw new Error(`no board ${input.board_id}`);
  if (typeof input.title !== "string" || !input.title.trim() || input.title.trim().length > 300) throw new Error("title must be 1–300 characters");
  const title = input.title.trim();
  let companyId = board.company_id;
  if (companyId == null) {
    const platform = FETCHABLE_BOARD.has(board.board_type) ? board.board_type : null;
    const slug = platform && board.board_key ? board.board_key : null;
    companyId = upsertCompany({
      name: board.name, domain: board.domain, source: "ledger", tags: board.tags,
      ats_platform: platform, ats_slug: slug, resolved: !!(platform && slug),
    }).id;
    db.prepare("UPDATE board_registry SET company_id=?, updated_at=? WHERE id=? AND company_id IS NULL").run(companyId, nowIso(), board.id);
  }
  let source_url = typeof input.url === "string" ? input.url.trim() : "";
  if (source_url) {
    let parsed: URL;
    try { parsed = new URL(source_url); } catch { throw new Error("url must be an https URL"); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("url must be an https URL without credentials");
    if (linkedInHost(parsed.hostname)) throw new Error("url cannot be a LinkedIn host");
    source_url = parsed.toString();
  } else {
    const raw = (input.posting_id?.trim() || title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
    source_url = `manual://board/${board.id}/${raw || "role"}`;
  }
  const existing = db.prepare("SELECT id FROM jobs WHERE company_id=? AND source_url=?").get(companyId, source_url) as { id: number } | undefined;
  const jobId = existing?.id ?? Number(db.prepare(
    `INSERT INTO jobs (company_id, source_url, title, fetched_at, last_seen_at, still_live)
     VALUES (?, ?, ?, datetime('now'), datetime('now'), 1)`,
  ).run(companyId, source_url, title).lastInsertRowid);
  if (existing) db.prepare("UPDATE jobs SET title=?, still_live=1, last_seen_at=datetime('now') WHERE id=?").run(title, jobId);
  recordApplication(jobId, { status: "applied", notes: input.note ?? null });
  return { board_id: board.id, job_id: jobId, company_id: companyId };
}
