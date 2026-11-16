# What one account may spend

A reviewer who approves fixes again and again cannot run up an unlimited bill. With accounts on (`AUTH_REQUIRED=true`), each account has:

- **A monthly limit on model spend**, `MODEL_SPEND_LIMIT_USD` (default $20), per calendar month in UTC. Every model call that the gate lets through adds its estimated cost to the account's month. Once the total reaches the limit, the gate refuses every OpenAI, Anthropic or Google call for that account until the month turns, and the case says so in plain words.
- **A daily limit on coding agents**, `CODING_THREADS_PER_DAY` (default 5), per calendar day in UTC. Every Capy thread is billed to the deployment's `CAPY_API_KEY`, so starting one counts. A retried start with the same request id counts once. Reading a thread that already exists does not count.

Each project also has its own allowance for what its customers cause, apart from the account's, so a customer who posts reports at every key's limit cannot spend the owner's month and stop turtl diagnosing the owner's outages:

- **A daily allowance for customer reports**, `INTAKE_SPEND_PER_DAY_USD` (default $0.50), per project per calendar day in UTC. Report triage (`convex/intake/triage.ts`) and the investigate and plan steps of a case customers opened (`convex/intake/workflow.ts`) ask the gate with `gateFor(ctx, { appId }, "intake")`; their cost lands on the project's day (`intakeDays`), never on the account's month. Once it is spent, triage judges reports by its rules and those cases get the labelled rule-based reading, until the next day. The account's own model calls are unaffected.
- **A daily cap on new cases from customer reports**, `INTAKE_CASES_PER_DAY` (default 5), per project. Past it a report that would open a case is kept on no case, and its triage reason says why; a report that matches an open case still joins it.

In the single-owner demo there is no limit and nothing is recorded.

## Files

- `limits.ts`: the two limits, the month and day keys, and `modelCost(model, usage)`: the list price from `convex/routing/configs.ts`, or the dearest price on that list for a model it does not price, so an unpriced model cannot slip past the limit. Speech-to-text and text-to-speech report no tokens and count $0.01 a call.
- `schema.ts`: `modelSpend` (one row per account per month: estimated dollars and calls), `codingThreads` (one row per thread started, by day) and `intakeDays` (one row per project per day: what its customer reports cost and how many cases they opened; older days are deleted as a new one starts).
- `ledger.ts`: `addModelSpend` (to the project's day when the gate was made for customer reports, otherwise the account's month) and `recordThread`, written only by the gate (`convex/consent/gate.ts`) after a call it let through; `openIntakeCase`, which `intake/records:land` asks before opening a case; and the readers the gate checks before a call.
- `status.ts`: `api.spend.status.mine`, the gear sheet's line: spend this month against the limit, and coding agents started today against theirs.

## Estimates, not invoices

Costs are estimates from the tokens each provider reports and published list prices. A burst of calls that start together can each pass the check before any of them is recorded, so the total can pass the limit by what those calls cost. The limit stops the next call, not the one in flight.
