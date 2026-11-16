# What one account may spend

A reviewer who approves fixes again and again cannot run up an unlimited bill. With accounts on (`AUTH_REQUIRED=true`), each account has:

- **A monthly limit on model spend**, `MODEL_SPEND_LIMIT_USD` (default $20), per calendar month in UTC. Every model call that the gate lets through adds its estimated cost to the account's month. Once the total reaches the limit, the gate refuses every OpenAI, Anthropic or Google call for that account until the month turns, and the case says so in plain words.
- **A daily limit on coding agents**, `CODING_THREADS_PER_DAY` (default 5), per calendar day in UTC. Every Capy thread is billed to the deployment's `CAPY_API_KEY`, so starting one counts. A retried start with the same request id counts once. Reading a thread that already exists does not count.

Each project also has its own allowance for what its customers cause, apart from the account's, so a customer who posts reports at every key's limit cannot spend the owner's month and stop turtl diagnosing the owner's outages:

- **A daily allowance for customer reports**, `INTAKE_SPEND_PER_DAY_USD` (default $0.50), per project per calendar day in UTC. Report triage (`convex/intake/triage.ts`) and the investigate and plan steps of a case customers opened (`convex/intake/workflow.ts`) ask the gate with `gateFor(ctx, { appId }, "intake")`; their cost lands on the project's day (`intakeDays`), never on the account's month. Once it is spent, triage judges reports by its rules and those cases get the labelled rule-based reading, until the next day. The account's own model calls are unaffected.
- **A daily cap on new cases from customer reports**, `INTAKE_CASES_PER_DAY` (default 5), per project. Past it a report that would open a case is kept on no case, and its triage reason says why; a report that matches an open case still joins it.

Every limit above is per account or per project, and nothing yet stops a script from making accounts (there is no email check until an email service is chosen; see `convex/auth/README.md`), so the deployment has ceilings of its own (`ceilings.ts`):

- **A daily ceiling on every account's model spend together**, `DEPLOYMENT_MODEL_SPEND_PER_DAY_USD` (default $25): the shared day. The gate checks it before any model call, whichever allowance it spends; past it no model is asked until the next day (UTC), except for each owner's own outages on its floor (below).
- **A hard stop on everything the deployment spends on models in a day**, `DEPLOYMENT_MODEL_HARD_STOP_PER_DAY_USD` (default twice the ceiling, $50): the shared day and every account's floor together. Past it no model is asked for anyone, outages included (below).
- **New accounts per hour and per day**, `NEW_ACCOUNTS_PER_HOUR` (default 20) and `NEW_ACCOUNTS_PER_DAY` (default 100), counted by Convex Auth's `afterUserCreatedOrUpdated` callback (`convex/auth.ts`) inside the mutation that makes the user, so a refused sign-up leaves nothing behind. Any method counts: email and password, Apple, GitHub.
- **Projects per account**, `PROJECTS_PER_ACCOUNT` (default 10), checked by `onboarding/projects:add`; **intake keys per project**, `INTAKE_KEYS_PER_PROJECT` (default 3 taking reports at once), checked by `intake/keys:issue`.

The totals live in `deploymentTotals` (one row per total per hour or day; older ones are deleted as a new one starts). They belong to no account and are not deleted with one.

## Each account's share of the day

The daily ceiling is one pool every account shares, so without more one account could reach it alone (its month in a morning of chat, plus its projects' customer reports) and no other owner would get a diagnosis until midnight UTC (second review, finding 12). So each account has a share of the day, checked by the gate after the ceiling:

- **Its own calls**, `ACCOUNT_MODEL_SPEND_PER_DAY_USD` (default $2.50): diagnosis, fix options, the case chat, voice, reading its repositories and the code map, and its practice app's cases (at most `PRACTICE_AI_PER_DAY_USD` of it, below).
- **Its projects' customer reports together**, `ACCOUNT_INTAKE_SPEND_PER_DAY_USD` (default $1.00), on top of each project's own `INTAKE_SPEND_PER_DAY_USD`. Kept apart from the first, so customers cannot use up what diagnosing the owner's outages needs.

Both live in `accountSpendDays` (one row per account per day; older days are deleted as a new one starts; the rows go with the account). A call is counted from the moment the gate lets it through: `internal.consent.gate.admit` holds the caller's estimate of its cost (`callEstimate(model, texts, maxOutputTokens)`: the texts' UTF-8 bytes, which no tokenizer turns into more tokens, plus the most it may write; or $0.10 when it gives none) in the same transaction as the check, and `addModelSpend` replaces the hold with what the call cost. So calls started together are counted one after another and a burst stops at the share; the day can pass the share by at most the last call let through. A call whose cost does not come back is settled as the section on calls that fail says below: never left held until midnight.

