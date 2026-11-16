import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

// Every environment variable the Convex backend reads, and what production does with it.
// production: "required" (the release stops without it), "optional", or "never" (the release stops if it is set).
export const variables = [
  { name: "OPENAI_API_KEY", production: "required", secret: true, what: "Model calls: diagnosis, fix options, customer report triage, the case chat, the code map's labels and chat, and voice. Without it turtl falls back to rule-based text or refuses the feature." },
  { name: "SUPERMEMORY_API_KEY", production: "required", secret: true, what: "Memory of past incidents, matching of customer reports, and the code map. Without it turtl reads only its recent notes in Convex and cannot build a code map. Use a key that is not the demo's, so production memory is separate." },
  { name: "DIAGNOSIS_MODEL", production: "optional", what: "Model for diagnosis. Default gpt-5.4-mini." },
  { name: "FIXES_MODEL", production: "optional", what: "Model for fix options and report triage. Default: the diagnosis model." },
  { name: "OPENAI_MODEL", production: "optional", what: "Model for the code map's labels and chat, and for assistant.chat. Default gpt-6-luna." },
  { name: "VOICE_ENABLED", production: "optional", what: "\"true\" turns on talking with turtl about a case. Anything else and voice refuses with a plain message. Each turn spends OpenAI credits." },
  { name: "VOICE_TRANSCRIBE_MODEL", production: "optional", what: "Model that transcribes a voice clip. Default gpt-4o-mini-transcribe." },
  { name: "VOICE_SPEECH_MODEL", production: "optional", what: "Model that speaks a reply. Default gpt-4o-mini-tts." },
  { name: "CODE_NETWORK_CHAT_ENABLED", production: "optional", what: "\"true\" lets the Investigate screen answer questions about the code. Each question spends OpenAI and Supermemory credits." },
  { name: "INTAKE_NAMESPACE_PREFIX", production: "optional", what: "Prefix for the Supermemory namespaces that hold customer reports. It keeps a test deployment's reports apart; leave it unset in production." },
  { name: "GITHUB_TOKEN", production: "optional", secret: true, what: "One GitHub token for the whole deployment: reads pull requests and checks, merges on the owner's approval, and fetches repositories for the code map. Every account acts through it, so give it only the repositories turtl may touch, and remove it once GitHub App installation tokens replace it." },
  { name: "CAPY_API_KEY", production: "optional", secret: true, what: "Starts the Capy thread that writes a code fix and opens its pull request. Without it a code fix reports that it cannot open a pull request. Every account's fixes are billed to this key's owner." },
  { name: "CAPY_PROJECT_ID", production: "optional", what: "Capy project those threads start in. Default: the project that holds the repository." },
  { name: "CAPY_MODEL_ID", production: "optional", what: "Model for those Capy threads. Default: the Capy project's model." },
  { name: "CAPY_REASONING", production: "optional", what: "Reasoning level for those Capy threads. Used only with CAPY_MODEL_ID." },
  { name: "REVYL_API_KEY", production: "optional", secret: true, what: "Runs a fix's device check on a Revyl cloud phone. Without it a device check reports that it is not set up." },
  { name: "REVYL_BASE_URL", production: "optional", what: "Revyl API address. Default https://backend.revyl.ai." },
  { name: "KEIKI_API_KEY", production: "optional", secret: true, what: "Keiki key for owner alerts by text. Does nothing without KEIKI_AGENT_ID and KEIKI_OWNER_CONTACT." },
  { name: "KEIKI_AGENT_ID", production: "optional", what: "The Keiki agent that words owner alerts." },
  { name: "KEIKI_BASE_URL", production: "optional", what: "Keiki API address. Default https://onkeiki.com." },
  { name: "KEIKI_OWNER_CONTACT", production: "never", what: "One phone number that receives every alert in the deployment. In production that would text one person about every account's incidents. Never set it until alerts go to each account's own owner." },
  { name: "DEV_TOOLS_ENABLED", production: "never", what: "\"true\" opens the dev tools functions: sample cases, staged outages on the booking demo, memory resets, and seeded data, callable by anyone who knows the backend address." },
  { name: "ASSISTANT_ENABLED", production: "never", what: "\"true\" opens assistant.chat, a public action that reads and writes memory under whatever user id the caller sends. No screen uses it. Never set it until the action checks its caller." },
  { name: "PROTECTED_APP_URL", production: "never", what: "Address of the booking demo's control routes. It makes this deployment watch the one demo app every minute. Demo only." },
  { name: "PROTECTED_APP_CONTROL_SECRET", production: "never", secret: true, what: "Bearer token turtl sends to the booking demo's control routes. Demo only." },
  { name: "PROTECTED_APP_CONTROL_SECRET_SHA256", production: "never", what: "Hash that opens the booking demo's control routes (/booking-demo/flags, /staged-failure, /journey-check, /errors) on this deployment. Without it they answer 503. Demo only." },
  { name: "PROTECTED_APP_REVISION", production: "never", what: "Revision label the booking demo reports. Demo only." },
  { name: "REVYL_BOOKING_WORKFLOW_ID", production: "never", what: "Revyl workflow for the booking demo's device check. Demo only." },
];

