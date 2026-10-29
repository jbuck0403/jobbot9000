// Per-company job-board ledger. Append-only events, mutable registry.
// Ships empty: nothing in here inserts a company. Browser checks reuse the same
// board_type + event kinds. Only db.ts imports this module.
import { registrationIdentity } from "./board-id.js";
import { linkedInHost } from "./network.js";

interface SqlStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface Sql {
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
  transaction<T>(fn: () => T): () => T;
}

export const KNOWN_BOARD_TYPES = [
  "ashby", "greenhouse", "lever", "workable", "workday", "smartrecruiters", "custom", "browser",
] as const;

// Documented kinds. The column accepts any short snake_case slug so a later
// adapter can record a new kind without a migration. Stats understand the ones below.
export const BOARD_EVENT_KINDS = [
  "board_registered", "board_checked", "posting_seen", "posting_gone", "posting_returned",
  "application_submitted", "application_status", "note", "contact",
] as const;

const STAT_KINDS = [
  "board_checked", "posting_seen", "posting_gone", "posting_returned",
  "application_submitted", "application_status",
] as const;

const SUBMITTED_STATUSES = new Set(["applied", "interviewing", "offer", "rejected"]);

export interface RegisterBoardInput {
  name: string;
  board_type: string;
  board_key?: string | null;
  domain?: string | null;
  careers_url?: string | null;
  tags?: string[];
  notes?: string | null;
  active?: boolean;
}
export interface RegisterBoardResult { id: number; inserted: boolean }

export interface AppendBoardEventInput {
  board_id: number;
  kind: string;
  summary: string;
  payload?: Record<string, unknown> | null;
  ref?: string | null;
  ts?: string;
  job_id?: number;
}
export interface BoardEvent {
  id: number;
  board_id: number;
  ts: string;
  kind: string;
  summary: string;
  payload: Record<string, unknown> | null;
  ref: string | null;
}
export interface OpenPosition { job_id: number | null; title: string | null; source_url: string }
export interface PositionApplied { job_id: number | null; title: string | null; source_url: string | null; status: string | null }
export interface LastCheck {
  at: string;
  method: string | null;
  postings_found: number | null;
  new_postings: number | null;
  closed_postings: number | null;
  error: string | null;
  new_positions: OpenPosition[];
  closed_positions: OpenPosition[];
}
export interface BoardStats {
  id: number;
  name: string;
  domain: string | null;
  careers_url: string | null;
  board_type: string;
  board_key: string | null;
  tags: string[];
  notes: string | null;
  active: boolean;
  company_id: number | null;
  created_at: string;
  updated_at: string;
  last_checked_at: string | null;
  hours_since_last_check: number | null;
  total_checks: number;
  open_postings_seen: number;
  open_positions: OpenPosition[];
  applications_submitted: number;
  positions_applied_to: PositionApplied[];
  last_check: LastCheck | null;
}
export interface BoardFetchInput {
  board_type: string;
  board_key: string;
  company_id: number;
  unreachable?: boolean;
  error?: string | null;
  seen: number;
  updated: number;
  new_postings: { job_id: number; source_url: string; title: string | null }[];
  returned_postings: { job_id: number; source_url: string; title: string | null }[];
  closed_postings: { job_id: number; source_url: string; title: string | null }[];
}
export interface BoardFetchRecord { recorded: boolean; board_id?: number; event_id?: number }

interface BoardStored {
  id: number;
  name: string;
  domain: string | null;
  careers_url: string | null;
  board_type: string;
  board_key: string | null;
  tags: string | null;
  notes: string | null;
  active: number;
  company_id: number | null;
  created_at: string;
  updated_at: string;
}
interface EventStored {
  id: number;
  board_id: number;
  ts: string;
  kind: string;
  summary: string;
  payload_json: string | null;
  ref: string | null;
}

export function parseEventTime(ts: string): number {
  if (typeof ts !== "string") throw new Error("invalid timestamp");
  const sqlite = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(ts);
  const iso = sqlite ? `${sqlite[1]}T${sqlite[2]}Z` : ts;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(iso)) throw new Error("invalid timestamp");
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error("invalid timestamp");
  return ms;
}
export function nowIso(now = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}
function canonicalTs(ts: string): string {
  return new Date(parseEventTime(ts)).toISOString().replace(/\.\d{3}Z$/, "Z");
}
export function hoursSince(ts: string | null, now: Date): number | null {
  if (!ts) return null;
  return Math.round(((now.getTime() - parseEventTime(ts)) / 3_600_000) * 10) / 10;
}