With the defaults one account can put at most about $3.50 (plus one call each side, about $3.57 in all) into the deployment's $25.00 day, so without more it would take seven accounts acting together to reach the ceiling. Its practice app adds nothing to that: its $2 is part of the $2.50 (fourth review, finding 23; beside the share it made $5.50 an account).

## Each account's floor for its own outages

An owner's own outage on a real project is diagnosed whatever other accounts spend, until the deployment's hard stop is reached (fourth review, finding 23: three brand-new accounts filled the general $15, and the reserve below waits 14 days for a new account, so a new owner's outage got no diagnosis at all). When the shared day has no room for it, for whatever reason (the day is used up, the reserve will not have it, the account has used its own share), the diagnosis of an outage turtl's checks found on the owner's own real project goes on the account's floor, `OUTAGE_FLOOR_PER_DAY_USD` (default $1.25 a day). The floor is the account's alone, and it sits outside the shared day: what it spends never counts toward `DEPLOYMENT_MODEL_SPEND_PER_DAY_USD`, so no other account's spending reaches it and it reaches no other owner's day.

Only these calls draw on it: investigate and plan on a case the monitor raised (`gateFor(ctx, { caseId }, "outage")`, which the gate checks against the case) and the council that investigate calls, on a project that is not a practice app. Never a practice app's cases, a case customers raised, a call made for a project rather than for one of its cases, the case chat or voice, or another account's project: the gate reads whose floor it is from the case's project, never from the caller. It counts toward the account's month like its own calls (`MODEL_SPEND_LIMIT_USD`), so the month bounds it too, and calls on it are held and spent like the shares (`floorUsd`, `floorHeldUsd` on `accountSpendDays`).

One outage with the default models costs about $0.32 at ordinary sizes (a quick and a careful diagnosis, a council of three and its summary, the fixes on offer) and at most about $1.08 (the diagnosis's $0.50 budget, `DIAGNOSIS_BUDGET_USD`; the council's $0.50 limit; the fixes at their most output). $1.25 covers the most, with room for the council's calls held side by side; $1.00 would refuse that outage's last council member. Past the floor the owner reads: "this account has used the $1.25 turtl keeps for it each day for finding the cause of its own outages, and no other AI is left for it today, so no model was asked; it starts again tomorrow".

### The hard stop: what the floor can cost the operator

The floors are outside the shared day, so the ceiling alone no longer bounds a day: each account with a real project whose check failed could add its $1.25, and nothing capped those accounts but the sign-ups (200 new accounts a day: $275 on the first day of an attack, and more each day after). So one setting bounds everything: `DEPLOYMENT_MODEL_HARD_STOP_PER_DAY_USD`, by default twice `DEPLOYMENT_MODEL_SPEND_PER_DAY_USD` and following it while unset ($50 with the defaults: the shared $25 and room for twenty owners' whole floors). It counts the shared day (`model_usd_day` in `deploymentTotals`), every account's floor and every call still out at its hold (`deploymentModelDays`, one row a day), and the gate checks it before anything else for every model call: a call is let through only if its hold fits under it, so a burst stops at it and the day passes it only by what a call costs beyond what it was held at (`callEstimate` holds a call at the most it can cost). The shared day counts its own calls in flight at their holds too, so calls that fail or hang cannot carry it past its ceiling, nor the deployment to the hard stop (below).

Past it no model is asked for anyone, outages included, until midnight UTC. Each case says so and falls back to turtl's own rules ("No model answered: turtl has reached the most it can spend on AI in one day, outages included, so no model was asked; it starts again tomorrow."), and the first call it refuses that day writes one line to the backend log, for the operator: "Model spend reached the deployment's hard stop for 2026-11-16 (UTC): $49.98 of $50.00 spent or in flight, …". Later refusals that day write nothing.

So the guarantee now reads: an owner's own outage on a real project is diagnosed whatever other accounts spend, until the deployment's hard stop is reached. With the defaults that takes about twenty accounts whose real projects failed that day, each drawing its whole floor once the shared $25 is spent (the hard stop's $25 above the ceiling at $1.25 an account), and each holding a GitHub repository, a merged preparation and a live app that passed its checks. `tests/shared-spend.test.mjs` counts 20 with no reserve; 21 established accounts, which reach the hard stop before they drain the reserve; and 27 fresh ones, which cannot reach the reserve and so put only about $15.50 into the shared day.

What the operator can pay now, with the defaults (the same file checks each figure):

- **A day**: at most $50, however many accounts there are. Forty fresh accounts doing everything they may came to $49.98 ($15.45 in the shared day, $34.53 on floors).
- **A month**: at most the hard stop times its days, $1,500 in 30 days and $1,550 in 31. No setting of its own is needed: it is read off the hard stop. Each account's month (`MODEL_SPEND_LIMIT_USD`, $20, its floor included) still bounds what any one account takes of it.

To bound it lower, lower the hard stop, or the ceiling it follows.

## The part of the day kept for outages

The last `OUTAGE_RESERVE_PERCENT` of the day (default 40%, $10 of the default $25) is kept for finding the cause of outages the monitor found: investigate and plan on a case the monitor raised (the case's own gate, `gateFor(ctx, { caseId }, "outage")`, which the gate checks against the case), and the council that investigate may call. Once the day's total passes the ceiling less the reserve, every other model call waits until the next day with the reason "turtl is keeping the rest of today's AI for finding the cause of outages", and an outage's diagnosis passes only for an account whose own calls cost less than `OUTAGE_RESERVE_ACCOUNT_USD` today (default $0.50).

That second rule is what made the reserve worth having before the floor existed. Any account can make the monitor raise cases at will (its own app, or its practice app, which it may break ten times a day), so a reserve every account could draw on up to its whole share would empty as fast as the rest: it took eight accounts to stop another owner's diagnosis with no reserve, and nine with that one. With each account drawing at most about $0.50 (plus one call), the $10 reserve takes about twenty accounts after the general part: `tests/shared-spend.test.mjs` counts 24.

And the reserve is only for real outages on established projects (third review, finding 19, where the same 24 accounts drained it every day by breaking their practice apps). A case qualifies only when:

- the monitor raised it on a project that is not a practice app;
- its check had been passing for `OUTAGE_RESERVE_STEADY_HOURS` (default 24) before this failure. The monitor keeps, on each check, since when it has passed every time (`journeys.passingSince`; a failure or a check that got no answer clears it), and the case records how long that was (`cases.passingForMs`). A check from before this was kept starts counting at its next pass;
- its account is at least `OUTAGE_RESERVE_ACCOUNT_AGE_DAYS` old (default 14).

An outage the reserve does not admit goes on the account's floor instead (above), so an owner no longer reads the reserve's refusals; the floor's sentence is the one left.

Short of the deployment's hard stop, no number of accounts stops another owner's diagnosis of a real outage: past the shared day it goes on the owner's floor (`tests/shared-spend.test.mjs` tries ten fresh accounts against a day-old owner, two days running, and thirty established ones against owners new and established, which reach the hard stop at the twenty-first). Established accounts draw on the reserve and on their floors at once, so they reach the hard stop before they drain the reserve. What accounts acting together can still do (the same file counts them): five accounts of any age (ones made that hour too) fill the general $15 (each puts in up to about $3.57: its own $2.50, its practice app within it, and its customers' $1, each passed by up to one call; seven fill the whole $25 with no reserve), after which the case chat, voice, customer reports and repository readings wait for everyone until the next day; and about twenty accounts with real projects whose checks failed reach the hard stop, after which nothing is asked of a model for anyone until the next day (above).

A practice app's cases (convex/practice) have a small allowance instead, `PRACTICE_AI_PER_DAY_USD` (default $2.00 an account a day, within its own $2.50 share, so the practice app gives an account no more room in the shared day; it counts toward the month as its own calls do). What is left of the share after the practice app is all its own calls may spend that day, and an outage on a real project then goes on its floor. One break, explained (a quick diagnosis, a careful one when that is unsure, the fixes on offer and a look for a broader cause), costs about $0.13 with the default models, so the ten breaks a day the practice app allows fit, and asking about it again and again stops there: "this account has used today's $2.00 of AI for its practice app". The case still opens and turtl explains it with its own rules. Accounts made for an attack cannot reach the reserve for two weeks, and then only through real projects whose live apps pass turtl's checks for a day before each failure, one such failure per project per day.

### Does the reserve still earn its place?

No, now that each account has its floor (fourth review, finding 23). It was built so that another owner's outage would still be diagnosed when other accounts had spent the day, and the floor does that for every owner, new or established, without the reserve's three rules. What the reserve still does:

- It gives an established owner (14 days old, a check passing for a day, under $0.50 today) more than one outage's diagnosis on a day the shared day is spent, while it lasts and the hard stop is not reached. The floor already covers the most one outage costs with the default models.
- It pays for those outages inside the ceiling rather than beside it. That lowers an ordinary busy day's bill a little, not the worst case: once the reserve is drained, every outage goes on the floors either way, so the worst day is the hard stop with or without it.
- It takes 40% of the day ($10 of $25) from everything else: the case chat, voice, code questions, repository readings and customer reports wait once $15 is used, which five fresh accounts reach, instead of once $25 is used, which takes seven.

So the recommendation is `OUTAGE_RESERVE_PERCENT=0` for launch (0 keeps none; nothing else changes), and to remove the reserve, its four settings and its refusals in a later change. It is left in place, at its default, for now.

## When the general part is used up

Once the shared day has no room left for them (its first $15 while the reserve keeps the rest, or the whole $25 with no reserve), these wait for everyone until midnight UTC, and each says so where the owner asked:

- the case chat: "turtl can't answer right now: …";
- voice: "turtl can't listen: …";
- code questions: "turtl can't answer questions about your code: …";
- repository readings: the map of the code waits ("The map of the code was not built: …"), and reading a repository to prepare it gives text-search leads only ("No model answered: … These results are text-search leads only.");
- customer reports: triage and the cases customers raised fall back to turtl's rules, labelled "No model answered: … Rule-based triage was used instead." or "No model answered: … A rule-based reading says: …".

After the colon: "turtl is keeping the rest of today's AI for finding the cause of outages, so no model was asked; it starts again tomorrow" while the reserve lasts, and "turtl has reached the most AI it uses in one day across everyone, so no model was asked; it starts again tomorrow" once the whole day is used.

What goes on is finding the cause of an outage turtl's checks found on an owner's own real project (the diagnosis, the council, the fixes on offer): on the reserve for an owner it admits, while it lasts, and on the owner's own floor otherwise, up to $1.25 a day, until the deployment's hard stop. A practice app's cases wait with the rest. Past the hard stop the outages wait too, with the sentence above.

In the single-owner demo there is no limit and nothing is recorded.

## Calls that fail, time out or never report a cost

Every call the gate lets through is held at its estimate until its cost comes back, against the account's share or floor, the shared day and the hard stop. Holds used to stand until midnight whenever no cost came back, and every model helper returns on an HTTP error or a timeout without reporting one, so fourteen fresh accounts whose calls all failed (bursting past the operator's rate limit at the vendor, or asking for very long answers) held the deployment at the hard stop with nothing spent, and a vendor outage did the same through ordinary traffic (fifth review, finding 26). Each hold now has its own row (`modelCallHolds`), and is settled one of four ways:

- **The vendor answered with an error status** (400, 429, 5xx): the hold is given back at once, at nothing, on the share, the floor, the shared day and the hard stop alike, and nothing reaches the month. The gate does it in the one fetch every model helper is handed (`gateFor(…).open`; `tests/consent-gate.test.mjs` fails for a helper that sends any other way), so a new helper cannot forget. The vendors bill a call by the tokens of a completed answer; an error answer carries no usage and is not billed, and a 429 is refused before any work.
- **The vendor answered**: the cost it reports replaces the hold exactly. An answer without its usage is counted at its hold, not at nothing.
- **No answer came back** (a timeout, a broken connection, an action that stopped between the gate and the vendor, or after the vendor answered but before the cost was recorded): the vendor may have done the work, so the hold stands, but only for `MODEL_CALL_HOLD_MS` (ten minutes, Convex's limit for an action, so no cost can come back later). Then a sweep every minute (`settleExpiredHolds`, `convex/crons.ts`) counts it at its hold, the most the call could cost: on the share, the month, the shared day or floor, and the hard stop. A cost reported after that adds nothing.
- **The account is deleted with calls out**: they are counted at their holds in the deployment's totals before its own rows go (`eraseHolds`, `convex/account/registry.ts`).

So no call that may have cost something is ever settled at nothing: only an error status gives a hold back, and every other way counts the reported cost or the hold, which is never less than the call can cost (its texts' bytes and the most it may write). The exceptions are the ones `callEstimate` already has: a caller that gives no estimate is held at $0.10, and no hold passes $5.

The calls in flight count wherever the costs do. The shared day counts its calls in flight at their holds against its ceiling, so failing or hanging calls hold at most the shared day: fresh accounts stop at the general $15, and the hard stop stays out of their reach. The month counts the account's calls in flight (its own, its practice app's and its floor's) at their holds, so a burst stops at it too, and a call whose cost never comes back reaches the month at its hold. A hold that runs past midnight is given back on the day it was counted, never off the next day's holds.

What the operator should watch is the gap between what is held and what is spent (`heldUsd` against `floorUsd` and `model_usd_day` on the day's rows). A few cents held is calls in flight. A large amount held for minutes means the vendor is slow or failing; holds then clear on their own, by the error status at once or by the sweep within eleven minutes. The sweep writes one line to the backend log each minute it counts anything ("3 model calls reported no cost within 10 minutes and were counted at their holds, $1.20 in all."); many such lines mean calls are timing out, and the recorded spend then runs above the vendor's bill by the difference between each hold and what the call really cost. The other way round, a vendor that billed a call it answered with an error would run above the recorded spend; the three vendors bill only the tokens of answers they complete.

## Files

- `limits.ts`: the two limits, the month and day keys, and `modelCost(model, usage)`: the list price from `convex/routing/configs.ts`, or the dearest price on that list for a model it does not price, so an unpriced model cannot slip past the limit. Speech-to-text and text-to-speech report no tokens and count $0.01 a call.
- `schema.ts`: `modelSpend` (one row per account per month: estimated dollars and calls), `accountSpendDays` (one row per account per day: its own calls, its practice app, its floor and its customers' reports, spent and held), `codingThreads` (one row per thread started, by day), `deploymentModelDays` (one row per day for the hard stop: every floor's cost, every call out at its hold and how much of that on floors, and when the log was told; it names no account), `modelCallHolds` (one row per call out: whose, which share and day, its hold, when it runs out) and `intakeDays` (one row per project per day: what its customer reports cost and how many cases they opened; older days are deleted as a new one starts).
- `ledger.ts`: `addModelSpend` (a call's cost in place of its hold: to the project's day when the gate was made for customer reports, otherwise the account's month) and `recordThread`, written only by the gate (`convex/consent/gate.ts`) after a call it let through; `settleExpiredHolds` (the sweep) and `eraseHolds` (account deletion), which count calls whose cost never came back at their holds; `openIntakeCase`, which `intake/records:land` asks before opening a case; and the readers the gate checks before a call.
- `status.ts`: `api.spend.status.mine`, the gear sheet's line: spend this month against the limit, and coding agents started today against theirs.

## Estimates, not invoices

Costs are estimates from the tokens each provider reports and published list prices. Calls started together are each counted at their holds as they are let through, so a burst stops at a limit; a limit can be passed by what the last call let through costs, not by the calls in flight.
