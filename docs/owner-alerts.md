# Owner alerts

[`convex/keiki.ts`](../convex/keiki.ts) lets the backend tell the app owner about an event through Keiki, which puts an agent on messaging channels. A Keiki agent named `turtl alerts` receives the event and messages the owner in its own words. Keiki is used for notifications to the owner only; customers never text it.

It exports `sendOwnerNotice(text)`, a plain function for actions, and `internal.keiki.notifyOwner`, an internal action with args `{ text }` that calls it. Both return `{ outcome, status? }`, where `outcome` is `ran`, `queued`, `unavailable`, `not_configured` or `failed`. Alerts are best effort: the helper never throws, so a failed alert cannot break the workflow that sends it. It logs one line with the status (never the key) on a failure. The text is cut to 600 characters.

```ts
// From a mutation: schedule it, so the mutation does not wait on the network.
await ctx.scheduler.runAfter(0, internal.keiki.notifyOwner, { text: "Case 12 is stuck on step 3." });

// From an action: call it directly.
import { sendOwnerNotice } from "./keiki";
const result = await sendOwnerNotice("Case 12 is stuck on step 3.");
```

## Case events

The workflow sends its alerts through [`convex/notices.ts`](../convex/notices.ts): `internal.notices.notifyOwner` takes `{ caseId, event, text }`, where `event` is `opened`, `needs_decision` or `handled_under_permission`. It claims one `ownerNotices` row per case and event, sends through `sendOwnerNotice`, and records the outcome on that row, so each event is sent at most once per case. `api.notices.forCase` reads those rows.

## Configuration

Set these on the Convex deployment (values are never committed). With any of the first three missing, the helper returns `not_configured` and makes no request:

```sh
npx convex env set KEIKI_API_KEY "$KEIKI_API_KEY"
npx convex env set KEIKI_AGENT_ID <the turtl alerts agent id>
npx convex env set KEIKI_OWNER_CONTACT <the owner's conversation identity, for example +15551234567>
npx convex env set KEIKI_BASE_URL https://onkeiki.com   # optional; this is the default
```

The owner must have messaged the agent once first: a notice goes to an existing conversation, and Keiki answers 404 (reported as `failed`) for a contact with none. The text is written for the agent and is not delivered word for word; the agent decides whether and how to tell the owner.
