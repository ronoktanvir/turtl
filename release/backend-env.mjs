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
  { name: "STRUCTURAL_MODEL", production: "optional", what: "Model that examines related cases for a deeper cause. Default gpt-5.4." },
  { name: "ANTHROPIC_API_KEY", production: "optional", secret: true, what: "Lets claude-sonnet-4-5 join the model council. With accounts on, nothing is sent to Anthropic until store/data-practices.json lists it and the owner has agreed." },
  { name: "GEMINI_API_KEY", production: "optional", secret: true, what: "Lets gemini-2.5-pro join the model council. With accounts on, nothing is sent to Google until store/data-practices.json lists it and the owner has agreed." },
  { name: "VOICE_ENABLED", production: "optional", what: "\"true\" turns on talking with turtl about a case. Anything else and voice refuses with a plain message. Each turn spends OpenAI credits." },
  { name: "VOICE_TRANSCRIBE_MODEL", production: "optional", what: "Model that transcribes a voice clip. Default gpt-4o-mini-transcribe." },
  { name: "VOICE_SPEECH_MODEL", production: "optional", what: "Model that speaks a reply. Default gpt-4o-mini-tts." },
  { name: "CODE_NETWORK_CHAT_ENABLED", production: "optional", what: "\"true\" lets the Investigate screen answer questions about the code. Each question spends OpenAI and Supermemory credits." },
  { name: "INTAKE_CONTACT_KEY", production: "required", secret: true, what: "Key for the keyed hash a customer's contact on the report form becomes, so turtl can count one person once without keeping the address. Use at least 32 random characters and never change it: a new key counts returning customers as new people. Without it the contact becomes a plain hash, which someone holding the database could match against a guessed address." },
  { name: "INTAKE_NAMESPACE_PREFIX", production: "optional", what: "Prefix for the Supermemory namespaces that hold customer reports. It keeps a test deployment's reports apart; leave it unset in production." },
  { name: "SUPERMEMORY_NAMESPACE_PREFIX", production: "optional", what: "Prefix for every Supermemory namespace. It keeps a test deployment's memory apart from a hosted project's; leave it unset in production." },
  { name: "GITHUB_APP_ID", production: "required", what: "The GitHub App's id. turtl reaches each account's repositories with a token of the app's installation on them, and with nothing else." },
  { name: "GITHUB_APP_PRIVATE_KEY", production: "required", secret: true, what: "The GitHub App's private key (the .pem file), which signs the request for an installation token." },
  { name: "GITHUB_APP_SLUG", production: "required", what: "The GitHub App's name in its public link, used to send an owner to install it." },
  { name: "GITHUB_APP_WEBHOOK_SECRET", production: "required", secret: true, what: "Proves a webhook delivery came from GitHub. Without it every delivery is answered 503." },
  { name: "AUTH_GITHUB_ID", production: "required", what: "The same GitHub App's client id. Connect GitHub asks the owner to authorize the app with it, which is how GitHub confirms who connected; signing in with GitHub uses it too. Without it Add project offers only a typed repository address." },
  { name: "AUTH_GITHUB_SECRET", production: "required", secret: true, what: "The same GitHub App's client secret. Connect GitHub exchanges the owner's authorization with it for a user token, uses that token to read which installations the owner can reach, then revokes it. Signing in with GitHub uses it too." },
  { name: "JWT_PRIVATE_KEY", production: "required", secret: true, what: "Signs the sign-in tokens the backend hands out (Convex Auth). Make it with the steps in convex/auth/README.md, with JWKS. Changing it signs everyone out." },
  { name: "JWKS", production: "required", what: "The public half of JWT_PRIVATE_KEY, which the backend checks sign-in tokens against." },
  { name: "SITE_URL", production: "required", what: "Where GitHub sign-in returns on the web, and the only web address a sign-in code may be sent to besides the app's own turtl:// link. The password reset email needs it too. For the iPhone-only launch, the turtl site: https://ronoktanvir.github.io/turtl" },
  { name: "AUTH_RESEND_KEY", production: "optional", secret: true, what: "Resend key that emails the code for a password reset. Without it, or without AUTH_EMAIL_FROM, reset is off and the app tells people to contact support." },
  { name: "AUTH_EMAIL_FROM", production: "optional", what: "Sender of the reset email, on a domain verified with Resend, such as \"turtl <no-reply@example.com>\". Register the same domain with Apple so Hide My Email addresses receive it." },
  { name: "AUTH_APPLE_BUNDLE_ID", production: "optional", what: "The app's bundle id, which Apple names as the audience of a Sign in with Apple token. Default com.turtl.oncall. Change it only together with the app's bundle id." },
  { name: "AUTH_APPLE_TEAM_ID", production: "required", what: "The Apple Developer team id. With AUTH_APPLE_KEY_ID and AUTH_APPLE_PRIVATE_KEY, turtl keeps the Apple token a person signs in with and revokes it when they delete their account, as Apple requires of apps that offer Sign in with Apple. Without all three, Sign in with Apple still works, but deleting such an account cannot revoke Apple's token." },
  { name: "AUTH_APPLE_KEY_ID", production: "required", what: "The id of the Sign in with Apple key (Certificates, Identifiers & Profiles > Keys) whose .p8 file is AUTH_APPLE_PRIVATE_KEY." },
  { name: "AUTH_APPLE_PRIVATE_KEY", production: "required", secret: true, what: "The contents of that Sign in with Apple key's .p8 file. It signs turtl's requests to Apple's token endpoints; line breaks may be spaces." },
  { name: "AUTH_STAND_IN_URL", production: "never", what: "Points GitHub sign-in, Apple's signing keys and token endpoints, and the reset email at a stand-in server in tests. In production it would let that server decide who is signed in, so with AUTH_REQUIRED=true the backend honours it only when it runs locally (convex/demoSettings.ts)." },
  { name: "AUTH_SESSION_TOTAL_DURATION_MS", production: "optional", what: "How long a sign-in lasts before the person must sign in again. Default 30 days." },
  { name: "AUTH_SESSION_INACTIVE_DURATION_MS", production: "optional", what: "How long a sign-in lasts unused. Default 30 days." },
  { name: "AUTH_LOG_LEVEL", production: "optional", what: "How much Convex Auth logs: ERROR, WARN, INFO (the default) or DEBUG. DEBUG writes email addresses to the logs; leave it unset in production." },
  { name: "AUTH_LOG_SECRETS", production: "never", what: "\"true\" makes Convex Auth write passwords and tokens to the logs." },
  { name: "CUSTOM_AUTH_SITE_URL", production: "optional", what: "The backend's own web address when it is served from a custom domain; GitHub sign-in starts there. Default: the deployment's .convex.site address." },
  { name: "SECRETS_ENCRYPTION_KEY", production: "required", secret: true, what: "Encrypts what owners entrust to turtl (each project's control token and each account's coding agent key) with AES-GCM. 32 random bytes in base64: make it with `openssl rand -base64 32`. Changing it makes every stored token and key unreadable, and owners must enter them again. Without it owners cannot store either, so no project can be watched with its token and no coding agent can start." },
  { name: "CAPY_API_KEY", production: "never", secret: true, what: "The single-owner demo's coding agent: starts the Capy thread that writes a code fix or a preparation and opens its pull request. With AUTH_REQUIRED=true it is never used: every account's threads start with that account's own Capy key, entered in the app. Demo only." },
  { name: "CAPY_PROJECT_ID", production: "never", what: "Capy project the demo's threads start in. Default: the project that holds the repository. Never used with accounts on. Demo only." },
  { name: "CAPY_MODEL_ID", production: "never", what: "Model for the demo's Capy threads. Default: the Capy project's model. Never used with accounts on. Demo only." },
  { name: "CAPY_REASONING", production: "never", what: "Reasoning level for the demo's Capy threads. Used only with CAPY_MODEL_ID. Demo only." },
  { name: "CAPY_API_URL", production: "never", what: "Points Capy calls at a stand-in server in tests. In production it would send owners' Capy keys to another server." },
  { name: "MODEL_SPEND_LIMIT_USD", production: "optional", what: "With accounts on, the estimated model spend in US dollars one account may reach in a calendar month (UTC); past it turtl asks no model for that account and says so on the case. Default 20. No limit in the single-owner demo." },
  { name: "CODING_THREADS_PER_DAY", production: "optional", what: "With accounts on, how many Capy threads (code changes) one account may start in a calendar day (UTC), since every thread is billed to CAPY_API_KEY. Default 5. No limit in the single-owner demo." },
  { name: "DEPLOYMENT_MODEL_SPEND_PER_DAY_USD", production: "optional", what: "With accounts on, the estimated model spend in US dollars of every account together in a calendar day (UTC). Every per-account limit multiplies with the number of accounts, and nothing yet stops a script making accounts, so this bounds the day's total; past it no account's model is asked until the next day, and each case says so. Default 25. No limit in the single-owner demo." },
  { name: "NEW_ACCOUNTS_PER_HOUR", production: "optional", what: "With accounts on, how many new accounts the deployment makes in one clock hour (UTC), by any sign-in method. Past it sign-up is refused in plain words until the next hour. Default 20." },
  { name: "NEW_ACCOUNTS_PER_DAY", production: "optional", what: "With accounts on, how many new accounts the deployment makes in a calendar day (UTC). Past it sign-up is refused in plain words until the next day. Default 100." },
  { name: "PROJECTS_PER_ACCOUNT", production: "optional", what: "With accounts on, how many projects one account may have. Each project brings its own report keys and customer-report allowance. Default 10." },
  { name: "INTAKE_KEYS_PER_PROJECT", production: "optional", what: "With accounts on, how many intake keys one project may have taking reports at once, since each key carries its own report limits. A stopped key makes room. Default 3." },
  { name: "INTAKE_SPEND_PER_DAY_USD", production: "optional", what: "With accounts on, the estimated model spend in US dollars that reading one project's customer reports may reach in a calendar day (UTC): triage, and investigating and planning the cases they open. It is separate from MODEL_SPEND_LIMIT_USD, so customers cannot spend what diagnosing the owner's outages needs; past it triage uses its rules and those cases a rule-based reading until the next day. Default 0.5. No limit in the single-owner demo." },
  { name: "INTAKE_CASES_PER_DAY", production: "optional", what: "With accounts on, how many new cases customer reports may open on one project in a calendar day (UTC). A report past it is kept on no case and says why; one that matches an open case still joins it. Default 5. No limit in the single-owner demo." },
  { name: "REVYL_API_KEY", production: "optional", secret: true, what: "Runs a fix's device check on a Revyl cloud phone. Without it a device check reports that it is not set up." },
  { name: "REVYL_BASE_URL", production: "optional", what: "Revyl API address. Default https://backend.revyl.ai." },
  { name: "KEIKI_API_KEY", production: "optional", secret: true, what: "Keiki key for owner alerts by text. Does nothing without KEIKI_AGENT_ID and KEIKI_OWNER_CONTACT." },
  { name: "KEIKI_AGENT_ID", production: "optional", what: "The Keiki agent that words owner alerts." },
  { name: "KEIKI_BASE_URL", production: "optional", what: "Keiki API address. Default https://onkeiki.com." },
  { name: "EXPO_ACCESS_TOKEN", production: "optional", secret: true, what: "Expo access token for push notifications, needed only once enhanced push security is turned on for the project in Expo. Without it pushes still send while that setting is off." },
  { name: "KEIKI_OWNER_CONTACT", production: "never", what: "One phone number that receives every alert in the deployment. In production that would text one person about every account's incidents. Never set it until alerts go to each account's own owner. With AUTH_REQUIRED=true the backend treats it as not set." },
  { name: "GITHUB_TOKEN", production: "never", secret: true, what: "One GitHub token for the whole deployment, which is how the demo reaches GitHub. Every account would act through it. Production reaches GitHub only through the GitHub App, and with this unset there is nothing to fall back to when the app's variables go missing, so access fails closed. With AUTH_REQUIRED=true the backend treats it as not set." },
  { name: "GITHUB_API_URL", production: "never", what: "Points GitHub calls at a stand-in server in tests. In production it would send the app's tokens to another server." },
  { name: "SUPERMEMORY_BASE_URL", production: "never", what: "Points Supermemory calls at a stand-in server in a local proof. In production it would send every owner's memory, reports and code to another server, so with AUTH_REQUIRED=true the backend honours it only when it runs locally (convex/demoSettings.ts)." },
  { name: "EXPO_PUSH_API_URL", production: "never", what: "Points push notifications at a stand-in for Expo's push service in tests. In production it would send every owner's phone address and project names to another server, so with AUTH_REQUIRED=true the backend honours it only when it runs locally." },
  { name: "DEV_TOOLS_ENABLED", production: "never", what: "\"true\" opens the dev tools functions: sample cases, staged outages on the booking demo, memory resets, and seeded data, callable by anyone who knows the backend address. With AUTH_REQUIRED=true they stay closed whatever this says." },
  { name: "EVIDENCE_LOCAL_PROOF", production: "never", what: "\"true\" opens the local evidence fixtures (convex/evidence/localProof.ts). They also need DEV_TOOLS_ENABLED and a localhost backend, and refuse to run anywhere else." },
  { name: "PROTECTED_APP_URL", production: "never", what: "Address of the booking demo's control routes. It makes this deployment watch the one demo app every minute. With AUTH_REQUIRED=true the monitor watches every project from its own rows and never reads it. Demo only." },
  { name: "PROTECTED_APP_CONTROL_SECRET", production: "never", secret: true, what: "Bearer token turtl sends to the booking demo's control routes. With AUTH_REQUIRED=true it is never sent: each project's requests carry only that project's own control token, entered by its owner. Demo only." },
  { name: "WATCHED_APP_ALLOW_LOOPBACK", production: "never", what: "\"true\" lets a backend running on this machine, with accounts on, watch apps at http://127.0.0.1 or localhost, for stand-in servers in tests. Any other backend ignores it." },
  { name: "PROTECTED_APP_CONTROL_SECRET_SHA256", production: "never", what: "Hash that opens the booking demo's control routes (/booking-demo/flags, /staged-failure, /journey-check, /errors) on this deployment. Without it they answer 503, and with AUTH_REQUIRED=true the booking demo's customer functions refuse too. Demo only." },
  { name: "PROTECTED_APP_REVISION", production: "never", what: "Revision label the booking demo reports. Demo only." },
  { name: "REVYL_BOOKING_WORKFLOW_ID", production: "never", what: "Revyl workflow for the booking demo's device check. Demo only: with AUTH_REQUIRED=true the backend treats it as not set, so no account's fix is checked with the demo's workflow on the operator's Revyl credits." },
];

