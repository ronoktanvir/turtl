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
| `OPENAI_API_KEY` (secret) | Required | Model calls: diagnosis, fix options, customer report triage, the case chat, the code map's labels and chat, and voice. Without it turtl falls back to rule-based text or refuses the feature. |
| `SUPERMEMORY_API_KEY` (secret) | Required | Memory of past incidents, matching of customer reports, and the code map. Without it turtl reads only its recent notes in Convex and cannot build a code map. Use a key that is not the demo's, so production memory is separate. |
| `DIAGNOSIS_MODEL` | Optional | Model for diagnosis. Default gpt-5.4-mini. |
| `FIXES_MODEL` | Optional | Model for fix options and report triage. Default: the diagnosis model. |
| `OPENAI_MODEL` | Optional | Model for the code map's labels and chat, and for assistant.chat. Default gpt-6-luna. |
| `VOICE_ENABLED` | Optional | "true" turns on talking with turtl about a case. Anything else and voice refuses with a plain message. Each turn spends OpenAI credits. |
| `VOICE_TRANSCRIBE_MODEL` | Optional | Model that transcribes a voice clip. Default gpt-4o-mini-transcribe. |
| `VOICE_SPEECH_MODEL` | Optional | Model that speaks a reply. Default gpt-4o-mini-tts. |
| `CODE_NETWORK_CHAT_ENABLED` | Optional | "true" lets the Investigate screen answer questions about the code. Each question spends OpenAI and Supermemory credits. |
| `INTAKE_NAMESPACE_PREFIX` | Optional | Prefix for the Supermemory namespaces that hold customer reports. It keeps a test deployment's reports apart; leave it unset in production. |
| `GITHUB_APP_ID` | Required, arrives with turtl#54 | The GitHub App's id. turtl reaches each account's repositories with a token of the app's installation on them, and with nothing else. |
| `GITHUB_APP_PRIVATE_KEY` (secret) | Required, arrives with turtl#54 | The GitHub App's private key (the .pem file), which signs the request for an installation token. |
| `GITHUB_APP_SLUG` | Required, arrives with turtl#54 | The GitHub App's name in its public link, used to send an owner to install it. |
| `GITHUB_APP_WEBHOOK_SECRET` (secret) | Required, arrives with turtl#54 | Proves a webhook delivery came from GitHub. Without it every delivery is answered 503. |
| `AUTH_GITHUB_ID` | Required, arrives with the accounts pull request | The same GitHub App's client id, for signing in with GitHub. |
| `AUTH_GITHUB_SECRET` (secret) | Required, arrives with the accounts pull request | The same GitHub App's client secret. |
| `CAPY_API_KEY` (secret) | Optional | Starts the Capy thread that writes a code fix and opens its pull request. Without it a code fix reports that it cannot open a pull request. Every account's fixes are billed to this key's owner. |
| `CAPY_PROJECT_ID` | Optional | Capy project those threads start in. Default: the project that holds the repository. |
| `CAPY_MODEL_ID` | Optional | Model for those Capy threads. Default: the Capy project's model. |
| `CAPY_REASONING` | Optional | Reasoning level for those Capy threads. Used only with CAPY_MODEL_ID. |
| `MODEL_SPEND_LIMIT_USD` | Optional | With accounts on, the estimated model spend in US dollars one account may reach in a calendar month (UTC); past it turtl asks no model for that account and says so on the case. Default 20. No limit in the single-owner demo. |
| `CODING_THREADS_PER_DAY` | Optional | With accounts on, how many Capy threads (code changes) one account may start in a calendar day (UTC), since every thread is billed to CAPY_API_KEY. Default 5. No limit in the single-owner demo. |
| `REVYL_API_KEY` (secret) | Optional | Runs a fix's device check on a Revyl cloud phone. Without it a device check reports that it is not set up. |
| `REVYL_BASE_URL` | Optional | Revyl API address. Default https://backend.revyl.ai. |
| `KEIKI_API_KEY` (secret) | Optional | Keiki key for owner alerts by text. Does nothing without KEIKI_AGENT_ID and KEIKI_OWNER_CONTACT. |
| `KEIKI_AGENT_ID` | Optional | The Keiki agent that words owner alerts. |
| `KEIKI_BASE_URL` | Optional | Keiki API address. Default https://onkeiki.com. |
| `KEIKI_OWNER_CONTACT` | Never set | One phone number that receives every alert in the deployment. In production that would text one person about every account's incidents. Never set it until alerts go to each account's own owner. |
| `GITHUB_TOKEN` (secret) | Never set | One GitHub token for the whole deployment, which is how the demo reaches GitHub. Every account would act through it. Production reaches GitHub only through the GitHub App, and with this unset there is nothing to fall back to when the app's variables go missing, so access fails closed. |
| `GITHUB_API_URL` | Never set, arrives with turtl#54 | Points GitHub calls at a stand-in server in tests. In production it would send the app's tokens to another server. |
| `DEV_TOOLS_ENABLED` | Never set | "true" opens the dev tools functions: sample cases, staged outages on the booking demo, memory resets, and seeded data, callable by anyone who knows the backend address. |
| `ASSISTANT_ENABLED` | Never set | "true" opens assistant.chat, a public action that reads and writes memory under whatever user id the caller sends. No screen uses it. Never set it until the action checks its caller. |
| `PROTECTED_APP_URL` | Never set | Address of the booking demo's control routes. It makes this deployment watch the one demo app every minute. Demo only. |
| `PROTECTED_APP_CONTROL_SECRET` (secret) | Never set | Bearer token turtl sends to the booking demo's control routes. Demo only. |
| `PROTECTED_APP_CONTROL_SECRET_SHA256` | Never set | Hash that opens the booking demo's control routes (/booking-demo/flags, /staged-failure, /journey-check, /errors) on this deployment. Without it they answer 503. Demo only. |
| `PROTECTED_APP_REVISION` | Never set | Revision label the booking demo reports. Demo only. |
| `REVYL_BOOKING_WORKFLOW_ID` | Never set | Revyl workflow for the booking demo's device check. Demo only. |
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
