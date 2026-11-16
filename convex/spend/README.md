# What one account may spend

A reviewer who approves fixes again and again cannot run up an unlimited bill. With accounts on (`AUTH_REQUIRED=true`), each account has:

- **A monthly limit on model spend**, `MODEL_SPEND_LIMIT_USD` (default $20), per calendar month in UTC. Every model call that the gate lets through adds its estimated cost to the account's month. Once the total reaches the limit, the gate refuses every OpenAI, Anthropic or Google call for that account until the month turns, and the case says so in plain words.
- **A daily limit on coding agents**, `CODING_THREADS_PER_DAY` (default 5), per calendar day in UTC. Every Capy thread is billed to the deployment's `CAPY_API_KEY`, so starting one counts. A retried start with the same request id counts once. Reading a thread that already exists does not count.

Each project also has its own allowance for what its customers cause, apart from the account's, so a customer who posts reports at every key's limit cannot spend the owner's month and stop turtl diagnosing the owner's outages:

- **A daily allowance for customer reports**, `INTAKE_SPEND_PER_DAY_USD` (default $0.50), per project per calendar day in UTC. Report triage (`convex/intake/triage.ts`) and the investigate and plan steps of a case customers opened (`convex/intake/workflow.ts`) ask the gate with `gateFor(ctx, { appId }, "intake")`; their cost lands on the project's day (`intakeDays`), never on the account's month. Once it is spent, triage judges reports by its rules and those cases get the labelled rule-based reading, until the next day. The account's own model calls are unaffected.
- **A daily cap on new cases from customer reports**, `INTAKE_CASES_PER_DAY` (default 5), per project. Past it a report that would open a case is kept on no case, and its triage reason says why; a report that matches an open case still joins it.

Every limit above is per account or per project, and nothing yet stops a script from making accounts (there is no email check until an email service is chosen; see `convex/auth/README.md`), so the deployment has ceilings of its own (`ceilings.ts`):

- **A daily ceiling on every account's model spend together**, `DEPLOYMENT_MODEL_SPEND_PER_DAY_USD` (default $25). The gate checks it before any model call, whichever allowance it spends; past it no model is asked for anyone until the next day (UTC).
- **New accounts per hour and per day**, `NEW_ACCOUNTS_PER_HOUR` (default 20) and `NEW_ACCOUNTS_PER_DAY` (default 100), counted by Convex Auth's `afterUserCreatedOrUpdated` callback (`convex/auth.ts`) inside the mutation that makes the user, so a refused sign-up leaves nothing behind. Any method counts: email and password, Apple, GitHub.
- **Projects per account**, `PROJECTS_PER_ACCOUNT` (default 10), checked by `onboarding/projects:add`; **intake keys per project**, `INTAKE_KEYS_PER_PROJECT` (default 3 taking reports at once), checked by `intake/keys:issue`.

The totals live in `deploymentTotals` (one row per total per hour or day; older ones are deleted as a new one starts). They belong to no account and are not deleted with one.

## Each account's share of the day

The daily ceiling is one pool every account shares, so without more one account could reach it alone (its month in a morning of chat, plus its projects' customer reports) and no other owner would get a diagnosis until midnight UTC (second review, finding 12). So each account has a share of the day, checked by the gate after the ceiling:

- **Its own calls**, `ACCOUNT_MODEL_SPEND_PER_DAY_USD` (default $2.50): diagnosis, fix options, the case chat, voice, reading its repositories and the code map.
- **Its projects' customer reports together**, `ACCOUNT_INTAKE_SPEND_PER_DAY_USD` (default $1.00), on top of each project's own `INTAKE_SPEND_PER_DAY_USD`. Kept apart from the first, so customers cannot use up what diagnosing the owner's outages needs.

Both live in `accountSpendDays` (one row per account per day; older days are deleted as a new one starts; the rows go with the account). A call is counted from the moment the gate lets it through: `internal.consent.gate.admit` holds the caller's estimate of its cost (`callEstimate(model, texts, maxOutputTokens)`: the texts' UTF-8 bytes, which no tokenizer turns into more tokens, plus the most it may write; or $0.10 when it gives none) in the same transaction as the check, and `addModelSpend` replaces the hold with what the call cost. So calls started together are counted one after another and a burst stops at the share; the day can pass the share by at most the last call let through. A call that fails before reporting its cost keeps its hold until the day ends.

