# The production backend

turtl's backend is a Convex deployment. Today there is one hosted deployment, `patient-kudu-956`, and it is the demo: it has the dev tools switched on, it watches the booking demo app, and it texts Ronok's phone. Production must be a different deployment that shares nothing with it: its own data, its own keys, its own deploy key.

Nothing in this file touches `patient-kudu-956`.

## 1. Create the production deployment

Make production its own Convex project. Convex gives every project one production deployment, and a separate project keeps the demo's deploy keys, dashboard, and `npx convex dev` sessions away from production data.

1. Open the Convex dashboard, pick the team, and choose **Create Project**. Name it `turtl-production`.
2. Open the project and switch to its **Production** deployment.
3. Open **Settings**, then **URL and Deploy Key**, and choose **Generate Production Deploy Key**. Name it `github-release`.
4. Save that key as the secret `CONVEX_DEPLOY_KEY` in the GitHub environment `production` (repository Settings, Environments). Do not paste it anywhere else. The release workflow is its only reader.

You do not need to copy the deployment's address. The release workflow reads it from Convex when it deploys and writes it to the EAS production environment as `EXPO_PUBLIC_CONVEX_URL`.

## 2. Set the backend's variables

Set them in the dashboard: the production deployment, **Settings**, **Environment Variables**. Or from a terminal, with the deploy key in that shell only:

```sh
export CONVEX_DEPLOY_KEY='the production deploy key'
npx convex env set OPENAI_API_KEY        # asks for the value, so it stays out of your shell history
npx convex env set SUPERMEMORY_API_KEY
```

This is every variable the backend reads, taken from the code. "Required" stops a release when it is missing. "Never set" stops a release when it is present. "Arrives with" marks a variable whose pull request had not merged when its row was written.

