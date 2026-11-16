# App Review readiness checklist

Written against Apple's App Review Guidelines as last updated on 16 October 2026 (read on 15 November 2026) and turtl's code at commit `3d01f64`.

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
- [ ] The store build cannot show example data. Example data appears whenever the build has no backend address or sets `EXPO_PUBLIC_DATA_SOURCE=example` ([data/source.ts:18](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/data/source.ts#L18 "EXPO_PUBLIC_DATA_SOURCE")). **TUR-59**
- [ ] A new account with no projects sees a first-run screen, not an empty list. **TUR-65**

### RC-02 · Guideline 2.1(a) · A review account and a backend that is switched on

> "include demo account info (and turn on your back-end service!) if your app includes a login."

- [ ] An email-and-password review account exists on the production backend. **TUR-57**
- [ ] The review account opens on a project with an open case, connected to a demo app that can be broken and fixed again and again without harm. **TUR-57** with **TUR-63**
- [ ] Every step in `store/review-notes.txt` works on that account, tap for tap, on the build that is submitted. **TUR-66**
- [ ] The six `APP_REVIEW_*` variables are set where `eas metadata:push` runs (names in `store/README.md`). **Ronok**
- [ ] The production backend, and the accounts it pays vendors from, stay up and funded for the whole review. **Ronok**
- [ ] A reviewer who approves fixes repeatedly cannot run up an unlimited bill: each account has a limit on model spend. **TUR-65**

### RC-03 · Guideline 2.1(a) · Tested on a device

> "Make sure your app has been tested on-device for bugs and stability before you submit it … We will reject incomplete app bundles and binaries that crash or exhibit obvious technical problems."

- [ ] A TestFlight build has been used on a physical iPhone through sign-in, opening a case, approving a fix, talking, and deleting the account. **TUR-66**
- [ ] A screen that fails to draw shows a message and a way back, not a blank screen. **TUR-65**
- [ ] Losing the network in the middle of a case shows a message, not a spinner that never ends. **TUR-65**

### RC-04 · Guidelines 2.1(a) and 2.2 · No demonstration controls

> "Demos, betas, and trial versions of your app don't belong on the App Store – use TestFlight instead."

- [ ] The Login button signs someone in. Today all four buttons on the first screen go straight into the app ([app/index.tsx:29](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app/index.tsx#L29 "router.replace")). **TUR-57**
- [ ] The Google button is removed, or it works. Google is not one of the planned sign-in methods ([app/index.tsx:22](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/app/index.tsx#L22 "Login with Google")). **TUR-57**
- [ ] The store build cannot show the developer tools: its profile does not set `EXPO_PUBLIC_DEV_TOOLS` ([components/ui/index.tsx:26](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/components/ui/index.tsx#L26 "EXPO_PUBLIC_DEV_TOOLS")), and the production backend does not set `DEV_TOOLS_ENABLED` ([convex/dev.ts:28](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/dev.ts#L28 "DEV_TOOLS_ENABLED")). **TUR-59**
- [ ] The store build refuses to run with sign-in or access checks switched off. **TUR-59** with **TUR-61**
- [ ] The profile picture is the signed-in person's own, or a neutral placeholder. Today a photo of Ronok is compiled into the app ([app/projects.tsx:26](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/app/projects.tsx#L26 "ronok-avatar.png")). **TUR-57**

### RC-05 · Guidelines 2.5.19 and 2.5.2 · Nothing hidden, dormant, or downloaded

> "Don't include any hidden, dormant, or undocumented features in your app; your app's functionality should be clear to end users and App Review."

> "Apps should be self-contained in their bundles, and may not … download, install, or execute code which introduces or changes features or functionality of the app."

- [x] The app downloads and runs no code, and has no over-the-air update library ([package.json:14](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/package.json#L14 "dependencies") to [package.json:45](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/package.json#L45 "supermemory")).
- [ ] The first release ships without over-the-air updates, as planned. **TUR-59**
- [ ] The old case list at `/live`, and the old case screen it opens, are removed from the store build. Today any build opens the list at `turtl://live`, and it shows every case in the backend ([app/live.tsx:16](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app/live.tsx#L16 "api.cases.listWithSteps"), [components/feed/CaseRow.tsx:27](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/feed/CaseRow.tsx#L27 "/case/[id]")). **TUR-65**
- [ ] The unused assistant function is deleted, or stays switched off in production ([convex/assistant.ts:39](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/assistant.ts#L39 "ASSISTANT_ENABLED")). **TUR-61**
- [ ] Every feature the listing describes is switched on in the production backend, or the listing stops describing it: talking ([convex/voice/rules.ts:27](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/voice/rules.ts#L27 "VOICE_ENABLED")) and questions about the code ([convex/codeNetwork/ask.ts:98](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/codeNetwork/ask.ts#L98 "CODE_NETWORK_CHAT_ENABLED")). **TUR-59**

### RC-06 · Guideline 4.2 · Enough of an app

> "Your app should include features, content, and UI that elevate it beyond a repackaged website. If your app is not particularly useful, unique, or 'app-like,' it doesn't belong on the App Store."

- [x] Every screen is native. The app has no web view library ([package.json:14](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/package.json#L14 "dependencies") to [package.json:45](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/package.json#L45 "supermemory")).
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
| "checks your live app about once a minute and opens a case when a check fails" | True for the one app the backend is set up to watch ([convex/crons.ts:8](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/crons.ts#L8 "check registered journeys"), [convex/monitor.ts:129](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/monitor.ts#L129 "Something is wrong with")) | Each account's own app: **TUR-63** |
| "explains the likely cause in plain words, with the evidence behind it" | True | - |
| "proposes fixes, each with what it does and what it trades off" | True ([components/fix/FixCard.tsx:87](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/fix/FixCard.tsx#L87 "Trade-offs")) | - |
| "Nothing changes in your app until you approve it" | True, apart from the Auto permission the owner grants | - |
| "merges only when you tap Merge and its checks pass" | True ([convex/pullRequests.ts:142](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/pullRequests.ts#L142 "snapshot.checks !==")) | - |
| "runs your app's key journey again to confirm it works" | True for the demo app | Each account's own app: **TUR-63** |
| "may repeat one recovery it has already proven, a limited number of times" | True: three uses, after two verified recoveries ([components/project/SettingsSheet.tsx:49](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/components/project/SettingsSheet.tsx#L49 "for at most 3 uses")) | - |
| "Add turtl's report form to your app" | Half true. The endpoint exists ([convex/intake/http.ts:26](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/intake/http.ts#L26 "path: INTAKE_PATH")), but the only form is inside the demo app ([protected-app/report/ReportForm.tsx:112](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/protected-app/report/ReportForm.tsx#L112 "Email, optional")). Another owner has nothing to add and no instructions | **Unowned** |
| "See a map of your code in plain words" | True | Each account's own repository: **TUR-62** |
| "Ask about a case by typing or by voice" | Typing is true. Talking is off unless the backend switches it on | **TUR-59** (RC-05) |
| "It asks your permission before it sends them anything" | **False.** Nothing asks | **TUR-65** (RC-26) |
| "the privacy policy names each service and what it receives" | True once the pages are published | **Ronok** (RC-01) |
| "you need a GitHub repository and a live app to connect" | The app has no way to connect either | **TUR-62** and **TUR-63** |

- [ ] An owner other than the demo's can add the report form to their own app: there is a form to add, and instructions for adding it. **Unowned**
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
- [ ] When accounts land, the answers include Email Address, Name, and User ID. **TUR-57**
- [ ] When push notifications land, the answers include Device ID. **TUR-64**
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

- [ ] Sign in with Apple is offered wherever Sign in with GitHub is, with equal prominence. **TUR-57**
- [ ] Sign in with Apple has been proven against Apple, not a stand-in. This waits for the Apple Developer membership. **TUR-66**
- [ ] An account that used "Hide My Email" still receives turtl's emails, such as a password reset. **TUR-57**

### RC-17 · Guideline 5.1.1(v) · A login only where it is needed

> "If your app doesn't include significant account-based features, let people use it without a login. … Apps may not require users to enter personal information to function, except when directly relevant to the core functionality of the app or required by law."

- [x] turtl's features are all tied to an account: a project, its repository, its live app, and its cases belong to one owner. The review notes say so.
- [ ] Sign-up asks for nothing beyond an email address and a password, or what Apple or GitHub passes on. No phone number, company, or role is required. **TUR-57**

### RC-18 · Guideline 5.1.1(v) · Taking GitHub away again

> "The app must also include a mechanism to revoke social network credentials and disable data access between the app and social network from within the app."

- [ ] An owner can disconnect GitHub from inside the app, and turtl then holds no token for their repositories. **TUR-62**
- [ ] Disconnecting says what stops working. **TUR-62**

## D. Privacy

### RC-19 · Guideline 5.1.1(i) · A privacy policy, linked in two places

> "All apps must include a link to their privacy policy in the App Store Connect metadata field and within the app in an easily accessible manner."

- [x] The policy is written from the audit and names every service that receives data (`site/privacy.md`; `node store/check.mjs` fails if a service in `store/data-practices.json` is missing from it).
- [x] The listing carries its address, and a second address for privacy choices (`store.config.json`).
- [x] The app links to it from the gear sheet, with the terms and the support page (`components/legal/LegalLinks.tsx`). The link shows in any build that uses a real backend.
- [ ] The sign-in screen links to the policy and the terms too, since nobody can reach the gear sheet before signing in. `LegalLinks` can be dropped in as it is. **TUR-57**
- [ ] Every "to confirm before launch" note on the policy is settled, and `show_review_notes` is set to `false`. **Ronok**
- [ ] The policy describes what the accounts work stores. **TUR-60**, after **TUR-57**

### RC-20 · Guideline 5.1.1(ii) · Purpose strings

> "Ensure your purpose strings clearly and completely describe your use of the data."

- [x] The microphone is the only permission the app asks for ([app.config.ts:16](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app.config.ts#L16 "microphonePermission")).
- [ ] The words iOS shows say where the recording goes. Today they say recordings "are transcribed and not kept", and do not say they are sent to OpenAI. Suggested: "turtl listens after you tap Talk so you can ask about a case out loud. Your recording is sent to OpenAI to be turned into text, and is not kept." **TUR-59**

### RC-21 · Guideline 2.5.14 · Recording is asked for and shown

> "Apps must request explicit user consent and provide a clear visual and/or audible indication when recording, logging, or otherwise making a record of user activity."

- [x] Recording starts only after a tap, and iOS asks first ([components/voice/useTalkSession.ts:142](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/voice/useTalkSession.ts#L142 "requestRecordingPermissionsAsync")).
- [x] The screen says it is listening for as long as it is ([components/voice/TalkControl.tsx:9](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/voice/TalkControl.tsx#L9 "Listening. Ask about this case")).
- [x] turtl keeps no audio ([convex/voice/schema.ts:5](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/voice/schema.ts#L5 "No audio and no transcript is kept here")).
- [ ] Declining the microphone leaves typing working, checked on a device. **TUR-66**

### RC-22 · Guidelines 5.1.1(iii) and 5.1.1(iv) · Only the data the job needs

> "Apps should only request access to data relevant to the core functionality of the app and should only collect and use data that is required to accomplish the relevant task."

- [x] The app reads nothing from the phone except the microphone, when asked.
- [ ] turtl reads only the repositories the owner picks, not every repository their GitHub account can see. **TUR-58** and **TUR-62**
- [ ] Secrets are stripped from source code before it goes to OpenAI or Supermemory. Today up to 30,000 characters of each file are sent as they are ([convex/codeNetwork/build.ts:255](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/build.ts#L255 "addDocuments(namespace, documents)")). **Unowned**

### RC-23 · Guideline 5.1.1(v) · Deleting an account

> "If your app supports account creation, you must also offer account deletion within the app."

- [ ] Account deletion is in the app, reachable without writing to anyone, and says what will be deleted. **TUR-57**
- [ ] It deletes the account's projects, cases, messages, decisions, the map of the code, screenshots, and customers' reports from turtl's database. Today nothing is ever deleted outside a developer reset ([convex/memory/reset.ts:11](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/memory/reset.ts#L11 "DEV_TOOLS_ENABLED")). **TUR-57**
- [ ] It deletes the copies in Supermemory. No code calls a delete on Supermemory today. **TUR-57**
- [ ] An account made with Sign in with Apple has its Apple token revoked on deletion, as Apple requires. **TUR-57**
- [ ] It removes turtl's access to the owner's GitHub repositories. **TUR-62**
- [ ] The review account can show deletion without destroying itself, or the notes tell the reviewer to make a throwaway account. **TUR-57**

### RC-24 · Guideline 5.1.1(i) · How long data is kept

> "Explain its data retention/deletion policies and describe how a user can revoke consent and/or request deletion of the user's data."

- [x] The policy has a section on how long data is kept and one on how to have it deleted (`site/privacy.md`).
- [ ] Decide how long closed cases, chat, and customers' reports are kept: forever, or deleted after a set time. The policy says "until you delete it" and the code keeps everything. **Ronok**
- [ ] Fill in how many days a deleted account survives in the backend's backups (`backup_retention_days`). **Ronok**

### RC-25 · Guidelines 5.1.1(viii) and 5.1.2(i) · Other people's data: customers' reports

> "Apps that compile personal information from any source that is not directly from the user or without the user's explicit consent, even public databases, are not permitted on the App Store."

turtl's report form collects words and contact details from people who are not turtl's users.

- [x] A customer's contact goes to no outside service ([convex/intake/schema.ts:23](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/intake/schema.ts#L23 "Contact details stay here, never in a prompt")), and alerts never quote a customer ([convex/intake/records.ts:324](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/intake/records.ts#L324 "A customer reported a problem with")).
- [x] The terms make the owner responsible for telling their customers, and the policy has a section for it (`site/terms.md`, `site/privacy.md`).
- [ ] The report form itself tells the customer where their words go, with a link to the policy. **Unowned**
- [ ] An owner can delete one report, and deleting an account deletes them all. **TUR-57**
- [ ] A customer's contact is encrypted, or not kept. Today it is stored as written ([convex/intake/records.ts:114](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/intake/records.ts#L114 "contact: args.contact")). **Unowned**

### RC-26 · Guideline 5.1.2(i) · Permission before data goes to third-party AI

> "You must clearly disclose where personal data will be shared with third parties, including with third-party AI, and obtain explicit permission before doing so."

- [ ] Before anything is sent, a screen names each service and what it receives, and asks. Build it from `store/data-practices.json`, so the screen, the policy, and the audit cannot disagree. **TUR-65**
- [ ] Nothing reaches OpenAI, Supermemory, Capy, or Keiki for an account that has not said yes. The backend enforces it, not only the screen. **TUR-65**
- [ ] Permission can be taken back in the gear sheet, and the backend stops sending from that moment. **TUR-65**
- [ ] After a "no", the app still opens and says what it cannot do. **TUR-65**
- [ ] Adding a service later asks again. **TUR-65**

### RC-27 · Guideline 5.1.2(i) · No tracking, and nothing forced on

> "Your app may not require users to enable system functionalities (such as push notifications, location services, tracking) in order to access functionality, content, use the app"

- [x] turtl does not track. It has no advertising or analytics library, reads no advertising identifier, and needs no App Tracking Transparency prompt ([package.json:14](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/package.json#L14 "dependencies") to [package.json:45](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/package.json#L45 "supermemory")).
- [x] The microphone is optional. Typing does the same job.
- [ ] Push notifications are optional. The app works for someone who declines them. **TUR-64**

### RC-28 · Guidelines 5.1.1(i) and 5.1.2(ii) · What the vendors do with it

> "Confirm that any third party with whom an app shares user data … will provide the same or equal protection of user data as stated in the app's privacy policy and required by these Guidelines."

> "Data collected for one purpose may not be repurposed without further consent unless otherwise explicitly permitted by law."

- [ ] A data processing agreement is accepted with each vendor that receives personal data: OpenAI, Supermemory, Capy, Keiki, Revyl, Convex, and GitHub. None is on file. **Ronok**
- [ ] Each vendor's terms rule out training on turtl's data. OpenAI, Keiki, and Capy say so in public. The pages read for Supermemory and Revyl do not say either way. **Ronok**
- [ ] Requests to OpenAI's Responses API set `store: false`, so OpenAI does not keep them as application state for 30 days ([convex/codeNetwork/openai.ts:38](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/codeNetwork/openai.ts#L38 "body: JSON.stringify")). **Unowned**

### RC-29 · Guideline 4.5.4 · Push notifications

> "Push Notifications must not be required for the app to function, and should not be used to send sensitive personal or confidential information."

- [ ] A notification names the app and says a case needs the owner. It does not carry a customer's words, an error message, or code. **TUR-64**
- [ ] No notification is promotional. **TUR-64**

### RC-30 · Guideline 1.6 · Data security

> "Apps should implement appropriate security measures to ensure proper handling of user information … and prevent its unauthorized use, disclosure, or access by third parties."

- [ ] Every backend function checks who is calling and whether the project is theirs. Today the backend treats every caller as the one owner ([convex/decisions.ts:14](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/decisions.ts#L14 "SOLO_OWNER")), and the app says so itself ([components/project/OwnerPasscodeSettings.tsx:42](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/project/OwnerPasscodeSettings.tsx#L42 "Anyone with the backend address can make decisions")). **TUR-61**
- [ ] The shared owner passcode is replaced by accounts. Its hash has no salt ([convex/ownerPasscode.ts:12](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/ownerPasscode.ts#L12 "SHA-256")). **TUR-61**
- [ ] The repository token belongs to one owner's installation, not to the whole backend ([convex/prTracking/github.ts:27](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/prTracking/github.ts#L27 "process.env.GITHUB_TOKEN")). **TUR-58**
- [ ] An error from OpenAI is not shown raw. Two functions pass its text through, and it can echo part of what was sent ([convex/assistant.ts:83](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/assistant.ts#L83 "OpenAI request failed")). **Unowned**
- [ ] The production backend is a separate deployment from the demo, with its own keys. **TUR-59**

### RC-31 · Guideline 1.5 · A way to reach the developer

> "Make sure your app and its Support URL include an easy way to contact you"

- [x] The support page leads with a contact address, and the app links to it (`site/support.md`, `components/legal/LegalLinks.tsx`).
- [ ] The contact address is filled in and someone reads it. **Ronok**

## E. Content and rights

### RC-32 · Guideline 1.2 · User-generated content

> "Apps that enable users to create, generate, upload, share, or otherwise contribute content … This includes social media, user-generated content platforms, and AI content creation apps."

- [x] Nothing an owner writes is shown to another owner, and owners cannot message each other. turtl's AI answers go only to the owner who asked. The review notes say so.
- [ ] A customer's report is shown only to the owner of the app it was sent to, never to another account. **TUR-61**

### RC-33 · Guidelines 5.2.1 and 5.2.2 · Other people's property and services

> "If your app uses, accesses, monetizes access to, or displays content from a third-party service, ensure that you are specifically permitted to do so under the service's terms of use."

- [x] The font is Capriola, under the SIL Open Font License, and ships inside the app ([app/_layout.tsx:8](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app/_layout.tsx#L8 "@expo-google-fonts/capriola")).
- [ ] The GitHub mark is used as GitHub's logo rules allow: unaltered, to say "sign in with" or "view on" GitHub ([components/ui/BrandIcon.tsx:7](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/ui/BrandIcon.tsx#L7 "github:")). **TUR-57**
- [ ] The Google mark leaves the app with the Google button ([components/ui/BrandIcon.tsx:6](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/components/ui/BrandIcon.tsx#L6 "google:")). **TUR-57**
- [ ] turtl's use of each vendor's API is within that vendor's terms for a product offered to the public. **Ronok**

## F. What App Store Connect asks for beyond the guidelines

### RC-34 · Privacy manifest

- [ ] The build declares the reasons its libraries use four of Apple's "required reason" APIs. The values are listed in `store/app-privacy.md`, read from the libraries installed today. **TUR-59**
- [ ] The manifest says the app does not track, and lists the same data types as the App Privacy answers. **TUR-59**

### RC-35 · Export compliance

- [ ] The build declares that it uses only exempt encryption (HTTPS, and the iOS Keychain), so App Store Connect does not ask at every upload: `ITSAppUsesNonExemptEncryption` is `false`. **TUR-59**

### RC-36 · iPhone only

> "iPhone apps should run on iPad whenever possible." (Guideline 2.4.1)

- [x] The app does not declare iPad support, so no iPad screenshots are required (`app.json` has no `supportsTablet`).
- [ ] The app is usable when an iPad runs it in iPhone mode, because App Review may test it there. **TUR-66**

### RC-37 · The European Union's trader status

App Store Connect asks whether the developer is a trader under the Digital Services Act. A trader's address, phone number, and email are shown on the product page in the EU. Without an answer the app cannot be offered there.

- [ ] Decide whether turtl is offered in the EU at launch, and declare trader status if so. **Ronok**
- [ ] If it is, the privacy policy's section on where data is processed states the legal basis for sending data to the United States. **TUR-60**

### RC-38 · Fields no file can set

- [ ] The app record exists in App Store Connect with its name, primary language, bundle id, and SKU. **TUR-66**
- [ ] The content rights question is answered. turtl shows the owner's own code and their customers' reports, and no third party's content. **TUR-66**
- [ ] `eas.json` points at the dynamic listing file: `submit.production.ios.metadataPath` is `./store.config.js`. **TUR-59**
- [ ] `eas metadata:push` has run cleanly once against the real record. **TUR-66**

### RC-39 · The membership everything waits for

- [ ] Ronok is enrolled in the Apple Developer Program (TUR-67). Sign in with Apple, push delivery, TestFlight, and submission cannot be proven without it. **Ronok**