With the defaults one account can put at most about $3.50 (plus one call each side) into the deployment's $25.00 day, so without more it would take eight accounts acting together to reach the ceiling.

## Each account's floor for its own outages

An owner's own outage is always diagnosed (fourth review, finding 23: three brand-new accounts filled the general $15, and the reserve below waits 14 days for a new account, so a new owner's outage got no diagnosis at all). When the shared day has no room for it, for whatever reason (the day is used up, the reserve will not have it, the account has used its own share), the diagnosis of an outage turtl's checks found on the owner's own real project goes on the account's floor, `OUTAGE_FLOOR_PER_DAY_USD` (default $1.25 a day). The floor is the account's alone, and it sits outside the shared day: what it spends never counts toward `DEPLOYMENT_MODEL_SPEND_PER_DAY_USD`, so no other account's spending reaches it and it reaches no other owner's day.

Only these calls draw on it: investigate and plan on a case the monitor raised (`gateFor(ctx, { caseId }, "outage")`, which the gate checks against the case) and the council that investigate calls, on a project that is not a practice app. Never a practice app's cases, a case customers raised, a call made for a project rather than for one of its cases, the case chat or voice, or another account's project: the gate reads whose floor it is from the case's project, never from the caller. It counts toward the account's month like its own calls (`MODEL_SPEND_LIMIT_USD`), so the month bounds it too, and calls on it are held and spent like the shares (`floorUsd`, `floorHeldUsd` on `accountSpendDays`).

One outage with the default models costs about $0.32 at ordinary sizes (a quick and a careful diagnosis, a council of three and its summary, the fixes on offer) and at most about $1.08 (the diagnosis's $0.50 budget, `DIAGNOSIS_BUDGET_USD`; the council's $0.50 limit; the fixes at their most output). $1.25 covers the most, with room for the council's calls held side by side; $1.00 would refuse that outage's last council member. Past the floor the owner reads: "this account has used the $1.25 turtl keeps for it each day for finding the cause of its own outages, and no other AI is left for it today, so no model was asked; it starts again tomorrow".

### What the floor costs the operator

The guarantee is paid for outside the day's ceiling, so the ceiling is no longer the most a day can cost. With the defaults (`tests/shared-spend.test.mjs` checks each figure):

