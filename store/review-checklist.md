# App Review readiness checklist

Written against Apple's App Review Guidelines as last updated on 16 October 2026 (read on 15 November 2026). First written against turtl's code at commit `3d01f64`, and checked again line by line against commit `2f99bfe` (the `build/wave-2` branch, 16 November 2026), the commit every link below is pinned to.

Each item quotes the words of Apple's that it answers. A ticked line is true of the code at that commit and links to the line that proves it. An unticked line is missing, and ends with the work that closes it. `node store/check.mjs` counts the open lines for each owner and checks every link.

| Tag | Work that closes the line |
| --- | --- |
| TUR-57 | Accounts and sign-in |
| TUR-61 | Access checks on every backend function |
| TUR-58, TUR-62 | The GitHub App, and connecting GitHub in the app |
| TUR-59 | Store build pipeline and production configuration |
| TUR-63 | Connecting a live app per account |
| TUR-64 | Push notifications |
| TUR-65 | First run, AI consent, and failure states |
| TUR-66 | TestFlight build and App Store submission |
| TUR-60 | This pack: listing, privacy, and review readiness |
| Ronok | A decision or a step only Ronok can take |
| Unowned | No issue in this crew covers it yet |

## A. The build is complete and honest

### RC-01 · Guideline 2.1(a) · A final version with working links

> "Submissions to App Review … should be final versions with all necessary metadata and fully functional URLs included; placeholder text, empty websites, and other temporary content should be scrubbed before submission."