function cleanName(name: string): string {
  if (typeof name !== "string") throw new Error("board name is required");
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 200) throw new Error("board name must be 1–200 characters");
  return trimmed;
}
function cleanType(type: string): string {
  if (typeof type !== "string") throw new Error("board_type is required");
  const slug = type.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,40}$/.test(slug))
    throw new Error("board_type must be a short slug such as greenhouse, workday, smartrecruiters, custom, or browser");
  return slug;
}
function cleanKey(key: string | null | undefined): string | null {
  if (key == null || key === "") return null;
  if (typeof key !== "string") throw new Error("board_key must be a slug");
  const slug = key.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,120}$/.test(slug)) throw new Error("board_key must be a slug (letters, numbers, '.', '_' or '-')");
  return slug;
}
function normalizeDomain(domain?: string | null): string | null {
  if (!domain) return null;
  const host = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
  return host || null;
}
function cleanCareersUrl(url: string | null | undefined): string | null {
  if (url == null || url === "") return null;
  if (typeof url !== "string") throw new Error("careers_url must be an https URL");
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("careers_url must be an https URL"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    throw new Error("careers_url must be an https URL without credentials");
  if (linkedInHost(parsed.hostname)) throw new Error("careers_url cannot be a LinkedIn host");
  return parsed.toString();
}
function validateTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string") throw new Error("tags must be strings");
    const cleaned = tag.trim().toLowerCase();
    if (!cleaned) continue;
    if (!/^[a-z0-9:_-]{1,64}$/.test(cleaned)) throw new Error(`invalid tag '${tag}'`);
    out.push(cleaned);
  }
  return [...new Set(out)].sort();
}
function serializeTags(tags: string[]): string | null {
  return tags.length ? tags.join(",") : null;
}
function parseTags(value: string | null): string[] {
  return value ? value.split(",").map((tag) => tag.trim()).filter(Boolean) : [];
}
function cleanNotes(notes: string | null | undefined): string | null {
  if (notes == null) return null;
  if (typeof notes !== "string") throw new Error("notes must be text");
  if (notes.length > 4000) throw new Error("notes must be at most 4000 characters");
  return notes;
}
function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  return Math.min(limit, max);
}
function payloadOf(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const value = JSON.parse(json) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}
function asString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function toEvent(row: EventStored): BoardEvent {
  const payload = row.payload_json ? payloadOf(row.payload_json) : null;
  return {
    id: row.id, board_id: row.board_id, ts: row.ts, kind: row.kind, summary: row.summary,
    payload: payload && Object.keys(payload).length ? payload : null,
    ref: row.ref,
  };
}
function positionFrom(payload: Record<string, unknown>): OpenPosition | null {
  const source_url = asString(payload.source_url);
  if (!source_url) return null;
  return { job_id: asNumber(payload.job_id), title: asString(payload.title), source_url };
}