- **A day** costs at most the ceiling plus the floors used: $25 + $1.25 × (accounts that drew on their floor that day), each floor passed by at most the last call let through. Forty fresh accounts doing everything they may: about $15.50 in the shared day and $51.87 on their floors.
- **Who can draw on a floor**: only an account with a real project (a GitHub repository, its preparation merged, a live app on a public address that passed turtl's check) whose check then failed, on a day the shared day had no room for it. Nothing caps those accounts but the sign-ups: at most 200 new accounts a day (100 through Apple or GitHub, `NEW_ACCOUNTS_PER_DAY`; 100 password accounts confirming their address, `CONFIRMED_SIGNUPS_PER_DAY`), 40 an hour. So on the first day of an attack at the sign-up ceilings, $25 + 200 × $1.25 = **$275**, and each day after, the accounts made so far can draw again: $25 + $250 a day for each day of sign-ups.
- **A month**: each account's floor counts toward its month, `MODEL_SPEND_LIMIT_USD` ($20, its own calls included; a burst can pass it by at most what the floor holds at once), so an account drawing its whole floor every day is stopped within sixteen days. The month costs at most 30 × $25 = $750 plus $20 for each account that drew on its floor: with sign-ups at their ceilings all month (6,000 accounts, each holding a real project), $750 + 6,000 × $20 = **$120,750**. A hundred owners with real projects whose outages run past the shared day every day: $150 a day, $2,750 a month.

To bound it lower, lower the floor (`OUTAGE_FLOOR_PER_DAY_USD`, the day), the month (`MODEL_SPEND_LIMIT_USD`, each account's month) or the sign-ups (`NEW_ACCOUNTS_PER_DAY`, `CONFIRMED_SIGNUPS_PER_DAY`, how many accounts there can be).

## The part of the day kept for outages

The last `OUTAGE_RESERVE_PERCENT` of the day (default 40%, $10 of the default $25) is kept for finding the cause of outages the monitor found: investigate and plan on a case the monitor raised (the case's own gate, `gateFor(ctx, { caseId }, "outage")`, which the gate checks against the case), and the council that investigate may call. Once the day's total passes the ceiling less the reserve, every other model call waits until the next day with the reason "turtl is keeping the rest of today's AI for finding the cause of outages", and an outage's diagnosis passes only for an account whose own calls cost less than `OUTAGE_RESERVE_ACCOUNT_USD` today (default $0.50).

That second rule is what makes the reserve worth having. Any account can make the monitor raise cases at will (its own app, or its practice app, which it may break ten times a day), so a reserve every account could draw on up to its whole share would empty as fast as the rest: it takes eight accounts to stop another owner's diagnosis with no reserve, and nine with that one. With each account drawing at most about $0.50 (plus one call), the $15 before the reserve takes five accounts and the $10 reserve about twenty more: `tests/shared-spend.test.mjs` counts 24.

And the reserve is only for real outages on established projects (third review, finding 19, where the same 24 accounts drained it every day by breaking their practice apps). A case qualifies only when:

- the monitor raised it on a project that is not a practice app;
- its check had been passing for `OUTAGE_RESERVE_STEADY_HOURS` (default 24) before this failure. The monitor keeps, on each check, since when it has passed every time (`journeys.passingSince`; a failure or a check that got no answer clears it), and the case records how long that was (`cases.passingForMs`). A check from before this was kept starts counting at its next pass;
- its account is at least `OUTAGE_RESERVE_ACCOUNT_AGE_DAYS` old (default 14).

An outage the reserve does not admit goes on the account's floor instead (above), so an owner no longer reads the reserve's refusals; the floor's sentence is the one left.

No number of accounts stops another owner's diagnosis of a real outage now: past the shared day it goes on the owner's floor (`tests/shared-spend.test.mjs` tries ten fresh accounts against a day-old owner, two days running, and thirty established ones against owners new and established). What accounts acting together can still do (the same file counts them): three accounts of any age fill the general $15 (each puts in up to $5.50: its own $2.50, its practice app's $2, its customers' $1), after which the case chat, voice, customer reports and repository readings wait for everyone until the next day; and about twenty accounts over 14 days old drain the $10 reserve at about $0.50 each, each holding a real project (a repository, a merged preparation, a live app that passes turtl's booking check) kept passing for a day before each failure (the test counts 24), after which established owners' outages go on their floors too.

A practice app's cases (convex/practice) have their own small allowance instead, `PRACTICE_AI_PER_DAY_USD` (default $2.00 an account a day, apart from its own share; it counts toward the month as its own calls do). One break, explained (a quick diagnosis, a careful one when that is unsure, the fixes on offer and a look for a broader cause), costs about $0.13 with the default models, so the ten breaks a day the practice app allows fit, and asking about it again and again stops there: "this account has used today's $2.00 of AI for its practice app". The case still opens and turtl explains it with its own rules. Accounts made for an attack cannot reach the reserve for two weeks, and then only through real projects whose live apps pass turtl's checks for a day before each failure, one such failure per project per day.

In the single-owner demo there is no limit and nothing is recorded.

## Files

- `limits.ts`: the two limits, the month and day keys, and `modelCost(model, usage)`: the list price from `convex/routing/configs.ts`, or the dearest price on that list for a model it does not price, so an unpriced model cannot slip past the limit. Speech-to-text and text-to-speech report no tokens and count $0.01 a call.
- `schema.ts`: `modelSpend` (one row per account per month: estimated dollars and calls), `accountSpendDays` (one row per account per day: its own calls, its practice app, its floor and its customers' reports, spent and held), `codingThreads` (one row per thread started, by day) and `intakeDays` (one row per project per day: what its customer reports cost and how many cases they opened; older days are deleted as a new one starts).
- `ledger.ts`: `addModelSpend` (to the project's day when the gate was made for customer reports, otherwise the account's month) and `recordThread`, written only by the gate (`convex/consent/gate.ts`) after a call it let through; `openIntakeCase`, which `intake/records:land` asks before opening a case; and the readers the gate checks before a call.
- `status.ts`: `api.spend.status.mine`, the gear sheet's line: spend this month against the limit, and coding agents started today against theirs.

## Estimates, not invoices

Costs are estimates from the tokens each provider reports and published list prices. A burst of calls that start together can each pass the check before any of them is recorded, so the total can pass the limit by what those calls cost. The limit stops the next call, not the one in flight.
