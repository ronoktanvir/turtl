# Deleting an account

An owner deletes their account from the app (the account section of the gear sheet, or the account sheet behind
Home's profile picture). Everything turtl kept for it goes: its projects and everything in them, its files, the copies
at the services turtl uses, turtl's access to its GitHub repositories, its phones, and the account itself. Checklist
RC-23 and RC-25. It works only in accounts mode (`AUTH_REQUIRED=true`); the single-owner demo has no account to
delete and refuses.

## Files

- `deletion.ts`: `request` (the app's one entry point), the job (`run`, an action, driving `next`, a mutation), the
  cron's `resumeStalled`, and for operators `lookup` and `hurry`.
- `registry.ts`: what is removed, a line per table or per module's eraser. Read it first.
- `erasers.ts`: the deleting itself, a bounded batch at a time: rows by index, files in storage, the report form's
  rate-limit windows, sign-in records.
- `vendors.ts`: the deletions asked of other services: Supermemory, GitHub, Apple.
- `schema.ts`: `accountDeletions`, the record.

## What happens

**The moment it is accepted** (`request`, one transaction):

- every session of the account ends (`expirationTime: 0`). `convex/access.ts` reads the session, so the app's token,
  though valid for up to an hour more, signs nobody in from that commit on, on every phone;
- its ways to sign in are removed (password, Apple, GitHub, with reset codes, resets under way and rate limits), so
  nobody can sign in to it again. Signing up again with the same address makes a new, empty account;
- its AI permission is taken back, so the gate (`convex/consent`) refuses every model, Supermemory, Capy and Keiki
  call for its projects from then on;
- its phones are removed (`internal.push.devices.removeAccount`), so no push goes out;
- the job starts.

**The job** keeps its place in the record and works in batches of at most 64 rows, so it can stop anywhere, resume, and
run twice without harm. One driver works at a time (a lease in the record). Stages:

1. `stop`: for each project, the monitor's journeys and standing permissions are deleted, the report form's keys are
   revoked, reports waiting for triage are dropped, and open cases are closed with their scheduled steps cancelled
   (by the job ids kept on their attempts, `convex/runner/jobs.ts`). Nothing new starts for the account after this.
2. `settle`: 11 minutes, longer than Convex lets any action run, so nothing that passed the permission check before
   the stop can still write afterwards.
3. `erase`: first the vendors, while turtl still knows what to ask them for:
   - **Supermemory**: every namespace the projects wrote to is deleted whole (`DELETE /ns/<namespace>`, the SDK's
     `namespaces.delete`): `app_`, `prefs_`, `reports_` and `code_` of each project id, with the configured
     prefixes. A request that only deletes needs no permission (the gate's `"erase"` purpose).
   - **GitHub**: `internal.github.connect.disconnectAccount` uninstalls turtl's GitHub App from every installation
     only this account uses and removes turtl's records of it; installations other accounts still use stay theirs.
     A deleted installation keeps its row (so a replayed webhook cannot revive it) with its GitHub login blanked.
   - **Apple**: each Sign in with Apple refresh token kept for the account is revoked
     (`convex/auth/appleTokens.ts`).

   Then, for each project: every case's rows (`caseErasers`) and files, then the case; the project's rows
   (`projectErasers`); the project. Then the account's rows (`accountErasers`), the sign-in records and the `users`
   row last.
4. `waiting`: a vendor that failed is asked again after 1 minute, 5, 30, 2 hours, 6, then daily, without holding up the
   rest. Its records stay until it confirms, so turtl still knows what to ask.
5. `done`: the record keeps only a SHA-256 of the account id, when it was asked for and finished, counts, and which
   vendors confirmed. Nothing personal.

A run that crashes is started again by the cron "resume account deletions" (`convex/crons.ts`, every 15 minutes) once
its record has not moved for 15 minutes.

## Adding a table

`tests/account-deletion.test.mjs` fails for any table in `convex/schema.ts` that the registry does not remove and
that is not exempt there with a reason. Add one line to `registry.ts`, in the list for what the rows hang off:

```ts
caseRows("myTable", "by_case")                    // caseErasers: rows whose caseId is one of the project's cases
projectRows("myTable", "by_app")                  // projectErasers: rows whose appId is the project
accountRows("myTable", "by_account")              // accountErasers: rows whose account field is the account id
call("project", "mine.project", ["myTable"], internal.mine.erase.forProject)
call("account", "mine.account", ["myTable"], internal.mine.erase.forAccount)
```

The index's first field must hold the case, project or account id (the test checks). A `call` entry is an internal
mutation taking `{ appId }` or `{ account }` that deletes a bounded batch and returns `{ done: boolean }`, `true` once
nothing is left; the job calls it again until it is. Its name is kept in the record, so keep it stable. A module whose
eraser has another shape wraps it in a mutation of this shape. A table that holds nothing of any account's (the
booking demo's, deployment-wide totals) goes in `EXEMPT` in the test, with the reason.

A new Supermemory namespace built from a project id is one line in `namespaces`; the test fails for a new file that
writes to Supermemory until it is listed.

## For operators

- Was this account deleted, and when: `npx convex run account/deletion:lookup '{"account":"<users id>"}'`.
- A local proof: `node scripts/account-deletion/prove-local.mjs` (see the file). `account/deletion:hurry` skips the
  settle wait; use it only where you know nothing for the account is still running.

## What is not proven here

Apple's and Supermemory's real endpoints: the tests and the local proof use stand-ins
(`tests/fixtures/auth-stand-in.mjs`, `tests/fixtures/supermemory-stand-in.mjs`) built from their published
documentation. Apple revocation needs `AUTH_APPLE_TEAM_ID`, `AUTH_APPLE_KEY_ID` and `AUTH_APPLE_PRIVATE_KEY` (a Sign in
with Apple key from the Apple Developer account); without them sign-in keeps no token and deletion cannot revoke one.