function toStats(row: BoardStored, events: EventStored[], now: Date): BoardStats {
  const checks = events.filter((event) => event.kind === "board_checked");
  const last = checks.length ? checks[checks.length - 1] : undefined;
  const lastPayload = last ? payloadOf(last.payload_json) : {};
  const posting = events.filter((event) => event.kind === "posting_seen" || event.kind === "posting_gone" || event.kind === "posting_returned");
  const open = new Map<string, OpenPosition>();
  for (const event of posting) {
    const position = positionFrom(payloadOf(event.payload_json));
    if (!position) continue;
    if (event.kind === "posting_gone") open.delete(position.source_url);
    else open.set(position.source_url, position);
  }
  let open_postings_seen = open.size;
  if (posting.length === 0) {
    const found = asNumber(lastPayload.postings_found);
    if (found != null && found >= 0) open_postings_seen = found;
  }
  const byJob = new Map<string, { submitted: boolean; pos: PositionApplied }>();
  for (const event of events) {
    if (event.kind !== "application_submitted" && event.kind !== "application_status") continue;
    const payload = payloadOf(event.payload_json);
    const job_id = asNumber(payload.job_id) ?? (event.ref && /^\d+$/.test(event.ref) ? Number(event.ref) : null);
    const key = job_id != null ? `id:${job_id}` : `event:${event.id}`;
    const prev = byJob.get(key);
    byJob.set(key, {
      submitted: event.kind === "application_submitted" || prev?.submitted === true,
      pos: {
        job_id,
        title: asString(payload.title) ?? prev?.pos.title ?? null,
        source_url: asString(payload.source_url) ?? prev?.pos.source_url ?? null,
        status: asString(payload.status) ?? asString(payload.to) ?? prev?.pos.status ?? null,
      },
    });
  }
  const positions_applied_to = [...byJob.values()].filter((item) => item.submitted).map((item) => item.pos);
  const after = (kinds: string[]): OpenPosition[] => {
    if (!last) return [];
    const out: OpenPosition[] = [];
    for (const event of events) {
      if (event.id <= last.id || !kinds.includes(event.kind)) continue;
      const position = positionFrom(payloadOf(event.payload_json));
      if (position) out.push(position);
    }
    return out;
  };
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    careers_url: row.careers_url,
    board_type: row.board_type,
    board_key: row.board_key,
    tags: parseTags(row.tags),
    notes: row.notes,
    active: row.active === 1,
    company_id: row.company_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_checked_at: last?.ts ?? null,
    hours_since_last_check: last ? hoursSince(last.ts, now) : null,
    total_checks: checks.length,
    open_postings_seen,
    open_positions: [...open.values()],
    applications_submitted: positions_applied_to.length,
    positions_applied_to,
    last_check: last ? {
      at: last.ts,
      method: asString(lastPayload.method),
      postings_found: asNumber(lastPayload.postings_found),
      new_postings: asNumber(lastPayload.new_postings),
      closed_postings: asNumber(lastPayload.closed_postings),
      error: asString(lastPayload.error),
      new_positions: after(["posting_seen", "posting_returned"]),
      closed_positions: after(["posting_gone"]),
    } : null,
  };
}

