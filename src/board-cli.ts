// Shell surface for the job-board ledger. Reads and writes go through db.ts.
// JSON goes to stdout when --json is set, so a non-Claude assistant can script it.
import * as DB from "./db.js";

export interface BoardCliIO {
  out(text: string): void;
  error(text: string): void;
}

const USAGE = `Usage:
  jobbot boards list [--stale-hours <n>] [--json]
  jobbot boards stale --hours <n> [--json]
  jobbot boards show --id <id> [--json]
  jobbot boards stats --id <id> [--json]
  jobbot boards add --name <name> --type <type> [--key <slug>] [--domain <host>] [--careers-url <https-url>] [--tags <a,b>] [--notes <text>] [--active|--inactive] [--json]
  jobbot boards event --id <id> --kind <kind> --summary <text> [--job-id <id>] [--payload <json>] [--ts <iso8601>] [--json]
  jobbot boards events [--id <id>] [--limit <n>] [--json]

The ledger starts empty. Register a board before expecting gather to record checks.
Workday, SmartRecruiters, custom, and browser are valid --type values; only Greenhouse, Ashby, Lever, and Workable are fetched today.`;

const BOOLEAN = new Set(["json", "active", "inactive"]);

function parseArgs(args: string[]): { command: string; flags: Record<string, string | boolean> } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") { flags.help = true; continue; }
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const name = arg.slice(2);
    if (!name) throw new Error("invalid flag");
    if (BOOLEAN.has(name)) { flags[name] = true; continue; }
    const value = args[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
    flags[name] = value;
  }
  if (positional.length > 1) throw new Error("unexpected extra arguments");
  return { command: positional[0] ?? "list", flags };
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

export function runBoardCli(args: string[], io: BoardCliIO): number {
  let parsed: { command: string; flags: Record<string, string | boolean> };
  try { parsed = parseArgs(args); }
  catch (error) { io.error(error instanceof Error ? error.message : "invalid arguments"); io.error(USAGE); return 2; }
  const { command, flags } = parsed;
  const jsonMode = flags.json === true;
  try {
    if (command === "help" || flags.help === true) { io.out(USAGE); return 0; }
    if (command === "list" || command === "stale") {
      const hours = hoursFlag(flags, command === "stale" ? "hours" : "stale-hours");
      if (command === "stale" && hours === undefined) throw new Error("--hours is required");
      const boards = hours === undefined ? DB.listBoardStats() : DB.staleBoards(hours);
      const payload = { ...(hours === undefined ? {} : { older_than_hours: hours }), boards, ...(boards.length ? {} : { note: "No boards registered. The ledger is empty." }) };
      const lines = boards.length
        ? boards.map((board) => `${board.id}\t${board.active ? "active" : "inactive"}\t${board.board_type}\t${board.board_key ?? "-"}\t${board.name}\tchecked=${board.last_checked_at ?? "never"}\thours=${board.hours_since_last_check ?? "-"}\tchecks=${board.total_checks}\topen=${board.open_postings_seen}\tapplications=${board.applications_submitted}`)
        : ["No boards registered. The ledger is empty.", "Add one with: jobbot boards add --name \"Example Studio\" --type greenhouse --key example --tags game-studio"];
      emit(io, jsonMode, payload, lines.join("\n"));
      return 0;
    }
    if (command === "show" || command === "stats") {
      const stats = DB.boardStats(requireId(flags));
      if (!stats) throw new Error(`no board ${flags.id}`);
      if (command === "stats") {
        emit(io, jsonMode, { stats }, [
          `${stats.name} (${stats.board_type}${stats.board_key ? `/${stats.board_key}` : ""})`,
          `active=${stats.active} last_checked=${stats.last_checked_at ?? "never"} hours_since=${stats.hours_since_last_check ?? "-"}`,
          `checks=${stats.total_checks} open_postings=${stats.open_postings_seen} applications=${stats.applications_submitted}`,
          stats.positions_applied_to.length ? `positions: ${stats.positions_applied_to.map((position) => `${position.title ?? position.job_id} [${position.status}]`).join("; ")}` : "positions: none",
          stats.last_check ? `last check: ${stats.last_check.postings_found ?? "?"} found, ${stats.last_check.new_postings ?? "?"} new${stats.last_check.error ? `, error=${stats.last_check.error}` : ""}` : "last check: none",
        ].join("\n"));
        return 0;
      }
      const events = DB.recentBoardEvents({ board_id: stats.id, limit: intFlag(flags, "limit") ?? 20 });
      emit(io, jsonMode, { stats, events }, [
        `${stats.name} [${stats.id}] ${stats.board_type}${stats.board_key ? `/${stats.board_key}` : ""} active=${stats.active}`,
        `checked=${stats.last_checked_at ?? "never"} hours=${stats.hours_since_last_check ?? "-"} checks=${stats.total_checks} open=${stats.open_postings_seen} applications=${stats.applications_submitted}`,
        ...events.map((event) => `${event.ts}\t${event.kind}\t${event.summary}`),
      ].join("\n"));
      return 0;
    }
    if (command === "add") {
      const name = flag(flags, "name");
      const board_type = flag(flags, "type");
      if (!name || !board_type) throw new Error("--name and --type are required");
      if (flags.active === true && flags.inactive === true) throw new Error("pass only one of --active or --inactive");
      const tags = flag(flags, "tags");
      const saved = DB.registerBoard({
        name,
        board_type,
        board_key: flag(flags, "key"),
        domain: flag(flags, "domain"),
        careers_url: flag(flags, "careers-url"),
        tags: tags === undefined ? undefined : tags.split(",").map((tag) => tag.trim()).filter(Boolean),
        notes: flag(flags, "notes"),
        active: flags.active === true ? true : flags.inactive === true ? false : undefined,
      });
      const stats = DB.boardStats(saved.id);
      emit(io, jsonMode, { ok: true, ...saved, stats }, `${saved.inserted ? "registered" : "updated"} board ${saved.id} ${stats?.name ?? name}`);
      return 0;
    }
    if (command === "event") {
      const board_id = requireId(flags);
      const kind = flag(flags, "kind");
      const summary = flag(flags, "summary");
      if (!kind || !summary) throw new Error("--kind and --summary are required");
      const rawPayload = flag(flags, "payload");
      let payload: Record<string, unknown> | undefined;
      if (rawPayload !== undefined) {
        const parsed = JSON.parse(rawPayload) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--payload must be a JSON object");
        payload = parsed as Record<string, unknown>;
      }
      const event = DB.appendBoardEvent({ board_id, kind, summary, payload, job_id: intFlag(flags, "job-id"), ts: flag(flags, "ts") });
      emit(io, jsonMode, { ok: true, event }, `appended ${event.kind} #${event.id} on board ${event.board_id}`);
      return 0;
    }
    if (command === "events") {
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