// Files that read a variable by a computed name, with the names they can ask for. A scan cannot see these names, so they are listed by hand.
export const computedReads = {
  "convex/assistant.ts": ["OPENAI_API_KEY", "SUPERMEMORY_API_KEY"],
  "convex/codeNetwork/ask.ts": ["OPENAI_API_KEY", "SUPERMEMORY_API_KEY"],
  "convex/codeNetwork/build.ts": ["OPENAI_API_KEY", "SUPERMEMORY_API_KEY"],
  "convex/diagnosis.ts": ["DIAGNOSIS_MODEL"],
  "convex/fixOptions.ts": ["FIXES_MODEL"],
  "convex/protectedApp/client.ts": ["PROTECTED_APP_CONTROL_SECRET"],
  "convex/revyl/api.ts": ["REVYL_API_KEY", "REVYL_BOOKING_WORKFLOW_ID"],
  "convex/voice/turn.ts": ["VOICE_ENABLED", "OPENAI_API_KEY"],
};

// Set by Convex itself on every deployment; nobody sets or checks these.
const builtIn = ["CONVEX_CLOUD_URL", "CONVEX_SITE_URL"];

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "_generated" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

// What the code under convex/ reads today: the names it reads directly, and the files that read by a computed name.
export function scanBackend(root) {
  const names = new Set();
  const computed = [];
  for (const path of sourceFiles(join(root, "convex"))) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(match[1]);
    if (/\bprocess\.env\s*(\[|[,)])/.test(source)) computed.push(relative(root, path).split("\\").join("/"));
  }
  return { names: [...names].filter((name) => !builtIn.includes(name)).sort(), computed: computed.sort() };
}

// Where the table and the code disagree. An empty list means the table covers exactly what the backend reads.
export function tableProblems(root) {
  const scan = scanBackend(root);
  const listed = variables.map((row) => row.name);
  const read = new Set([...scan.names, ...Object.values(computedReads).flat()]);
  const known = Object.keys(computedReads).sort();
  return [
    ...[...read].filter((name) => !listed.includes(name)).map((name) => `convex/ reads ${name}, which has no row in release/backend-env.mjs. Add one saying what it does and whether production needs it.`),
    ...listed.filter((name) => !read.has(name)).map((name) => `release/backend-env.mjs lists ${name}, which convex/ no longer reads. Remove its row.`),
    ...scan.computed.filter((file) => !known.includes(file)).map((file) => `${file} reads a variable by a computed name. List the names it can ask for under computedReads in release/backend-env.mjs.`),
    ...known.filter((file) => !scan.computed.includes(file)).map((file) => `release/backend-env.mjs lists computed reads in ${file}, which has none now. Remove that entry.`),
    ...listed.filter((name, index) => listed.indexOf(name) !== index).map((name) => `release/backend-env.mjs lists ${name} twice.`),
  ];
}

// Compares the variable names set on a deployment with the table. It never sees a value.
export function deploymentProblems(names) {
  const set = new Set(names);
  return [
    ...variables.filter((row) => row.production === "required" && !set.has(row.name)).map((row) => `${row.name} is required and is not set.`),
    ...variables.filter((row) => row.production === "never" && set.has(row.name)).map((row) => `${row.name} is set and must never be set in production. Remove it.`),
    ...[...set].filter((name) => !variables.some((row) => row.name === name) && !builtIn.includes(name)).sort().map((name) => `${name} is set but has no row in release/backend-env.mjs. Add a row for it or remove it from the deployment.`),
  ];
}

export function markdownTable() {
  const word = { required: "Required", optional: "Optional", never: "Never set" };
  return [
    "| Variable | Production | What it does |",
    "| --- | --- | --- |",
    ...variables.map((row) => `| \`${row.name}\`${row.secret ? " (secret)" : ""} | ${word[row.production]} | ${row.what} |`),
  ].join("\n");
}