<!-- variables:start -->
| Variable | Production | What it does |
| --- | --- | --- |
| `AUTH_REQUIRED` | Required | Set it to "true". Every backend function then needs a signed-in account and reaches only that account's projects, owner decisions are authorised by the account instead of the shared owner passcode, and the dev tools stay closed. Unset, the backend is the single-owner demo, where anyone with its address acts as the one owner. The release check sees only the name, so check the value is "true". |
| `OPENAI_API_KEY` (secret) | Required | Model calls: diagnosis, fix options, customer report triage, the case chat, the code map's labels and chat, and voice. Without it turtl falls back to rule-based text or refuses the feature. |
| `SUPERMEMORY_API_KEY` (secret) | Required | Memory of past incidents, matching of customer reports, and the code map. Without it turtl reads only its recent notes in Convex and cannot build a code map. Use a key that is not the demo's, so production memory is separate. |
| `DIAGNOSIS_MODEL` | Optional | Model for diagnosis. Default gpt-5.4-mini. |
| `FIXES_MODEL` | Optional | Model for fix options and report triage. Default: the diagnosis model. |
| `OPENAI_MODEL` | Optional | Model for the code map's labels and chat, and for reading a repository at onboarding. Default gpt-6-luna. |
| `STRUCTURAL_MODEL` | Optional | Model that examines related cases for a deeper cause. Default gpt-5.4. |
| `ANTHROPIC_API_KEY` (secret) | Optional | Lets claude-sonnet-4-5 join the model council. With accounts on, nothing is sent to Anthropic until store/data-practices.json lists it and the owner has agreed. |
| `GEMINI_API_KEY` (secret) | Optional | Lets gemini-2.5-pro join the model council. With accounts on, nothing is sent to Google until store/data-practices.json lists it and the owner has agreed. |
| `VOICE_ENABLED` | Optional | "true" turns on talking with turtl about a case. Anything else and voice refuses with a plain message. Each turn spends OpenAI credits. |
| `VOICE_TRANSCRIBE_MODEL` | Optional | Model that transcribes a voice clip. Default gpt-4o-mini-transcribe. |
| `VOICE_SPEECH_MODEL` | Optional | Model that speaks a reply. Default gpt-4o-mini-tts. |
| `CODE_NETWORK_CHAT_ENABLED` | Optional | "true" lets the Investigate screen answer questions about the code. Each question spends OpenAI and Supermemory credits. |
| `INTAKE_CONTACT_KEY` (secret) | Required | Key for the keyed hash a customer's contact on the report form becomes, so turtl can count one person once without keeping the address. Use at least 32 random characters and never change it: a new key counts returning customers as new people. Without it the contact becomes a plain hash, which someone holding the database could match against a guessed address. |
| `INTAKE_NAMESPACE_PREFIX` | Optional | Prefix for the Supermemory namespaces that hold customer reports. It keeps a test deployment's reports apart; leave it unset in production. |
| `SUPERMEMORY_NAMESPACE_PREFIX` | Optional | Prefix for every Supermemory namespace. It keeps a test deployment's memory apart from a hosted project's; leave it unset in production. |
| `GITHUB_APP_ID` | Required | The GitHub App's id. turtl reaches each account's repositories with a token of the app's installation on them, and with nothing else. |
| `GITHUB_APP_PRIVATE_KEY` (secret) | Required | The GitHub App's private key (the .pem file), which signs the request for an installation token. |
| `GITHUB_APP_SLUG` | Required | The GitHub App's name in its public link, used to send an owner to install it. |
| `GITHUB_APP_WEBHOOK_SECRET` (secret) | Required | Proves a webhook delivery came from GitHub. Without it every delivery is answered 503. |
| `AUTH_GITHUB_ID` | Required | The same GitHub App's client id. Connect GitHub asks the owner to authorize the app with it, which is how GitHub confirms who connected; signing in with GitHub uses it too. Without it Add project offers only a typed repository address. |
| `AUTH_GITHUB_SECRET` (secret) | Required | The same GitHub App's client secret. Connect GitHub exchanges the owner's authorization with it for a user token, uses that token to read which installations the owner can reach, then revokes it. Signing in with GitHub uses it too. |
| `JWT_PRIVATE_KEY` (secret) | Required | Signs the sign-in tokens the backend hands out (Convex Auth). Make it with the steps in convex/auth/README.md, with JWKS. Changing it signs everyone out. |
| `JWKS` | Required | The public half of JWT_PRIVATE_KEY, which the backend checks sign-in tokens against. |
| `SITE_URL` | Required | Where GitHub sign-in returns on the web, and the only web address a sign-in code may be sent to besides the app's own turtl:// link. The password reset email needs it too. For the iPhone-only launch, the turtl site: https://ronoktanvir.github.io/turtl |
| `AUTH_RESEND_KEY` (secret) | Optional | Resend key that emails the code for a password reset. Without it, or without AUTH_EMAIL_FROM, reset is off and the app tells people to contact support. |
| `AUTH_EMAIL_FROM` | Optional | Sender of the reset email, on a domain verified with Resend, such as "turtl <no-reply@example.com>". Register the same domain with Apple so Hide My Email addresses receive it. |
| `AUTH_APPLE_BUNDLE_ID` | Optional | The app's bundle id, which Apple names as the audience of a Sign in with Apple token. Default com.turtl.oncall. Change it only together with the app's bundle id. |
| `AUTH_APPLE_TEAM_ID` | Required | The Apple Developer team id. With AUTH_APPLE_KEY_ID and AUTH_APPLE_PRIVATE_KEY, turtl keeps the Apple token a person signs in with and revokes it when they delete their account, as Apple requires of apps that offer Sign in with Apple. Without all three, Sign in with Apple still works, but deleting such an account cannot revoke Apple's token. |
| `AUTH_APPLE_KEY_ID` | Required | The id of the Sign in with Apple key (Certificates, Identifiers & Profiles > Keys) whose .p8 file is AUTH_APPLE_PRIVATE_KEY. |
| `AUTH_APPLE_PRIVATE_KEY` (secret) | Required | The contents of that Sign in with Apple key's .p8 file. It signs turtl's requests to Apple's token endpoints; line breaks may be spaces. |
| `AUTH_STAND_IN_URL` | Never set | Points GitHub sign-in, Apple's signing keys and token endpoints, and the reset email at a stand-in server in tests. In production it would let that server decide who is signed in, so with AUTH_REQUIRED=true the backend honours it only when it runs locally (convex/demoSettings.ts). |
| `AUTH_SESSION_TOTAL_DURATION_MS` | Optional | How long a sign-in lasts before the person must sign in again. Default 30 days. |
| `AUTH_SESSION_INACTIVE_DURATION_MS` | Optional | How long a sign-in lasts unused. Default 30 days. |
| `AUTH_LOG_LEVEL` | Optional | How much Convex Auth logs: ERROR, WARN, INFO (the default) or DEBUG. DEBUG writes email addresses to the logs; leave it unset in production. |
| `AUTH_LOG_SECRETS` | Never set | "true" makes Convex Auth write passwords and tokens to the logs. |
| `CUSTOM_AUTH_SITE_URL` | Optional | The backend's own web address when it is served from a custom domain; GitHub sign-in starts there. Default: the deployment's .convex.site address. |
| `SECRETS_ENCRYPTION_KEY` (secret) | Required | Encrypts what owners entrust to turtl (each project's control token and each account's coding agent key) with AES-GCM. 32 random bytes in base64: make it with `openssl rand -base64 32`. Changing it makes every stored token and key unreadable, and owners must enter them again. Without it owners cannot store either, so no project can be watched with its token and no coding agent can start. |
| `CAPY_API_KEY` (secret) | Never set | The single-owner demo's coding agent: starts the Capy thread that writes a code fix or a preparation and opens its pull request. With AUTH_REQUIRED=true it is never used: every account's threads start with that account's own Capy key, entered in the app. Demo only. |
| `CAPY_PROJECT_ID` | Never set | Capy project the demo's threads start in. Default: the project that holds the repository. Never used with accounts on. Demo only. |
| `CAPY_MODEL_ID` | Never set | Model for the demo's Capy threads. Default: the Capy project's model. Never used with accounts on. Demo only. |
| `CAPY_REASONING` | Never set | Reasoning level for the demo's Capy threads. Used only with CAPY_MODEL_ID. Demo only. |
| `CAPY_API_URL` | Never set | Points Capy calls at a stand-in server in tests. In production it would send owners' Capy keys to another server. |
| `MODEL_SPEND_LIMIT_USD` | Optional | With accounts on, the estimated model spend in US dollars one account may reach in a calendar month (UTC); past it turtl asks no model for that account and says so on the case. Default 20. No limit in the single-owner demo. |
| `CODING_THREADS_PER_DAY` | Optional | With accounts on, how many Capy threads (code changes) one account may start in a calendar day (UTC), since every thread is billed to CAPY_API_KEY. Default 5. No limit in the single-owner demo. |
| `DEPLOYMENT_MODEL_SPEND_PER_DAY_USD` | Optional | With accounts on, the estimated model spend in US dollars of every account together in a calendar day (UTC). Every per-account limit multiplies with the number of accounts, and nothing yet stops a script making accounts, so this bounds the day's total; past it no account's model is asked until the next day, and each case says so. Default 25. No limit in the single-owner demo. |
| `NEW_ACCOUNTS_PER_HOUR` | Optional | With accounts on, how many new accounts the deployment makes in one clock hour (UTC), by any sign-in method. Past it sign-up is refused in plain words until the next hour. Default 20. |
| `NEW_ACCOUNTS_PER_DAY` | Optional | With accounts on, how many new accounts the deployment makes in a calendar day (UTC). Past it sign-up is refused in plain words until the next day. Default 100. |
| `PROJECTS_PER_ACCOUNT` | Optional | With accounts on, how many projects one account may have. Each project brings its own report keys and customer-report allowance. Default 10. |
| `INTAKE_KEYS_PER_PROJECT` | Optional | With accounts on, how many intake keys one project may have taking reports at once, since each key carries its own report limits. A stopped key makes room. Default 3. |
| `INTAKE_SPEND_PER_DAY_USD` | Optional | With accounts on, the estimated model spend in US dollars that reading one project's customer reports may reach in a calendar day (UTC): triage, and investigating and planning the cases they open. It is separate from MODEL_SPEND_LIMIT_USD, so customers cannot spend what diagnosing the owner's outages needs; past it triage uses its rules and those cases a rule-based reading until the next day. Default 0.5. No limit in the single-owner demo. |
| `INTAKE_CASES_PER_DAY` | Optional | With accounts on, how many new cases customer reports may open on one project in a calendar day (UTC). A report past it is kept on no case and says why; one that matches an open case still joins it. Default 5. No limit in the single-owner demo. |
| `REVYL_API_KEY` (secret) | Optional | Runs a fix's device check on a Revyl cloud phone. Without it a device check reports that it is not set up. |
| `REVYL_BASE_URL` | Optional | Revyl API address. Default https://backend.revyl.ai. |
| `KEIKI_API_KEY` (secret) | Optional | Keiki key for owner alerts by text. Does nothing without KEIKI_AGENT_ID and KEIKI_OWNER_CONTACT. |
| `KEIKI_AGENT_ID` | Optional | The Keiki agent that words owner alerts. |
| `KEIKI_BASE_URL` | Optional | Keiki API address. Default https://onkeiki.com. |
| `EXPO_ACCESS_TOKEN` (secret) | Optional | Expo access token for push notifications, needed only once enhanced push security is turned on for the project in Expo. Without it pushes still send while that setting is off. |
| `KEIKI_OWNER_CONTACT` | Never set | One phone number that receives every alert in the deployment. In production that would text one person about every account's incidents. Never set it until alerts go to each account's own owner. With AUTH_REQUIRED=true the backend treats it as not set. |
| `GITHUB_TOKEN` (secret) | Never set | One GitHub token for the whole deployment, which is how the demo reaches GitHub. Every account would act through it. Production reaches GitHub only through the GitHub App, and with this unset there is nothing to fall back to when the app's variables go missing, so access fails closed. With AUTH_REQUIRED=true the backend treats it as not set. |
| `GITHUB_API_URL` | Never set | Points GitHub calls at a stand-in server in tests. In production it would send the app's tokens to another server. |
| `SUPERMEMORY_BASE_URL` | Never set | Points Supermemory calls at a stand-in server in a local proof. In production it would send every owner's memory, reports and code to another server, so with AUTH_REQUIRED=true the backend honours it only when it runs locally (convex/demoSettings.ts). |
| `EXPO_PUSH_API_URL` | Never set | Points push notifications at a stand-in for Expo's push service in tests. In production it would send every owner's phone address and project names to another server, so with AUTH_REQUIRED=true the backend honours it only when it runs locally. |
| `DEV_TOOLS_ENABLED` | Never set | "true" opens the dev tools functions: sample cases, staged outages on the booking demo, memory resets, and seeded data, callable by anyone who knows the backend address. With AUTH_REQUIRED=true they stay closed whatever this says. |
| `EVIDENCE_LOCAL_PROOF` | Never set | "true" opens the local evidence fixtures (convex/evidence/localProof.ts). They also need DEV_TOOLS_ENABLED and a localhost backend, and refuse to run anywhere else. |
| `PROTECTED_APP_URL` | Never set | Address of the booking demo's control routes. It makes this deployment watch the one demo app every minute. With AUTH_REQUIRED=true the monitor watches every project from its own rows and never reads it. Demo only. |
| `PROTECTED_APP_CONTROL_SECRET` (secret) | Never set | Bearer token turtl sends to the booking demo's control routes. With AUTH_REQUIRED=true it is never sent: each project's requests carry only that project's own control token, entered by its owner. Demo only. |
| `WATCHED_APP_ALLOW_LOOPBACK` | Never set | "true" lets a backend running on this machine, with accounts on, watch apps at http://127.0.0.1 or localhost, for stand-in servers in tests. Any other backend ignores it. |
| `PROTECTED_APP_CONTROL_SECRET_SHA256` | Never set | Hash that opens the booking demo's control routes (/booking-demo/flags, /staged-failure, /journey-check, /errors) on this deployment. Without it they answer 503, and with AUTH_REQUIRED=true the booking demo's customer functions refuse too. Demo only. |
| `PROTECTED_APP_REVISION` | Never set | Revision label the booking demo reports. Demo only. |
| `REVYL_BOOKING_WORKFLOW_ID` | Never set | Revyl workflow for the booking demo's device check. Demo only: with AUTH_REQUIRED=true the backend treats it as not set, so no account's fix is checked with the demo's workflow on the operator's Revyl credits. |
<!-- variables:end -->

