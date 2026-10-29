// Shell surface for the job-board ledger. Reads and writes go through db.ts.
// JSON goes to stdout when --json is set, so a non-Claude assistant can script it.
import { readFileSync } from "node:fs";
import { detectBoard } from "./board-id.js";
import { checkBoards } from "./board-check.js";
import * as DB from "./db.js";

export interface BoardCliIO {
  out(text: string): void;
  error(text: string): void;
}

const USAGE = `Usage:
  jobbot boards list [--tag <tag>] [--limit <n>] [--offset <n>] [--full] [--fields <a,b>] [--json]
  jobbot boards stale --hours <n> [--tag <tag>] [--limit <n>] [--offset <n>] [--json]
  jobbot boards show --id <id> [--json]
  jobbot boards stats --id <id> [--json]
  jobbot boards stats --tag <tag> [--json]
  jobbot boards add --name <name> --type <type> [--key <slug>] [--domain <host>] [--careers-url <https-url>] [--tags <a,b>] [--notes <text>] [--active|--inactive] [--json]
  jobbot boards update --id <id> [--name <name>] [--tags <a,b>] [--notes <text>] [--active|--inactive] [--json]
  jobbot boards import <file.json|file.csv> [--json]
  jobbot boards check [<id>...] [--stale-hours <n>] [--tag <tag>] [--concurrency <n>] [--details none|new|all] [--max-postings <n>] [--json]
  jobbot boards apply <id> --title <title> [--url <https-url>] [--posting-id <id>] [--note <text>] [--json]
  jobbot boards record-manual-check <id> --postings <n> [--note <text>] [--json]
  jobbot boards event --id <id> --kind <kind> --summary <text> [--job-id <id>] [--payload <json>] [--ts <iso8601>] [--json]
  jobbot boards events [--id <id>] [--limit <n>] [--json]
  jobbot boards detect <url> [--json]

State is the same folder the MCP server uses: ~/.jobbot/.private/state unless STATE_DIR or JOBBOT_PRIVATE_DIR is set. --state-dir <absolute path inside .private> selects one run.
Lever board keys keep their case. Other ATS keys are stored lowercase.
A failed check does not move hours_since_last_check. list --json is a compact page; pass --full for positions.
custom and browser boards are not fetched. Record them with record-manual-check.
The ledger starts empty. Nothing is auto-applied and no message is sent.`;

const BOOLEAN = new Set(["json", "active", "inactive", "help", "full"]);
const COMPACT_FIELDS = [
  "id", "name", "board_type", "board_key", "active", "tags",
  "last_success_at", "last_attempt_at", "last_checked_at", "hours_since_last_check",
  "consecutive_failures", "last_error", "total_checks", "open_postings_seen", "applications_submitted",
] as const;

