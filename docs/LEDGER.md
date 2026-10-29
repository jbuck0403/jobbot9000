# Job-board ledger

An empty, append-only record of company job boards. It answers "how long since we checked Studio Y?", "what was new?", "how many applications went to this company?", and "which positions?". It does not fetch by itself and it does not ship with studios filled in. `seeds/companies.json` stays empty and is a different list (the curated `find_companies` roster).

The personal `events` journal is still the candidate's journey (assessments, interviews, applications). Board checks live in `board_events` so hundreds of studio polls do not bury that timeline. Discovery's read ledger (`src/discovery-ledger.ts`) is a third thing: a request budget for the offline discovery loop. This document is only the company/board ledger.

## Board types

`board_type` is a slug, not a closed list. These are understood today:

| type | fetched by `gather`? |
|---|---|
| `greenhouse`, `ashby`, `lever`, `workable` | yes, public board API |
| `workday` | yes. `board_key` is `tenant.wdN.site` (for example `nature.wd108.externalcareers`). A `myworkdayjobs.com` careers URL is accepted and parsed. |
| `smartrecruiters` | yes. `board_key` is the company identifier (`smartrecruiters`). A `jobs.smartrecruiters.com` URL is accepted. |
| `custom`, `browser` | no fetcher — put the careers page in `careers_url` and record checks by hand |

`board_key` for Greenhouse, Ashby, and Workable is the public board slug, stored lowercase (`riotgames`, `mcfarlane-aviation`). Lever keeps the slug's case (`Convai` is not `convai`) because Lever's postings path is case-sensitive. A re-import of the same board updates that row. A browser board can omit the key and is identified by type + name. `jobbot boards detect <url>` tells you the type and key without registering or fetching.

Tags are short slugs such as `game-studio`. Set them at register time or with `jobbot boards update --id <id> --tags a,b`. `active: false` hides a board from the stale list without deleting history. `--tag` filters `list`, `stale`, `check`, and `stats`.

## Events

Events are insert-only. The database rejects updates and deletes. Known kinds:

- `board_registered` — written once when the row is created
- `board_checked` — a poll. `payload.method` is `ats_api` (from `gather` or `jobbot boards check`), `manual`, or `browser`. Includes `postings_found`, `new_postings`, `closed_postings`, `truncated` when the cap stopped the list, `http_status` when the board responded with one, and `error` with the real message (HTTP status, timeout, or host error) when the check failed
- `posting_seen` / `posting_returned` / `posting_gone` — one posting. `gather` writes these from the diff
- `application_submitted` / `application_status` — written by `record_application` when the job's company matches a registered board (same `company_id`, or same type + slug). `interested` is a status change, not a submission. Exact repeats add nothing
- `note`, `contact` — freeform. Any other short snake_case kind is stored and shows up in the feed; stats ignore it

`open_postings_seen` is the set of posting URLs still open. If a check only reported a count (`postings_found`) and there are no posting rows, that count is used instead.

`hours_since_last_check` is computed when you read, from the latest **successful** `board_checked` (`last_success_at`). A failed check updates `last_attempt_at`, `consecutive_failures`, and `last_error`, and it does not move that clock. `total_checks` still counts the failed attempt. A board that has never succeeded is stale for every threshold. Inactive boards are left off the stale list. Failing boards stay visible via `consecutive_failures` and `last_error`.

Stats for list and stale come from `board_summary`, a per-board row maintained when an event is appended. `board_events` stays append-only. `idx_board_events_kind` and `idx_board_summary_success` keep those reads from scanning the whole log.

## MCP

- `detect_board` — careers URL in, ATS type and board identifier out. No fetch and no write. Unknown sites come back as `custom`.
- `register_board` — create or update. The same `board_type` + `board_key` updates name, domain, careers URL, tags, notes, and active. It does not rewrite events. A Workday careers URL or SmartRecruiters jobs URL is parsed into `board_key`.
- `record_board_event` — append a note, contact, manual/browser check, or posting. `job_id` must already exist.
- `look({ at: 'boards', stale_hours, tag, limit, offset, full })` — compact rows by default (no open-position arrays). `full: true` adds them. `limit` defaults to 100 and the result includes `next_offset` when another page remains
- `look({ at: 'board', board_id })` — one company, including positions applied to and what was new on the last check
- `look({ at: 'board_events', board_id, limit })` — newest first
- `gather({ step: 'fetch_jobs', ats_platform, ats_slug, limit, cursor, details, max_postings })` — live fetch, and a check event when a row is already registered. It does not register the company for you. An unscoped call fetches 5 companies per call (pass `limit` to change that) and returns `next_cursor`. `details` is `none` (list fields), `new` (detail pages only for URLs not already stored), or `all`. A truncated page does not mark the unseen jobs gone. Long runs belong on `jobbot boards check`, which is not bound to the MCP client's timeout