The table's source is `backend-env.mjs`. After changing it, run `node release/check-backend-env.mjs --write-table`.

The six GitHub App values are one app: turtl#54 reads its id, private key, slug, and webhook secret, and sign-in reads its client id and secret. `convex/github/README.md` says where each comes from once turtl#54 has merged. Sign-in may add more variables of its own; until they have rows, the check below reports them as unlisted.

## 3. Check the names

```sh
CONVEX_DEPLOY_KEY='the production deploy key' node release/check-backend-env.mjs
```

It asks Convex for variable **names only** (`npx convex env list --names-only`) and compares them with the table: a required name that is missing, a "never set" name that is present, and a name the table does not list each fail the check. It never reads or prints a value. The release workflow runs the same check before every deploy.

To check another deployment you can reach with your own Convex login, pass the selection through: `node release/check-backend-env.mjs --deployment <name>`.

## 4. Deploy

The release workflow deploys for you (Actions, Release iOS, with "Deploy" on). To deploy by hand from a clean checkout of `main`:

```sh
CONVEX_DEPLOY_KEY='the production deploy key' npx convex deploy
```

`npx convex deploy` typechecks `convex/`, pushes the functions, schema, and indexes, and stops before changing anything if the schema does not fit the data already stored. Schema changes in this repository are additive, so a deploy does not rewrite rows. A new production deployment starts empty and needs no setup calls.