- [ ] The privacy, terms, and support addresses in `store.config.json` load. Today they return "not found" because GitHub Pages is not switched on for the repository. **Ronok**
- [ ] `node store/check.mjs --release` passes: no blank left in `site/_data/operator.json`, the "to confirm before launch" notes are switched off, and the code has not drifted from the audit. **Ronok**, then **TUR-66**
- [x] The store build cannot show example data. A preview or production build always uses live data ([data/source.ts:8](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/data/source.ts#L8 "export function usesLiveData")), refuses to build with `EXPO_PUBLIC_DATA_SOURCE=example` ([release/build-env.js:29](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/release/build-env.js#L29 "EXPO_PUBLIC_DATA_SOURCE=example is set")), and with no backend address shows "This version of turtl can't connect" instead ([components/ui/BackendUnavailable.tsx:12](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/ui/BackendUnavailable.tsx#L12 "This version of turtl can't connect")).
- [x] A new account with no projects sees a first-run screen, not an empty list ([app/projects.tsx:62](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app/projects.tsx#L62 "<FirstRun onAdd=")).

### RC-02 · Guideline 2.1(a) · A review account and a backend that is switched on

> "include demo account info (and turn on your back-end service!) if your app includes a login."

- [ ] An email-and-password review account exists on the production backend. **TUR-57**
- [ ] The review account opens on a project with an open case, connected to a demo app that can be broken and fixed again and again without harm. **TUR-57** with **TUR-63**
- [ ] Every step in `store/review-notes.txt` works on that account, tap for tap, on the build that is submitted. **TUR-66**
- [ ] The six `APP_REVIEW_*` variables are set where `eas metadata:push` runs (names in `store/README.md`). **Ronok**
- [ ] The production backend, and the accounts it pays vendors from, stay up and funded for the whole review. **Ronok**
- [x] A reviewer who approves fixes repeatedly cannot run up an unlimited bill: each account has a limit on model spend, $20 a month unless the backend sets another ([convex/spend/limits.ts:34](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/spend/limits.ts#L34 "export const modelSpendLimitUsd")), and at most 5 code changes a day ([convex/spend/limits.ts:37](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/spend/limits.ts#L37 "export const codingThreadsPerDay")).

### RC-03 · Guideline 2.1(a) · Tested on a device

> "Make sure your app has been tested on-device for bugs and stability before you submit it … We will reject incomplete app bundles and binaries that crash or exhibit obvious technical problems."

- [ ] A TestFlight build has been used on a physical iPhone through sign-in, opening a case, approving a fix, talking, and deleting the account. **TUR-66**
- [x] A screen that fails to draw shows a message and a way back, not a blank screen ([app/_layout.tsx:21](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app/_layout.tsx#L21 "ScreenError as ErrorBoundary"), [components/ui/ScreenError.tsx:23](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/ui/ScreenError.tsx#L23 "This screen didn't load")).
- [x] Losing the network in the middle of a case shows a message, not a spinner that never ends. A store build covers every screen, open sheets included, with "Can't reach turtl" while the backend is out of reach ([app/_layout.tsx:43](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app/_layout.tsx#L43 "setSheetCover(reachable ? null"), [components/ui/BackendUnavailable.tsx:9](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/ui/BackendUnavailable.tsx#L9 "Check your internet connection")).

### RC-04 · Guidelines 2.1(a) and 2.2 · No demonstration controls

> "Demos, betas, and trial versions of your app don't belong on the App Store – use TestFlight instead."

- [x] The Login button signs someone in. In a store build, and on any backend with accounts on, Log in, Sign up, Apple and GitHub sign in for real ([app/index.tsx:28](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app/index.tsx#L28 "const real = realSignIn(isStoreBuild, mode)"), [data/account/status.ts:36](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/data/account/status.ts#L36 "export function realSignIn")). Only the single-owner demo's buttons still go straight to Home.
- [x] The Google button is removed. The first screen offers email and password, Apple, and GitHub ([app/index.tsx:14](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app/index.tsx#L14 "Sign in with Apple"), [app/index.tsx:15](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app/index.tsx#L15 "Sign in with GitHub")).
- [x] The store build cannot show the developer tools. Outside a development build the app ignores `EXPO_PUBLIC_DEV_TOOLS` ([data/source.ts:12](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/data/source.ts#L12 "export function allowsDevTools")) and a store build refuses to be built with it ([release/build-env.js:32](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/release/build-env.js#L32 "EXPO_PUBLIC_DEV_TOOLS=1 is set")). The backend's tools stay closed with accounts on, whatever `DEV_TOOLS_ENABLED` says ([convex/access.ts:217](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/access.ts#L217 "export function devToolsEnabled")).
- [x] The store build refuses to run with sign-in or access checks switched off: on a backend without accounts it shows a screen saying it cannot be used, and nothing else ([data/account/status.ts:14](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/data/account/status.ts#L14 "if (!mode.accounts) return storeBuild ?"), [components/account/AccountGate.tsx:24](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/account/AccountGate.tsx#L24 "return <AccountsOff />")). Sign-in and the backend's access checks are the same switch, `AUTH_REQUIRED` ([convex/access.ts:41](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/access.ts#L41 "export function accessEnforced")).
- [x] The profile picture is the signed-in person's own, or a neutral placeholder ([components/account/ProfilePicture.tsx:28](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/account/ProfilePicture.tsx#L28 "<UserRound size")). A preview or production build does not bundle the demo's photo ([components/account/ProfilePicture.tsx:9](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/account/ProfilePicture.tsx#L9 "A preview or production build never bundles it")).

### RC-05 · Guidelines 2.5.19 and 2.5.2 · Nothing hidden, dormant, or downloaded

> "Don't include any hidden, dormant, or undocumented features in your app; your app's functionality should be clear to end users and App Review."

> "Apps should be self-contained in their bundles, and may not … download, install, or execute code which introduces or changes features or functionality of the app."

- [x] The app downloads and runs no code, and has no over-the-air update library ([package.json:14](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/package.json#L14 "dependencies") to [package.json:45](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/package.json#L45 "supermemory")).
- [x] The first release ships without over-the-air updates, as planned: `expo-updates` is not a dependency ([package.json:14](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/package.json#L14 "dependencies") to [package.json:45](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/package.json#L45 "supermemory")).
- [x] The old case list at `/live`, and the old case screen it opens, are out of the store build's reach. A store build sends both to Projects and never asks the backend for them ([app/live.tsx:12](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app/live.tsx#L12 "return isStoreBuild ? <Redirect"); `app/case/[id].tsx` does the same). With accounts on, the list holds only the account's own cases ([convex/cases.ts:28](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/cases.ts#L28 "visibleCases(ctx)")).
- [x] The unused assistant function is deleted ([9d142e0](https://github.com/ronoktanvir/turtl/commit/9d142e07018347c49bb69290ac55204ae8a66bb8)).
- [ ] Every feature the listing describes is switched on in the production backend, or the listing stops describing it: talking ([convex/voice/rules.ts:27](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/voice/rules.ts#L27 "VOICE_ENABLED")) and questions about the code ([convex/codeNetwork/ask.ts:98](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/codeNetwork/ask.ts#L98 "CODE_NETWORK_CHAT_ENABLED")). **TUR-59**

### RC-06 · Guideline 4.2 · Enough of an app

> "Your app should include features, content, and UI that elevate it beyond a repackaged website. If your app is not particularly useful, unique, or 'app-like,' it doesn't belong on the App Store."

- [x] Every screen is native. The app has no web view library. `expo-web-browser` opens GitHub's sign-in page in the system's browser sheet ([data/account/live.ts:6](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/data/account/live.ts#L6 "import * as WebBrowser from")), and Connect GitHub opens GitHub in the browser; none of turtl's screens is a web page ([package.json:14](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/package.json#L14 "dependencies") to [package.json:45](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/package.json#L45 "supermemory")).
- [ ] Someone who installs turtl from the store can get from sign-up to a watched app on their own. Today the repository token and the watched app are settings of the whole backend, so only its operator can connect anything ([convex/prTracking/github.ts:27](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/prTracking/github.ts#L27 "process.env.GITHUB_TOKEN"), [convex/protectedApp/client.ts:45](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/protectedApp/client.ts#L45 "PROTECTED_APP_URL")). **TUR-62** and **TUR-63**
- [ ] The app is useful before the first outage: a new project shows its checks passing and the map of its code, not an empty page. **TUR-65**

### RC-07 · Guidelines 3.1.1 and 2.1(b) · Payments

> "If you want to unlock features or functionality within your app, (by way of example: subscriptions, in-game currencies, game levels, access to premium content, or unlocking a full version), you must use in-app purchase."

- [x] The app has no payment library and unlocks nothing for money ([package.json:14](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/package.json#L14 "dependencies") to [package.json:45](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/package.json#L45 "supermemory")).
- [x] The listing names no price. `node store/check.mjs` fails if the name, subtitle, promotional text, or keywords mention one.
- [ ] The price is set to free in every country in App Store Connect. **TUR-66**
- [ ] Decide before charging for turtl, not after: a paid plan that unlocks anything in the app has to be sold through in-app purchase. **Ronok**

## B. The listing is accurate

### RC-08 · Guideline 2.3 · The description matches the app

> "make sure all your app metadata, including privacy information, your app description, screenshots, and previews accurately reflect the app's core experience"

Each sentence of the description in `store.config.json`, and what makes it true:

| The listing says | Today | What it still needs |
| --- | --- | --- |
| "checks your live app about once a minute and opens a case when a check fails" | True with accounts on for each project that has a live address ([convex/crons.ts:8](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/crons.ts#L8 "check registered journeys"), [convex/monitor.ts:129](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/monitor.ts#L129 "Something is wrong with")). Each minute checks the next 25 projects in turn ([convex/protectedApp/watching.ts:17](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/protectedApp/watching.ts#L17 "PROJECTS_PER_TICK = 25")), so past 25 projects on one backend a project waits longer than a minute | Checking more often once a backend has more than 25 projects: **Unowned** |
| "explains the likely cause in plain words, with the evidence behind it" | True | - |
| "proposes fixes, each with what it does and what it trades off" | True ([components/fix/FixCard.tsx:87](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/fix/FixCard.tsx#L87 "Trade-offs")) | - |
| "Nothing changes in your app until you approve it" | True, apart from the Auto permission the owner grants | - |
| "merges only when you tap Merge and its checks pass" | True ([convex/pullRequests.ts:142](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/pullRequests.ts#L142 "snapshot.checks !==")) | - |
| "runs your app's key journey again to confirm it works" | True for each project's own live app ([convex/runner/handlers/verify.ts:89](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/runner/handlers/verify.ts#L89 "runJourneyCheck(check, watched)")) | - |
| "may repeat one recovery it has already proven, a limited number of times" | True: three uses, after two verified recoveries ([convex/screens/projects.ts:65](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/screens/projects.ts#L65 "at most 3 times"), [convex/permissions.ts:14](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/permissions.ts#L14 "MIN_VERIFIED_RECOVERIES = 2")) | - |
| "Add turtl's report form to your app" | True. The endpoint exists ([convex/intake/http.ts:26](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/intake/http.ts#L26 "path: INTAKE_PATH")), the form is one file meant to be copied into any app ([protected-app/report/ReportForm.tsx:5](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/protected-app/report/ReportForm.tsx#L5 "copy it into any")), and each project makes its own report key, with a link to the instructions ([components/reportKeys/CustomerReportsSettings.tsx:84](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/reportKeys/CustomerReportsSettings.tsx#L84 "How to add the report form to your app")) | - |
| "See a map of your code in plain words" | True, for each project's own repository through the GitHub App ([convex/codeNetwork/build.ts:206](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/codeNetwork/build.ts#L206 "repositoryAccess(ctx, repo, ")) | - |
| "Ask about a case by typing or by voice" | Typing is true. Talking is off unless the backend switches it on | **TUR-59** (RC-05) |
| "It asks your permission before it sends them anything" | True with accounts on, which a store build requires (RC-26) | - |
| "the privacy policy names each service and what it receives" | True once the pages are published | **Ronok** (RC-01) |
| "you need a GitHub repository and a live app to connect" | True. Add project connects GitHub ([components/github/ConnectGithub.tsx:71](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/github/ConnectGithub.tsx#L71 "Add project's GitHub section")) and takes the live app's address ([app/add-project.tsx:46](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app/add-project.tsx#L46 "Live app URL (optional)")) | - |

- [x] An owner other than the demo's can add the report form to their own app: there is a form to add ([protected-app/report/ReportForm.tsx:5](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/protected-app/report/ReportForm.tsx#L5 "copy it into any")), a report key for each project, and instructions for adding it, linked from the project's settings ([components/reportKeys/CustomerReportsSettings.tsx:84](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/reportKeys/CustomerReportsSettings.tsx#L84 "How to add the report form to your app")).
- [ ] Every row above reads "True" on the build that is submitted, or its sentence is removed from the description. **TUR-66**

### RC-09 · Guideline 2.3.1(a) · Notes for the reviewer

> "All new features, functionality, and product changes must be described with specificity in the Notes for Review section of App Store Connect (generic descriptions will be rejected) and accessible for review."

- [x] The notes are written, specific, and under Apple's limit of 4,000 bytes (`store/review-notes.txt`, checked by `node store/check.mjs`).
- [ ] Each section of the notes is true of the submitted build: the sign-in methods, the review account, the AI permission screen, where account deletion is, and the absence of purchases. **TUR-66**

### RC-10 · Guideline 2.3.3 · Screenshots show the app in use

> "Screenshots should show the app in use, and not merely the title art, login page, or splash screen."

- [x] A shot list, captions, sizes, and a capture method are written (`store/screenshots.md`).
- [ ] The screenshots are captured from the build that is submitted, at 1206 × 2622 or 1179 × 2556, with no transparency. **TUR-66**
- [ ] The first screenshot is not the sign-in screen. **TUR-66**

### RC-11 · Guideline 2.3.9 · Fictional data, and the right to every image

> "You are responsible for securing the rights to use all materials in your app icons, screenshots, and previews, and you should display fictional account information instead of data from a real person."

- [ ] The screenshots show a made-up owner, a made-up app, and made-up customers. No real name, photo, repository, phone number, or email. **TUR-66**
- [ ] Ronok confirms he owns or has licensed the turtle drawings, the app icon, and the logo. **Ronok**

### RC-12 · Guidelines 2.3 and 5.1.1 · The App Privacy answers match the code

> "make sure all your app metadata, including privacy information … accurately reflect the app's core experience and remember to keep them up-to-date with new versions."

- [x] The answers are drafted from the code, one row for each of Apple's data types (`store/app-privacy.md`).
- [ ] The audit is run again on the commit that is submitted. `node store/check.mjs` names every audited file that has changed and every new outside host, setting, and library. **TUR-66**
- [ ] The answers are typed into App Store Connect. No tool pushes them. **TUR-66**
- [ ] When accounts land, the answers include Email Address, Name, and User ID. Accounts have landed; this waits on `store/app-privacy.md`. **TUR-57**
- [ ] When push notifications land, the answers include Device ID. Push has landed; this waits on `store/app-privacy.md`. **TUR-64**
- [ ] When crash reporting lands, the answers include Crash Data and Performance Data, and the vendor is added to the privacy policy. **TUR-65**

### RC-13 · Guidelines 2.3.7 and 5.2.1 · A name of turtl's own

> "Choose a unique app name, assign keywords that accurately describe your app, and don't try to pack any of your metadata with trademarked terms, popular app names, pricing information, or other irrelevant phrases just to game the system."

- [x] The name is 5 characters, the subtitle 25, and the keywords 99 of 100 bytes, with no brand name among them (checked by `node store/check.mjs`).
- [ ] The name "turtl" can be used. An app called "Turtl: Private File Sharing" is already on the App Store, from Turtl Development LLC, with the bundle id `com.turtl.turtl`. Apple may refuse the bare name, and that company may hold a trademark. **Ronok**
- [ ] The bundle id is in a namespace Ronok controls. It is `com.turtl.oncall` today ([app.json:11](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app.json#L11 "bundleIdentifier")), which reads as belonging to whoever owns turtl.com. It cannot be changed after the first upload. **Ronok**, then **TUR-59**

### RC-14 · Guidelines 2.3.5 and 2.3.6 · Category and age rating

> "Answer the age rating questions in App Store Connect honestly so that your app aligns properly with parental controls."

- [x] The categories are Developer Tools, then Productivity (`store.config.json`).
- [x] Every age rating answer is "none" or "no". turtl has no user-to-user messaging, no content shown to other users, no web browser, no advertising, and no gambling. The reasoning for the three answers a reviewer might question is in `store/README.md`.
- [ ] The age rating answers are confirmed in App Store Connect after the first push, since Apple has added questions faster than the tools have followed. **TUR-66**

### RC-15 · Guidelines 2.3.8 and 2.3.10 · Fit for every audience, and about Apple's platforms

> "don't include names, icons, or imagery of other mobile platforms or alternative app marketplaces in your app or metadata"

- [x] The listing names no other mobile platform.
- [ ] No screenshot shows an Android device, a browser frame, or another store's badge. **TUR-66**

## C. Signing in

### RC-16 · Guideline 4.8 · Login services

> "Apps that use a third-party or social login service … to set up or authenticate the user's primary account with the app must also offer as an equivalent option another login service" that limits collection to name and email, lets people keep their email private, and does not collect interactions for advertising without consent.

- [x] Sign in with Apple is offered wherever Sign in with GitHub is, with equal prominence: the first screen is the only place either is offered, and they are the same button side by side ([app/index.tsx:14](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app/index.tsx#L14 "Sign in with Apple"), [app/index.tsx:15](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app/index.tsx#L15 "Sign in with GitHub")).
- [ ] Sign in with Apple has been proven against Apple, not a stand-in. This waits for the Apple Developer membership. **TUR-66**
- [ ] An account that used "Hide My Email" still receives turtl's emails, such as a password reset. The only email turtl sends is a password reset ([convex/auth/email.ts:10](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/auth/email.ts#L10 "The one outside call is sendResetCode below")), which an Apple account has no password for. What remains: register the sending domain with Apple's private relay before any email goes to an Apple account. **TUR-57**

### RC-17 · Guideline 5.1.1(v) · A login only where it is needed

> "If your app doesn't include significant account-based features, let people use it without a login. … Apps may not require users to enter personal information to function, except when directly relevant to the core functionality of the app or required by law."

- [x] turtl's features are all tied to an account: a project, its repository, its live app, and its cases belong to one owner. The review notes say so.
- [x] Sign-up asks for nothing beyond an email address and a password, or what Apple or GitHub passes on. No phone number, company, or role is required ([app/sign-up.tsx:36](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app/sign-up.tsx#L36 "<Field label="), [app/sign-up.tsx:37](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app/sign-up.tsx#L37 "<Field label=")).

### RC-18 · Guideline 5.1.1(v) · Taking GitHub away again

> "The app must also include a mechanism to revoke social network credentials and disable data access between the app and social network from within the app."

- [x] An owner can disconnect GitHub from inside the app, in the gear sheet ([components/github/GithubSettings.tsx:70](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/github/GithubSettings.tsx#L70 "Disconnect GitHub")), and turtl then holds no token for their repositories: each installation only they use is uninstalled at GitHub and its token deleted ([convex/github/connect.ts:214](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/github/connect.ts#L214 "uninstalled at GitHub, and its token, repositories and links are deleted")). Proven against a stand-in for GitHub (`tests/github-connect.test.mjs`), not yet against GitHub.
- [x] Disconnecting says what stops working before it happens ([components/github/GithubSettings.tsx:14](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/github/GithubSettings.tsx#L14 "When you disconnect, turtl stops:")).

## D. Privacy

### RC-19 · Guideline 5.1.1(i) · A privacy policy, linked in two places

> "All apps must include a link to their privacy policy in the App Store Connect metadata field and within the app in an easily accessible manner."

- [x] The policy is written from the audit and names every service that receives data (`site/privacy.md`; `node store/check.mjs` fails if a service in `store/data-practices.json` is missing from it).
- [x] The listing carries its address, and a second address for privacy choices (`store.config.json`).
- [x] The app links to it from the gear sheet, with the terms and the support page (`components/legal/LegalLinks.tsx`). The link shows in any build that uses a real backend.
- [x] The sign-in screen links to the policy and the terms too, since nobody can reach the gear sheet before signing in ([app/index.tsx:61](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app/index.tsx#L61 "<LegalLinks />")).
- [ ] Every "to confirm before launch" note on the policy is settled, and `show_review_notes` is set to `false`. **Ronok**
- [ ] The policy describes what the accounts work stores. **TUR-60**, after **TUR-57**

### RC-20 · Guideline 5.1.1(ii) · Purpose strings

> "Ensure your purpose strings clearly and completely describe your use of the data."

- [x] The microphone is the only permission with a purpose string ([app.config.ts:16](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app.config.ts#L16 "microphonePermission")). The app also asks for notifications, which need none, and only after the owner taps Turn on notifications ([components/push/PushNotifications.tsx:10](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/push/PushNotifications.tsx#L10 "It never asks at launch")).
- [x] The words iOS shows say where the recording goes: "Your recording is sent to OpenAI to be turned into text, and is not kept." ([app.config.ts:16](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app.config.ts#L16 "Your recording is sent to OpenAI to be turned into text")).

### RC-21 · Guideline 2.5.14 · Recording is asked for and shown

> "Apps must request explicit user consent and provide a clear visual and/or audible indication when recording, logging, or otherwise making a record of user activity."

- [x] Recording starts only after a tap, and iOS asks first ([components/voice/useTalkSession.ts:142](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/voice/useTalkSession.ts#L142 "requestRecordingPermissionsAsync")).
- [x] The screen says it is listening for as long as it is ([components/voice/TalkControl.tsx:9](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/voice/TalkControl.tsx#L9 "Listening. Ask about this case")).
- [x] turtl keeps no audio ([convex/voice/schema.ts:5](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/voice/schema.ts#L5 "No audio and no transcript is kept here")).
- [ ] Declining the microphone leaves typing working, checked on a device. **TUR-66**

### RC-22 · Guidelines 5.1.1(iii) and 5.1.1(iv) · Only the data the job needs

> "Apps should only request access to data relevant to the core functionality of the app and should only collect and use data that is required to accomplish the relevant task."

- [x] The app reads nothing from the phone except the microphone, when asked, and the phone's push token once the owner turns notifications on ([data/push/device.native.ts:36](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/data/push/device.native.ts#L36 "getExpoPushTokenAsync")).
- [x] turtl reads only the repositories the owner picks, not every repository their GitHub account can see. With accounts on, a repository is reached only through an installation the project's owner connected, and only if they allowed it ([convex/github/access.ts:27](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/github/access.ts#L27 "is not one of the repositories this project's owner connected to turtl")).
- [ ] Secrets are stripped from source code before it goes to OpenAI or Supermemory. Today up to 30,000 characters of each file are sent as they are ([convex/codeNetwork/build.ts:28](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/codeNetwork/build.ts#L28 "const DOCUMENT_CHARS = 30_000"), [convex/codeNetwork/build.ts:270](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/codeNetwork/build.ts#L270 "addDocuments(gate, namespace, documents)")). **Unowned**

### RC-23 · Guideline 5.1.1(v) · Deleting an account

> "If your app supports account creation, you must also offer account deletion within the app."

- [x] Account deletion is in the app, reachable without writing to anyone, and says what will be deleted. It is in the account section of the gear sheet ([components/project/SettingsSheet.tsx:78](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/project/SettingsSheet.tsx#L78 "<AccountSection />")) and of the account sheet behind Home's profile picture ([components/account/ProfileButton.tsx:20](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/account/ProfileButton.tsx#L20 "<AccountSection heading=")), and lists what goes before asking twice ([components/account/DeleteAccount.tsx:53](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/account/DeleteAccount.tsx#L53 "Deleting your account removes all of this from turtl")).
- [x] It deletes the account's projects, cases, messages, decisions, the map of the code, screenshots, and customers' reports from turtl's database ([convex/account/registry.ts:75](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/account/registry.ts#L75 "export const caseErasers"), [convex/account/registry.ts:99](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/account/registry.ts#L99 "export const projectErasers")). `tests/account-deletion.test.mjs` fails for any table the registry neither removes nor exempts with a reason.
- [x] It deletes the copies in Supermemory: every namespace the account's projects wrote to is deleted whole ([convex/account/vendors.ts:37](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/account/vendors.ts#L37 "const deleted = await deleteNamespace(gateFor(ctx,")). Proven against a stand-in for Supermemory, not yet against Supermemory.
- [ ] An account made with Sign in with Apple has its Apple token revoked on deletion, as Apple requires. Built and tested against a stand-in ([convex/account/vendors.ts:61](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/account/vendors.ts#L61 "const revoked = await revokeToken(client, token.refreshToken)")). What remains: `AUTH_APPLE_TEAM_ID`, `AUTH_APPLE_KEY_ID` and `AUTH_APPLE_PRIVATE_KEY` on the production backend (without them no token is kept, so none can be revoked), and one run against Apple. **TUR-57**, then **TUR-66**
- [x] It removes turtl's access to the owner's GitHub repositories ([convex/account/vendors.ts:47](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/account/vendors.ts#L47 "internal.github.connect.disconnectAccount,")).
- [ ] The review account can show deletion without destroying itself, or the notes tell the reviewer to make a throwaway account. **TUR-57**

### RC-24 · Guideline 5.1.1(i) · How long data is kept

> "Explain its data retention/deletion policies and describe how a user can revoke consent and/or request deletion of the user's data."

- [x] The policy has a section on how long data is kept and one on how to have it deleted (`site/privacy.md`).
- [ ] Decide how long closed cases, chat, and customers' reports are kept: forever, or deleted after a set time. The policy says "until you delete it" and the code keeps everything. **Ronok**
- [ ] Fill in how many days a deleted account survives in the backend's backups (`backup_retention_days`). **Ronok**

### RC-25 · Guidelines 5.1.1(viii) and 5.1.2(i) · Other people's data: customers' reports

> "Apps that compile personal information from any source that is not directly from the user or without the user's explicit consent, even public databases, are not permitted on the App Store."

turtl's report form collects words and contact details from people who are not turtl's users.

- [x] A customer's contact goes to no outside service: it is turned into a reference and dropped, never stored or sent ([convex/intake/records.ts:65](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/intake/records.ts#L65 "The contact becomes this reference and is then dropped")), and alerts never quote a customer ([convex/intake/records.ts:324](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/intake/records.ts#L324 "A customer reported a problem with")).
- [x] The terms make the owner responsible for telling their customers, and the policy has a section for it (`site/terms.md`, `site/privacy.md`).
- [x] The report form itself tells the customer where their words go, with a link to the policy ([protected-app/report/ReportForm.tsx:109](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/protected-app/report/ReportForm.tsx#L109 "How turtl handles your message")).
- [x] An owner can delete one report ([components/fix/CustomerReports.tsx:62](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/fix/CustomerReports.tsx#L62 "Delete this report?"), [convex/intake/records.ts:463](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/intake/records.ts#L463 "export const deleteReport")), and deleting an account deletes them all ([convex/account/registry.ts:100](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/account/registry.ts#L100 "Customers' reports and their triage (RC-25)")).
- [x] A customer's contact is not kept. The form asks for none ([protected-app/report/ReportForm.tsx:14](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/protected-app/report/ReportForm.tsx#L14 "No name, email, account or location")), and one sent anyway becomes a keyed hash and is dropped ([convex/intake/records.ts:65](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/intake/records.ts#L65 "The contact becomes this reference and is then dropped")).

### RC-26 · Guideline 5.1.2(i) · Permission before data goes to third-party AI

> "You must clearly disclose where personal data will be shared with third parties, including with third-party AI, and obtain explicit permission before doing so."

- [x] Before anything is sent, a screen names each service and what it receives, and asks. It is built from `store/data-practices.json` ([convex/consent/services.ts:1](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/consent/services.ts#L1 "import practices from")), and a signed-in owner who has not answered is sent to it ([components/consent/ConsentGate.tsx:22](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/consent/ConsentGate.tsx#L22 "ai-permission?from=start")).
- [x] Nothing reaches OpenAI, Supermemory, Capy, or Keiki for an account that has not said yes. The backend enforces it, not only the screen: every call asks the gate first ([convex/consent/gate.ts:65](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/consent/gate.ts#L65 "export const check")), and `tests/consent-gate.test.mjs` fails on a call that does not.
- [x] Permission can be taken back in the gear sheet ([components/consent/AiSettings.tsx:45](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/consent/AiSettings.tsx#L45 "Take back")), and the backend stops sending from that moment, since the gate asks again on every call ([convex/consent/permission.ts:108](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/consent/permission.ts#L108 "export const withdraw")).
- [x] After a "no", the app still opens and says what it cannot do ([components/consent/AiNotice.tsx:17](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/consent/AiNotice.tsx#L17 "until you allow")).
- [x] Adding a service later asks again: the list has one version, and a change to it shows the screen again ([convex/consent/services.ts:65](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/consent/services.ts#L65 "export const LIST_VERSION")).

### RC-27 · Guideline 5.1.2(i) · No tracking, and nothing forced on

> "Your app may not require users to enable system functionalities (such as push notifications, location services, tracking) in order to access functionality, content, use the app"

- [x] turtl does not track. It has no advertising or analytics library, reads no advertising identifier, and needs no App Tracking Transparency prompt ([package.json:14](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/package.json#L14 "dependencies") to [package.json:45](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/package.json#L45 "supermemory")).
- [x] The microphone is optional. Typing does the same job.
- [x] Push notifications are optional. The app offers them once and never asks at launch, and works for someone who declines them ([components/push/PushNotifications.tsx:22](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/push/PushNotifications.tsx#L22 "turtl works the same without notifications")).

### RC-28 · Guidelines 5.1.1(i) and 5.1.2(ii) · What the vendors do with it

> "Confirm that any third party with whom an app shares user data … will provide the same or equal protection of user data as stated in the app's privacy policy and required by these Guidelines."

> "Data collected for one purpose may not be repurposed without further consent unless otherwise explicitly permitted by law."

- [ ] A data processing agreement is accepted with each vendor that receives personal data: OpenAI, Supermemory, Capy, Keiki, Revyl, Convex, and GitHub, and since accounts and push landed, Expo (push), Resend (the reset email), and Apple (sign-in). None is on file. **Ronok**
- [ ] Each vendor's terms rule out training on turtl's data. OpenAI, Keiki, and Capy say so in public. The pages read for Supermemory and Revyl do not say either way. **Ronok**
- [x] Requests to OpenAI's Responses API set `store: false`, so OpenAI does not keep them as application state for 30 days ([convex/codeNetwork/openai.ts:13](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/codeNetwork/openai.ts#L13 "store: false")). It is the only call to that API.

### RC-29 · Guideline 4.5.4 · Push notifications

> "Push Notifications must not be required for the app to function, and should not be used to send sensitive personal or confidential information."

- [x] A notification names the app and says a case needs the owner. It does not carry a customer's words, an error message, or code: its title is the project's name and its body one of two fixed sentences ([convex/push/message.ts:3](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/push/message.ts#L3 "A notification shows on a locked phone"), [convex/push/message.ts:17](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/push/message.ts#L17 "export const PUSH_BODIES")).
- [x] No notification is promotional ([convex/push/message.ts:6](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/push/message.ts#L6 "Nothing here is promotional")).

### RC-30 · Guideline 1.6 · Data security

> "Apps should implement appropriate security measures to ensure proper handling of user information … and prevent its unauthorized use, disclosure, or access by third parties."

- [x] Every backend function checks who is calling and whether the project is theirs, with accounts on ([convex/access.ts:9](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/access.ts#L9 "Every public function asks here")). `tests/access-coverage.test.mjs` fails for a public function that does not. The single-owner demo still treats every caller as the one owner, and a store build refuses a backend that runs as the demo (RC-04).
- [x] The shared owner passcode is replaced by accounts: with accounts on no passcode is asked for, accepted, or set ([convex/ownerPasscode.ts:6](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/ownerPasscode.ts#L6 "replaces it: an owner decision is authorised by being the signed-in owner")). Its unsalted hash remains only in the single-owner demo ([convex/ownerPasscode.ts:12](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/ownerPasscode.ts#L12 "SHA-256")).
- [x] The repository token belongs to one owner's installation, not to the whole backend. With accounts on the deployment-wide token reads as not set ([convex/prTracking/github.ts:27](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/prTracking/github.ts#L27 "demoOnly(process.env.GITHUB_TOKEN)")), and each repository is reached with a token of an installation its project's owner connected ([convex/github/access.ts:35](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/github/access.ts#L35 "export async function repositoryAccess")).
- [x] An error from OpenAI is not shown raw. A failed call is reported by its status and error type only, never the vendor's text ([convex/consent/outbound.ts:17](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/consent/outbound.ts#L17 "It never carries the vendor's own text")), and the unused assistant that passed it through is deleted.
- [ ] The production backend is a separate deployment from the demo, with its own keys. A production build refuses the demo backend's address ([release/build-env.js:26](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/release/build-env.js#L26 "points at the demo backend")); the production deployment and its keys do not exist yet. **TUR-59**

### RC-31 · Guideline 1.5 · A way to reach the developer

> "Make sure your app and its Support URL include an easy way to contact you"

- [x] The support page leads with a contact address, and the app links to it (`site/support.md`, `components/legal/LegalLinks.tsx`).
- [ ] The contact address is filled in and someone reads it. **Ronok**

## E. Content and rights

### RC-32 · Guideline 1.2 · User-generated content

> "Apps that enable users to create, generate, upload, share, or otherwise contribute content … This includes social media, user-generated content platforms, and AI content creation apps."

- [x] Nothing an owner writes is shown to another owner, and owners cannot message each other. turtl's AI answers go only to the owner who asked. The review notes say so.
- [x] A customer's report is shown only to the owner of the app it was sent to, never to another account ([convex/intake/records.ts:342](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/intake/records.ts#L342 "What customers wrote is shown only to the owner of the app they sent it to")).

### RC-33 · Guidelines 5.2.1 and 5.2.2 · Other people's property and services

> "If your app uses, accesses, monetizes access to, or displays content from a third-party service, ensure that you are specifically permitted to do so under the service's terms of use."

- [x] The fonts are Capriola and Righteous, both under the SIL Open Font License, and ship inside the app ([app/_layout.tsx:8](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app/_layout.tsx#L8 "@expo-google-fonts/capriola"), [app/_layout.tsx:9](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app/_layout.tsx#L9 "@expo-google-fonts/righteous")).
- [ ] The GitHub mark is used as GitHub's logo rules allow: unaltered, to say "sign in with" or "view on" GitHub ([components/ui/BrandIcon.tsx:7](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/ui/BrandIcon.tsx#L7 "github:")). It is on the sign-in button and the project's GitHub link, and also heads the Connect GitHub card ([components/github/ConnectGithub.tsx:31](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/github/ConnectGithub.tsx#L31 "<BrandIcon name=")), drawn in the theme's text color. What remains: confirm GitHub's rules allow that third use and the color. **TUR-57**
- [x] The Google mark has left the app with the Google button: the only marks are GitHub's and Apple's ([components/ui/BrandIcon.tsx:6](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/ui/BrandIcon.tsx#L6 "const paths = ")).
- [ ] turtl's use of each vendor's API is within that vendor's terms for a product offered to the public. **Ronok**

## F. What App Store Connect asks for beyond the guidelines

### RC-34 · Privacy manifest

- [x] The build declares the reasons its libraries use four of Apple's "required reason" APIs ([app.json:20](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app.json#L20 "NSPrivacyAccessedAPITypes")). They match the `PrivacyInfo.xcprivacy` files of every library installed at `2f99bfe`, `expo-notifications` and `expo-application` included.
- [ ] The manifest says the app does not track, and lists the same data types as the App Privacy answers. It says the app does not track ([app.json:17](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app.json#L17 "NSPrivacyTracking")), but its list of data types is empty ([app.json:19](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app.json#L19 "NSPrivacyCollectedDataTypes")). What remains: list the App Privacy answers' types there. **TUR-59**

### RC-35 · Export compliance

- [x] The build declares that it uses only exempt encryption (HTTPS, and the iOS Keychain), so App Store Connect does not ask at every upload: `ITSAppUsesNonExemptEncryption` is `false`, which Expo writes from `usesNonExemptEncryption` ([app.json:14](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app.json#L14 "usesNonExemptEncryption")).

### RC-36 · iPhone only

> "iPhone apps should run on iPad whenever possible." (Guideline 2.4.1)

- [x] The app does not declare iPad support, so no iPad screenshots are required ([app.json:12](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app.json#L12 "supportsTablet")).
- [ ] The app is usable when an iPad runs it in iPhone mode, because App Review may test it there. **TUR-66**

### RC-37 · The European Union's trader status

App Store Connect asks whether the developer is a trader under the Digital Services Act. A trader's address, phone number, and email are shown on the product page in the EU. Without an answer the app cannot be offered there.

- [ ] Decide whether turtl is offered in the EU at launch, and declare trader status if so. **Ronok**
- [ ] If it is, the privacy policy's section on where data is processed states the legal basis for sending data to the United States. **TUR-60**

### RC-38 · Fields no file can set

- [ ] The app record exists in App Store Connect with its name, primary language, bundle id, and SKU. **TUR-66**
- [ ] The content rights question is answered. turtl shows the owner's own code and their customers' reports, and no third party's content. **TUR-66**
- [x] `eas.json` points at the dynamic listing file: `submit.production.ios.metadataPath` is `./store.config.js` ([eas.json:38](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/eas.json#L38 "metadataPath")).
- [ ] `eas metadata:push` has run cleanly once against the real record. **TUR-66**

### RC-39 · The membership everything waits for

- [ ] Ronok is enrolled in the Apple Developer Program (TUR-67). Sign in with Apple, push delivery, TestFlight, and submission cannot be proven without it. **Ronok**
