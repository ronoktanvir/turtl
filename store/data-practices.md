# What turtl does with data: an audit from the code

**Audited commit:** `2f99bfe` on `build/wave-2` (16 November 2026). **Scope:** `app/`, `components/`, `data/`, `theme/`, `convex/`, `protected-app/`, `package.json`, `app.json`, `app.config.ts`.

This describes what the code at that commit does, not what the product is meant to do. Every claim links to the line that proves it, pinned to the audited commit so the link never drifts. Hover a link to see the text that line must contain; `node store/check.mjs` checks every one, and lists the referenced files that changed since the audit.

The machine-readable list of outside services is [`data-practices.json`](data-practices.json). The permission screen reads it ([convex/consent/services.ts:1](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/consent/services.ts#L1 "store/data-practices.json")), and the privacy policy and the App Privacy answers should match it.

## How the audit was done

1. Listed every outbound call: each `fetch(`, each SDK client, each `process.env` name, and each `https://` literal in the scope above. `node store/check.mjs` lists any it has not seen; at this commit there are none.
2. Read each call site to see which fields go into the request and what is kept from the answer.
3. Read `convex/schema.ts` and each module's tables for what is stored, and the account deletion registry for what is removed.
4. Read each vendor's public policy on 15 November 2026 for what happens on their side. The three vendors added since (Expo, Resend, Apple) were not read for this audit.

**Not covered:** which switches are turned on in a hosted deployment (no production deployment exists yet), and anything a vendor does beyond its published policy. One fact comes from a handoff note and not from code, and is marked where it appears.

## Two modes

The backend runs in one of two modes, chosen by `AUTH_REQUIRED` ([convex/access.ts:41](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/access.ts#L41 "export function accessEnforced()")):

- **Accounts mode** (`AUTH_REQUIRED=true`): people sign in, every project belongs to one account, nothing goes to an AI service before the owner allows it, and each account has spending limits. A store build refuses a backend that is not in this mode ([components/account/AccountGate.tsx:24](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/account/AccountGate.tsx#L24 "<AccountsOff />")), so this is what the App Store app does.
- **The single-owner demo** (`AUTH_REQUIRED` unset): nobody signs in, everything belongs to one owner, the AI permission answers yes without asking ([convex/consent/gate.ts:72](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/consent/gate.ts#L72 "if (!accessEnforced()) return { ok: true, account: SOLO_ACCOUNT }")), and owner decisions are guarded by a shared passcode. This is the hackathon demo.

Where the two differ, this audit says so. Everything else holds in both.

## The short version

- **The iOS app talks to turtl's Convex backend** ([data/live/client.ts:18](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/data/live/client.ts#L18 "new ConvexReactClient")), and to three other places only when the owner asks: Expo, to get the phone's push token when the owner turns notifications on; Apple's own sheet for Sign in with Apple; and GitHub's pages, in a browser sheet, to sign in with GitHub or connect repositories. It has no analytics, advertising, crash-reporting or tracking library, and asks for two permissions, each after a tap: the microphone (Talk) and notifications (Turn on notifications).
- **The backend sends data to:** OpenAI, Supermemory and Capy (AI), GitHub, Revyl, Expo (push), Resend (the password reset email) and Apple (Sign in with Apple). Convex hosts the backend and stores everything turtl keeps. The backend also calls the owner's own live app. Keiki, and the council's Anthropic and Google models, are reached only in the single-owner demo.
- **Four kinds of content go to third-party AI:** the owner's source code, case text (which can include their customers' own words), what the owner writes (messages, notes, preferences), and the owner's voice.
- **In accounts mode the owner is asked first.** One screen names each AI service and what it receives, the backend refuses every call to a service the owner has not allowed, and the owner can take it back in Settings.
- **An account can be deleted from the app,** and with it its projects, cases, reports, the copies at Supermemory, turtl's GitHub access and the Apple sign-in token.
- **Accounts collect** an email address, a name and picture when Apple or GitHub passes one on, the id Apple or GitHub gives the person, and a password hash. Turning on notifications collects the phone's push token.

## Who the data is about

| Group | How their data reaches turtl |
| --- | --- |
| **Owners**: the people who install turtl | The app, their account, and the repositories and live app they connect |
| **Owners' customers**: people who use an owner's app | A report form inside the owner's app posts to turtl's public endpoint. They never install turtl and have no account |
| **The operator** | Deployment settings. In the single-owner demo also one GitHub token, one alert phone number and one watched app; accounts mode ignores those ([convex/demoSettings.ts:30](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/demoSettings.ts#L30 "export function demoOnly")) |

## What goes where

"Stored" means kept in turtl's Convex database or file storage. A dash means the code never sends that data there. Keiki is left out: it is used only in the demo (D12).

| Data | Convex (host) | OpenAI | Supermemory | GitHub | Capy | Revyl | Expo | Resend | Apple |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D1 Account | stored | - | - | sign-in | - | - | - | email address, for a reset | sign-in |
| D2 Owner passcode (demo) | hash stored | - | - | - | - | - | - | - | - |
| D3 Source code | map only, no code | excerpts | up to 30,000 characters of each file | read from | works in the repository through its own access | - | - | - | - |
| D4 Questions about the code | stored | sent | sent as a search | - | - | - | - | - | - |
| D5 Case text | stored | sent | sent | - | case title and change instructions | - | project name only | - | - |
| D6 Chat, notes and preferences | stored | sent | preferences | - | - | - | - | - | - |
| D7 Voice | not stored | audio sent | - | - | - | - | - | - | - |
| D8 Customers' reports | stored | text sent | text sent | - | indirectly (see D8) | - | - | - | - |
| D9 Screenshots of the owner's app | stored | - | - | - | - | made there | - | - | - |
| D10 Pull request details | stored | - | - | read and merged | thread id | - | - | - | - |
| D13 Push token | stored | - | - | - | - | - | sent | - | through Expo |
| D16 Control token, coding agent key | encrypted | - | - | - | the key, to Capy | - | - | - | - |

## Each kind of data

### D1. Account

Accounts mode only. The demo has no sign-in and files everything under one constant ([convex/access.ts:29](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/access.ts#L29 "export const SOLO_ACCOUNT =")).

- **What:** an email address; a name and a picture when Apple or GitHub passes one on; which ways the person signs in, with Apple's or GitHub's id for them; a Scrypt hash of a password; sessions ([convex/auth/schema.ts:8](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/auth/schema.ts#L8 "What they hold about a person"), [convex/auth/password.ts:11](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/auth/password.ts#L11 "import { Scrypt } from")). Apple's email and name come in its token, the name only on the first sign-in ([convex/auth/apple.ts:17](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/auth/apple.ts#L17 "Apple's own name and email for the person come in the token")).
- **Sign in with Apple:** the backend checks Apple's token against Apple's published keys ([convex/auth/settings.ts:38](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/auth/settings.ts#L38 "https://appleid.apple.com/auth/keys")), and trades Apple's one-time code for a refresh token, which it keeps only to revoke it when the account is deleted ([convex/auth/appleTokens.ts:11](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/auth/appleTokens.ts#L11 "authorization code with the identity token"), table at [convex/auth/schema.ts:21](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/auth/schema.ts#L21 "authAppleTokens: defineTable")). Without the Apple key settings no token is kept ([convex/auth/settings.ts:52](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/auth/settings.ts#L52 "export function appleClient()")).
- **Sign in with GitHub:** through the same GitHub App that reaches repositories ([convex/auth.ts:27](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/auth.ts#L27 "GitHub({ allowDangerousEmailAccountLinking: false")). Accounts are never merged by email.
- **Password reset:** an 8-digit code emailed through Resend, only when `AUTH_RESEND_KEY` and `AUTH_EMAIL_FROM` are set ([convex/auth/settings.ts:61](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/auth/settings.ts#L61 "export function resetEmail()"), [[convex/auth/email.ts|body: JSON.stringify({ from: settings.from, to: [to], subject, text })]]). The email holds the code and fixed words ([convex/auth/email.ts:28](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/auth/email.ts#L28 "export function resetMessage")). Codes are stored only as hashes.
- **On the phone:** the session is kept in the iOS Keychain ([data/account/storage.ts:14](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/data/account/storage.ts#L14 "keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY")).
- **Kept:** until the account is deleted (see "How long turtl keeps things").

### D2. Owner passcode

- **Demo only.** With accounts on, owner decisions are authorised by being the owner, and setting a passcode is refused ([convex/ownerPasscode.ts:57](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/ownerPasscode.ts#L57 "if (accessEnforced()) throw new ConvexError(PASSCODE_REPLACED)")).
- **Device:** the passcode itself is kept in the iOS Keychain through expo-secure-store ([data/live/ownerPasscode.ts:21](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/data/live/ownerPasscode.ts#L21 "SecureStore.setItemAsync")), or in the browser's local storage on web ([data/live/ownerPasscode.ts:19](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/data/live/ownerPasscode.ts#L19 "localStorage.setItem")).
- **Backend:** only a hash is stored ([convex/schema.ts:46](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/schema.ts#L46 "ownerPasscodeConfig")). **Sent outside:** never.

### D3. Source code

- **What:** the contents of a repository the owner connects.
- **Collected:** in accounts mode, only through turtl's GitHub App, and only for a repository the project's owner connected to turtl ([convex/github/access.ts:27](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/github/access.ts#L27 "is not one of the repositories this project's owner connected to turtl")); the demo's deployment-wide `GITHUB_TOKEN` reads as unset ([convex/prTracking/github.ts:27](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/prTracking/github.ts#L27 "export const githubToken = () => demoOnly(process.env.GITHUB_TOKEN)")). The code map reads up to 200 source files of at most 200 kB each ([convex/codeNetwork/build.ts:23](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/codeNetwork/build.ts#L23 "const MAX_FILES = 200"), [convex/codeNetwork/build.ts:24](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/codeNetwork/build.ts#L24 "const MAX_FILE_BYTES = 200_000")). Adding a project reads up to 400 files to see what the app already has ([convex/onboarding/github.ts:5](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/onboarding/github.ts#L5 "const MAX_FILES = 400")).
- **Sent to OpenAI:** for the code map, an excerpt of each file of up to 2,500 characters within a 240,000 character budget ([convex/codeNetwork/build.ts:26](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/codeNetwork/build.ts#L26 "const DIGEST_BUDGET = 240_000"), [convex/codeNetwork/build.ts:27](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/codeNetwork/build.ts#L27 "const EXCERPT_CHARS = 2500")); when a project is added, excerpts of up to 6,000 characters within a 150,000 character budget ([convex/onboarding/inspect.ts:29](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/onboarding/inspect.ts#L29 "const EXCERPT_CHARS = 6000"), [convex/onboarding/inspect.ts:30](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/onboarding/inspect.ts#L30 "const EXCERPT_BUDGET = 150_000"), [convex/onboarding/inspect.ts:216](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/onboarding/inspect.ts#L216 "const { text } = await respond(gate, {")). Both go through the Responses API with `store: false` ([convex/codeNetwork/openai.ts:43](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/codeNetwork/openai.ts#L43 "store: false,")).
- **Sent to Supermemory:** the first 30,000 characters of every file, as searchable documents in a namespace per project ([convex/codeNetwork/build.ts:28](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/codeNetwork/build.ts#L28 "const DOCUMENT_CHARS = 30_000"), [convex/codeNetwork/build.ts:270](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/codeNetwork/build.ts#L270 "const added = await addDocuments(gate, namespace, documents)")).
- **Capy:** works in the repository through its own GitHub connection when the owner approves a code change or the preparation of a new project (D5).
- **Stored by turtl:** only the map (part names, plain summaries, file paths) and, for a new project, a readiness summary with file paths. No code ([convex/codeNetwork/schema.ts:67](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/codeNetwork/schema.ts#L67 "codeNetworks: defineTable"), [convex/onboarding/schema.ts:42](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/onboarding/schema.ts#L42 "onboardingInspections: defineTable")).
- **Kept:** the map is replaced when it is rebuilt. Everything here, and the copies at Supermemory, goes when the account is deleted.

### D4. Questions about the code

- **What:** what the owner types into "Ask about your code" and turtl's answers, stored ([convex/codeNetwork/schema.ts:79](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/codeNetwork/schema.ts#L79 "codeChatMessages: defineTable")).
- **Sent to Supermemory** as a search over the stored code, and **to OpenAI** with the excerpts found, the map, and the last six turns ([convex/codeNetwork/ask.ts:15](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/codeNetwork/ask.ts#L15 "const HISTORY_TURNS = 6")).
- **Switch:** off unless the deployment sets `CODE_NETWORK_CHAT_ENABLED` ([convex/codeNetwork/ask.ts:98](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/codeNetwork/ask.ts#L98 "CODE_NETWORK_CHAT_ENABLED")).

### D5. Case text

- **What:** a case's title and impact, the facts and evidence turtl gathered from the owner's app, the cause it worked out, the fixes it proposed, and what the owner decided ([convex/schema.ts:60](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/schema.ts#L60 "cases: defineTable"), [convex/schema.ts:143](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/schema.ts#L143 "evidence: defineTable"), [convex/schema.ts:147](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/schema.ts#L147 "proposals: defineTable")).
- **Sent to OpenAI:** the facts, evidence and past cases for the diagnosis ([convex/diagnosis.ts:76](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/diagnosis.ts#L76 "const answer = await callModel(gate, {"), [convex/routing/models.ts:78](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/routing/models.ts#L78 "api.openai.com/v1/chat/completions")), and the case, diagnosis and evidence for the fix options ([convex/fixOptions.ts:207](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/fixOptions.ts#L207 "api.openai.com/v1/chat/completions")) and for a broader cause across related cases ([convex/structural/examine.ts:48](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/structural/examine.ts#L48 "api.openai.com/v1/chat/completions")).
- **Sent to Anthropic and Google, in the demo only:** when the careful diagnosis is unsure, the council can ask `claude-sonnet-4-5` and `gemini-2.5-pro` too, if their keys are set ([convex/council/settings.ts:17](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/council/settings.ts#L17 "claude-sonnet-4-5"), [convex/routing/models.ts:50](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/routing/models.ts#L50 "https://api.anthropic.com/v1/messages"), [convex/routing/models.ts:61](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/routing/models.ts#L61 "generativelanguage.googleapis.com")). In accounts mode the permission refuses them, because the list does not name them ([convex/consent/services.ts:73](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/consent/services.ts#L73 "nothing reaches them until data-practices.json lists them")).
- **Sent to Supermemory:** a recovery memory and a case note, in a namespace per project, searched when a new case opens ([convex/memory/service.ts:69](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/memory/service.ts#L69 "const response: unknown = await addMemory("), [convex/memory/service.ts:366](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/memory/service.ts#L366 "await addMemory(gate, `app_${row.appId}`, note, {")).
- **Sent to Capy:** when the owner approves a code change, the case title, the fix title, the instructions for the change, and the repository's name ([convex/prTracking/execute.ts:60](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/prTracking/execute.ts#L60 "const started = await startCapyThread("), [convex/prTracking/capy.ts:125](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/prTracking/capy.ts#L125 "const created = await capy<{ id: string }>(opened.fetch, config.apiKey,")). When the owner approves preparing a new project, a brief: the project's name, repository, folders, live address, what turtl found missing, and what the owner said must never break ([convex/onboarding/prepare.ts:50](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/onboarding/prepare.ts#L50 "const { title, message } = preparationBrief({")). In accounts mode this goes with the owner's own Capy key, never the deployment's ([convex/prTracking/codingAgent.ts:11](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/prTracking/codingAgent.ts#L11 "With accounts on: the project owner's own Capy key")).
- **Sent to Expo:** a push carries the project's name and one fixed sentence, never the case's words ([convex/push/message.ts:17](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/push/message.ts#L17 "export const PUSH_BODIES")).

### D6. Chat, notes and preferences

- **What:** what the owner types in "Investigate further" and turtl's replies ([convex/schema.ts:183](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/schema.ts#L183 "fixChatMessages: defineTable")); a note the owner leaves when deciding on a fix; and preferences the owner states for a project ([convex/schema.ts:167](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/schema.ts#L167 "ownerPreferences: defineTable")).
- **Sent to OpenAI:** the message with the recent conversation and the case's context ([convex/fixes.ts:348](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/fixes.ts#L348 "conversation: context.history")); a decision's note, to suggest a preference from it ([convex/learning/model.ts:55](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/learning/model.ts#L55 "{ decision, note },")); the project's preferences, when fixes are proposed ([convex/fixOptions.ts:257](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/fixOptions.ts#L257 "an object from preference ref to")).
- **Sent to Supermemory:** each preference, to find the ones that apply to a new case ([convex/learning/preferences.ts:189](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/learning/preferences.ts#L189 "Owner preference (Convex ownerPreferences")).

### D7. Voice

- **What:** a recording of up to 30 seconds and 1 MB, made after the owner taps Talk ([convex/voice/rules.ts:3](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/voice/rules.ts#L3 "MAX_CLIP_MS = 30_000"), [convex/voice/rules.ts:4](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/voice/rules.ts#L4 "MAX_CLIP_BYTES")).
- **Permission:** iOS asks for the microphone the first time ([components/voice/useTalkSession.ts:1](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/voice/useTalkSession.ts#L1 "requestRecordingPermissionsAsync")), with words that say the recording goes to OpenAI ([app.config.ts:16](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app.config.ts#L16 "Your recording is sent to OpenAI to be turned into text, and is not kept.")).
- **Device:** the recording's file is deleted as soon as it is read ([components/voice/clip.ts:17](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/voice/clip.ts#L17 "file.delete()")); the spoken reply plays from a temporary file that is deleted after it plays ([components/voice/clip.ts:32](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/voice/clip.ts#L32 "turtl-reply-")).
- **Sent:** as bytes to the backend ([convex/voice/turn.ts:109](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/voice/turn.ts#L109 "audio: v.bytes()")), which passes them to OpenAI to be transcribed, with the app's name and the case title as a hint ([convex/voice/turn.ts:130](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/voice/turn.ts#L130 "transcribe(gate, audio, mimeType")). turtl's reply text goes to OpenAI to be spoken ([convex/voice/turn.ts:154](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/voice/turn.ts#L154 "speak(gate, spokenText(reply))")).
- **Stored by turtl:** no audio ([convex/voice/schema.ts:5](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/voice/schema.ts#L5 "No audio and no transcript is kept here")). The transcript becomes a chat message, as in D6.
- **Switch:** off unless the deployment sets `VOICE_ENABLED` ([convex/voice/rules.ts:26](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/voice/rules.ts#L26 "VOICE_ENABLED")).

### D8. Customers' reports

These people are not turtl's users. They use an owner's app.

- **What:** up to 2,000 characters a customer writes in a report form ([convex/intake/rules.ts:10](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/intake/rules.ts#L10 "export const MAX_TEXT = 2_000")) and a random id the form makes up to count one person once ([protected-app/report/ReportForm.tsx:24](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/protected-app/report/ReportForm.tsx#L24 "const randomId = () =>")). turtl's own form asks for no contact. The endpoint accepts an optional contact of up to 200 characters from other forms, turns it into a reference and drops it ([convex/intake/records.ts:65](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/intake/records.ts#L65 "The contact becomes this reference and is then dropped")); with `INTAKE_CONTACT_KEY` set the reference is a keyed hash ([convex/intake/rules.ts:91](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/intake/rules.ts#L91 "it is a keyed hash (HMAC-SHA-256)")).
- **Collected:** through a public endpoint that any origin may post to ([convex/intake/http.ts:10](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/intake/http.ts#L10 "Access-Control-Allow-Origin")). The code reads only the body ([convex/intake/http.ts:33](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/intake/http.ts#L33 "readSubmission(await request.text())")).
- **Sent to OpenAI:** the report's text, to decide whether it is a bug, a request, or noise ([convex/intake/triage.ts:60](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/intake/triage.ts#L60 "message: report.text,")), and again when the case is investigated and planned ([convex/intake/workflow.ts:91](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/intake/workflow.ts#L91 "const answer = await askJson(gateFor(ctx, { appId: input.case.appId },")).
- **Sent to Supermemory:** the report's text, as a document in a namespace per project, and as a search ([convex/intake/triage.ts:117](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/intake/triage.ts#L117 "content: report.text"), [convex/intake/triage.ts:27](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/intake/triage.ts#L27 "searchChunks(gate, reportsNamespace(appId)")).
- **Indirectly to Capy:** a model that read the reports writes a fix's change instructions, and those are what Capy receives if the owner approves (D5).
- **Deleted:** the owner can delete one report, which also deletes its copy at Supermemory ([convex/intake/records.ts:463](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/intake/records.ts#L463 "export const deleteReport = mutation({")); deleting the account deletes them all.
- **Who answers for it:** the owner decides to put the form in their app, so the owner must tell their customers. The form links to turtl's privacy policy ([protected-app/report/ReportForm.tsx:22](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/protected-app/report/ReportForm.tsx#L22 "export const POLICY_URL")).

### D9. Screenshots of the owner's app

- **What:** screenshots Revyl takes while it runs the owner's app on a cloud phone.
- **Sent to Revyl:** only the id of the test to run ([convex/revyl/api.ts:97](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/revyl/api.ts#L97 "workflow_id: config.workflowId")). In accounts mode only a check that names its own workflow runs; the demo's workflow reads as unset ([[convex/revyl/api.ts|const workflowId = check?.workflowId ?? demoOnly(process.env[BOOKING_WORKFLOW_VAR])]]).
- **Stored:** turtl downloads the screenshots and keeps them in Convex file storage ([convex/revyl/runs.ts:113](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/revyl/runs.ts#L113 "fetch(shot.url"), [convex/revyl/schema.ts:27](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/revyl/schema.ts#L27 "revylScreenshots: defineTable")).

### D10. Pull request details

- **What:** a pull request's repository, number, title, link, head commit, and the names and results of its checks.
- **From GitHub:** read with the credential `repositoryAccess` picks, a GitHub App installation token in accounts mode, every 30 seconds while one is open ([convex/crons.ts:11](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/crons.ts#L11 "refresh pull requests")). The owner's Merge tap merges it ([convex/prTracking/github.ts:143](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/prTracking/github.ts#L143 "/merge")).
- **From Capy:** the id of the thread writing the change, and its replies, read only to find the pull request's link ([convex/prTracking/capy.ts:158](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/prTracking/capy.ts#L158 "/messages")).

### D11. The owner's live app

- **What:** health, a test run of the key journeys, feature flags, recent error counts, and the deployed revision.
- **Accounts mode:** each project has its own live address, which must be https on a public name ([convex/protectedApp/address.ts:5](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/protectedApp/address.ts#L5 "A project's live address must be https, name a public host")), and its own control token, sent only to that address ([convex/protectedApp/watched.ts:13](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/protectedApp/watched.ts#L13 "only the project's own control token")). The monitor takes 25 projects a minute in turn ([convex/protectedApp/watching.ts:17](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/protectedApp/watching.ts#L17 "export const PROJECTS_PER_TICK = 25"), [convex/crons.ts:8](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/crons.ts#L8 "check registered journeys")).
- **Demo:** one watched app for the deployment, with the deployment's control secret ([convex/protectedApp/client.ts:8](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/protectedApp/client.ts#L8 "PROTECTED_APP_CONTROL_SECRET")).
- **Stored:** as the facts and evidence of a case (D5). Error counts are totals, not records of people.

### D12. Keiki and the alert phone number

- **Demo only.** Keiki texts the one phone number the deployment sets; with accounts on that number reads as unset and nothing is sent ([convex/keiki.ts:27](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/keiki.ts#L27 "const phone = demoOnly(process.env.KEIKI_OWNER_CONTACT)")). In the demo it receives a notice of up to 600 characters and the number ([convex/keiki.ts:14](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/keiki.ts#L14 "const MAX_TEXT_LENGTH = 600"), [convex/keiki.ts:41](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/keiki.ts#L41 "body: JSON.stringify({ text: text.slice(0, MAX_TEXT_LENGTH), phone })")).
- **Still on the permission screen.** Keiki is one of the four services the screen asks about ([convex/consent/services.ts:8](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/consent/services.ts#L8 "export type Outbound =")), though accounts mode never sends to it.
- **From the handoff note, not from code:** Keiki's agent rewords each notice with a Google Gemini model and delivers it by iMessage.

### D13. Push token and device identifiers

- **What:** the phone's Expo push token, which identifies a phone ([convex/push/schema.ts:29](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/push/schema.ts#L29 "pushTokens: defineTable({")). At most 10 live phones per account.
- **Collected:** only after the owner taps Turn on notifications and iOS asks ([components/push/PushNotifications.tsx:24](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/components/push/PushNotifications.tsx#L24 "Turn on notifications")). To get the token, the push library on the phone sends Expo the phone's Apple push token, an installation id it makes up, and the app's id (`expo-notifications`, `getExpoPushTokenAsync`; [data/push/device.native.ts:36](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/data/push/device.native.ts#L36 "token: async () => (await lib().getExpoPushTokenAsync()).data")). turtl does not store the installation id.
- **Sent to Expo:** each notification goes to Expo with the token, the project's name, one fixed sentence and the case's id; Expo hands it to Apple ([convex/push/expo.ts:11](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/push/expo.ts#L11 "https://exp.host/--/api/v2/push"), [convex/push/message.ts:49](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/push/message.ts#L49 "export function expoMessages")). Only two events send one: a case needs a decision, and a fix the owner allowed ran and passed.
- **Removed:** when the owner turns notifications off on that phone or signs out, and when the account is deleted ([convex/account/deletion.ts:103](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/account/deletion.ts#L103 "await ctx.scheduler.runAfter(0, internal.push.devices.removeAccount, { account })")).
- **No advertising identifier.** The id in a customer's report (D8) is a random value the form makes up.

### D14. Usage, diagnostics, and logs

- **None collected from the app.**
- The backend records one row for each AI call: which model, how long it took, and whether it failed ([convex/schema.ts:171](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/schema.ts#L171 "agentRuns: defineTable")); each account's estimated AI spend by month and code changes by day ([convex/spend/schema.ts:8](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/spend/schema.ts#L8 "modelSpend: defineTable({"), [convex/spend/schema.ts:17](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/spend/schema.ts#L17 "codingThreads: defineTable({")); and the outcome of each push ([convex/push/schema.ts:42](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/push/schema.ts#L42 "pushSends")). These describe turtl's own work.
- Vendor errors are reported by status code, never by the vendor's text, which can echo the request ([convex/supermemory.ts:40](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/supermemory.ts#L40 "Supermemory's errors carry its response body, which can echo what was sent")).

### D15. Things that stay on the device

- The session (D1) and, in the demo, the passcode (D2), in the iOS Keychain.
- The theme choice is held in memory and lost on restart ([[theme/index.tsx|setMode] = useState]]).
- Both fonts ship inside the app, so no request goes to Google ([app/_layout.tsx:8](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app/_layout.tsx#L8 "@expo-google-fonts/capriola"), [app/_layout.tsx:9](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app/_layout.tsx#L9 "@expo-google-fonts/righteous")).

### D16. What an owner entrusts to turtl

Accounts mode only.

- **What:** a project's control token, the secret its app's protected routes answer to, and the owner's own Capy key ([convex/secrets/schema.ts:12](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/secrets/schema.ts#L12 "secrets: defineTable")).
- **Kept:** encrypted with AES-GCM under `SECRETS_ENCRYPTION_KEY` ([convex/secrets/seal.ts:2](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/secrets/seal.ts#L2 "AES-GCM and the key in SECRETS_ENCRYPTION_KEY")). No function returns either one. Each is opened only in the action that sends it: the control token to the project's own live address (D11), the key to Capy (D5).

### D17. The AI permission and the limits

Accounts mode only.

- **What:** each answer the owner gives on the permission screen, with the services and the version of each that was on it, and when permission was taken back ([convex/consent/schema.ts:10](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/consent/schema.ts#L10 "aiConsents: defineTable({")).
- **How it is enforced:** every call to OpenAI, Supermemory, Capy and Keiki asks the gate first ([convex/consent/gate.ts:39](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/consent/gate.ts#L39 "export interface Gate")). A request that only deletes the owner's data at a vendor needs no permission ([convex/consent/gate.ts:33](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/consent/gate.ts#L33 "erase: a request that only deletes the owner's data at the vendor")).
- **Limits:** a monthly AI spend and a daily number of code changes per account, a daily spend and number of cases for each project's customer reports, and ceilings for the whole deployment ([convex/spend/limits.ts:34](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/spend/limits.ts#L34 "export const modelSpendLimitUsd")).

### D18. GitHub's records

- **What:** each GitHub App installation an owner connected, the GitHub account it is on, the repositories it covers, which turtl account may use it, cached installation tokens that last an hour, and a digest of each webhook delivery ([convex/github/schema.ts:17](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/github/schema.ts#L17 "githubInstallations"), [convex/github/schema.ts:33](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/github/schema.ts#L33 "githubInstallationTokens")). The person's GitHub user token is used for three reads during Connect GitHub and revoked; it is never stored.
- **Removed:** on Disconnect, and when the account is deleted, turtl's app is removed from every installation only that account uses ([convex/account/vendors.ts:20](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/account/vendors.ts#L20 "internal.github.connect.disconnectAccount uninstalls turtl's GitHub App")).

### D19. The booking demo

- The demo's own tables hold test bookings with a service, a date, and a time, and no personal fields ([convex/schema.ts:196](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/schema.ts#L196 "bookingDemoSettings")). They belong to the demo, not to the product. In accounts mode they open only on a backend that hosts the demo app (`PROTECTED_APP_CONTROL_SECRET_SHA256` set, [convex/access.ts:229](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/access.ts#L229 "export function hostsBookingDemo()")).

## Outside services

| Service | What it does for turtl | Where in the code | Setting that turns it on |
| --- | --- | --- | --- |
| **Convex** | Hosts the backend, database, and file storage | [data/live/client.ts:18](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/data/live/client.ts#L18 "new ConvexReactClient") | `EXPO_PUBLIC_CONVEX_URL` |
| **OpenAI** | Diagnosis, fix options, broader causes, chat, triage, naming the parts of the code, reading a new project, speech to text, text to speech | [convex/routing/models.ts:78](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/routing/models.ts#L78 "api.openai.com/v1/chat/completions"), [convex/codeNetwork/openai.ts:35](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/codeNetwork/openai.ts#L35 "https://api.openai.com/v1/responses"), [convex/voice/openai.ts:24](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/voice/openai.ts#L24 "https://api.openai.com/v1/") | `OPENAI_API_KEY` |
| **Supermemory** | Search over the code, past cases, preferences, and customers' reports | [convex/supermemory.ts:37](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/supermemory.ts#L37 "return new Supermemory({ apiKey, fetch: opened.fetch, baseUrl })") | `SUPERMEMORY_API_KEY` |
| **Capy** | Writes an approved code change or a new project's preparation, and opens the pull request | [convex/prTracking/capy.ts:13](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/prTracking/capy.ts#L13 "https://api.capy.ai/api/v1") | The owner's own key (accounts), `CAPY_API_KEY` (demo) |
| **GitHub** | Sign-in, reading the connected repositories, reading and merging pull requests | [convex/github/config.ts:30](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/github/config.ts#L30 "export const githubApiUrl"), [convex/github/api.ts:91](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/github/api.ts#L91 "/login/oauth/access_token") | `GITHUB_APP_ID` and the other GitHub App settings; `GITHUB_TOKEN` in the demo |
| **Revyl** | Runs the owner's app on a cloud phone to check a fix | [convex/revyl/api.ts:10](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/revyl/api.ts#L10 "backend.revyl.ai") | `REVYL_API_KEY` |
| **Expo** | Delivers push notifications, through Apple | [convex/push/expo.ts:11](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/push/expo.ts#L11 "https://exp.host/--/api/v2/push") | none: on by default; `EXPO_ACCESS_TOKEN` once Expo's enhanced security is on |
| **Resend** | Sends the password reset email | [convex/auth/settings.ts:66](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/auth/settings.ts#L66 "https://api.resend.com/emails") | `AUTH_RESEND_KEY`, `AUTH_EMAIL_FROM` |
| **Apple** | Sign in with Apple, and revoking it on deletion | [convex/auth/settings.ts:38](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/auth/settings.ts#L38 "https://appleid.apple.com") | `AUTH_APPLE_TEAM_ID`, `AUTH_APPLE_KEY_ID`, `AUTH_APPLE_PRIVATE_KEY` for the token |
| Keiki (demo only) | Texts the demo's owner when a case needs them | [convex/keiki.ts:13](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/keiki.ts#L13 "https://onkeiki.com") | `KEIKI_API_KEY`, `KEIKI_AGENT_ID`, `KEIKI_OWNER_CONTACT` |
| Anthropic, Google (demo only) | Second opinions in the council | [convex/routing/configs.ts:11](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/routing/configs.ts#L11 "ANTHROPIC_API_KEY") | `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` |
| The owner's own app | Health checks and the approved recovery action | [convex/protectedApp/client.ts:45](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/protectedApp/client.ts#L45 "PROTECTED_APP_URL") | The project's live address and control token |

**Looked for and not found:** analytics, advertising, attribution, crash reporting, a payment library, and over-the-air updates.

### What each vendor says about the data it receives

Read from each vendor's public pages on 15 November 2026. These are their statements, not something this audit verified. Expo, Resend and Apple were added after that reading and have not been read.

| Vendor | Trains on it? | Keeps it how long? | Source |
| --- | --- | --- | --- |
| OpenAI | No, unless the account opts in | Up to 30 days in abuse-monitoring logs for chat and speech requests. Nothing for transcription. turtl's Responses API calls set `store: false` | [Data controls in the OpenAI platform](https://developers.openai.com/api/docs/guides/your-data) |
| Supermemory | Not stated on the page read | For as long as the account exists, or until deleted | [Privacy Policy](https://supermemory.ai/privacy/) |
| Keiki | No | Until deleted or the account is closed | [Privacy Policy](https://onkeiki.com/privacy) |
| Capy | Not on non-public customer content, unless the customer opts in | As long as reasonably necessary; thread content until deleted | [Privacy Policy](https://capy.ai/privacy-policy) |
| Revyl | Not stated on the page read | No longer than the account exists | [Privacy Policy](https://revyl.com/privacy/) |
| GitHub | Not relevant: turtl reads from GitHub and sends it nothing new except the merge | - | [GitHub General Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) |
| Convex | Not read: the page needs a browser to render | Not read | [Privacy Policy](https://www.convex.dev/legal/privacy) |
| Expo, Resend, Apple | Not read | Not read | [Expo](https://expo.dev/privacy), [Resend](https://resend.com/legal/privacy-policy), [Apple](https://www.apple.com/legal/privacy/) |

Apple asks that every third party gives "the same or equal protection" as the app's own policy. A data processing agreement with each vendor is what backs that sentence up. None is on file.

## How long turtl keeps things, as coded

| What | Kept until |
| --- | --- |
| The account, its projects, cases, evidence, proposals, decisions, chat, code questions, preferences, reports, screenshots | The account is deleted. There is no way in the app to delete a single project, case or conversation |
| One customer report | The owner deletes it, or the account |
| The map of the code | Replaced on rebuild; deleted with the account |
| Everything in Supermemory | Each namespace of the account's projects is deleted whole with the account ([convex/account/vendors.ts:18](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/account/vendors.ts#L18 "each namespace the account's projects wrote to is deleted whole")); one report's copy when the owner deletes it |
| Push tokens | Notifications turned off on that phone, sign-out, or the account deleted |
| Apple's refresh token | Revoked at Apple and deleted with the account |
| Voice recordings | Not kept by turtl at all |
| Rate-limit counters | Pruned when a new window opens |
| The record of a deletion | Kept, with only a SHA-256 of the account id, when it ran, counts, and which vendors confirmed |

**Deleting an account** ([convex/account/deletion.ts:82](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/account/deletion.ts#L82 "export const request = mutation({")): at once, every session ends, the ways to sign in are removed, the AI permission is taken back and the phones are removed. Then the job stops everything running for the account, waits 11 minutes so nothing in flight can write ([convex/account/deletion.ts:40](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/account/deletion.ts#L40 "export const SETTLE_MS = 11 * 60_000")), asks Supermemory, GitHub and Apple to delete, and removes every row from the registry ([convex/account/registry.ts:146](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/account/registry.ts#L146 "(appId) => `prefs_${appId}`")). A vendor that fails is asked again later without holding up the rest, and a stalled run is restarted by a cron ([convex/crons.ts:20](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/crons.ts#L20 "resume account deletions")). `tests/account-deletion.test.mjs` fails for a table the registry does not remove.

## What this means for App Review

Each item is a line in the [review checklist](review-checklist.md), where it has an owner and a way to check it.

1. **The privacy manifest says turtl collects nothing.** `NSPrivacyCollectedDataTypes` is empty ([app.json:19](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app.json#L19 "NSPrivacyCollectedDataTypes")), while accounts collect an email address, a name and a user id, and push collects a device id. It should match the App Privacy answers. (RC-34)
2. **Keiki is on the permission screen but accounts mode never sends to it** (D12). The screen asks about a service the App Store app does not use.
3. **The permission screen says turtl "needs" Convex, GitHub, Revyl, Expo, Resend and Apple "to run at all"** ([app/ai-permission.tsx:94](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/app/ai-permission.tsx#L94 "to run at all, so it does not ask about them")). Expo, Resend, Apple and Revyl are each used only when the owner turns on notifications, resets a password, signs in with Apple, or has a check that runs on a Revyl phone. The sentence is in the app's code.
4. **Source code and customers' words are sent whole.** Nothing strips secrets, emails, or names before text goes to OpenAI or Supermemory. (RC-22)
5. **No data processing agreement is on file** with any vendor. (RC-28)
6. **Apple and Supermemory deletion, push, and the GitHub App are proven only against stand-ins.** None has run against the real service. (RC-23, RC-27)
7. **Developer tools are compiled into the app** and shown only in a development build, with Expo's development mode or `EXPO_PUBLIC_DEV_TOOLS` set to `1` ([data/source.ts:12](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/data/source.ts#L12 "export function allowsDevTools")). A store backend must not set `DEV_TOOLS_ENABLED`; with accounts on the backend refuses it anyway ([convex/access.ts:217](https://github.com/ronoktanvir/turtl/blob/2f99bfebc3a7eae0379704a36a19dcbf687526fa/convex/access.ts#L217 "export function devToolsEnabled()")). (RC-04)
