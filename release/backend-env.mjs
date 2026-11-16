import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

// Every environment variable the Convex backend reads, and what production does with it.
// production: "required" (the release stops without it), "optional", or "never" (the release stops if it is set).
// exactly: the one value production must have. The check reads that variable's value (never a secret's) and stops on
// any other; it never prints the value.
// arrives: the pull request that brings the variable, for a row written before its code merged. Delete the field once it has.
export const variables = [
  { name: "AUTH_REQUIRED", production: "required", exactly: "true", what: "Set it to exactly \"true\". Every backend function then needs a signed-in account and reaches only that account's projects, owner decisions are authorised by the account instead of the shared owner passcode, and the dev tools stay closed. Unset, empty or \"false\": the single-owner demo, where anyone with the backend's address acts as the one owner and nobody can sign up; a deployment that already holds accounts (a sign-in, a user, or a project another account owns) then refuses every call and runs nothing in the demo's terms instead of opening them to anyone, and its log says why once a day. Any other value (\"TRUE\", \"1\", \" true\") also turns accounts on, but the release check reads this value, which is not a secret, and stops on anything but \"true\"." },
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
  { name: "AUTH_RESEND_KEY", production: "required", secret: true, what: "Resend key for turtl's two emails: the code that resets a password, and the code that confirms a new password account's email address. Without it, or without AUTH_EMAIL_FROM, reset is off (the app tells people to contact support) and, with AUTH_REQUIRED=true, nobody can sign up with a password, only with Apple or GitHub." },
  { name: "AUTH_EMAIL_FROM", production: "required", what: "Sender of turtl's emails, on a domain verified with Resend, such as \"turtl <no-reply@example.com>\". Register the same domain with Apple so Hide My Email addresses receive them." },
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
  { name: "DEPLOYMENT_MODEL_SPEND_PER_DAY_USD", production: "optional", what: "With accounts on, the estimated model spend in US dollars of every account together in a calendar day (UTC). Every per-account limit multiplies with the number of accounts, and a script can still make up to the sign-up ceilings' worth of accounts a day that may spend (Apple and GitHub sign-ups, and password accounts that confirmed their email address), so this bounds the day's total; past it no account's model is asked until the next day, and each case says so. Default 25. No limit in the single-owner demo." },
  { name: "ACCOUNT_MODEL_SPEND_PER_DAY_USD", production: "optional", what: "With accounts on, the estimated model spend in US dollars of one account's own calls (diagnosis, the case chat, voice, reading its repositories) in a calendar day (UTC): its share of DEPLOYMENT_MODEL_SPEND_PER_DAY_USD, so one account cannot use up the day for every owner. A call is counted from the moment it is let through, so calls started together stop at the share. Past it turtl asks no model for that account until the next day and says so on the case. Default 2.5. No limit in the single-owner demo." },
  { name: "ACCOUNT_INTAKE_SPEND_PER_DAY_USD", production: "optional", what: "With accounts on, the estimated model spend in US dollars on the customer reports of all one account's projects together in a calendar day (UTC). It is apart from ACCOUNT_MODEL_SPEND_PER_DAY_USD, so customers cannot use up what diagnosing the owner's outages needs; each project still has INTAKE_SPEND_PER_DAY_USD. Default 1. No limit in the single-owner demo." },
  { name: "OUTAGE_RESERVE_PERCENT", production: "optional", what: "With accounts on, the last part of DEPLOYMENT_MODEL_SPEND_PER_DAY_USD, as a percentage, kept for finding the cause of outages turtl's checks found, and only for accounts whose own calls cost less than OUTAGE_RESERVE_ACCOUNT_USD that day. Once only this part is left, the case chat, voice, customer reports and repository readings wait until the next day (UTC), and say so. 0 keeps none, 100 keeps the whole day. Default 40 ($10 of the default $25). No limit in the single-owner demo." },
  { name: "OUTAGE_RESERVE_ACCOUNT_USD", production: "optional", what: "With accounts on, an account may draw on the part of the day OUTAGE_RESERVE_PERCENT keeps only while its own calls that day cost less than this, in US dollars. It is what makes that part last: every account can make turtl's checks raise cases at will, so a part any account could draw on up to its whole share would empty as fast as the rest of the day. Default 0.5." },
  { name: "PRACTICE_AI_PER_DAY_USD", production: "optional", what: "With accounts on, the estimated model spend in US dollars that finding the cause of one account's practice-app cases may reach in a calendar day (UTC), apart from ACCOUNT_MODEL_SPEND_PER_DAY_USD: enough for the practice app's ten breaks a day, each explained by AI (about $0.15 each), and no more. A practice app never uses the part of the day kept for outages. Past it, its cases open and turtl explains them with its own rules, and says so. Default 2. No limit in the single-owner demo." },
  { name: "OUTAGE_RESERVE_STEADY_HOURS", production: "optional", what: "With accounts on, the part of the day OUTAGE_RESERVE_PERCENT keeps is used only for an outage whose check had been passing for at least this many hours before it failed, so a project that keeps failing, or one just set up, cannot draw on it. Default 24." },
  { name: "OUTAGE_RESERVE_ACCOUNT_AGE_DAYS", production: "optional", what: "With accounts on, the part of the day OUTAGE_RESERVE_PERCENT keeps is used only for outages on accounts at least this many days old, so accounts made for an attack cannot draw on it until they have waited this long. Raise it if a group of accounts drains the reserve. Default 14." },
  { name: "OUTAGE_FLOOR_PER_DAY_USD", production: "optional", what: "With accounts on, the estimated model spend in US dollars that finding the cause of one account's own outages may reach in a calendar day (UTC) once the shared day has no room for them, outside DEPLOYMENT_MODEL_SPEND_PER_DAY_USD, so no other account can use it up. Only an outage turtl's checks found on the owner's own project draws on it, never a practice app or a case customers raised, and it counts toward the account's MODEL_SPEND_LIMIT_USD. Enough for the most one outage costs with the default models (about $1.08). It is paid outside the ceiling: the most a day can cost is DEPLOYMENT_MODEL_SPEND_PER_DAY_USD plus this amount for each account that draws on it, which is at most every account with a real project (up to 200 new ones a day under the sign-up limits, so $25 + $250 on the first day of an attack), and the most a month can cost is MODEL_SPEND_LIMIT_USD more for each such account. Default 1.25. No limit in the single-owner demo." },
  { name: "NEW_ACCOUNTS_PER_HOUR", production: "optional", what: "With accounts on, how many new accounts the deployment makes with Sign in with Apple or GitHub in one clock hour (UTC). Password sign-ups have their own ceilings (PASSWORD_SIGNUPS_*, CONFIRMED_SIGNUPS_*), so throwaway password sign-ups cannot use this up. Past it sign-up is refused in plain words until the next hour. Default 20." },
  { name: "NEW_ACCOUNTS_PER_DAY", production: "optional", what: "With accounts on, how many new accounts the deployment makes with Sign in with Apple or GitHub in a calendar day (UTC). Past it sign-up is refused in plain words until the next day. Default 100." },
  { name: "PASSWORD_SIGNUPS_PER_HOUR", production: "optional", what: "With accounts on, how many password sign-ups the deployment takes in one clock hour (UTC). Each is held at \"check your email\", able to do nothing, until it confirms its address, and each sends one email; past this, password sign-up is refused in plain words and Apple and GitHub still work. One email domain may take a tenth of this and of PASSWORD_SIGNUPS_PER_DAY, at least 2, and each large public provider (convex/auth/domains.ts) half. Default 40." },
  { name: "PASSWORD_SIGNUPS_PER_DAY", production: "optional", what: "With accounts on, how many password sign-ups the deployment takes in a calendar day (UTC). Default 200." },
  { name: "CONFIRMED_SIGNUPS_PER_HOUR", production: "optional", what: "With accounts on, how many password accounts may confirm their email address, which is when they may start to act and spend, in one clock hour (UTC). A refusal leaves the code working for later. Default 20." },
  { name: "CONFIRMED_SIGNUPS_PER_DAY", production: "optional", what: "With accounts on, how many password accounts may confirm their email address in a calendar day (UTC). One email domain may take a tenth of this and of CONFIRMED_SIGNUPS_PER_HOUR, at least 2, and each large public provider half. Default 100." },
  { name: "EMAILS_PER_DAY", production: "optional", what: "With the email service set, the most emails turtl sends in a calendar day (UTC), all kinds together; set it to fit your email plan. Emails a sign-up can cause (every confirmation, and a reset of an account not yet confirmed) may use two thirds of it, and one email domain a tenth of those (a large public provider half), so a flood of sign-ups never takes the room a confirmed owner's reset needs. Past it turtl says so in plain words, and codes already sent keep working. Default 300." },
  { name: "PROJECTS_PER_ACCOUNT", production: "optional", what: "With accounts on, how many projects one account may have. Each project brings its own report keys and customer-report allowance. Default 10." },
  { name: "INTAKE_KEYS_PER_PROJECT", production: "optional", what: "With accounts on, how many intake keys one project may have taking reports at once, since each key carries its own report limits. A stopped key makes room. Default 3." },
  { name: "INTAKE_SPEND_PER_DAY_USD", production: "optional", what: "With accounts on, the estimated model spend in US dollars that reading one project's customer reports may reach in a calendar day (UTC): triage, and investigating and planning the cases they open. It is separate from MODEL_SPEND_LIMIT_USD, so customers cannot spend what diagnosing the owner's outages needs; past it triage uses its rules and those cases a rule-based reading until the next day. Default 0.5. No limit in the single-owner demo." },
  { name: "INTAKE_CASES_PER_DAY", production: "optional", what: "With accounts on, how many new cases customer reports may open on one project in a calendar day (UTC). A report past it is kept on no case and says why; one that matches an open case still joins it. Default 5. No limit in the single-owner demo." },
  { name: "PRACTICE_BREAKS_PER_DAY", production: "optional", what: "With accounts on, how many times one account may break its practice app on purpose in a calendar day (UTC). Each break starts one check and, through the case it opens, the ordinary model calls, which PRACTICE_AI_PER_DAY_USD and the monthly limit bound. Default 10. The operator's setup of the review account (practice/review:prepare) does not count." },
  { name: "REVYL_API_KEY", production: "optional", secret: true, what: "Runs a fix's device check on a Revyl cloud phone. Without it a device check reports that it is not set up." },
  { name: "REVYL_BASE_URL", production: "never", what: "Points Revyl calls at a stand-in server in tests. Default https://backend.revyl.ai. In production it would send the operator's Revyl key to another server, so with AUTH_REQUIRED=true the backend honours it only when it runs locally (convex/demoSettings.ts)." },
  { name: "KEIKI_API_KEY", production: "optional", secret: true, what: "Keiki key for owner alerts by text. Does nothing without KEIKI_AGENT_ID and KEIKI_OWNER_CONTACT." },
  { name: "KEIKI_AGENT_ID", production: "optional", what: "The Keiki agent that words owner alerts." },
  { name: "KEIKI_BASE_URL", production: "never", what: "Points Keiki calls at a stand-in server in tests. Default https://onkeiki.com. In production it would send the operator's Keiki key to another server, so with AUTH_REQUIRED=true the backend honours it only when it runs locally (convex/demoSettings.ts)." },
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

// Compares the variable names set on a deployment with the table, and the values it was given (only those of rows that
// name an exact value) with that value. It never puts a value in what it returns.
export function deploymentProblems(names, values = {}) {
  const set = new Set(names);
  return [
    ...variables.filter((row) => row.production === "required" && !set.has(row.name)).map((row) => `${row.name} is required and is not set.`),
    ...variables
      .filter((row) => row.exactly !== undefined && set.has(row.name) && values[row.name] !== undefined && values[row.name] !== row.exactly)
      .map((row) => `${row.name} must be exactly "${row.exactly}" in production, and it is set to something else.`),
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
