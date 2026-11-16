# Releasing turtl for iOS

This folder holds everything between this repository and a build Apple accepts: the build profiles' rules, the checks that run before a release, the production backend runbook, and the list of what Ronok must create. The workflows live in `.github/workflows/`.

| File | What it is |
| --- | --- |
| `../eas.json` | The three EAS build profiles. |
| `build-env.js` | The rules `app.config.ts` applies to a build's environment. A build that breaks one stops with a plain message. |
| `store-checks.mjs` | Checks of `app.json`, the icon, the privacy manifest, `eas.json`, and the generated iOS project. |
| `backend-env.mjs` | The table of every environment variable the backend reads. |
| `check-backend-env.mjs` | Compares a Convex deployment's variable names with that table. It never reads a value. |
| `preflight.mjs` | Runs every check that needs no credential. The release workflow runs it first. |
| `backend-runbook.md` | How to create the production backend and deploy to it. |

## The three builds

| Profile | What it is for | `EXPO_PUBLIC_APP_ENV` | Backend address | Distribution |
| --- | --- | --- | --- | --- |
| `development` | A simulator build with the dev tools switched on. | `development` | `EXPO_PUBLIC_CONVEX_URL` in the EAS **development** environment. Without one the app shows example data. | Simulator `.app` |
| `preview` | The store build's twin for testers' own iPhones, against a backend that is not production. | `preview` | `EXPO_PUBLIC_CONVEX_URL` in the EAS **preview** environment. | Internal (ad hoc, registered devices) |
| `production` | The App Store and TestFlight. | `production` | `EXPO_PUBLIC_CONVEX_URL` in the EAS **production** environment. The release workflow writes it from the backend it has just deployed. | App Store |

Each profile reads its backend address from its own EAS environment, so no address is committed. Set one with `npx eas-cli env:set <environment> --name EXPO_PUBLIC_CONVEX_URL --value <https address> --visibility plaintext`. The app reads the environment name as `appEnv` from `data` (`import { appEnv, isStoreBuild } from "../data"`).

Build numbers are kept by EAS (`appVersionSource: remote`) and go up by one on every preview and production build (`autoIncrement`). Nobody edits a build number. The version people see (`1.0.0`) is `version` in `app.json` and changes by hand, once per release.

TestFlight takes a store-signed build, so TestFlight testing uses the `production` profile: every upload lands in TestFlight first and goes to App Review only when someone submits it there. `preview` is for a build on a registered phone before that, with no upload to Apple.

A `development` build is a Release build for the simulator, like the one Revyl makes. The project has no development client, and a Debug build would load its code from a laptop and ignore the profile's settings.

## What a preview or production build locks

`EXPO_PUBLIC_APP_ENV` set to `preview` or `production` switches the lock on. Any other value except `development` is treated as production, so a typo cannot unlock a build.

- **No dev tools.** The Dev pill, its panel, and the "Live cases" link are not rendered, whatever `EXPO_PUBLIC_DEV_TOOLS` says and whatever the backend reports.
- **No example data.** The app is always on live data, whatever `EXPO_PUBLIC_DATA_SOURCE` says. A build with no backend address shows "This version of turtl can't connect" and nothing else; it never falls back to the example projects.
- **A plain screen when the backend cannot be reached.** After 8 seconds without a connection the app shows "Can't reach turtl" over the current screen, and removes it by itself when the connection returns. Time spent in the background does not count.
- **The build refuses a wrong environment.** `app.config.ts` stops a preview or production build that sets `EXPO_PUBLIC_DEV_TOOLS=1` or `EXPO_PUBLIC_DATA_SOURCE=example`, whose backend address is not https, or, for production, whose address is the demo backend. On the EAS builder it also stops a build with no backend address, or whose profile and environment name differ.

**The demo is untouched.** With `EXPO_PUBLIC_APP_ENV` unset, which is how `.revyl/config.yaml` and local work run, every rule above is off and the app behaves as it did: `EXPO_PUBLIC_DATA_SOURCE=example` shows example data and `EXPO_PUBLIC_DEV_TOOLS=1` shows the Dev pill.

## The iOS store configuration

- **Icon:** `assets/images/icon.png`, 1024 by 1024, no alpha channel.
- **Export compliance:** `ios.config.usesNonExemptEncryption: false` in `app.json`. turtl uses only the system's HTTPS and Keychain.
- **Purpose strings:** the microphone, for voice on a case, set on the `expo-audio` plugin in `app.config.ts`. It is the only permission the app asks for. `expo-secure-store` would add a Face ID string by default; the app never asks for Face ID, so `app.config.ts` switches it off.
- **Privacy manifest:** `ios.privacyManifests` in `app.json` declares no tracking and repeats every required-reason API its libraries declare (user defaults, file timestamps, boot time, disk space), because Apple reads only the app's own manifest reliably. `NSPrivacyCollectedDataTypes` is empty until the listing thread's data audit says what belongs there.
- **iPhone only:** `ios.supportsTablet: false`.
- **Scheme:** `turtl://` stays.

When you add a native module or a config plugin:

- If it adds a purpose string the app really needs, add its key to `PURPOSE_STRINGS` in `store-checks.mjs`. If the app does not need it, switch it off on the plugin.
- If `npm run test:ci` says the privacy manifest misses a reason, add that reason to `ios.privacyManifests` in `app.json`.
- If the backend reads a new environment variable, add its row to `backend-env.mjs` and run `node release/check-backend-env.mjs --write-table`. A variable a library reads, such as Convex Auth's keys, needs its row by hand: the scan sees only `convex/`.

