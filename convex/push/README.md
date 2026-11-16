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

## Tables

- `pushTokens`: one row per phone. `account`, the Expo push `token` (it identifies a phone: collected data, Device ID),
  `platform`, `addedAt`, `lastSeenAt`, and `disabledAt`/`disabledReason` when Expo said the phone no longer accepts
  notifications (`not_registered`) or a newer phone took its place (`replaced`). At most 10 live and 10 disabled
  phones per account.
- `pushSends`: the push outcome of one owner notice, beside its text outcome: `noticeId`, `caseId`, `event`, `account`,
  `outcome` (`sent`, `partly_sent`, `failed`), Expo's HTTP status, and one ticket per phone (Expo's receipt id or error,
  and the receipt when read). Written only when there was a phone to send to.

## Functions

| Function | Who calls it |
| --- | --- |
| `push/devices:status` (query) | The app, to show the Notifications row. Returns `accountsMode`, `signedIn`, `registered`. |
| `push/devices:register` | The app, after the owner allowed notifications. |
| `push/devices:refresh` | The app, at launch and when the phone's token changes (`previousToken` is removed). |
| `push/devices:remove` | The app, when the owner turns notifications off on this phone, and on sign-out (`removePushRegistration()` in `data/push`), before the session ends. |
| `internal.push.devices.removeAccount` | Account deletion: removes all of an account's phones in batches. |
| `internal.push.deliver.forNotice` | `convex/notices.ts`, once per case event. |
| `internal.push.deliver.checkReceipts` | Scheduled 15 minutes after a send, as Expo asks; retried once if Expo cannot answer. |

The public functions ask `convex/access.ts` for the account. With `AUTH_REQUIRED=true` they refuse without sign-in,
and an account can only read, refresh or remove its own phones. A token registered by another account moves to it,
since the phone is now signed in there.

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
