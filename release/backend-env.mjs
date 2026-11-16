import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

// Every environment variable the Convex backend reads, and what production does with it.
// production: "required" (the release stops without it), "optional", or "never" (the release stops if it is set).
// arrives: the pull request that brings the variable, for a row written before its code merged. Delete the field once it has.
export const variables = [
  { name: "AUTH_REQUIRED", production: "required", what: "Set it to \"true\". Every backend function then needs a signed-in account and reaches only that account's projects, owner decisions are authorised by the account instead of the shared owner passcode, and the dev tools stay closed. Unset, the backend is the single-owner demo, where anyone with its address acts as the one owner. The release check sees only the name, so check the value is \"true\"." },
  { name: "OPENAI_API_KEY", production: "required", secret: true, what: "Model calls: diagnosis, fix options, customer report triage, the case chat, the code map's labels and chat, and voice. Without it turtl falls back to rule-based text or refuses the feature." },
  { name: "SUPERMEMORY_API_KEY", production: "required", secret: true, what: "Memory of past incidents, matching of customer reports, and the code map. Without it turtl reads only its recent notes in Convex and cannot build a code map. Use a key that is not the demo's, so production memory is separate." },
  { name: "DIAGNOSIS_MODEL", production: "optional", what: "Model for diagnosis. Default gpt-5.4-mini." },
  { name: "FIXES_MODEL", production: "optional", what: "Model for fix options and report triage. Default: the diagnosis model." },
  { name: "OPENAI_MODEL", production: "optional", what: "Model for the code map's labels and chat, and for reading a repository at onboarding. Default gpt-6-luna." },
  { name: "VOICE_ENABLED", production: "optional", what: "\"true\" turns on talking with turtl about a case. Anything else and voice refuses with a plain message. Each turn spends OpenAI credits." },
  { name: "VOICE_TRANSCRIBE_MODEL", production: "optional", what: "Model that transcribes a voice clip. Default gpt-4o-mini-transcribe." },
  { name: "VOICE_SPEECH_MODEL", production: "optional", what: "Model that speaks a reply. Default gpt-4o-mini-tts." },
  { name: "CODE_NETWORK_CHAT_ENABLED", production: "optional", what: "\"true\" lets the Investigate screen answer questions about the code. Each question spends OpenAI and Supermemory credits." },
  { name: "INTAKE_CONTACT_KEY", production: "required", secret: true, what: "Key for the keyed hash a customer's contact on the report form becomes, so turtl can count one person once without keeping the address. Use at least 32 random characters and never change it: a new key counts returning customers as new people. Without it the contact becomes a plain hash, which someone holding the database could match against a guessed address." },
  { name: "INTAKE_NAMESPACE_PREFIX", production: "optional", what: "Prefix for the Supermemory namespaces that hold customer reports. It keeps a test deployment's reports apart; leave it unset in production." },
  { name: "GITHUB_APP_ID", production: "required", arrives: "turtl#54", what: "The GitHub App's id. turtl reaches each account's repositories with a token of the app's installation on them, and with nothing else." },
  { name: "GITHUB_APP_PRIVATE_KEY", production: "required", secret: true, arrives: "turtl#54", what: "The GitHub App's private key (the .pem file), which signs the request for an installation token." },
  { name: "GITHUB_APP_SLUG", production: "required", arrives: "turtl#54", what: "The GitHub App's name in its public link, used to send an owner to install it." },
  { name: "GITHUB_APP_WEBHOOK_SECRET", production: "required", secret: true, arrives: "turtl#54", what: "Proves a webhook delivery came from GitHub. Without it every delivery is answered 503." },
  { name: "AUTH_GITHUB_ID", production: "required", what: "The same GitHub App's client id, for signing in with GitHub." },
  { name: "AUTH_GITHUB_SECRET", production: "required", secret: true, what: "The same GitHub App's client secret." },
  { name: "JWT_PRIVATE_KEY", production: "required", secret: true, what: "Signs the sign-in tokens the backend hands out (Convex Auth). Make it with the steps in convex/auth/README.md, with JWKS. Changing it signs everyone out." },
  { name: "JWKS", production: "required", what: "The public half of JWT_PRIVATE_KEY, which the backend checks sign-in tokens against." },
  { name: "SITE_URL", production: "required", what: "Where GitHub sign-in returns on the web, and the only web address a sign-in code may be sent to besides the app's own turtl:// link. The password reset email needs it too. For the iPhone-only launch, the turtl site: https://ronoktanvir.github.io/turtl" },
  { name: "AUTH_RESEND_KEY", production: "optional", secret: true, what: "Resend key that emails the code for a password reset. Without it, or without AUTH_EMAIL_FROM, reset is off and the app tells people to contact support." },
  { name: "AUTH_EMAIL_FROM", production: "optional", what: "Sender of the reset email, on a domain verified with Resend, such as \"turtl <no-reply@example.com>\". Register the same domain with Apple so Hide My Email addresses receive it." },
  { name: "AUTH_APPLE_BUNDLE_ID", production: "optional", what: "The app's bundle id, which Apple names as the audience of a Sign in with Apple token. Default com.turtl.oncall. Change it only together with the app's bundle id." },
  { name: "AUTH_STAND_IN_URL", production: "never", what: "Points GitHub sign-in, Apple's signing keys and the reset email at a stand-in server in tests. In production it would let that server decide who is signed in." },
  { name: "AUTH_SESSION_TOTAL_DURATION_MS", production: "optional", what: "How long a sign-in lasts before the person must sign in again. Default 30 days." },
  { name: "AUTH_SESSION_INACTIVE_DURATION_MS", production: "optional", what: "How long a sign-in lasts unused. Default 30 days." },
  { name: "AUTH_LOG_LEVEL", production: "optional", what: "How much Convex Auth logs: ERROR, WARN, INFO (the default) or DEBUG. DEBUG writes email addresses to the logs; leave it unset in production." },
  { name: "AUTH_LOG_SECRETS", production: "never", what: "\"true\" makes Convex Auth write passwords and tokens to the logs." },
  { name: "CUSTOM_AUTH_SITE_URL", production: "optional", what: "The backend's own web address when it is served from a custom domain; GitHub sign-in starts there. Default: the deployment's .convex.site address." },
  { name: "CAPY_API_KEY", production: "optional", secret: true, what: "Starts the Capy thread that writes a code fix and opens its pull request. Without it a code fix reports that it cannot open a pull request. Every account's fixes are billed to this key's owner." },
  { name: "CAPY_PROJECT_ID", production: "optional", what: "Capy project those threads start in. Default: the project that holds the repository." },
  { name: "CAPY_MODEL_ID", production: "optional", what: "Model for those Capy threads. Default: the Capy project's model." },
  { name: "CAPY_REASONING", production: "optional", what: "Reasoning level for those Capy threads. Used only with CAPY_MODEL_ID." },
  { name: "MODEL_SPEND_LIMIT_USD", production: "optional", what: "With accounts on, the estimated model spend in US dollars one account may reach in a calendar month (UTC); past it turtl asks no model for that account and says so on the case. Default 20. No limit in the single-owner demo." },
  { name: "CODING_THREADS_PER_DAY", production: "optional", what: "With accounts on, how many Capy threads (code changes) one account may start in a calendar day (UTC), since every thread is billed to CAPY_API_KEY. Default 5. No limit in the single-owner demo." },
  { name: "REVYL_API_KEY", production: "optional", secret: true, what: "Runs a fix's device check on a Revyl cloud phone. Without it a device check reports that it is not set up." },
  { name: "REVYL_BASE_URL", production: "optional", what: "Revyl API address. Default https://backend.revyl.ai." },
  { name: "KEIKI_API_KEY", production: "optional", secret: true, what: "Keiki key for owner alerts by text. Does nothing without KEIKI_AGENT_ID and KEIKI_OWNER_CONTACT." },
  { name: "KEIKI_AGENT_ID", production: "optional", what: "The Keiki agent that words owner alerts." },
  { name: "KEIKI_BASE_URL", production: "optional", what: "Keiki API address. Default https://onkeiki.com." },
  { name: "EXPO_ACCESS_TOKEN", production: "optional", secret: true, what: "Expo access token for push notifications, needed only once enhanced push security is turned on for the project in Expo. Without it pushes still send while that setting is off." },
  { name: "KEIKI_OWNER_CONTACT", production: "never", what: "One phone number that receives every alert in the deployment. In production that would text one person about every account's incidents. Never set it until alerts go to each account's own owner." },
  { name: "GITHUB_TOKEN", production: "never", secret: true, what: "One GitHub token for the whole deployment, which is how the demo reaches GitHub. Every account would act through it. Production reaches GitHub only through the GitHub App, and with this unset there is nothing to fall back to when the app's variables go missing, so access fails closed." },
  { name: "GITHUB_API_URL", production: "never", arrives: "turtl#54", what: "Points GitHub calls at a stand-in server in tests. In production it would send the app's tokens to another server." },
  { name: "EXPO_PUSH_API_URL", production: "never", what: "Points push notifications at a stand-in for Expo's push service in tests. In production it would send every owner's phone address and project names to another server." },
  { name: "DEV_TOOLS_ENABLED", production: "never", what: "\"true\" opens the dev tools functions: sample cases, staged outages on the booking demo, memory resets, and seeded data, callable by anyone who knows the backend address. With AUTH_REQUIRED=true they stay closed whatever this says." },
  { name: "PROTECTED_APP_URL", production: "never", what: "Address of the booking demo's control routes. It makes this deployment watch the one demo app every minute. Demo only." },
  { name: "PROTECTED_APP_CONTROL_SECRET", production: "never", secret: true, what: "Bearer token turtl sends to the booking demo's control routes. Demo only." },
  { name: "PROTECTED_APP_CONTROL_SECRET_SHA256", production: "never", what: "Hash that opens the booking demo's control routes (/booking-demo/flags, /staged-failure, /journey-check, /errors) on this deployment. Without it they answer 503, and with AUTH_REQUIRED=true the booking demo's customer functions refuse too. Demo only." },
  { name: "PROTECTED_APP_REVISION", production: "never", what: "Revision label the booking demo reports. Demo only." },
  { name: "REVYL_BOOKING_WORKFLOW_ID", production: "never", what: "Revyl workflow for the booking demo's device check. Demo only." },
];

