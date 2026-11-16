import { MANIFEST_CREDENTIAL_REF, MANIFEST_FILE, READINESS_ITEMS, manifestPath, type Item, type Stack } from "./detect";

type NeverBreak = { text: string; addCheck: boolean };

const label = (key: Item["key"]) => READINESS_ITEMS.find((item) => item.key === key)!.label;
const cite = (item: Item) => item.files.map((file) => (file.line ? `${file.path}:${file.line}` : file.path)).join(", ");

const MANIFEST_SPEC = [
  `{`,
  `  "version": 1,`,
  `  "credentialRef": "${MANIFEST_CREDENTIAL_REF}", // exactly this name: the setting on turtl's side that holds the bearer token for authenticated paths; never the secret itself`,
  `  "health":    { "name": "...", "path": "/health" },`,
  `  "readiness": { "name": "...", "path": "/ready", "authenticated": false },`,
  `  "journeys": [ { "name": "...", "description": "...", "path": "/journey-check", "authenticated": true } ],`,
  `  "flags": [ { "name": "...", "description": "...", "field": "someFeatureEnabled", "path": "/flags", "authenticated": true } ],`,
  `  "recoveryHooks": [ { "name": "...", "description": "...", "field": "someSwitch", "path": "/some-switch", "authenticated": true } ]`,
  `}`,
].join("\n");

// The message Capy works from. It is built only from the stored readiness report and the owner's answers.
export function preparationBrief(input: {
  appName: string;
  repo: string;
  baseBranch: string;
  folders: string[];
  liveUrl?: string;
  ref: string;
  stack: Stack;
  items: Item[];
  hasManifest: boolean;
  neverBreak: NeverBreak[];
}): { title: string; message: string } {
  const { appName, repo, baseBranch, folders, liveUrl, ref, stack, items, hasManifest, neverBreak } = input;
  const found = items.filter((item) => item.status === "found");
  const toAdd = items.filter((item) => item.status !== "found");
  const checks = neverBreak.filter((item) => item.addCheck);
  const watchOnly = neverBreak.filter((item) => !item.addCheck);
  const where = folders.length ? `the app in ${folders.map((folder) => `\`${folder}/\``).join(" and ")} (and the files that mount it, such as a shared HTTP router)` : "the app (the whole repository)";
  const title = `turtl onboarding: prepare ${appName} to be watched and recovered`;
  const message = [
    `turtl is an on-call app for a solo owner who cannot read code. The owner connected ${repo} to turtl and approved ONE pull request that prepares ${where} so turtl can watch it and recover it. turtl read the repository at commit ${ref}; the stack is ${stack.label}.`,
    "",
    "## Already there (keep it; reuse it; do not duplicate it)",
    ...(found.length ? found.map((item) => `- ${label(item.key)}: ${item.note} (${cite(item)})`) : ["- Nothing turtl could confirm."]),
    "",
    "## Add what is missing",
    ...(toAdd.length
      ? toAdd.map((item) => `- ${label(item.key)} (${item.status === "missing" ? "missing" : "turtl could not tell; check, and add it only if it is really absent"}): ${item.note}`)
      : ["- Every item exists already; add only the checks below and the manifest."]),
    "",
    "## What the owner said must never break",
    ...(checks.length ? ["Add one journey check for each of these, in the owner's words:", ...checks.map((item) => `- ${item.text}`)] : ["- The owner asked for no new journey checks."]),
    ...(watchOnly.length ? ["The owner also named these but asked for no check now; do not add checks for them:", ...watchOnly.map((item) => `- ${item.text}`)] : []),
    "",
    "## How to build it on this stack (Expo with a Convex backend)",
    "- Put HTTP endpoints in the app's Convex HTTP router (convex/http.ts), under the same path prefix the app's existing endpoints use, so they live next to the app's other routes. Change nothing outside the app's files and that router.",
    "- Health: GET returns 200 with a small JSON body as long as the server answers.",
    "- Readiness: GET returns 200 when the app can serve customers (its own data store and required providers answer) and 503 with the failing dependency when it cannot.",
    "- Journey checks: POST, protected by the app's existing bearer secret. Each runs the journey end to end on the server with test fixtures, cleans the fixtures up, and returns JSON { runId, verdict: \"passed\" | \"failed\", failedStep, error: { code, message, step } | null, steps: [{ step, verdict, detail }], cleanup: { ok, deletedBookings (the number of fixture records deleted) }, revision, environment, startedAt, completedAt } with HTTP 200 when passed and 503 when failed. Reuse the shape of an existing journey check if there is one.",
    "- Structured errors: every failure records a stable error code and an identifier (request or run id) so one failure can be found and counted.",
    "- Feature flags and recovery hooks: each is a boolean switch. GET (authenticated) returns JSON with the switch's field; POST (authenticated) with exactly one boolean field sets it and returns the new state. Unknown fields get 400, a wrong or missing secret gets 401.",
    "- Test fixtures: mark fixture data so it never counts as a real customer and is deleted after each check.",
    "",
    `## Describe it for turtl: \`${manifestPath(folders)}\``,
    `${hasManifest ? "Update" : "Add"} \`${MANIFEST_FILE}\` at that path, listing every health, readiness, journey, flag and recovery endpoint (new and existing). Paths are relative to the live app URL${liveUrl ? ` the owner gave turtl (${liveUrl})` : ""}. After the merge turtl reads this file at the merge commit, calls each path on the live app, and registers only the ones that answer. Shape:`,
    "```jsonc",
    MANIFEST_SPEC,
    "```",
    "",
    "## Explain and test everything you add",
    "- Add tests for every endpoint and behaviour you add (follow the repository's existing test style), and run the repository's typecheck and tests.",
    "- In the pull request description, explain each addition in plain words an owner who cannot read code understands: what it is, why turtl needs it, and how it was tested. Say plainly what you did not add and why. New logs cannot recover failures from before they were installed; say so.",
    "- Install no new service and no new dependency unless it is unavoidable, and name it in the description if you do.",
    "",
    `Open exactly one pull request against ${baseBranch} titled "${title}" and reply with its URL. Do not merge it: the owner merges it from turtl once its checks pass.`,
  ].join("\n");
  return { title, message };
}
