# Push notifications

turtl tells the owner on their own phone when a case needs them. Delivery goes through Expo's push service
(`https://exp.host/--/api/v2/push`), which hands the message to Apple or Google.

## When a push is sent

`convex/notices.ts` records one outcome per case event (`ownerNotices`). After it claims an event, it schedules
`push/deliver:forNotice` for the events below, and records the text outcome exactly as before.

| Event | Push | Why |
| --- | --- | --- |
| `needs_decision` | "A case needs your decision. Open it to approve or decline a fix." | The case waits for the owner. |
| `handled_under_permission` | "A fix you allowed ran and the app passed its check. Open the case to see what changed." | A fix the owner approved in advance has finished. |
| `not_answering` | "Your app is not answering turtl's checks. Open the case to see what turtl saw." | The app gave turtl's checks nothing at all: every journey check that has passed before got no reply, or a 5xx with no result, three times in a row, and no check answered. A case opened (`convex/protectedApp/notAnswering.ts`). turtl cannot look into an app it cannot reach. |
| `answering_again` | "Your app is answering turtl's checks again. Open the case to see whether they pass." | That case closed because the app answered, possibly with a failing check, so the sentence is no all-clear. When turtl stops checking the project instead, the case closes with no notice. |
| `opened` | none | turtl is still looking into it; nothing to do yet. If the owner must act, `needs_decision` follows. |

A run under a permission that does not restore service revokes the permission, so the next failure sends
`needs_decision`; it sends no push of its own.

## What a push says

`message.ts` builds every notification and imports nothing. The title is the project's name (one line, at most 60
characters). The body is one fixed sentence from the table above. The payload is `{ caseId }`, and a tap opens
`/review/<caseId>`. Nothing from a customer, a log, an error, a model or code can reach it; `tests/push.test.mjs`
proves this. No notification is promotional.

## Who receives it

Every live phone of the project's owner: the account in `apps.ownerId` (in the single-owner demo, `solo-owner`).
Identity does not travel through the scheduler, so the recipient comes from the project, never from a caller.

With `AUTH_REQUIRED=true`, a phone is live only while the sign-in session that turned its notifications on is live
(`receives` in `devices.ts`). Signing out, a password reset and account deletion end sessions, and sessions run out;
from then on delivery skips the phone, another account may register it, and it is removed: at once by a reset
(`forgetEnded`), and otherwise by the hourly sweep. A phone registered by a caller whose token names no session (an
identity the operator's admin key stands for) is live until removed. Phones registered before sessions were kept name
none: they receive nothing until the app, signed in to the same account, files them under its session at its next
launch, and the sweep removes the rest. The single-owner demo keeps no sessions and is unchanged.

## Tables

- `pushTokens`: one row per phone. `account`, the Expo push `token` (it identifies a phone: collected data, Device ID),
  `platform`, `addedAt`, `lastSeenAt`, and `disabledAt`/`disabledReason` when Expo said the phone no longer accepts
  notifications (`not_registered`) or a newer phone took its place (`replaced`). With accounts on, `sessionId` (the
  sign-in session that registered it) or `noSession`. At most 10 live and 10 disabled phones per account.
- `pushSends`: the push outcome of one owner notice, beside its text outcome: `noticeId`, `caseId`, `event`, `account`,
  `outcome` (`sent`, `partly_sent`, `failed`), Expo's HTTP status, and one ticket per phone (Expo's receipt id or error,
  and the receipt when read). Written only when there was a phone to send to.

## Functions

| Function | Who calls it |
| --- | --- |
| `push/devices:status` (query) | The app, to show the Notifications row. Returns `accountsMode`, `signedIn`, `registered`. |
| `push/devices:register` | The app, after the owner allowed notifications. |
| `push/devices:refresh` | The app, at launch and when the phone's token changes (`previousToken` is removed), tying the phone to the session it is signed in with now. With accounts on it never registers a phone: it answers false for a token that is not this account's, and the app forgets it. |
| `push/devices:remove` | The app, when the owner turns notifications off on this phone, and on sign-out (`removePushRegistration()` in `data/push`), before the session ends. |
| `internal.push.devices.removeAccount` | Account deletion: removes all of an account's phones in batches. |
| `internal.push.devices.forgetEnded` | A password reset (`convex/auth/password.ts`): removes the account's phones whose session it ended. |
| `internal.push.devices.sweep` | Every hour (`convex/crons.ts`): removes every phone whose session has ended, in batches. |
| `internal.push.deliver.forNotice` | `convex/notices.ts`, once per case event. |
| `internal.push.deliver.checkReceipts` | Scheduled 15 minutes after a send, as Expo asks; retried once if Expo cannot answer. |

The public functions ask `convex/access.ts` for the account. With `AUTH_REQUIRED=true` they refuse without sign-in,
and an account can only read, refresh or remove its own phones. A token that is live on another account (its session
is live) is refused by `register` and `refresh` ("This phone still gets notifications for another turtl account…"):
a token is not a secret, so moving it would let anyone who learned one take that owner's notifications. Signing out on
the phone removes its token first, and ends its session in any case, so the next account to sign in there can
register it; a token Expo turned off moves freely.

## Expo's answers

A ticket or a receipt with `DeviceNotRegistered` turns that phone off until it registers again. A phone that
registered after the send is left alone. Other errors are recorded on the ticket. A failed request records `failed`
with the HTTP status; it is not retried, and the text notice is unaffected.

## Environment

- `EXPO_ACCESS_TOKEN` (optional, secret): needed only once "enhanced push security" is turned on for the project in Expo.
- `EXPO_PUSH_API_URL` (never in production): points the module at a stand-in in tests.

## Tests

- `tests/push.test.mjs` runs these functions against an in-memory copy of the tables and
  `tests/fixtures/expo-push-stub.mjs`, a stand-in for Expo served over HTTP.
- `tests/push-local.integration.mjs` repeats the main paths on a local Convex backend with the stand-in on port 8204.
  `localProof.ts` seeds it and refuses anything but a localhost backend with `DEV_TOOLS_ENABLED=true`.

Nothing here has reached a real phone: that needs an Apple Developer membership and the push key in EAS.
