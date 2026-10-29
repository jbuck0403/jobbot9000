# Job-board ledger

An empty, append-only record of company job boards. It answers "how long since we checked Studio Y?", "what was new?", "how many applications went to this company?", and "which positions?". It does not fetch by itself and it does not ship with studios filled in. `seeds/companies.json` stays empty and is a different list (the curated `find_companies` roster).

The personal `events` journal is still the candidate's journey (assessments, interviews, applications). Board checks live in `board_events` so hundreds of studio polls do not bury that timeline. Discovery's read ledger (`src/discovery-ledger.ts`) is a third thing: a request budget for the offline discovery loop. This document is only the company/board ledger.

## What you can store before a fetcher exists

`board_type` is a slug, not a closed list. These are understood today:

| type | fetched by `gather`? |
|---|---|
| `greenhouse`, `ashby`, `lever`, `workable` | yes, public board API |
| `workday`, `smartrecruiters` | no fetcher yet — register and record checks by hand |
| `custom`, `browser` | no fetcher yet — put the careers page in `careers_url` |

`board_key` is the public board slug (`riotgames`, `mcfarlane-aviation`) when there is one. A browser board can omit it and is identified by type + name.

Tags are short slugs such as `game-studio`. `active: false` hides a board from the stale list without deleting history.

## Events

Events are insert-only. The database rejects updates and deletes. Known kinds:

- `board_registered` — written once when the row is created
- `board_checked` — a poll. `payload.method` is `ats_api` (from `gather`), `manual`, or `browser`. Includes `postings_found`, `new_postings`, `closed_postings`, and `error` when the board could not be reached
- `posting_seen` / `posting_returned` / `posting_gone` — one posting. `gather` writes these from the diff
- `application_submitted` / `application_status` — written by `record_application` when the job's company matches a registered board (same `company_id`, or same type + slug). `interested` is a status change, not a submission. Exact repeats add nothing
- `note`, `contact` — freeform. Any other short snake_case kind is stored and shows up in the feed; stats ignore it

`open_postings_seen` is the set of posting URLs still open. If a check only reported a count (`postings_found`) and there are no posting rows, that count is used instead.

`hours_since_last_check` is computed when you read, from the latest `board_checked` timestamp. A board that has never been checked is stale for every threshold. Inactive boards are left off the stale list.

## MCP

- `register_board` — create or update. The same `board_type` + `board_key` updates name, domain, careers URL, tags, notes, and active. It does not rewrite events.
- `record_board_event` — append a note, contact, manual/browser check, or posting. `job_id` must already exist.
- `look({ at: 'boards', stale_hours })` — stats, or only boards not checked in that many hours
- `look({ at: 'board', board_id })` — one company, including positions applied to and what was new on the last check
- `look({ at: 'board_events', board_id, limit })` — newest first
- `gather({ step: 'fetch_jobs', ats_platform, ats_slug })` — live fetch, and a check event when a row is already registered. It does not register the company for you.

Nothing here applies to a job or sends a message. LinkedIn careers URLs are rejected.

## CLI

From a built checkout (`npm run build`), `bin/jobbot.mjs` talks to the same SQLite file as the server. State defaults to `./.private/state` (or `JOBBOT_PRIVATE_DIR` / `STATE_DIR`).

```bash
node bin/jobbot.mjs boards list --json
node bin/jobbot.mjs boards stale --hours 48 --json
node bin/jobbot.mjs boards add --name "Example Studio" --type greenhouse --key examplestudio --tags game-studio --json
node bin/jobbot.mjs boards add --name "Browser Studio" --type browser --careers-url https://careers.example.com/jobs --json
node bin/jobbot.mjs boards event --id 1 --kind note --summary "recruiter intro" --json
node bin/jobbot.mjs boards events --id 1 --json
node bin/jobbot.mjs boards stats --id 1 --json
node bin/jobbot.mjs boards show --id 1
```

`--json` prints one JSON document on stdout. Exit `0` is success, `1` is a rejected command, `2` is usage. A shell script can do `node bin/jobbot.mjs boards stale --hours 72 --json` and read `.boards`.

`JOBBOT_NETWORK=off` does not disable the ledger. It only stops `gather` from using the network. Tests run in that mode and inject a fake `fetch`.

## Left for later

Workday and SmartRecruiters adapters, and browser careers-page checks, are not implemented. Register those boards and append `board_checked` / `posting_seen` events yourself until a fetcher exists. The type and event columns do not need a migration when that lands.