Nothing here applies to a job or sends a message. LinkedIn careers URLs are rejected.

## CLI

From a built checkout (`npm run build`), `bin/jobbot.mjs` uses the same state folder as the MCP server. Both call `prepareStorage`:

- `STATE_DIR` — absolute path inside a `.private` directory
- `JOBBOT_PRIVATE_DIR` — that `.private` directory; state is `<dir>/state` when `STATE_DIR` is unset
- neither set — `~/.jobbot/.private/state`
- `jobbot boards --state-dir <absolute path inside .private>` — one CLI run

`list --json` is a compact page (`--limit` defaults to 100, `--offset` walks it, `next_offset` is set when more rows remain). `--full` or `--fields id,name,tags` selects more. `stats` includes `positions_applied_to`.

```bash
node bin/jobbot.mjs boards list --tag game-studio --json
node bin/jobbot.mjs boards stale --hours 48 --tag game-studio --json
node bin/jobbot.mjs boards add --name "Example Studio" --type greenhouse --key examplestudio --tags game-studio --json
node bin/jobbot.mjs boards update --id 1 --tags game-studio,remote --json
node bin/jobbot.mjs boards import studios.json
node bin/jobbot.mjs boards import studios.csv
node bin/jobbot.mjs boards check --tag game-studio --concurrency 4 --details none --json
node bin/jobbot.mjs boards check 1 2 --stale-hours 48 --details new --max-postings 200 --json
node bin/jobbot.mjs boards apply 1 --title "Gameplay Engineer" --url https://boards.greenhouse.io/example/jobs/1 --note "submitted on the site" --json
node bin/jobbot.mjs boards record-manual-check 2 --postings 7 --note "counted in the browser" --json
node bin/jobbot.mjs boards add --name "Browser Studio" --type browser --careers-url https://careers.example.com/jobs --json
node bin/jobbot.mjs boards detect https://jobs.lever.co/Convai --json
node bin/jobbot.mjs boards add --name "Nature" --type workday --careers-url https://nature.wd108.myworkdayjobs.com/ExternalCareers --json
node bin/jobbot.mjs boards stats --id 1 --json
node bin/jobbot.mjs boards show --id 1
```

Import JSON is an array or `{ "boards": [ ... ] }` with `name`, `board_type`, and optional `board_key`, `domain`, `careers_url`, `tags`, `notes`, `active`. CSV uses that header. Put several tags in one CSV cell separated by `;`. Importing a board that is already registered updates it and does not insert a second row.

`boards check` fetches, stores postings, and appends the check. It is the command to use for a long pass. `--details` defaults to `none` (title, location, URL). `new` fetches a detail page only for a posting URL that is not stored yet. `all` fetches every detail page. `--max-postings` defaults from `JOBBOT_MAX_POSTINGS` (500). A truncated result is reported and does not mark the missing postings gone. `custom` and `browser` rows are skipped; use `record-manual-check` so they still get a last-success time. `--concurrency` defaults to 4 and caps at 8.

`boards apply` records an application the user already submitted. It does not submit anything. `stats` then lists that position instead of `positions: none`.

`--json` prints one JSON document on stdout. Exit `0` is success, `1` is a rejected command, `2` is usage.

`JOBBOT_NETWORK=off` does not disable the ledger. It stops `check` and `gather` from using the network. Each live request times out after `JOBBOT_FETCH_TIMEOUT_MS` (default 20s), retries `JOBBOT_FETCH_RETRIES` times (default 2) with `JOBBOT_FETCH_BACKOFF_MS` (default 200, doubling). GET/HEAD retries cover timeouts, 429, and 5xx. POST retries a timeout only, so a Workday search that returned HTTP 500 is not sent again. Tests run with the network off and inject a fake `fetch`.

Workday and SmartRecruiters checks use the same ledger path as the other ATSes. A failed check stores the reason on `payload.error`: a wrong `wd` number, a renamed Workday site, a timeout, or an HTTP 4xx/5xx. An empty SmartRecruiters company and an unknown identifier both come back as an empty board (the public API returns 200 with no postings either way), so a zero-job SmartRecruiters check is not treated as a hard error. Workday no longer fetches a detail page for every posting unless `--details` asks for it.