function parseArgs(args: string[]): { command: string; flags: Record<string, string | boolean>; positionals: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") { flags.help = true; continue; }
    if (!arg.startsWith("--")) { positionals.push(arg); continue; }
    const name = arg.slice(2);
    if (!name) throw new Error("invalid flag");
    if (BOOLEAN.has(name)) { flags[name] = true; continue; }
    const value = args[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
    flags[name] = value;
  }
  return { command: positionals[0] ?? "list", flags, positionals: positionals.slice(1) };
}
function flag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`--${name} needs a value`);
  return value;
}
function intFlag(flags: Record<string, string | boolean>, name: string): number | undefined {
  const value = flag(flags, name);
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`--${name} must be a positive integer`);
  return Number(value);
}
function countFlag(flags: Record<string, string | boolean>, name: string): number | undefined {
  const value = flag(flags, name);
  if (value === undefined) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`--${name} must be a non-negative integer`);
  return Number(value);
}
function hoursFlag(flags: Record<string, string | boolean>, name: string): number | undefined {
  const value = flag(flags, name);
  if (value === undefined) return undefined;
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`--${name} must be a non-negative number of hours`);
  return Number(value);
}
function emit(io: BoardCliIO, jsonMode: boolean, payload: unknown, text: string): void {
  io.out(jsonMode ? JSON.stringify(payload, null, 2) : text);
}
function requireId(flags: Record<string, string | boolean>): number {
  const id = intFlag(flags, "id");
  if (id === undefined) throw new Error("--id is required");
  return id;
}
function tagsOf(flags: Record<string, string | boolean>): string[] | undefined {
  const tags = flag(flags, "tags");
  if (tags === undefined) return undefined;
  return tags.split(",").map((tag) => tag.trim()).filter(Boolean);
}
function project(board: DB.BoardStats, full: boolean, fields: string[] | undefined): Record<string, unknown> {
  const source = board as unknown as Record<string, unknown>;
  if (fields?.length) {
    const out: Record<string, unknown> = {};
    for (const name of fields) out[name] = source[name];
    return out;
  }
  if (full) return source;
  const out: Record<string, unknown> = {};
  for (const name of COMPACT_FIELDS) out[name] = source[name];
  return out;
}
function pageOpts(flags: Record<string, string | boolean>, detail: boolean | "applications") {
  return {
    tag: flag(flags, "tag"),
    limit: (intFlag(flags, "limit") ?? 100) + 1,
    offset: countFlag(flags, "offset") ?? 0,
    detail,
  };
}
function splitPage<T>(rows: T[], flags: Record<string, string | boolean>): { page: T[]; limit: number; offset: number; next_offset?: number } {
  const limit = intFlag(flags, "limit") ?? 100;
  const offset = countFlag(flags, "offset") ?? 0;
  const more = rows.length > limit;
  return { page: more ? rows.slice(0, limit) : rows, limit, offset, ...(more ? { next_offset: offset + limit } : {}) };
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].split(",").map((cell) => cell.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    header.forEach((name, index) => { row[name] = (cells[index] ?? "").trim(); });
    return row;
  });
}
function boardsFromImport(text: string, file: string): DB.RegisterBoardInput[] {
  const jsonLike = file.toLowerCase().endsWith(".json") || text.trim().startsWith("[") || text.trim().startsWith("{");
  const rows: Record<string, unknown>[] = [];
  if (jsonLike) {
    const parsed = JSON.parse(text) as unknown;
    const list = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" && Array.isArray((parsed as { boards?: unknown }).boards) ? (parsed as { boards: unknown[] }).boards : null);
    if (!list) throw new Error("import JSON must be an array or { boards: [] }");
    for (const item of list) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("each imported board must be an object");
      rows.push(item as Record<string, unknown>);
    }
  } else {
    rows.push(...parseCsv(text));
  }
  return rows.map((row) => {
    const name = String(row.name ?? "");
    const board_type = String(row.board_type ?? row.type ?? "");
    if (!name || !board_type) throw new Error("each board needs name and board_type");
    const rawTags = row.tags;
    const tags = Array.isArray(rawTags)
      ? rawTags.map(String)
      : typeof rawTags === "string" && rawTags
        ? rawTags.split(/[;,]/).map((tag) => tag.trim()).filter(Boolean)
        : undefined;
    const active = row.active === undefined || row.active === "" ? undefined : row.active === true || row.active === "true" || row.active === "1";
    return {
      name,
      board_type,
      board_key: row.board_key == null || row.board_key === "" ? (row.key == null || row.key === "" ? undefined : String(row.key)) : String(row.board_key),
      domain: row.domain == null || row.domain === "" ? undefined : String(row.domain),
      careers_url: row.careers_url == null || row.careers_url === "" ? undefined : String(row.careers_url),
      tags,
      notes: row.notes == null || row.notes === "" ? undefined : String(row.notes),
      active,
    };
  });
}