// Files that read a variable by a computed name, with the names they can ask for. A scan cannot see these names, so they are listed by hand.
// An entry for a file that does not exist yet waits for the pull request that brings it.
export const computedReads = {
  "convex/codeNetwork/ask.ts": ["OPENAI_API_KEY", "SUPERMEMORY_API_KEY"],
  "convex/codeNetwork/build.ts": ["OPENAI_API_KEY", "SUPERMEMORY_API_KEY"],
  "convex/council/settings.ts": ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"],
  "convex/diagnosis.ts": ["DIAGNOSIS_MODEL"],
  // Reads every name only to refuse when a provider's settings are present; it asks for none by a name of its own.
  "convex/evidence/localProof.ts": [],
  "convex/fixOptions.ts": ["FIXES_MODEL"],
  "convex/auth/settings.ts": ["JWT_PRIVATE_KEY", "JWKS", "SITE_URL", "AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET", "AUTH_LOG_LEVEL", "AUTH_LOG_SECRETS", "AUTH_SESSION_TOTAL_DURATION_MS", "AUTH_SESSION_INACTIVE_DURATION_MS", "CUSTOM_AUTH_SITE_URL"],
  "convex/github/access.ts": ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_SLUG", "GITHUB_APP_WEBHOOK_SECRET", "AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET", "GITHUB_TOKEN"],
  "convex/github/config.ts": ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_SLUG", "GITHUB_APP_WEBHOOK_SECRET"],
  "convex/protectedApp/client.ts": ["PROTECTED_APP_CONTROL_SECRET"],
  "convex/revyl/api.ts": ["REVYL_API_KEY", "REVYL_BOOKING_WORKFLOW_ID"],
  "convex/routing/models.ts": ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"],
  "convex/structural/examine.ts": ["STRUCTURAL_MODEL"],
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
