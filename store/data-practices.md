# What turtl does with data: an audit from the code

**Audited commit:** `3d01f64` on `main` (15 November 2026). **Scope:** `app/`, `components/`, `data/`, `theme/`, `convex/`, `protected-app/`, `package.json`, `app.json`, `app.config.ts`.

This describes what the code at that commit does, not what the product is meant to do. Every claim links to the line that proves it, pinned to the audited commit so the link never drifts. Hover a link to see the text that line must contain; `node store/check.mjs` checks every one, and lists the referenced files that changed since the audit.

The machine-readable list of outside services is [`data-practices.json`](data-practices.json). The consent screen, the privacy policy, and the App Privacy answers should all be built from it.

## How the audit was done

1. Listed every outbound call: each `fetch(`, each SDK client, each `process.env` name, and each `https://` literal in the scope above.
2. Read each call site to see which fields go into the request and what is kept from the answer.
3. Read `convex/schema.ts` and each module's tables for what is stored, and every `ctx.db.delete` and `ctx.storage.delete` for what is ever removed.
4. Read each vendor's public policy on 15 November 2026 for what happens on their side.

**Not covered:** which switches are turned on in the hosted deployment (it is off limits to this crew), and anything a vendor does beyond its published policy. Two facts come from a handoff note and not from code, and are marked where they appear.

## The short version