// Files that read a variable by a computed name, with the names they can ask for. A scan cannot see these names, so they are listed by hand.
// An entry for a file that does not exist yet waits for the pull request that brings it.
export const computedReads = {
  "convex/codeNetwork/ask.ts": ["OPENAI_API_KEY", "SUPERMEMORY_API_KEY"],
  "convex/codeNetwork/build.ts": ["OPENAI_API_KEY", "SUPERMEMORY_API_KEY"],
  "convex/diagnosis.ts": ["DIAGNOSIS_MODEL"],
  "convex/fixOptions.ts": ["FIXES_MODEL"],
  "convex/auth/settings.ts": ["JWT_PRIVATE_KEY", "JWKS", "SITE_URL", "AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET", "AUTH_LOG_LEVEL", "AUTH_LOG_SECRETS", "AUTH_SESSION_TOTAL_DURATION_MS", "AUTH_SESSION_INACTIVE_DURATION_MS", "CUSTOM_AUTH_SITE_URL"],
  "convex/github/access.ts": ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_SLUG", "GITHUB_APP_WEBHOOK_SECRET", "AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET", "GITHUB_TOKEN"],
  "convex/github/config.ts": ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_SLUG", "GITHUB_APP_WEBHOOK_SECRET"],
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
  const known = Object.keys(computedReads).filter((file) => existsSync(join(root, file))).sort();
  const read = new Set([...scan.names, ...known.flatMap((file) => computedReads[file])]);
  return [
    ...[...read].filter((name) => !listed.includes(name)).map((name) => `convex/ reads ${name}, which has no row in release/backend-env.mjs. Add one saying what it does and whether production needs it.`),
    ...variables.filter((row) => !row.arrives && !read.has(row.name)).map((row) => `release/backend-env.mjs lists ${row.name}, which convex/ no longer reads. Remove its row.`),
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
    ...variables.map((row) => `| \`${row.name}\`${row.secret ? " (secret)" : ""} | ${word[row.production]}${row.arrives ? `, arrives with ${row.arrives}` : ""} | ${row.what} |`),
  ].join("\n");
}