## 5. Go back

Convex keeps no "previous version" button. To undo a deploy, revert the commit on `main` and run the release workflow again with "Send" off, or deploy an older commit by hand as in step 4. Take a backup before a risky deploy: the dashboard's **Backups** page, or `npx convex export --path backup.zip` with the deploy key set.

## What the production backend does not do yet

These are limits of the product today, not of this runbook. Each is why a row above says "Never set".

- **It watches no app.** The only app turtl can watch is the booking demo, wired through the `PROTECTED_APP_*` variables for the whole deployment. Production leaves them unset until each account can connect its own app.
- **It alerts nobody by text.** `KEIKI_OWNER_CONTACT` is one phone number for every case in the deployment. Production leaves it unset until alerts go to each account's owner.
- **The booking demo ships inside it.** `convex/bookingDemo/` deploys with the rest. Its control routes answer 503 while `PROTECTED_APP_CONTROL_SECRET_SHA256` is unset, but its public functions (`bookingDemo/booking:getCatalog`, `getFlags`, `recommendations`, `submit`) and the routes `/booking-demo/health` and `/booking-demo/revision` answer anyone.
- **It reaches GitHub only through the GitHub App.** `GITHUB_TOKEN` is the demo's one token for every repository, and production never sets it. Until turtl#54 has merged, that leaves a production backend unable to read or merge a pull request or to fetch a repository for the code map.
- **One Capy key serves every account**, if `CAPY_API_KEY` is set.