## Checks

- **Every pull request** (`.github/workflows/ci.yml`): both typechecks and `npm run test:ci`, which is every test in `tests/` that does not drive a browser. It then prints release readiness warnings that never fail the run.
- **Before a release:** `node release/preflight.mjs` runs the store checks, generates the iOS project in a scratch folder and reads its `Info.plist` and privacy manifest, checks the backend table against `convex/`, and refuses while the backend has no sign-in (`convex/auth.config.ts`).
- **By hand:** `npx expo-doctor` should report no issues.

## The release workflow

**Actions, Release iOS, Run workflow**, from `main`. It runs in the GitHub environment `production` and does this in order, stopping at the first failure:

1. Refuses any branch but `main`, and refuses if a setting from the list below is missing.
2. Runs the typechecks, the tests, and `preflight.mjs`.
3. Checks the production backend's variable names against the table.
4. Deploys `convex/` to the production backend (the "Deploy" box, on by default).
5. Writes that backend's address to `EXPO_PUBLIC_CONVEX_URL` in the EAS production environment, so the app always talks to the backend its own release deployed.
6. Builds the `production` profile on EAS and, with the "Send" box on, submits the build to App Store Connect.

Nothing in the repository holds a credential. The workflow reads `EXPO_TOKEN` and `CONVEX_DEPLOY_KEY` from the GitHub environment; the signing certificate, provisioning profile, and App Store Connect API key stay on Expo's servers.

## What Ronok must create, in order

1. **Apple Developer Program membership.** Steps 6 to 8 wait for it; steps 2 to 5 do not.
2. **An Expo account and the EAS project.** In a terminal in this repository: `npx eas-cli login`, then `npx eas-cli init`. It prints a project id and writes it to `app.json` under `expo.extra.eas.projectId`. The id is not a secret. Send it to the Captain, who gets it committed.
3. **The GitHub environment.** Repository Settings, Environments, New environment, name it `production`. Add yourself as a required reviewer if you want every release to wait for your approval.
4. **An Expo access token.** expo.dev, Account settings, Access tokens, Create token. Save it as the secret `EXPO_TOKEN` in the `production` environment.
5. **The production backend and its deploy key.** Follow `backend-runbook.md`: create the Convex project, save its production deploy key as the secret `CONVEX_DEPLOY_KEY` in the `production` environment, and set the backend's variables.
6. **Signing and the App Store Connect API key.** In a terminal in this repository: `npx eas-cli credentials --platform ios`. Choose the `production` profile and sign in with your Apple ID. When it asks for a team, choose yours: this is the one place your Apple team id is used. Then:
   - "Build Credentials", then "All: Set up all the required credentials". EAS registers `com.turtl.oncall`, creates the distribution certificate and the provisioning profile, and keeps them.
   - "App Store Connect: Manage your API Key", then "Set up your project to use an API Key for EAS Submit". Let EAS create the key, or upload one you made in App Store Connect under Users and Access, Integrations. EAS keeps it.
7. **The app in App Store Connect.** Apps, the plus button, New App: platform iOS, bundle ID `com.turtl.oncall`. Then open App Information and copy the number called Apple ID. Save it as the variable (not secret) `ASC_APP_ID` in the `production` environment.
8. **Run it.** Actions, Release iOS, Run workflow, on `main`, both boxes on. Fifteen minutes or so after it finishes, the build is in TestFlight.

| Value | Where it comes from | Where it goes |
| --- | --- | --- |
| Apple team id | developer.apple.com, Membership details | Chosen once at the `eas credentials` prompt. Stored nowhere in the repository or GitHub. Tell the Captain; push notifications and Sign in with Apple will ask for it. |
| App Store Connect API key | Created by `eas credentials` | Expo's servers, attached to `com.turtl.oncall` |
| Expo access token | expo.dev, Access tokens | GitHub environment secret `EXPO_TOKEN` |
| Production Convex deploy key | Convex dashboard, the production deployment's settings | GitHub environment secret `CONVEX_DEPLOY_KEY` |
| App Store Connect app id | App Store Connect, App Information, Apple ID | GitHub environment variable `ASC_APP_ID` |
| EAS project id | Printed by `eas init` | `app.json`, committed |
| Backend variables | Each provider | The Convex production deployment (names in `backend-runbook.md`) |

If Apple says `com.turtl.oncall` is taken by another developer, stop and tell the Captain: the bundle identifier is in `app.json` and in Revyl's app.

## What only a signed build can prove

None of this has run against Apple or Expo, because no credential for them exists yet. Proven without them: the resolved configuration of each profile, the generated `Info.plist` and privacy manifest, the lock on a production-configuration simulator build, the backend deploy and variable check against a local Convex backend, and the pull request workflow. Still unproven until the first real run:

- That the release workflow's EAS steps work as written: `eas env:set`, `eas env:get`, `eas build --auto-submit`, and the build number going up.
- That EAS can create the certificate and profile for this Apple team, and that `com.turtl.oncall` is free.
- That App Store Connect accepts the upload: its checks of the icon, the privacy manifest, the purpose strings, and the export compliance answer run only on a signed archive.
- How the app behaves on a real iPhone: the microphone prompt, and the "Can't reach turtl" screen on a real network drop.
