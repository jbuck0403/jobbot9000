// Long-running board checks for the CLI. One call can cover many boards; the
// MCP gather path stays bounded and returns a cursor instead. Nothing here
// applies to a job or sends a message. Inject fetchPage in tests so
// JOBBOT_NETWORK=off never touches the network.
import { BoardUnreachable, fetchBoardPage, postingCap, type BoardPage, type DetailMode, type FetchBoardOptions } from "./ats.js";
import * as DB from "./db.js";
import { NETWORK_DISABLED, configuredFetch, networkEnabled } from "./network.js";

const FETCHABLE = new Set(["ashby", "greenhouse", "lever", "workable", "workday", "smartrecruiters"]);

export interface CheckRequest {
  ids?: number[];
  staleHours?: number;
  tag?: string;
  concurrency?: number;
  details?: DetailMode;
  maxPostings?: number;
  now?: Date;
}
export interface CheckRow {
  board_id: number;
  name: string;
  board_type: string;
  board_key: string | null;
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
  http_status?: number | null;
  postings_found?: number;
  truncated?: boolean;
  recorded?: boolean;
}
export interface CheckResult {
  ok: boolean;
  checked: number;
  failed: number;
  skipped: number;
  results: CheckRow[];
}
export interface CheckDeps {
  fetchPage?: (platform: string, slug: string, opts: FetchBoardOptions) => Promise<BoardPage>;
}

function concurrencyOf(value: number | undefined): number {
  const n = value ?? 4;
  if (!Number.isInteger(n) || n < 1 || n > 8) throw new Error("concurrency must be an integer from 1 to 8");
  return n;
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function checkBoards(request: CheckRequest = {}, deps: CheckDeps = {}): Promise<CheckResult> {
  const now = request.now ?? new Date();
  const details = request.details ?? "none";
  if (details !== "none" && details !== "new" && details !== "all") throw new Error("details must be none, new, or all");
  const cap = postingCap(request.maxPostings);
  const concurrency = concurrencyOf(request.concurrency);
  const missing: CheckRow[] = [];
  let selected: DB.BoardStats[] = [];
  if (request.ids?.length) {
    for (const id of request.ids) {
      const board = DB.boardStats(id, now);
      if (!board) missing.push({ board_id: id, name: "", board_type: "", board_key: null, ok: false, error: `no board ${id}` });
      else selected.push(board);
    }
  } else if (request.staleHours !== undefined) {
    selected = DB.staleBoards(request.staleHours, now, { tag: request.tag, detail: false });
  } else {
    selected = DB.listBoardStats(now, { tag: request.tag, detail: false }).filter((board) => board.active);
  }

  const skipped: CheckRow[] = [];
  const todo: DB.BoardStats[] = [];
  for (const board of selected) {
    if (!FETCHABLE.has(board.board_type) || !board.board_key) {
      skipped.push({
        board_id: board.id, name: board.name, board_type: board.board_type, board_key: board.board_key,
        ok: false, skipped: true, reason: "no fetcher for this board; record a manual check instead",
      });
    } else todo.push(board);
  }

  const fetchPage = deps.fetchPage ?? ((platform: string, slug: string, opts: FetchBoardOptions) => fetchBoardPage(platform as "greenhouse", slug, configuredFetch, opts));
  const offline = !deps.fetchPage && !networkEnabled();

  const fetched = await mapPool(todo, concurrency, async (board) => {
    if (offline) return { board, error: new Error(NETWORK_DISABLED), status: null as number | null };
    const linked = board.company_id ?? DB.getCompanyByAts(board.board_type, board.board_key!)?.id ?? null;
    const known = details === "new" && linked != null ? new Set(DB.jobSourceUrls(linked)) : undefined;
    try {
      const page = await fetchPage(board.board_type, board.board_key!, { details, maxPostings: cap, knownUrls: known });
      return { board, page };
    } catch (error) {
      const status = error instanceof BoardUnreachable ? error.status : null;
      return { board, error, status };
    }
  });

  const results: CheckRow[] = [...missing, ...skipped];
  for (const item of fetched) {
    const board = item.board;
    if ("error" in item && item.error) {
      const message = item.error instanceof Error ? item.error.message : String(item.error);
      const recorded = DB.recordBoardFetch({
        board_type: board.board_type,
        board_key: board.board_key!,
        company_id: board.company_id ?? 0,
        unreachable: true,
        error: message,
        http_status: item.status,
        seen: 0,
        updated: 0,
        new_postings: [],
        returned_postings: [],
        closed_postings: [],
      });
      results.push({
        board_id: board.id, name: board.name, board_type: board.board_type, board_key: board.board_key,
        ok: false, error: message, http_status: item.status, recorded: recorded.recorded,
      });
      continue;
    }
    const page = item.page!;
    let companyId = board.company_id;
    if (companyId == null) {
      companyId = DB.upsertCompany({
        name: board.name, domain: board.domain, source: "ledger", tags: board.tags,
        ats_platform: board.board_type, ats_slug: board.board_key, resolved: true,
      }).id;
    }
    const saved = DB.upsertJobs(companyId, page.jobs, { closeMissing: !page.truncated });
    const recorded = DB.recordBoardFetch({
      board_type: board.board_type,
      board_key: board.board_key!,
      company_id: companyId,
      seen: saved.seen,
      updated: saved.updated,
      truncated: page.truncated,
      new_postings: saved.new_postings,
      returned_postings: saved.returned_postings,
      closed_postings: saved.closed_postings,
    });
    results.push({
      board_id: board.id, name: board.name, board_type: board.board_type, board_key: board.board_key,
      ok: true, postings_found: saved.seen, truncated: page.truncated, recorded: recorded.recorded,
    });
  }
  const failed = results.filter((row) => !row.ok && !row.skipped).length;
  return {
    ok: failed === 0 && missing.length === 0,
    checked: results.filter((row) => row.ok).length,
    failed,
    skipped: skipped.length,
    results,
  };
}
