---
name: job-search
description: Run jobbot9000 in job-search mode — discover companies and live jobs, grade them, and surface roles matched on BOTH fitness and desire. Use once the user is onboarded and their competency profile is verified.
---

# Job-search mode

You're the market analyst and matchmaker: gather raw, grade honestly, then match on **fitness × desire** — the hermeneutic join between what the user can do and what they want. You never write the DB directly; the tools do.

## Orient first
- `orient` at the start — it resumes any open thread and tells you if the profile is still unverified (if so, do **jobbot9000:verify** first; searching on an unverified band mis-targets everything).

## Discover companies (populate the catalog)
The reachable universe is companies on the four ATSes, so the **free path reaches everyone reachable**. Escalate only as recall demands:
1. **On-demand (zero-config):** `gather({ step: 'find_companies', companies: [{ name: 'Stripe', domain: 'stripe.com' }] })`. If a slug isn't derivable (e.g. Glean → Greenhouse `gleanwork`), **pin it**: `companies: [{ name, ats_platform, ats_slug }]`.
2. **Curated roster (free, default):** no args → the local seed roster (`seeds/companies.json`).
3. **TheirStack (opt-in, paid):** `provider: 'theirstack'` + `THEIRSTACK_API_KEY`, with a query you build from the resume. `dry_run: true` is a free count; a paid pull gates on the per-run credit ceiling.

Re-runs dedup on domain. Greenhouse / Ashby / Lever are verified; **Workable is best-effort**.

## Fetch jobs (→ raw, ungraded)
`gather({ step: 'fetch_jobs' })` — one board (`ats_platform`+`ats_slug` or `company_id`) or all resolved (pass nothing). Idempotent; a liveness pass closes vanished postings; grades survive a refetch. This is a live HTTPS GET unless `JOBBOT_NETWORK=off`. `dry_run: true` previews and writes nothing. Pass `dry_run: false` only when you mean the same thing as omitting it.

If that company is in the board ledger (`register_board`, or `jobbot boards add`), the fetch appends a check event. Register studios you want a "hours since last check" for; fetching an unregistered slug does not create a ledger row. See `docs/LEDGER.md`. Workday, SmartRecruiters, and browser careers pages can be registered now; only the four ATS fetchers run.

## Grade + match (your judgment)
1. `look({ at: 'jobs', scope: 'worklist' })` → the grading queue.
2. **Intrinsic grade** with `grade_job` (seniority, market signal A→B, required/preferred skills).
3. **Role fit** with `assess_role_fit` — band (over/exact/under) **per dimension** vs. the role, AND `desire_alignment` vs. the user's stated desires. This is the join: **surface the tension** — "a fit, but onsite when you want remote", or "you want it but you're a level under." That tension is the signal that drives the loop (upskill toward the stretch roles, or adjust desires).

## Surface
- `look({ at: 'jobs', scope: 'relevant' })` — roles in the band ±1, with fit + a coarse desire hint (sorted by it). `scope: 'market'` is the whole market; the gap between them is the honest read.
- `orient({ detail: 'dashboard' })` precomputes the band-vs-market gap + the market demand overlay.

## Next
- Call `orient` — it routes: to **jobbot9000:application** to pursue a role, or **jobbot9000:upskill** if the best-fit roles are all a stretch (close the gap, then re-match).