export async function runBoardCli(args: string[], io: BoardCliIO): Promise<number> {
  let parsed: { command: string; flags: Record<string, string | boolean>; positionals: string[] };
  try { parsed = parseArgs(args); }
  catch (error) { io.error(error instanceof Error ? error.message : "invalid arguments"); io.error(USAGE); return 2; }
  const { command, flags, positionals } = parsed;
  const jsonMode = flags.json === true;
  try {
    if (command === "help" || flags.help === true) { io.out(USAGE); return 0; }
    if (command === "detect") {
      if (positionals.length > 1) throw new Error("unexpected extra arguments");
      const url = positionals[0] ?? flag(flags, "url");
      if (!url) throw new Error("pass a careers URL: jobbot boards detect <url>");
      const detected = detectBoard(url);
      emit(io, jsonMode, detected, [
        `${detected.board_type}${detected.board_key ? `\t${detected.board_key}` : ""}`,
        detected.careers_url,
        ...(detected.note ? [detected.note] : []),
      ].join("\n"));
      return 0;
    }
    if (command === "list" || command === "stale") {
      if (positionals.length) throw new Error("unexpected extra arguments");
      const hours = hoursFlag(flags, command === "stale" ? "hours" : "stale-hours");
      if (command === "stale" && hours === undefined) throw new Error("--hours is required");
      const full = flags.full === true;
      const fields = flag(flags, "fields")?.split(",").map((name) => name.trim()).filter(Boolean);
      const loaded = hours === undefined
        ? DB.listBoardStats(new Date(), pageOpts(flags, full))
        : DB.staleBoards(hours, new Date(), pageOpts(flags, full));
      const { page, limit, offset, next_offset } = splitPage(loaded, flags);
      const boards = page.map((board) => project(board, full, fields));
      const payload = { ...(hours === undefined ? {} : { older_than_hours: hours }), ...(flag(flags, "tag") ? { tag: flag(flags, "tag") } : {}), limit, offset, ...(next_offset !== undefined ? { next_offset } : {}), boards, ...(boards.length ? {} : { note: "No boards registered. The ledger is empty." }) };
      const lines = boards.length
        ? page.map((board) => `${board.id}\t${board.active ? "active" : "inactive"}\t${board.board_type}\t${board.board_key ?? "-"}\t${board.name}\tchecked=${board.last_checked_at ?? "never"}\thours=${board.hours_since_last_check ?? "-"}\tfails=${board.consecutive_failures}\tchecks=${board.total_checks}\topen=${board.open_postings_seen}\tapplications=${board.applications_submitted}${board.last_error ? `\terror=${board.last_error}` : ""}`)
        : ["No boards registered. The ledger is empty.", "Add one with: jobbot boards add --name \"Example Studio\" --type greenhouse --key example --tags game-studio"];
      emit(io, jsonMode, payload, lines.join("\n"));
      return 0;
    }
    if (command === "show" || command === "stats") {
      if (positionals.length) throw new Error("unexpected extra arguments");
      const tag = flag(flags, "tag");
      if (command === "stats" && tag && flags.id === undefined) {
        const loaded = DB.listBoardStats(new Date(), { tag, detail: "applications", limit: (intFlag(flags, "limit") ?? 100) + 1, offset: countFlag(flags, "offset") ?? 0 });
        const { page, limit, offset, next_offset } = splitPage(loaded, flags);
        const boards = page.map((board) => ({
          id: board.id, name: board.name, board_type: board.board_type, board_key: board.board_key,
          applications_submitted: board.applications_submitted, positions_applied_to: board.positions_applied_to,
          hours_since_last_check: board.hours_since_last_check, consecutive_failures: board.consecutive_failures, last_error: board.last_error,
        }));
        emit(io, jsonMode, { tag, limit, offset, ...(next_offset !== undefined ? { next_offset } : {}), boards }, boards.length
          ? boards.map((board) => `${board.id}\t${board.name}\t${board.positions_applied_to.length ? board.positions_applied_to.map((position) => `${position.title ?? position.job_id} [${position.status}]`).join("; ") : "positions: none"}`).join("\n")
          : `No boards tagged ${tag}.`);
        return 0;
      }
      const stats = DB.boardStats(requireId(flags));
      if (!stats) throw new Error(`no board ${flags.id}`);
      if (command === "stats") {
        emit(io, jsonMode, { stats }, [
          `${stats.name} (${stats.board_type}${stats.board_key ? `/${stats.board_key}` : ""})`,
          `active=${stats.active} last_success=${stats.last_success_at ?? "never"} last_attempt=${stats.last_attempt_at ?? "never"} hours_since=${stats.hours_since_last_check ?? "-"} failures=${stats.consecutive_failures}`,
          `checks=${stats.total_checks} open_postings=${stats.open_postings_seen} applications=${stats.applications_submitted}`,
          stats.positions_applied_to.length ? `positions: ${stats.positions_applied_to.map((position) => `${position.title ?? position.job_id} [${position.status}]`).join("; ")}` : "positions: none",
          stats.last_check ? `last check: ${stats.last_check.postings_found ?? "?"} found, ${stats.last_check.new_postings ?? "?"} new${stats.last_check.error ? `, error=${stats.last_check.error}` : ""}${stats.last_check.truncated ? ", truncated" : ""}` : "last check: none",
        ].join("\n"));
        return 0;
      }
      const events = DB.recentBoardEvents({ board_id: stats.id, limit: intFlag(flags, "limit") ?? 20 });
      emit(io, jsonMode, { stats, events }, [
        `${stats.name} [${stats.id}] ${stats.board_type}${stats.board_key ? `/${stats.board_key}` : ""} active=${stats.active} tags=${stats.tags.join(",") || "-"}`,
        `checked=${stats.last_checked_at ?? "never"} hours=${stats.hours_since_last_check ?? "-"} checks=${stats.total_checks} open=${stats.open_postings_seen} applications=${stats.applications_submitted} failures=${stats.consecutive_failures}`,
        ...events.map((event) => `${event.ts}\t${event.kind}\t${event.summary}`),
      ].join("\n"));
      return 0;
    }
    if (command === "add") {
      if (positionals.length) throw new Error("unexpected extra arguments");
      const name = flag(flags, "name");
      const board_type = flag(flags, "type");
      if (!name || !board_type) throw new Error("--name and --type are required");
      if (flags.active === true && flags.inactive === true) throw new Error("pass only one of --active or --inactive");
      const saved = DB.registerBoard({
        name,
        board_type,
        board_key: flag(flags, "key"),
        domain: flag(flags, "domain"),
        careers_url: flag(flags, "careers-url"),
        tags: tagsOf(flags),
        notes: flag(flags, "notes"),
        active: flags.active === true ? true : flags.inactive === true ? false : undefined,
      });
      const stats = DB.boardStats(saved.id);
      emit(io, jsonMode, { ok: true, ...saved, stats }, `${saved.inserted ? "registered" : "updated"} board ${saved.id} ${stats?.name ?? name}`);
      return 0;
    }
    if (command === "update") {
      if (positionals.length) throw new Error("unexpected extra arguments");
      if (flags.active === true && flags.inactive === true) throw new Error("pass only one of --active or --inactive");
      const saved = DB.updateBoard({
        id: requireId(flags),
        name: flag(flags, "name"),
        tags: tagsOf(flags),
        notes: flag(flags, "notes"),
        active: flags.active === true ? true : flags.inactive === true ? false : undefined,
        domain: flag(flags, "domain"),
        careers_url: flag(flags, "careers-url"),
      });
      const stats = DB.boardStats(saved.id);
      emit(io, jsonMode, { ok: true, stats }, `updated board ${saved.id} ${stats?.name ?? ""}`.trim());
      return 0;
    }
    if (command === "import") {
      if (positionals.length !== 1) throw new Error("pass one JSON or CSV file");
      const file = positionals[0];
      const inputs = boardsFromImport(readFileSync(file, "utf8"), file);
      const boards = inputs.map((input) => {
        const saved = DB.registerBoard(input);
        return { ...saved, name: input.name, board_type: input.board_type, board_key: DB.boardStats(saved.id)?.board_key ?? null };
      });
      emit(io, jsonMode, { ok: true, count: boards.length, boards }, boards.map((board) => `${board.inserted ? "registered" : "updated"}\t${board.id}\t${board.board_type}\t${board.board_key ?? "-"}\t${board.name}`).join("\n") || "No boards in file.");
      return 0;
    }
    if (command === "check") {
      const ids = positionals.map((value) => {
        if (!/^[1-9]\d*$/.test(value)) throw new Error("board ids must be positive integers");
        return Number(value);
      });
      const details = flag(flags, "details") ?? "none";
      if (details !== "none" && details !== "new" && details !== "all") throw new Error("--details must be none, new, or all");
      const result = await checkBoards({
        ids: ids.length ? ids : undefined,
        staleHours: hoursFlag(flags, "stale-hours"),
        tag: flag(flags, "tag"),
        concurrency: intFlag(flags, "concurrency"),
        details,
        maxPostings: intFlag(flags, "max-postings"),
      });
      const lines = result.results.map((row) => row.skipped
        ? `${row.board_id}\tskipped\t${row.board_type}\t${row.reason}`
        : row.ok
          ? `${row.board_id}\tok\t${row.board_type}/${row.board_key}\tpostings=${row.postings_found}${row.truncated ? "\ttruncated" : ""}`
          : `${row.board_id}\tfailed\t${row.board_type}${row.board_key ? `/${row.board_key}` : ""}\t${row.error}`);
      emit(io, jsonMode, result, lines.join("\n") || "No boards to check.");
      return result.results.some((row) => row.error?.startsWith("no board")) ? 1 : 0;
    }
    if (command === "apply") {
      if (positionals.length !== 1) throw new Error("pass one board id");
      if (!/^[1-9]\d*$/.test(positionals[0])) throw new Error("board id must be a positive integer");
      const title = flag(flags, "title");
      if (!title) throw new Error("--title is required");
      const saved = DB.applyOnBoard({
        board_id: Number(positionals[0]),
        title,
        url: flag(flags, "url"),
        posting_id: flag(flags, "posting-id"),
        note: flag(flags, "note"),
      });
      const stats = DB.boardStats(saved.board_id);
      emit(io, jsonMode, { ok: true, ...saved, positions_applied_to: stats?.positions_applied_to ?? [] }, `recorded application ${saved.job_id} on board ${saved.board_id}: ${title}`);
      return 0;
    }
    if (command === "record-manual-check") {
      if (positionals.length !== 1) throw new Error("pass one board id");
      if (!/^[1-9]\d*$/.test(positionals[0])) throw new Error("board id must be a positive integer");
      const postings = countFlag(flags, "postings");
      if (postings === undefined) throw new Error("--postings is required");
      const event = DB.recordManualCheck({ board_id: Number(positionals[0]), postings, note: flag(flags, "note") });
      const stats = DB.boardStats(event.board_id);
      emit(io, jsonMode, { ok: true, event, stats }, `recorded manual check on board ${event.board_id}: ${postings} posting(s)`);
      return 0;
    }
    if (command === "event") {
      if (positionals.length) throw new Error("unexpected extra arguments");
      const board_id = requireId(flags);
      const kind = flag(flags, "kind");
      const summary = flag(flags, "summary");
      if (!kind || !summary) throw new Error("--kind and --summary are required");
      const rawPayload = flag(flags, "payload");
      let payload: Record<string, unknown> | undefined;
      if (rawPayload !== undefined) {
        const parsedPayload = JSON.parse(rawPayload) as unknown;
        if (!parsedPayload || typeof parsedPayload !== "object" || Array.isArray(parsedPayload)) throw new Error("--payload must be a JSON object");
        payload = parsedPayload as Record<string, unknown>;
      }
      const event = DB.appendBoardEvent({ board_id, kind, summary, payload, job_id: intFlag(flags, "job-id"), ts: flag(flags, "ts") });
      emit(io, jsonMode, { ok: true, event }, `appended ${event.kind} #${event.id} on board ${event.board_id}`);
      return 0;
    }
    if (command === "events") {
      if (positionals.length) throw new Error("unexpected extra arguments");
      const events = DB.recentBoardEvents({ board_id: intFlag(flags, "id"), limit: intFlag(flags, "limit") });
      emit(io, jsonMode, { events }, events.length ? events.map((event) => `${event.id}\t${event.ts}\tboard=${event.board_id}\t${event.kind}\t${event.summary}`).join("\n") : "No board events.");
      return 0;
    }
    io.error(USAGE);
    return 2;
  } catch (error) {
    io.error(error instanceof Error ? error.message : "board command failed");
    return 1;
  }
}
