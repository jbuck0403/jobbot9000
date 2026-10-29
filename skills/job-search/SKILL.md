---
name: job-search
description: Run jobbot9000 in job-search mode — discover companies and live jobs, grade them, and surface roles matched on BOTH fitness and desire. Use once the user is onboarded and their competency profile is verified.
---

# Job-search mode

You're the market analyst and matchmaker: gather raw, grade honestly, then match on **fitness × desire** — the hermeneutic join between what the user can do and what they want. You never write the DB directly; the tools do.

## Orient first
- `orient` at the start — it resumes any open thread and tells you if the profile is still unverified (if so, do **jobbot9000:verify** first; searching on an unverified band mis-targets everything).

## Discover companies (populate the catalog)
The free slug probe reaches companies on Ashby, Greenhouse, Lever, and Workable. Workday and SmartRecruiters are fetched when you pin them (`tenant.wdN.site`, or the SmartRecruiters company identifier). `detect_board` / `jobbot boards detect <url>` reads the identifier off a careers URL. Escalate only as recall demands:
1. **On-demand (zero-config):** `gather({ step: 'find_companies', companies: [{ name: 'Stripe', domain: 'stripe.com' }] })`. If a slug isn't derivable (e.g. Glean → Greenhouse `gleanwork`), **pin it**: `companies: [{ name, ats_platform, ats_slug }]`.
2. **Curated roster (free, default):** no args → the local seed roster (`seeds/companies.json`).
3. **TheirStack (opt-in, paid):** `provider: 'theirstack'` + `THEIRSTACK_API_KEY`, with a query you build from the resume. `dry_run: true` is a free count; a paid pull gates on the per-run credit ceiling.

Re-runs dedup on domain. Greenhouse / Ashby / Lever are verified; **Workable is best-effort**.

## Fetch jobs (→ raw, ungraded)
`gather({ step: 'fetch_jobs' })` — one board (`ats_platform`+`ats_slug` or `company_id`) or a short batch of resolved companies (`limit` defaults to 5, pass `cursor` from `next_cursor` to continue). Idempotent; a full list closes vanished postings; a truncated list (`max_postings`, default 500) does not. Grades survive a refetch. Detail pages are off unless `details` is `new` or `all`. This is a live public fetch unless `JOBBOT_NETWORK=off`. `dry_run: true` previews and writes nothing. Pass `dry_run: false` only when you mean the same thing as omitting it. Workday slugs look like `nature.wd108.externalcareers`. SmartRecruiters slugs are the company identifier. Lever slugs keep their case.

For a long studio pass, use the shell so a 60s tool timeout does not cut it off: `jobbot boards check --tag game-studio --json`. The same state folder as the server (`STATE_DIR`, `JOBBOT_PRIVATE_DIR`, or `~/.jobbot/.private/state`).

If that company is in the board ledger (`register_board`, or `jobbot boards add`), the fetch appends a check event, including a Workday or SmartRecruiters failure (wrong `wd` number, renamed site, timeout, HTTP error). A failed check does not reset hours-since-last-success. Register studios you want a "hours since last check" for; fetching an unregistered slug does not create a ledger row. See `docs/LEDGER.md`. `custom` and `browser` careers pages are not fetched; `jobbot boards record-manual-check <id> --postings N` stamps a last-success time. `jobbot boards apply <id> --title ...` records an application the user already submitted. `jobbot boards import file.json` registers many boards at once.

## Grade + match (your judgment)
1. `look({ at: 'jobs', scope: 'worklist' })` → the grading queue.
2. **Intrinsic grade** with `grade_job` (seniority, market signal A→B, required/preferred skills).
3. **Role fit** with `assess_role_fit` — band (over/exact/under) **per dimension** vs. the role, AND `desire_alignment` vs. the user's stated desires. This is the join: **surface the tension** — "a fit, but onsite when you want remote", or "you want it but you're a level under." That tension is the signal that drives the loop (upskill toward the stretch roles, or adjust desires).

## Surface
- `look({ at: 'jobs', scope: 'relevant' })` — roles in the band ±1, with fit + a coarse desire hint (sorted by it). `scope: 'market'` is the whole market; the gap between them is the honest read.
- `orient({ detail: 'dashboard' })` precomputes the band-vs-market gap + the market demand overlay.

## Next
- Call `orient` — it routes: to **jobbot9000:application** to pursue a role, or **jobbot9000:upskill** if the best-fit roles are all a stretch (close the gap, then re-match).
