# Offline company discovery

Stage (a) exposes a bounded library loop for an owner to test with synthetic
company, career-page and ATS fixtures. It has no installed network transport,
MCP registration, CLI, people discovery, sender or submission executor. The
separate `gather` door can fetch public Greenhouse, Ashby, Lever, and Workable
boards unless `JOBBOT_NETWORK=off`. This discovery-loop library still has no
live transport, and no environment setting enables one here. This does not
authorize any live discovery or real candidate input.

## Boundaries

`discoverCompanies({ id })` returns a preview without calling an adapter, store
or limiter. Execution needs `execute: true` and explicit injected dependencies:
a fixture adapter, a private checkpoint store, one shared read ledger, source
policies and optionally a scoring callback. `fixtureOnly: true` describes the
adapter contract; it cannot prove an arbitrary injected function is harmless.
Tests use fixture maps and the execution sandbox remains the network boundary.
No environment setting enables live transport for this loop. `JOBBOT_NETWORK`
only affects `gather` (public ATS, opt-in TheirStack, and public GitHub).

A source policy contains an exact host, allowed operations (`discover`,
`resolve`, `jobs`), a terms reference and checked/expiry timestamps. Policies are
synthetic in tests. No current external terms have been checked. The loop
rechecks policy after a limiter wait and on every redirect/retry; it blocks
non-HTTPS, credentials, IP literals, local/LinkedIn hosts and login/CAPTCHA paths.
A hostname allowlist is not DNS rebinding protection. A future live adapter must
validate resolved and connected public IPs at every redirect and needs separate
operator authorization. Unsupported sources stop explicitly.

The initial bounds are 25 companies, 100 requests per run, 500 requests per day,
one request per host at a time and one second between starts. Attempts and
redirects consume the request budgets. There are at most two retries for safe
reads on timeout, 429 or server error, and at most two redirects. Retry-After
values above 60 seconds stop the run for later review rather than truncating
server instructions. Use `privateReadLedger()` from `src/discovery-ledger.ts` for serial owner runs:
its atomic SQLite reservations preserve the global UTC-day count and host start
timestamps across ledger recreation and process restart. Share one ledger instance
to serialize in-flight reads and Retry-After cooldowns. `memoryReadLedger()` is a
synthetic in-process alternative; its counters reset on restart. Neither provides
cross-process in-flight locks; do not run independent owners concurrently.
Stage (e) scheduling and worker leases are not implemented.

## Workflow and persistence

The loop discovers paged company leads or starts from manual targets, normalizes
and deduplicates domains, resolves each career/board context, reads job pages,
deduplicates job URLs, and checkpoints phase/cursor/provenance after each step.
Provenance records the source URL, fetched time, source-reported confidence and
TTL. A caller can inject a synthetic scoring callback; absent that callback no
score is invented. Real preference-based grading remains with the owner and
existing mode-governed tools after the operator provides their private inputs.
This loop does not call a model or claim a verified role fit.

Import `privateDiscoveryStore` from `src/discovery-store.ts` only after configuring
private storage; that import opens the private DB. It saves schema-versioned run
JSON and an opaque journal event in one transaction. SQLite is the sole writer.
Findings stay in `.private`; `discoveryReceipt(run)` returns only opaque ID,
status and company/job/request counts for the executive. Detailed findings can
be read privately from the saved run by its owner. This is a discovery shortlist,
not an outbound review queue or approval to contact anyone.

Reuse of an existing run ID requires `resume: true`. A completed run is a no-op
unless `refreshStale: true` is explicitly requested and its evidence has expired.
Manual targets survive refresh; empty results have a TTL and `no_candidates`
reason. Cancellation/stops retain the last cursor and cumulative attempt count.
Missing (when resuming), unknown-version or corrupt state fails closed instead of starting over.
There is no automatic migration of earlier experimental run JSON. Preserve it
and start a new synthetic run ID or review a future migration explicitly.

Checkpointing and the journal are atomic. A crash after an external read but
before its checkpoint can repeat that safe read on resume. This offers no
exactly-once network guarantee. The private store is for a serial owner; concurrent
writers/worker scheduling are outside this slice. Real personal use is still
held pending transcript-retention review, regardless of database containment.

## ATS fixture bridge

`atsFixtureAdapter({ leadUrl, read })` in `src/discovery-ats.ts` supplies the
loop adapter. Every `read(url, signal)` is injected and must return synthetic
`Reply` objects. Lead bodies are `{ companies: Candidate[], next?: string }`;
career fixtures are `{ boardUrl: string }`; board fixtures use the official
Greenhouse, Lever, Ashby or Workable JSON shape. The board URL must match a known
public ATS endpoint. `normalizeAtsBoard` reuses the existing pure normalizers and
preserves the distinction between a valid empty board and malformed data.
No slug probing, HTML crawler or hidden fetches are introduced. All requested
URLs pass through the loop's policy/rate gate, including pagination/redirects.

## Offline verification

Run `npm test` and `npm run typecheck` with installed dependencies. No package
install, live API, credential or real profile is required.

| Stage (a) criterion | Synthetic evidence |
| --- | --- |
| Four ATS formats; empty/malformed boards; no hidden probes | `test/discovery-ats.test.mjs`; existing `test/discovery.test.mjs` |
| Empty roster, manual targets, pagination and duplicate companies/jobs | `test/discovery-loop.test.mjs` |
| Stale evidence, manual/empty refresh and preserved identity | `test/discovery-loop.test.mjs` |
| Unsafe hosts/redirects, source-policy expiry, denied operations | `test/discovery-loop.test.mjs`, `test/discovery-ats.test.mjs` |
| Timeout, 429/Retry-After, bounded retry, run/day limits, shared cooldown | `test/discovery-loop.test.mjs` |
| Cancellation, resume, no overwrite and corrupt/versioned state rejection | `test/discovery-loop.test.mjs` |
| Default preview: zero adapter calls and checkpoint writes | `test/discovery-loop.test.mjs`, `test/dry-run.test.mjs` |
| Root/link escape rejection; actual SQLite sidecar confinement/permissions | `test/storage.test.mjs`, `test/storage-db.test.mjs` |
| Durable private checkpoint, counts-only receipt and journal rollback | `test/discovery-store.test.mjs` |
| Durable daily quota, UTC rollover and host spacing after restart | `test/discovery-ledger.test.mjs` |

These establish the offline synthetic slice, not live provider readiness. Live
transport/DNS enforcement, authenticated terms decisions, cross-process rate
coordination, operator preferences, transcript retention and actual hiring results
are not demonstrated. Stages (b)–(e) and outbound approval/execution remain unbuilt.
