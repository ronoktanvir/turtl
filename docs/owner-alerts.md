# Owner alerts

turtl tells the owner about a case in two ways:

- **A push notification** on the owner's own phones, through Expo's push service. It is how alerts arrive with accounts on (`AUTH_REQUIRED` set to anything but empty or `false`). With accounts on, a phone receives only while the sign-in session that registered it is alive: signing out removes its registration, a password reset removes the account's ended phones at once, and an hourly cron ("forget phones whose sign-in ended") removes the rest. See [`convex/push/README.md`](../convex/push/README.md).
- **A text through Keiki**, which puts an agent on messaging channels. It goes to one phone number set for the whole deployment, so it is used only in the single-owner demo: with accounts on that number reads as not set, the AI permission refuses Keiki because it is not on the list an owner is asked about, and no account's alerts are texted to someone else.

## Case events

The workflow sends its alerts through [`convex/notices.ts`](../convex/notices.ts): `internal.notices.notifyOwner` takes `{ caseId, event, text }`, where `event` is `opened`, `needs_decision` or `handled_under_permission`. It claims one `ownerNotices` row per case and event, so each event is sent at most once per case. Then:

- for `needs_decision` and `handled_under_permission` it schedules `internal.push.deliver.forNotice`, which pushes a fixed sentence to every live phone of the project's owner and records the outcome in `pushSends`. `opened` sends no push. The push never carries `text`: its words come only from `convex/push/message.ts`;
- for every event it sends `text` through Keiki and records the outcome on the `ownerNotices` row.

`api.notices.forCase` reads those rows, and only for a case the caller may see.

## Keiki

[`convex/keiki.ts`](../convex/keiki.ts) exports `sendOwnerNotice(gate, text)`, a plain function for actions, and `internal.keiki.notifyOwner`, an internal action with args `{ appId, text }` that calls it with that project's permission gate. Both return `{ outcome, status? }`, where `outcome` is `ran`, `queued`, `unavailable`, `not_configured` or `failed`. Alerts are best effort: the helper never throws, so a failed alert cannot break the workflow that sends it. It logs one line with the status (never the key) on a failure. The text is cut to 600 characters and sent with the phone number.

Keiki is not on the AI permission screen (`convex/consent`): like the council's Anthropic and Google models it is demo only, so with accounts on the gate refuses it and the helper reports `not_configured`. In the demo the gate always says yes.

```ts
// From an action: call it directly with the project's gate.
import { gateFor } from "./consent/gate";
import { sendOwnerNotice } from "./keiki";
const result = await sendOwnerNotice(gateFor(ctx, { appId }), "Case 12 is stuck on step 3.");

// From a mutation: schedule it, so the mutation does not wait on the network.
await ctx.scheduler.runAfter(0, internal.keiki.notifyOwner, { appId, text: "Case 12 is stuck on step 3." });
```

### Configuration

Set these on the Convex deployment (values are never committed). With any of the first three missing, or with accounts on, the helper returns `not_configured` and makes no request:

```sh
npx convex env set KEIKI_API_KEY "$KEIKI_API_KEY"
npx convex env set KEIKI_AGENT_ID <the turtl alerts agent id>
npx convex env set KEIKI_OWNER_CONTACT <the owner's conversation identity, a phone number>
```

`KEIKI_BASE_URL` points the helper at a stand-in in tests; leave it unset otherwise (the default is `https://onkeiki.com`). With accounts on, the backend honours it only when it runs on this machine.

The owner must have messaged the agent once first: a notice goes to an existing conversation, and Keiki answers 404 (reported as `failed`) for a contact with none. The text is written for the agent and is not delivered word for word; the agent decides whether and how to tell the owner.