- **The iOS app talks to one place, turtl's Convex backend** ([data/live/client.ts:7](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/data/live/client.ts#L7 "new ConvexReactClient")). It has no analytics, advertising, crash-reporting, or tracking library ([package.json:13](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/package.json#L13 "dependencies") to [package.json:34](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/package.json#L34 "supermemory")), and asks for one permission, the microphone ([app.config.ts:10](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/app.config.ts#L10 "microphonePermission")).
- **The backend sends data to six outside services:** OpenAI, Supermemory, GitHub, Capy, Revyl, and Keiki. Convex hosts the backend and stores everything turtl keeps. The backend also calls the owner's own live app.
- **Three kinds of content go to third-party AI:** the owner's source code, case text (which can include their customers' own words), and the owner's voice.
- **Nobody is asked first.** No screen names these services or asks permission before data goes to them. This is the gap Apple's guideline 5.1.2(i) is about.
- **Nothing is deleted on a schedule and nothing can be deleted from the app.** The only deletes are developer resets and housekeeping.
- **There are no accounts yet,** so turtl collects no email address, name, or user id today. Every owner action is recorded as one constant identity ([convex/decisions.ts:10](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/decisions.ts#L10 "SOLO_OWNER")), and all four buttons on the Login screen go straight into the app ([app/index.tsx:11](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/app/index.tsx#L11 "router.replace")).

## Who the data is about

| Group | How their data reaches turtl |
| --- | --- |
| **Owners**: the people who install turtl | The app, and the repository and live app they connect |
| **Owners' customers**: people who use an owner's app | A report form inside the owner's app posts to turtl's public endpoint. They never install turtl and have no account |
| **The operator** (Ronok today) | Deployment settings: one GitHub token, one alert phone number, one watched app |

## What goes where

"Stored" means kept in turtl's Convex database or file storage. A dash means the code never sends that data there.

| Data | Convex (host) | OpenAI | Supermemory | GitHub | Capy | Revyl | Keiki |
| --- | --- | --- | --- | --- | --- | --- | --- |
| D1 Account identifiers | none today | - | - | - | - | - | - |
| D2 Owner passcode | hash stored | - | - | - | - | - | - |
| D3 Source code | map only, no code | excerpts | up to 30,000 characters of each file | read from | works in the repository through its own access | - | - |
| D4 Questions about the code | stored | sent | sent as a search | - | - | - | - |
| D5 Case text | stored | sent | sent | - | case title and change instructions | - | one or two sentences |
| D6 Chat about a case | stored | sent | - | - | - | - | - |
| D7 Voice | not stored | audio sent | - | - | - | - | - |
| D8 Customers' reports | stored | text sent | text sent | - | indirectly (see D8) | - | never the customer's words |
| D8 Customers' contact details | stored as written | - | - | - | - | - | - |
| D9 Screenshots of the owner's app | stored | - | - | - | - | made there | - |
| D10 Pull request details | stored | - | - | read and merged | thread id | - | - |
| D12 Alert phone number | deployment setting | - | - | - | - | - | sent with every alert |

## Each kind of data

### D1. Account identifiers

- **Today:** none. There is no sign-in, so no email, name, Apple id, or GitHub id is collected. Owner actions are attributed to a constant ([convex/decisions.ts:10](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/decisions.ts#L10 "SOLO_OWNER")), which is also written as the owner of a registered app ([convex/protectedApp/registry.ts:24](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/protectedApp/registry.ts#L24 "ownerId: SOLO_OWNER.identity")).
- **Changes when:** the accounts work lands (see "In flight").

### D2. Owner passcode

- **What:** a passcode the owner sets in the gear sheet to protect decisions.
- **Device:** the passcode itself is kept in the iOS Keychain through expo-secure-store ([data/live/ownerPasscode.ts:21](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/data/live/ownerPasscode.ts#L21 "SecureStore.setItemAsync")), or in the browser's local storage on web ([data/live/ownerPasscode.ts:19](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/data/live/ownerPasscode.ts#L19 "localStorage.setItem")).
- **Backend:** only a SHA-256 hash is stored ([convex/ownerPasscode.ts:46](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/ownerPasscode.ts#L46 "passcodeDigest"), table at [convex/schema.ts:34](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/schema.ts#L34 "ownerPasscodeConfig")). The passcode travels to the backend with each protected action, for example a merge ([convex/pullRequests.ts:115](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/pullRequests.ts#L115 "ownerPasscode.authorize")).
- **Sent outside:** never.
- **Kept:** until changed. One passcode covers the whole deployment, not one account.

### D3. Source code

- **What:** the contents of the repository an owner connects.
- **Collected:** the backend reads it from GitHub with the deployment's token ([convex/codeNetwork/build.ts:195](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/build.ts#L195 "fetchRepository"), [convex/codeNetwork/build.ts:91](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/build.ts#L91 "api.github.com"), [convex/codeNetwork/build.ts:127](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/build.ts#L127 "raw.githubusercontent.com")): up to 200 source files of at most 200 kB each ([convex/codeNetwork/build.ts:19](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/build.ts#L19 "MAX_FILES = 200"), [convex/codeNetwork/build.ts:20](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/build.ts#L20 "MAX_FILE_BYTES")).
- **Sent to OpenAI:** an excerpt of each file, up to 2,500 characters, within a 240,000 character budget, to name the parts of the app in plain words ([convex/codeNetwork/build.ts:22](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/build.ts#L22 "DIGEST_BUDGET"), [convex/codeNetwork/build.ts:23](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/build.ts#L23 "EXCERPT_CHARS"), [convex/codeNetwork/build.ts:160](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/build.ts#L160 "input: digest(files, nodes, edges)"), [convex/codeNetwork/openai.ts:21](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/openai.ts#L21 "api.openai.com/v1/responses")).
- **Sent to Supermemory:** the first 30,000 characters of every file, as searchable documents in a namespace per project ([convex/codeNetwork/build.ts:24](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/build.ts#L24 "DOCUMENT_CHARS"), [convex/codeNetwork/build.ts:247](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/build.ts#L247 "slice(0, DOCUMENT_CHARS)"), [convex/codeNetwork/build.ts:255](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/build.ts#L255 "addDocuments(namespace, documents)"), [convex/supermemory.ts:62](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/supermemory.ts#L62 "documents.batchAdd"), namespace at [convex/codeNetwork/schema.ts:63](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/schema.ts#L63 "code_")).
- **Stored by turtl:** only the map: part names, plain summaries, and file paths. No code ([convex/codeNetwork/build.ts:258](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/build.ts#L258 "codeNetwork.network.store"), [convex/codeNetwork/schema.ts:67](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/schema.ts#L67 "codeNetworks: defineTable")).
- **Why:** so an owner who cannot read code can see how their app fits together and ask questions about it.
- **Kept:** the map is replaced when it is rebuilt ([convex/codeNetwork/network.ts:101](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/network.ts#L101 "ctx.db.delete")). **The copies in Supermemory are never deleted by any code.** OpenAI keeps the request under its own terms (see "Outside services").

### D4. Questions about the code

- **What:** what the owner types into "Questions about the codebase?" and turtl's answers.
- **Stored:** both sides of the conversation ([convex/codeNetwork/ask.ts:116](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/ask.ts#L116 "codeNetwork.network.addMessage"), [convex/codeNetwork/schema.ts:79](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/schema.ts#L79 "codeChatMessages: defineTable")).
- **Sent to Supermemory:** the question, as a search over the stored code ([convex/codeNetwork/ask.ts:123](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/ask.ts#L123 "searchChunks(network.namespace, text")).
- **Sent to OpenAI:** the question, the code excerpts the search found, the map, and the last six turns ([convex/codeNetwork/ask.ts:130](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/ask.ts#L130 "await respond("), [convex/codeNetwork/ask.ts:13](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/ask.ts#L13 "HISTORY_TURNS = 6")).
- **Switch:** off unless the deployment sets `CODE_NETWORK_CHAT_ENABLED` ([convex/codeNetwork/ask.ts:95](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/ask.ts#L95 "CODE_NETWORK_CHAT_ENABLED")).
- **Kept:** no code deletes these messages.

### D5. Case text

- **What:** a case's title and impact, the facts and evidence turtl gathered from the owner's app, the cause it worked out, the fixes it proposed, and what the owner decided.
- **Stored:** in the case tables ([convex/schema.ts:45](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/schema.ts#L45 "cases: defineTable"), [convex/schema.ts:114](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/schema.ts#L114 "evidence: defineTable"), [convex/schema.ts:118](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/schema.ts#L118 "proposals: defineTable"), [convex/schema.ts:122](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/schema.ts#L122 "actions: defineTable"), [convex/schema.ts:129](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/schema.ts#L129 "verifications: defineTable")).
- **Sent to OpenAI:** facts and evidence for the diagnosis ([convex/diagnosis.ts:68](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/diagnosis.ts#L68 "api.openai.com/v1/chat/completions"), [convex/diagnosis.ts:88](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/diagnosis.ts#L88 "{ facts, evidence, pastCases }")), and the app's name, the case, facts, diagnosis, and evidence for the fix options ([convex/fixOptions.ts:238](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/fixOptions.ts#L238 "await askJson("), [convex/fixOptions.ts:245](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/fixOptions.ts#L245 "evidence: input.evidence.map"), [convex/fixOptions.ts:166](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/fixOptions.ts#L166 "api.openai.com/v1/chat/completions")).
- **Sent to Supermemory:** a recovery memory and a case note, in a namespace per app, and searched when a new case opens ([convex/memory/service.ts:65](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/memory/service.ts#L65 "await addMemory("), [convex/memory/service.ts:66](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/memory/service.ts#L66 "app_"), [convex/memory/service.ts:354](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/memory/service.ts#L354 "await addMemory("), [convex/memory/service.ts:154](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/memory/service.ts#L154 "await searchMemories("), [convex/memory/service.ts:431](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/memory/service.ts#L431 "searchChunks(")).
- **Sent to Capy:** when the owner approves a code change, the case title, the fix title, the instructions for the change, and the repository's name ([convex/prTracking/execute.ts:55](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/prTracking/execute.ts#L55 "startCapyThread(capy"), [convex/prTracking/execute.ts:60](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/prTracking/execute.ts#L60 "needs a code change"), [convex/prTracking/capy.ts:63](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/prTracking/capy.ts#L63 "/threads")). Capy then works in the repository through its own GitHub access.
- **Sent to Keiki:** a notice of one or two sentences, cut at 600 characters ([convex/notices.ts:54](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/notices.ts#L54 "sendOwnerNotice(text)"), [convex/keiki.ts:12](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/keiki.ts#L12 "MAX_TEXT_LENGTH = 600"), [convex/keiki.ts:34](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/keiki.ts#L34 "body: JSON.stringify({ text")). The four notices carry the app's name and the case title ([convex/monitor.ts:110](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/monitor.ts#L110 "Something is wrong with")), the recommended fix's title ([convex/runner/run.ts:87](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/runner/run.ts#L87 "turtl needs your decision on")), or what turtl did under a standing permission ([convex/permissions.ts:238](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/permissions.ts#L238 "turtl handled")).
- **Kept:** no code deletes cases outside the developer resets.

### D6. Chat about a case

- **What:** what the owner types in "Investigate further" and turtl's replies.
- **Stored:** every message ([convex/fixes.ts:262](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/fixes.ts#L262 "fixes.addMessage"), [convex/schema.ts:150](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/schema.ts#L150 "fixChatMessages: defineTable")).
- **Sent to OpenAI:** the message, the recent conversation, and the case's context ([convex/fixes.ts:274](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/fixes.ts#L274 "await askJson("), [convex/fixes.ts:293](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/fixes.ts#L293 "conversation: context.history")).
- **Kept:** no code deletes these messages outside the developer resets.

### D7. Voice

- **What:** a recording of up to 30 seconds and 1 MB, made after the owner taps Talk ([convex/voice/rules.ts:3](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/voice/rules.ts#L3 "MAX_CLIP_MS = 30_000"), [convex/voice/rules.ts:4](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/voice/rules.ts#L4 "MAX_CLIP_BYTES")).
- **Permission:** iOS asks for the microphone the first time ([components/voice/useTalkSession.ts:142](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/components/voice/useTalkSession.ts#L142 "requestRecordingPermissionsAsync")). The words iOS shows are in [app.config.ts:10](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/app.config.ts#L10 "microphonePermission").
- **Device:** the recording is read into memory and its file is deleted at once ([components/voice/clip.ts:17](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/components/voice/clip.ts#L17 "file.delete()")). The spoken reply is played from a temporary file that is deleted after it plays ([components/voice/clip.ts:32](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/components/voice/clip.ts#L32 "turtl-reply-"), [components/voice/clip.ts:35](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/components/voice/clip.ts#L35 "file.delete()")).
- **Sent:** as bytes to the backend ([data/live/voice.ts:15](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/data/live/voice.ts#L15 "api.voice.turn.talk"), [convex/voice/turn.ts:106](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/voice/turn.ts#L106 "audio: v.bytes()")), which passes them to OpenAI to be transcribed, with the app's name and the case title as a hint ([convex/voice/turn.ts:122](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/voice/turn.ts#L122 "transcribe(audio, mimeType"), [convex/voice/openai.ts:48](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/voice/openai.ts#L48 "audio/transcriptions")). turtl's reply text goes to OpenAI to be spoken ([convex/voice/turn.ts:146](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/voice/turn.ts#L146 "speak(spokenText(reply))"), [convex/voice/openai.ts:59](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/voice/openai.ts#L59 "audio/speech")).
- **Stored by turtl:** no audio ([convex/voice/schema.ts:5](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/voice/schema.ts#L5 "No audio and no transcript is kept here")). The transcript becomes a chat message, as in D6 ([convex/voice/turn.ts:139](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/voice/turn.ts#L139 "text: transcript"), [convex/voice/turn.ts:142](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/voice/turn.ts#L142 "api.fixes.investigate")). One row per turn records when it started, how it ended, and any error ([convex/voice/schema.ts:7](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/voice/schema.ts#L7 "voiceTurns: defineTable"), [convex/voice/turn.ts:70](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/voice/turn.ts#L70 "ctx.db.insert(")).
- **Switch:** off unless the deployment sets `VOICE_ENABLED` ([convex/voice/rules.ts:27](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/voice/rules.ts#L27 "VOICE_ENABLED")).
- **Gap:** the words iOS shows say recordings "are transcribed and not kept". That is true of turtl, and OpenAI's published table lists no retention for transcription, but the words do not say the recording goes to OpenAI.

### D8. Customers' reports

These people are not turtl's users. They use an owner's app.

- **What:** up to 2,000 characters a customer writes in a report form, an optional contact of up to 200 characters, and an anonymous random id the form makes up to count one person once ([convex/intake/rules.ts:10](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/intake/rules.ts#L10 "MAX_TEXT = 2_000"), [convex/intake/rules.ts:12](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/intake/rules.ts#L12 "MAX_CONTACT = 200"), [protected-app/report/ReportForm.tsx:24](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/protected-app/report/ReportForm.tsx#L24 "randomId"), [protected-app/report/ReportForm.tsx:112](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/protected-app/report/ReportForm.tsx#L112 "Email, optional")).
- **Collected:** through a public endpoint that any origin may post to ([convex/intake/http.ts:26](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/intake/http.ts#L26 "path: INTAKE_PATH"), [convex/intake/http.ts:10](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/intake/http.ts#L10 "Access-Control-Allow-Origin")). The code reads only the body, not the sender's address ([convex/intake/http.ts:33](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/intake/http.ts#L33 "request.text()")).
- **Stored:** the text as written ([convex/intake/records.ts:103](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/intake/records.ts#L103 "text: args.text")), a reference that is a hash of the contact or the anonymous id ([convex/intake/records.ts:55](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/intake/records.ts#L55 "form:contact:"), [convex/intake/records.ts:57](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/intake/records.ts#L57 "form:device:")), and **the contact itself, unencrypted** ([convex/intake/records.ts:114](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/intake/records.ts#L114 "contact: args.contact"), [convex/intake/schema.ts:29](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/intake/schema.ts#L29 "contact: v.optional(v.string())")).
- **Sent to OpenAI:** the report's text, with up to three earlier reports from each open case, to decide whether it is a bug, a request, or noise ([convex/intake/triage.ts:53](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/intake/triage.ts#L53 "askJson(TRIAGE_PROMPT"), [convex/intake/triage.ts:56](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/intake/triage.ts#L56 "message: report.text"), [convex/intake/triage.ts:62](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/intake/triage.ts#L62 "sampleReports: c.texts")), and again when the case is investigated and planned ([convex/intake/workflow.ts:88](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/intake/workflow.ts#L88 "await askJson(system, user)"), [convex/intake/workflow.ts:107](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/intake/workflow.ts#L107 "r.text.slice(0, 600)")).
- **Sent to Supermemory:** the report's text, as a document in a namespace per app, and as a search ([convex/intake/triage.ts:112](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/intake/triage.ts#L112 "addDocuments(reportsNamespace"), [convex/intake/triage.ts:113](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/intake/triage.ts#L113 "content: report.text"), [convex/intake/triage.ts:26](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/intake/triage.ts#L26 "searchChunks(reportsNamespace"), [convex/intake/triage.ts:16](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/intake/triage.ts#L16 "reports_")).
- **Not sent:** the contact goes to no outside service ([convex/intake/schema.ts:23](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/intake/schema.ts#L23 "Contact details stay here, never in a prompt")). The alert to the owner names the app and never quotes the customer ([convex/intake/records.ts:306](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/intake/records.ts#L306 "A customer reported a problem with")).
- **Indirectly to Capy:** a model that read the reports writes a fix's change instructions, and those are what Capy receives if the owner approves (D5).
- **Kept:** reports are never deleted. Only the rate-limit counters are pruned ([convex/intake/records.ts:95](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/intake/records.ts#L95 "ctx.db.delete(old._id)")).
- **Who answers for it:** the owner decides to put the form in their app, so the owner must tell their customers. turtl's terms and privacy policy have to say so.

### D9. Screenshots of the owner's app

- **What:** screenshots Revyl takes while it runs the owner's app on a cloud phone.
- **Sent to Revyl:** only the id of the test to run ([convex/revyl/api.ts:85](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/revyl/api.ts#L85 "workflow_id: config.workflowId"), [convex/revyl/runs.ts:48](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/revyl/runs.ts#L48 "startWorkflow(resolved.config)")).
- **Stored:** turtl downloads the screenshots Revyl made and keeps them in Convex file storage ([convex/revyl/runs.ts:112](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/revyl/runs.ts#L112 "fetch(shot.url"), [convex/revyl/runs.ts:114](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/revyl/runs.ts#L114 "ctx.storage.store"), [convex/revyl/schema.ts:27](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/revyl/schema.ts#L27 "revylScreenshots: defineTable")). The app shows them through a storage link ([convex/revyl/runs.ts:222](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/revyl/runs.ts#L222 "ctx.storage.getUrl"), [components/fix/CasePage.tsx:126](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/components/fix/CasePage.tsx#L126 "uri: shot.url")).
- **Kept:** deleted only by a developer reset ([convex/memory/reset.ts:205](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/memory/reset.ts#L205 "ctx.storage.delete(storageId)"), [convex/memory/reset.ts:11](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/memory/reset.ts#L11 "DEV_TOOLS_ENABLED")).

### D10. Pull request details

- **What:** a pull request's repository, number, title, link, head commit, and the names and results of its checks.
- **From GitHub:** read with the deployment's token, every 30 seconds while one is open ([convex/prTracking/github.ts:121](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/prTracking/github.ts#L121 "/pulls/"), [convex/prTracking/github.ts:25](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/prTracking/github.ts#L25 "process.env.GITHUB_TOKEN"), [convex/crons.ts:10](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/crons.ts#L10 "refresh pull requests")). The owner's Merge tap merges it with the same token ([convex/pullRequests.ts:137](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/pullRequests.ts#L137 "mergePullRequest(token"), [convex/prTracking/github.ts:141](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/prTracking/github.ts#L141 "/merge")).
- **From Capy:** the id of the thread writing the change, and its replies, read only to find the pull request's link ([convex/prTracking/execute.ts:69](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/prTracking/execute.ts#L69 "prTracking.records.insertForAction"), [convex/prTracking/capy.ts:90](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/prTracking/capy.ts#L90 "/messages")).

### D11. The owner's live app

- **What:** health, a test run of the key journey, feature flags, recent error counts, and the deployed revision.
- **Collected:** the backend calls the owner's app every minute with a control secret ([convex/protectedApp/client.ts:39](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/protectedApp/client.ts#L39 "PROTECTED_APP_URL"), [convex/protectedApp/client.ts:61](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/protectedApp/client.ts#L61 "Bearer"), [convex/protectedApp/client.ts:123](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/protectedApp/client.ts#L123 "await call(config.url"), [convex/protectedApp/client.ts:189](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/protectedApp/client.ts#L189 "/errors"), [convex/protectedApp/client.ts:197](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/protectedApp/client.ts#L197 "/revision"), [convex/runner/handlers/gather_context.ts:39](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/runner/handlers/gather_context.ts#L39 "/flags"), [convex/crons.ts:7](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/crons.ts#L7 "check registered journeys")).
- **Stored:** as the facts and evidence of a case (D5). Error counts are totals, not records of people ([convex/monitor.ts:24](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/monitor.ts#L24 "vCounts")).
- **Today:** one watched app for the whole deployment.

### D12. The alert phone number

- **What:** the contact Keiki messages when a case needs the owner.
- **Today:** a deployment setting, not something the app asks for ([convex/keiki.ts:22](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/keiki.ts#L22 "KEIKI_OWNER_CONTACT")). It is sent to Keiki with every alert ([convex/keiki.ts:34](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/keiki.ts#L34 "body: JSON.stringify({ text")).
- **From the handoff note, not from code:** Keiki's agent rewords each notice with a Google Gemini model and delivers it by iMessage.

### D13. Device identifiers

- **None.** The app has no library that reads a device or advertising identifier and none for push notifications ([package.json:13](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/package.json#L13 "dependencies") to [package.json:34](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/package.json#L34 "supermemory")).
- The id in a customer's report (D8) is a random value the report form makes up. It is not read from the device ([protected-app/report/ReportForm.tsx:24](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/protected-app/report/ReportForm.tsx#L24 "randomId")).

### D14. Usage, diagnostics, and logs

- **None collected from the app.**
- The backend records one row for each AI call: which model, how long it took, and whether it failed ([convex/voice/runs.ts:18](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/voice/runs.ts#L18 "ctx.db.insert")). These describe turtl's own work.
- Failed alerts log a status code and no content ([convex/keiki.ts:39](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/keiki.ts#L39 "console.error")).
- **Gap:** two functions put OpenAI's raw error text into an error they throw ([convex/assistant.ts:83](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/assistant.ts#L83 "OpenAI request failed"), [convex/codeNetwork/openai.ts:33](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/openai.ts#L33 "OpenAI request failed")). An error can echo part of the request, and it reaches the screen and Convex's logs.

### D15. Things that stay on the device

- The theme choice is held in memory and lost on restart ([theme/index.tsx:19](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/theme/index.tsx#L19 "setMode] = useState")).
- The font ships inside the app, so no request goes to Google ([app/_layout.tsx:9](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/app/_layout.tsx#L9 "@expo-google-fonts/capriola")).

### D16. An unused assistant

- A public backend function sends a message to OpenAI and stores it and the reply in Supermemory under whatever name the caller gives ([convex/assistant.ts:29](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/assistant.ts#L29 "chat = action"), [convex/assistant.ts:49](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/assistant.ts#L49 "searchMemories(userId, message)"), [convex/assistant.ts:69](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/assistant.ts#L69 "api.openai.com/v1/responses"), [convex/assistant.ts:102](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/assistant.ts#L102 "addMemory(userId")).
- No screen calls it, and it is off unless the deployment sets `ASSISTANT_ENABLED` ([convex/assistant.ts:39](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/assistant.ts#L39 "ASSISTANT_ENABLED")).
- **Recommendation:** delete it, or keep it off in the store backend. If it ships switched on, it is a second place personal text goes that no policy describes.

### D17. The booking demo

- The demo's own tables hold test bookings with a service, a date, and a time, and no personal fields ([convex/schema.ts:163](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/schema.ts#L163 "bookingDemoSettings")). They belong to the demo, not to the product.

## Outside services

| Service | What it does for turtl | Where in the code | Setting that turns it on |
| --- | --- | --- | --- |
| **Convex** | Hosts the backend, database, and file storage | [data/live/client.ts:7](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/data/live/client.ts#L7 "new ConvexReactClient") | `EXPO_PUBLIC_CONVEX_URL` |
| **OpenAI** | Diagnosis, fix options, chat, triage, naming the parts of the code, speech to text, text to speech | [convex/diagnosis.ts:68](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/diagnosis.ts#L68 "api.openai.com/v1/chat/completions"), [convex/fixOptions.ts:166](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/fixOptions.ts#L166 "api.openai.com/v1/chat/completions"), [convex/codeNetwork/openai.ts:21](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/openai.ts#L21 "api.openai.com/v1/responses"), [convex/voice/openai.ts:48](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/voice/openai.ts#L48 "audio/transcriptions"), [convex/voice/openai.ts:59](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/voice/openai.ts#L59 "audio/speech") | `OPENAI_API_KEY` |
| **Supermemory** | Search over the code, past cases, and customers' reports | [convex/supermemory.ts:22](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/supermemory.ts#L22 "new Supermemory"), [convex/supermemory.ts:44](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/supermemory.ts#L44 "dreaming") | `SUPERMEMORY_API_KEY` |
| **GitHub** | Reading the repository, reading and merging pull requests | [convex/codeNetwork/build.ts:91](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/build.ts#L91 "api.github.com"), [convex/prTracking/github.ts:5](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/prTracking/github.ts#L5 "api.github.com") | `GITHUB_TOKEN` |
| **Capy** | Writes an approved code change and opens the pull request | [convex/prTracking/capy.ts:3](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/prTracking/capy.ts#L3 "api.capy.ai"), [convex/prTracking/capy.ts:15](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/prTracking/capy.ts#L15 "CAPY_API_KEY") | `CAPY_API_KEY` |
| **Revyl** | Runs the owner's app on a cloud phone to check a fix | [convex/revyl/api.ts:8](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/revyl/api.ts#L8 "backend.revyl.ai"), [convex/revyl/api.ts:6](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/revyl/api.ts#L6 "REVYL_API_KEY") | `REVYL_API_KEY`, `REVYL_BOOKING_WORKFLOW_ID` |
| **Keiki** | Texts the owner when a case needs them | [convex/keiki.ts:11](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/keiki.ts#L11 "onkeiki.com"), [convex/keiki.ts:20](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/keiki.ts#L20 "KEIKI_API_KEY") | `KEIKI_API_KEY`, `KEIKI_AGENT_ID`, `KEIKI_OWNER_CONTACT` |
| The owner's own app | Health checks and the approved recovery action | [convex/protectedApp/client.ts:39](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/protectedApp/client.ts#L39 "PROTECTED_APP_URL"), [convex/protectedApp/client.ts:8](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/protectedApp/client.ts#L8 "PROTECTED_APP_CONTROL_SECRET") | `PROTECTED_APP_URL` |

**Looked for and not found:** analytics, advertising, attribution, crash reporting, push notifications, a sign-in provider, a payment library, and over-the-air updates.

### What each vendor says about the data it receives

Read from each vendor's public pages on 15 November 2026. These are their statements, not something this audit verified.

| Vendor | Trains on it? | Keeps it how long? | Source |
| --- | --- | --- | --- |
| OpenAI | No, unless the account opts in | Up to 30 days in abuse-monitoring logs for chat and speech requests. Nothing for transcription. **The Responses API also stores each response for at least 30 days unless the request sets `store: false`, and turtl's requests do not** ([convex/codeNetwork/openai.ts:24](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/openai.ts#L24 "body: JSON.stringify")) | [Data controls in the OpenAI platform](https://developers.openai.com/api/docs/guides/your-data) |
| Supermemory | Not stated on the page read | For as long as the account exists, or until deleted | [Privacy Policy](https://supermemory.ai/privacy/) |
| Keiki | No | Until deleted or the account is closed | [Privacy Policy](https://onkeiki.com/privacy) |
| Capy | Not on non-public customer content, unless the customer opts in | As long as reasonably necessary; thread content until deleted | [Privacy Policy](https://capy.ai/privacy-policy) |
| Revyl | Not stated on the page read | No longer than the account exists | [Privacy Policy](https://revyl.com/privacy/) |
| GitHub | Not relevant: turtl reads from GitHub and sends it nothing new except the merge | - | [GitHub General Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement) |
| Convex | Not read: the page needs a browser to render | Not read | [Privacy Policy](https://www.convex.dev/legal/privacy) |

Apple asks that every third party gives "the same or equal protection" as the app's own policy. A data processing agreement with each vendor is what backs that sentence up. None is on file.

## How long turtl keeps things, as coded

| What | Kept until |
| --- | --- |
| Cases, evidence, proposals, decisions, chat, code questions | Never deleted, outside the developer resets ([convex/memory/reset.ts:11](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/memory/reset.ts#L11 "DEV_TOOLS_ENABLED")) |
| The map of the code | Replaced on rebuild ([convex/codeNetwork/network.ts:101](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/codeNetwork/network.ts#L101 "ctx.db.delete")) |
| Customers' reports and contacts | Never deleted |
| Screenshots of the owner's app | Never deleted, outside a developer reset |
| Voice recordings | Not kept by turtl at all |
| Rate-limit counters | Pruned when a new window opens ([convex/intake/records.ts:95](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/intake/records.ts#L95 "ctx.db.delete(old._id)")) |
| Everything in Supermemory | **Never deleted. No code calls a delete on Supermemory** |

There is no way in the app to delete a project, a case, a conversation, or an account.

## What this means for App Review

Each item is a line in the [review checklist](review-checklist.md), where it has an owner and a way to check it.

1. **No permission is asked before personal data goes to third-party AI** (D3 to D8). Guideline 5.1.2(i) names third-party AI explicitly. (RC-26)
2. **No privacy policy is linked in the app** until this pull request's links ship. (RC-19)
3. **Nothing can be deleted,** and the Supermemory copies outlive everything. Account deletion has to remove them. (RC-23, RC-24)
4. **Source code and customers' words are sent whole.** Nothing strips secrets, emails, or names before text goes to OpenAI or Supermemory. (RC-22)
5. **Customers' contact details are stored unencrypted** and are not covered by any notice the customer sees. (RC-25)
6. **The Responses API stores what turtl sends for 30 days** because `store: false` is not set. (RC-28)
7. **Every public backend function answers anyone who has the address** ([components/project/OwnerPasscodeSettings.tsx:38](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/components/project/OwnerPasscodeSettings.tsx#L38 "Anyone with the backend address can make decisions")). This is the accounts work's second pull request. (RC-30)
8. **The owner passcode hash has no salt** ([convex/ownerPasscode.ts:5](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/ownerPasscode.ts#L5 "SHA-256")). Accounts replace it; until then it is one fast hash. (RC-30)
9. **A real person's photo ships in the app** as the profile picture ([app/projects.tsx:26](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/app/projects.tsx#L26 "ronok-avatar.png")). (RC-04)
10. **Developer tools are compiled into the app** and shown when `EXPO_PUBLIC_DEV_TOOLS` is `1` ([components/dev/DevTools.tsx:16](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/components/dev/DevTools.tsx#L16 "EXPO_PUBLIC_DEV_TOOLS")). A store build must not set it, and the store backend must not set `DEV_TOOLS_ENABLED` ([convex/dev.ts:66](https://github.com/ronoktanvir/turtl/blob/3d01f6404fede6e87f619bfd6cb5ae521b12b64a/convex/dev.ts#L66 "DEV_TOOLS_ENABLED")). (RC-04)

## In flight: work that changes this audit

Read from open pull requests and this crew's plan on 15 November 2026. None of it is in the audited commit. Re-run this audit before submission.

| Work | What it adds |
| --- | --- |
| Accounts and sign-in (this crew) | Email address, name, an Apple id, a GitHub id and login, password hashes, sessions |
| GitHub linking (this crew) | A GitHub App: per-owner installation tokens and webhook events, replacing the one deployment token |
| Push notifications (this crew, later) | A device push token, sent to Apple and possibly Expo |
| Crash reporting (this crew, later) | Crash and performance data, and a new vendor |
| turtl#46, the council | Two more AI providers when their keys are set: Anthropic (`api.anthropic.com`) and Google (`generativelanguage.googleapis.com`) |
| turtl#45, broader causes | More case text to OpenAI |
| turtl#47, owner preferences | More case text and the owner's feedback to Supermemory |
| turtl#48, onboarding | Reads a repository from GitHub and sends parts of it to OpenAI when an owner connects it |
