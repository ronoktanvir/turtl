# Owner preferences, feedback learning and context learning

Brief section 5.4 (the "Owner constraints and feedback" and "Codebase and product context" rows) and section 5.7 (the context and feedback loops). turtl remembers what the owner says matters, learns from how the owner decides, and learns which context helped a verified fix. None of it is evidence, and none of it authorizes anything.

## Files

- `schema.ts`: `ownerDecisions`, `preferenceSuggestions` and `contextUses`, spread into `convex/schema.ts`. The existing `ownerPreferences` and `contextSources` tables are the records; this module is the first to write them.
- `rules.ts`: pure rules with no Convex imports, so `tests/learning-rules.test.mjs` loads them directly: which case conditions count as the same, what makes two fixes the same option, how a preference and past decisions move the recommendation.
- `preferences.ts`: the owner's statements. Public: `list` (query), `add`, `remove`, `confirm` and `dismiss` (mutations, each behind the owner passcode). Internal: Supermemory indexing and ranking, suggestions, and reading a decision note.
- `feedback.ts`: `recordDecision`, called by `decisions.approve`, `decisions.decline` and `decisions.stop` in the same transaction, and `history`, which the plan step reads.
- `context.ts`: `supplyContext`, called by `gather_context`, and `markForCase`, called by `learn`.
- `model.ts`: one JSON model call with its `agentRuns` row, and the note-to-preference prompt.
- `runs.ts`: start and finish `agentRuns` rows for this module's model calls.

## Preferences

A preference is a plain sentence ("Keep checkout up", "Don't restart active jobs"). Convex's `ownerPreferences` is the record. A copy goes to Supermemory in the namespace `prefs_<appId>`, with the Convex id as the document id, and that id is stored on the row as `supermemoryId`. Removing a preference deletes the row and then the Supermemory document.

There are three ways in, and only the owner's confirmation saves anything:

1. The gear sheet's "What matters to you": typing a statement and tapping Add is the confirmation.
2. A note left when declining (`decisions.decline`) or when approving a fix that was not the recommended one (`decisions.approve` with `note`). The note is stored on the decision. `suggestFromNote` asks a model whether it states a lasting preference; if so, a pending suggestion appears under "turtl heard". With no model answer, the note itself is suggested as written, and the result says no model answered.
3. The Investigate further chat (`fixes.investigate`). The chat's own model call returns `preference` when the owner states one; turtl adds a pending suggestion tied to that message, and the message shows it back with Save and Not now.

`confirm` turns a suggestion into a preference (the owner may edit the words), and `dismiss` drops it. Both check the passcode.

## How preferences shape a recommendation

The plan step calls `applicablePreferences`: every Convex preference for the app, with those Supermemory ranks as relevant to the case first. A Supermemory hit with no Convex record is ignored. `planFixes` (`convex/fixOptions.ts`) passes them to the model as `ownerPreferences` with short refs, and the model marks each fix `honours` or `against` each preference it bears on. When no preferences exist, the prompt says so, and any sentence claiming the owner asked for something is removed from a fix that cites no stored preference.

`recommend` in `rules.ts` makes the final pick:

1. Start from the rule-based pick: the catalog action when the facts or a rechecked recovery memory support it, otherwise the model's pick among code changes.
2. A preference may steer the pick to another supported fix the model recommended because it honours a preference, or, when the pick goes against a preference, to a supported fix that honours it.
3. A fix turned down twice under the same conditions is not recommended while another supported fix exists.

A preference never makes a fix recommended that the facts don't support. It never enters the facts that a recovery memory's conditions or a permission's checks read (`memory/checks.ts` evaluates only typed observation facts), and it never approves anything. An Auto permission runs only when the recommended option matches it, so a preference can stop an automatic run but never start one.

Each fix carries `preferences` (a snapshot of the statements that shaped it), shown under "What you asked for", apart from the evidence. The recommended fix's explanation cites them ("You asked: … So turtl recommends this instead of …"), and a fix that goes against one says so.

## Feedback learning

Every owner decision writes an `ownerDecisions` row: what turtl recommended, what the owner did (`approved`, `chose_other`, `declined` or `stopped`), the owner's note, and the case conditions (the symptom signature plus `journey.failedStep`, `journey.errorCode` and `flags.recommendationsEnabled`). The fix the owner turned down is recorded by fingerprint: the catalog action and its values, or, for a code change whose words differ every time, `pull_request:<kind>`. A fix counts as turned down when the owner declined it while it was recommended, passed over it for another fix, or stopped it after approving it.

The plan step reads the decisions under the same conditions. The model sees the recent ones as `pastDecisions`. Each fix with history carries `pastDecisions`, one plain sentence ("You turned this down twice before when … You said: "…". So turtl does not recommend it this time."). A fix turned down twice is not recommended again when another supported fix exists; when it is the only one, it stays recommended and says why.

## Context learning

`gather_context` calls `supplyContext` after memory recall. It supplies:

- code network nodes (`code:<path>`, or `document` for a `.md` path), ranked by the rarer words of the failure;
- earlier case notes for the app (`cases/<id>`);
- recovery memory candidates (`recoveryMemories/<id>`);
- any source that helped a verified fix before, even when this case's words did not match it.

Each source is one `contextSources` row per app and source reference, keyed by the item, not by the code that read it. Each supply writes a `contextUses` row with the app revision. Sources that helped before are ranked first, and the step's summary names them ("Fetched first, because they helped a verified fix before: …"). A source that helped at another app revision is flagged as possibly stale in the summary, and is passed to the model with `possiblyStale`.

The plan step passes the supplied context to the fix model, which lists the entries each fix relies on. These become the option's `contextIds`. `learn` calls `markForCase`. A source counts as used when the chosen fix relied on it, when it is the recovery memory the case used, or when a model diagnosis read that past case's note. When the approved action completed and an after-fix check passed, the used sources are marked as having helped, with `timesHelped` and the revision recorded on the source.

## Model calls

Every model call this module adds writes an `agentRuns` row:

- `propose_fixes`: the plan step's fix model, with `contextRefs` set to the supplied sources;
- `extract_preference`: reading a decision note. It belongs to the case and to no step.

The chat's preference detection rides on the chat's existing call, which `fixes.investigate` already records.

## Supermemory

Namespaces are `prefs_<appId>` for preferences. `convex/supermemory.ts` prefixes every namespace with `SUPERMEMORY_NAMESPACE_PREFIX` when it is set, so a local proof never writes into a hosted project's memory. Leave the variable unset on the hosted deployment. A missing `SUPERMEMORY_API_KEY` leaves preferences unranked and unindexed; the Convex records still apply.