export function createBoardLedger(db: Sql) {
  db.exec(`
CREATE TABLE IF NOT EXISTS board_registry (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  domain       TEXT,
  careers_url  TEXT,
  board_type   TEXT NOT NULL,
  board_key    TEXT,
  tags         TEXT,
  notes        TEXT,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  company_id   INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_board_registry_type_key
  ON board_registry(board_type, board_key) WHERE board_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_board_registry_type_name
  ON board_registry(board_type, lower(name)) WHERE board_key IS NULL;
CREATE TABLE IF NOT EXISTS board_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id     INTEGER NOT NULL REFERENCES board_registry(id),
  ts           TEXT NOT NULL,
  kind         TEXT NOT NULL,
  summary      TEXT NOT NULL,
  payload_json TEXT,
  ref          TEXT
);
CREATE INDEX IF NOT EXISTS idx_board_events_board ON board_events(board_id, id);
CREATE TRIGGER IF NOT EXISTS board_events_no_update
BEFORE UPDATE ON board_events
BEGIN
  SELECT RAISE(ABORT, 'append-only: board_events cannot be updated');
END;
CREATE TRIGGER IF NOT EXISTS board_events_no_delete
BEFORE DELETE ON board_events
BEGIN
  SELECT RAISE(ABORT, 'append-only: board_events cannot be deleted');
END;
`);

  const statKindSql = STAT_KINDS.map(() => "?").join(",");

  function readEvent(id: number): BoardEvent {
    const row = db.prepare("SELECT id, board_id, ts, kind, summary, payload_json, ref FROM board_events WHERE id=?").get(id) as EventStored | undefined;
    if (!row) throw new Error("board event was not stored");
    return toEvent(row);
  }
  function insertBoardEvent(input: {
    board_id: number; kind: string; summary: string;
    payload?: Record<string, unknown> | null; ref?: string | null; ts?: string;
  }): BoardEvent {
    const ts = input.ts ? canonicalTs(input.ts) : nowIso();
    const payload = input.payload && Object.keys(input.payload).length ? JSON.stringify(input.payload) : null;
    if (payload && payload.length > 8000) throw new Error("event payload is too large");
    const info = db.prepare(
      "INSERT INTO board_events (board_id, ts, kind, summary, payload_json, ref) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(input.board_id, ts, input.kind, input.summary, payload, input.ref ?? null);
    return readEvent(Number(info.lastInsertRowid));
  }
  function catalogCompanyId(board_type: string, board_key: string): number | null {
    const row = db.prepare(
      "SELECT id FROM companies WHERE lower(ats_platform)=? AND lower(ats_slug)=? ORDER BY id LIMIT 1",
    ).get(board_type, board_key) as { id: number } | undefined;
    return row?.id ?? null;
  }
  function findBoard(board_type: string, board_key: string | null, name: string): BoardStored | undefined {
    if (board_key) {
      const byKey = db.prepare("SELECT * FROM board_registry WHERE board_type=? AND board_key=?").get(board_type, board_key) as BoardStored | undefined;
      if (byKey) return byKey;
    }
    return db.prepare(
      "SELECT * FROM board_registry WHERE board_type=? AND board_key IS NULL AND lower(name)=lower(?)",
    ).get(board_type, name) as BoardStored | undefined;
  }
  function eventsFor(boardId: number): EventStored[] {
    return db.prepare(
      `SELECT id, board_id, ts, kind, summary, payload_json, ref FROM board_events
       WHERE board_id=? AND kind IN (${statKindSql}) ORDER BY id ASC`,
    ).all(boardId, ...STAT_KINDS) as EventStored[];
  }

  function registerBoard(input: RegisterBoardInput): RegisterBoardResult {
    const name = cleanName(input.name);
    const board_type = cleanType(input.board_type);
    const identity = registrationIdentity(board_type, input.board_key, input.careers_url);
    const lookupKey = identity ? identity.key : (input.board_key === undefined ? null : cleanKey(input.board_key));
    const nextKey = identity ? identity.key : (input.board_key === undefined ? undefined : cleanKey(input.board_key));
    const nextUrl = identity ? cleanCareersUrl(identity.careers_url) : (input.careers_url === undefined ? undefined : cleanCareersUrl(input.careers_url));
    return db.transaction((): RegisterBoardResult => {
      const existing = findBoard(board_type, lookupKey, name);
      const stamp = nowIso();
      if (!existing) {
        if ((board_type === "workday" || board_type === "smartrecruiters") && !nextKey)
          throw new Error(board_type === "workday"
            ? "workday boards need board_key tenant.wdN.site or a myworkdayjobs.com careers URL"
            : "smartrecruiters boards need a company identifier or a jobs.smartrecruiters.com URL");
        const key = nextKey === undefined ? null : nextKey;
        const tags = serializeTags(validateTags(input.tags ?? []));
        const domain = normalizeDomain(input.domain);
        const careers_url = nextUrl === undefined ? null : nextUrl;
        const notes = cleanNotes(input.notes);
        const active = input.active === false ? 0 : 1;
        const company_id = key ? catalogCompanyId(board_type, key) : null;
        const info = db.prepare(
          `INSERT INTO board_registry
             (name, domain, careers_url, board_type, board_key, tags, notes, active, company_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(name, domain, careers_url, board_type, key, tags, notes, active, company_id, stamp, stamp);
        const id = Number(info.lastInsertRowid);
        insertBoardEvent({
          board_id: id,
          kind: "board_registered",
          summary: `registered ${name} (${board_type}${key ? `/${key}` : ""})`,
          payload: { name, board_type, board_key: key, domain, careers_url, tags: parseTags(tags) },
          ts: stamp,
        });
        return { id, inserted: true };
      }
      const key = nextKey === undefined ? existing.board_key : nextKey;
      if (key && key !== existing.board_key) {
        const owner = db.prepare("SELECT id FROM board_registry WHERE board_type=? AND board_key=? AND id<>?").get(board_type, key, existing.id) as { id: number } | undefined;
        if (owner) throw new Error(`board ${board_type}/${key} is already registered`);
      }
      const keyChanged = key !== existing.board_key;
      let company_id = existing.company_id;
      if (key && (company_id == null || keyChanged)) {
        const found = catalogCompanyId(board_type, key);
        if (found) company_id = found;
        else if (keyChanged) company_id = null;
      }
      const domain = input.domain === undefined ? existing.domain : normalizeDomain(input.domain);
      const careers_url = nextUrl === undefined ? existing.careers_url : nextUrl;
      const tags = input.tags === undefined ? existing.tags : serializeTags(validateTags(input.tags));
      const notes = input.notes === undefined ? existing.notes : cleanNotes(input.notes);
      const active = input.active === undefined ? existing.active : (input.active ? 1 : 0);
      db.prepare(
        `UPDATE board_registry
           SET name=?, domain=?, careers_url=?, board_key=?, tags=?, notes=?, active=?, company_id=?, updated_at=?
         WHERE id=?`,
      ).run(name, domain, careers_url, key, tags, notes, active, company_id, stamp, existing.id);
      return { id: existing.id, inserted: false };
    })();
  }

  function appendBoardEvent(input: AppendBoardEventInput): BoardEvent {
    if (!Number.isSafeInteger(input.board_id) || input.board_id < 1) throw new Error("board_id must be a positive integer");
    const board = db.prepare("SELECT id FROM board_registry WHERE id=?").get(input.board_id) as { id: number } | undefined;
    if (!board) throw new Error(`no board ${input.board_id}`);
    if (typeof input.kind !== "string") throw new Error("event kind is required");
    const kind = input.kind.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(kind)) throw new Error("event kind must be a short snake_case slug");
    if (typeof input.summary !== "string") throw new Error("event summary is required");
    const summary = input.summary.trim();
    if (!summary || summary.length > 500) throw new Error("event summary must be 1–500 characters");
    const payload: Record<string, unknown> = { ...(input.payload ?? {}) };
    let ref = input.ref ?? null;
    if (ref != null && (typeof ref !== "string" || ref.length > 200)) throw new Error("ref must be a short string");
    if (input.job_id !== undefined) {
      if (!Number.isSafeInteger(input.job_id) || input.job_id < 1) throw new Error("job_id must be a positive integer");
      const job = db.prepare("SELECT id, title, source_url, company_id FROM jobs WHERE id=?").get(input.job_id) as { id: number; title: string | null; source_url: string; company_id: number } | undefined;
      if (!job) throw new Error(`no job ${input.job_id}`);
      payload.job_id = job.id;
      if (payload.title == null) payload.title = job.title;
      if (payload.source_url == null) payload.source_url = job.source_url;
      payload.company_id = job.company_id;
      ref = String(job.id);
    }
    if (kind === "board_checked" && payload.method == null) payload.method = "manual";
    return insertBoardEvent({ board_id: input.board_id, kind, summary, payload, ref, ts: input.ts });
  }

  function listBoardStats(now = new Date()): BoardStats[] {
    const rows = db.prepare("SELECT * FROM board_registry ORDER BY id").all() as BoardStored[];
    const grouped = new Map<number, EventStored[]>();
    const events = db.prepare(
      `SELECT id, board_id, ts, kind, summary, payload_json, ref FROM board_events
       WHERE kind IN (${statKindSql}) ORDER BY id ASC`,
    ).all(...STAT_KINDS) as EventStored[];
    for (const event of events) {
      const list = grouped.get(event.board_id);
      if (list) list.push(event);
      else grouped.set(event.board_id, [event]);
    }
    return rows
      .map((row) => toStats(row, grouped.get(row.id) ?? [], now))
      .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name) || a.id - b.id);
  }
  function boardStats(id: number, now = new Date()): BoardStats | undefined {
    if (!Number.isSafeInteger(id) || id < 1) return undefined;
    const row = db.prepare("SELECT * FROM board_registry WHERE id=?").get(id) as BoardStored | undefined;
    if (!row) return undefined;
    return toStats(row, eventsFor(id), now);
  }
  function staleBoards(olderThanHours: number, now = new Date()): BoardStats[] {
    if (typeof olderThanHours !== "number" || !Number.isFinite(olderThanHours) || olderThanHours < 0)
      throw new Error("olderThanHours must be a non-negative number");
    return listBoardStats(now)
      .filter((board) => board.active && (board.hours_since_last_check === null || board.hours_since_last_check >= olderThanHours))
      .sort((a, b) => {
        if (a.hours_since_last_check === null && b.hours_since_last_check === null) return a.name.localeCompare(b.name);
        if (a.hours_since_last_check === null) return -1;
        if (b.hours_since_last_check === null) return 1;
        return b.hours_since_last_check - a.hours_since_last_check || a.name.localeCompare(b.name);
      });
  }
  function recentBoardEvents(opts: { board_id?: number; limit?: number } = {}): BoardEvent[] {
    const limit = clampLimit(opts.limit, 50, 500);
    const rows = opts.board_id !== undefined
      ? db.prepare("SELECT id, board_id, ts, kind, summary, payload_json, ref FROM board_events WHERE board_id=? ORDER BY id DESC LIMIT ?").all(opts.board_id, limit)
      : db.prepare("SELECT id, board_id, ts, kind, summary, payload_json, ref FROM board_events ORDER BY id DESC LIMIT ?").all(limit);
    return (rows as EventStored[]).map(toEvent);
  }

  function recordPosting(kind: string, label: string, board_id: number, posting: BoardFetchInput["new_postings"][number]): void {
    const title = posting.title ?? posting.source_url;
    insertBoardEvent({
      board_id,
      kind,
      summary: `${label}: ${title}`.slice(0, 500),
      payload: { job_id: posting.job_id, title: posting.title, source_url: posting.source_url },
      ref: String(posting.job_id),
    });
  }
  function recordBoardFetch(input: BoardFetchInput): BoardFetchRecord {
    let board_type: string;
    let board_key: string | null;
    try {
      board_type = cleanType(input.board_type);
      board_key = cleanKey(input.board_key);
    } catch { return { recorded: false }; }
    if (!board_key) return { recorded: false };
    const board = db.prepare("SELECT * FROM board_registry WHERE board_type=? AND board_key=?").get(board_type, board_key) as BoardStored | undefined;
    if (!board) return { recorded: false };
    return db.transaction((): BoardFetchRecord => {
      if (board.company_id == null && Number.isSafeInteger(input.company_id)) {
        db.prepare("UPDATE board_registry SET company_id=?, updated_at=? WHERE id=? AND company_id IS NULL")
          .run(input.company_id, nowIso(), board.id);
      }
      const error = input.unreachable ? (input.error ?? "unreachable") : null;
      const payload: Record<string, unknown> = {
        method: "ats_api",
        postings_found: input.unreachable ? null : input.seen,
        new_postings: input.new_postings.length,
        returned_postings: input.returned_postings.length,
        closed_postings: input.closed_postings.length,
        updated_postings: input.updated,
        error,
      };
      const summary = input.unreachable
        ? `${board_type}/${board_key} check failed (${String(payload.error)})`
        : `${board_type}/${board_key} checked via ats_api: ${input.seen} posting(s), ${input.new_postings.length} new, ${input.closed_postings.length} gone`;
      const check = insertBoardEvent({ board_id: board.id, kind: "board_checked", summary, payload });
      if (!input.unreachable) {
        for (const posting of input.new_postings) recordPosting("posting_seen", "first seen", board.id, posting);
        for (const posting of input.returned_postings) recordPosting("posting_returned", "returned", board.id, posting);
        for (const posting of input.closed_postings) recordPosting("posting_gone", "gone", board.id, posting);
      }
      return { recorded: true, board_id: board.id, event_id: check.id };
    })();
  }

  function recordApplicationOnLedger(jobId: number, from: string | null, to: string): void {
    const job = db.prepare(
      `SELECT j.id, j.title, j.source_url, j.company_id, c.ats_platform, c.ats_slug
       FROM jobs j JOIN companies c ON c.id = j.company_id WHERE j.id = ?`,
    ).get(jobId) as { id: number; title: string | null; source_url: string; company_id: number; ats_platform: string | null; ats_slug: string | null } | undefined;
    if (!job) return;
    const platform = (job.ats_platform ?? "").toLowerCase();
    const slug = (job.ats_slug ?? "").toLowerCase();
    const matches = db.prepare(
      `SELECT id FROM board_registry WHERE company_id = ? OR (board_type = ? AND board_key = ?)`,
    ).all(job.company_id, platform, slug) as { id: number }[];
    const ids = [...new Set(matches.map((row) => row.id))];
    if (!ids.length) return;
    const wasSubmitted = from != null && SUBMITTED_STATUSES.has(from);
    const nowSubmitted = SUBMITTED_STATUSES.has(to);
    const kind = nowSubmitted && !wasSubmitted ? "application_submitted" : "application_status";
    const payload = {
      job_id: job.id, title: job.title, source_url: job.source_url, company_id: job.company_id, from, to, status: to,
    };
    const summary = kind === "application_submitted"
      ? `application submitted: ${job.title ?? `job ${job.id}`} → ${to}`
      : `application ${job.id} status ${from ?? "none"} → ${to}`;
    for (const board_id of ids) insertBoardEvent({ board_id, kind, summary, payload, ref: String(job.id) });
  }

  return {
    KNOWN_BOARD_TYPES,
    BOARD_EVENT_KINDS,
    registerBoard,
    appendBoardEvent,
    listBoardStats,
    boardStats,
    staleBoards,
    recentBoardEvents,
    recordBoardFetch,
    recordApplicationOnLedger,
    hoursSince,
    nowIso,
    parseEventTime,
  };
}
