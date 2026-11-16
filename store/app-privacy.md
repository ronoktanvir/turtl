# App Privacy answers

The answers to the App Privacy questions in App Store Connect, in Apple's own categories, taken from [the audit](data-practices.md). Apple shows them on the product page as the privacy label.

Someone has to type these into App Store Connect by hand: `eas metadata:push` does not send them. They describe the build that is submitted, which runs in accounts mode (a store build refuses a backend without accounts). Run the audit again on the submitted commit before typing them in (RC-12 in [the checklist](review-checklist.md)).

Apple's definitions used here were read on 15 November 2026 from [App privacy details on the App Store](https://developer.apple.com/app-store/app-privacy-details/).

## The two questions that frame the rest

**Do you or your third-party partners collect data from this app?** Yes.

**Is any of it used to track?** No. turtl has no advertising or analytics library, reads no advertising identifier, and shares nothing with a data broker. It does not need the App Tracking Transparency prompt.

## The answers

Apple asks three things about each type that is collected: what it is used for, whether it is linked to the person's identity, and whether it is used to track them. Every type turtl collects has the same three answers: **App Functionality**, **linked**, **not used to track**.

| Apple's category | Apple's data type | Collected | What it is in turtl | Where in the audit |
| --- | --- | --- | --- | --- |
| Contact Info | Email Address | **Yes** | The address the owner signs in with, or the one Apple or GitHub passes on | [D1](data-practices.md#d1-account) |
| Contact Info | Name | **Yes** | The name Apple or GitHub passes on at sign-in. turtl stores it on the account and shows it in Settings | [D1](data-practices.md#d1-account) |
| Identifiers | User ID | **Yes** | The account's id, and the id Apple or GitHub gives turtl for the person | [D1](data-practices.md#d1-account) |
| Identifiers | Device ID | **Yes** | The phone's push token, collected only after the owner taps Turn on notifications | [D13](data-practices.md#d13-push-token-and-device-identifiers) |
| User Content | Audio Data | **Yes** | The recording made after the owner taps Talk. See "Judgment calls" | [D7](data-practices.md#d7-voice), behind `VOICE_ENABLED` |
| User Content | Other User Content | **Yes** | What the owner types to turtl, the text of what they say, their notes, preferences and decisions, and the code in the repositories they connect | [D3](data-practices.md#d3-source-code) to [D6](data-practices.md#d6-chat-notes-and-preferences) |
| Diagnostics | Crash Data | No | turtl has no crash reporter. **This becomes yes** if one is added | [D14](data-practices.md#d14-usage-diagnostics-and-logs) |
| Diagnostics | Performance Data | No | Nothing measures launch time or hangs. **This becomes yes** with a crash reporter that gathers them | [D14](data-practices.md#d14-usage-diagnostics-and-logs) |

What Apple will show at launch:

> **Data Linked to You:** Contact Info, User Content, Identifiers
>
> **Data Used to Track You:** none

## Not collected, and why

| Apple's data type | Why the answer is no |
| --- | --- |
| Phone Number | The app never asks for one. The number Keiki texts is a setting of the single-owner demo, which a store build does not use ([D12](data-practices.md#d12-keiki-and-the-alert-phone-number)). **This becomes yes** if the app starts asking each owner for a number |
| Physical Address, Other User Contact Info | Never asked for |
| Health, Fitness, Payment Info, Credit Info, Other Financial Info | Nothing of the kind exists in the app |
| Precise Location, Coarse Location | The app has no location permission and the backend does not read the caller's address |
| Sensitive Info, Contacts, Photos or Videos | Never asked for and never read. The profile picture GitHub passes on at sign-in is shown, not taken from the phone |
| Emails or Text Messages | Owners cannot message each other. The emails and notifications turtl sends an owner are turtl's own words |
| Gameplay Content | Not a game |
| Customer Support | Support is by email, outside the app |
| Browsing History | The app opens GitHub's pages in a browser sheet to sign in or connect repositories, and reads nothing back but the result |
| Search History | See "Judgment calls" |
| Purchase History | Nothing is sold |
| Product Interaction, Advertising Data, Other Usage Data | No analytics. See "Judgment calls" |
| Other Diagnostic Data | None collected from the app |
| Environment Scanning, Hands, Head | Not used |
| Other Data Types | None. See "Judgment calls" for the control token and the coding agent key |

## Judgment calls

Each of these could be answered the other way. The recommendation is the answer that is safest if Apple or a user checks it against the app.

1. **Audio Data: declare it.** Apple counts data as collected when it is kept "for a period longer than what is necessary to service the transmitted request in real time". turtl keeps no audio, and OpenAI's published policy lists no retention for transcription, so a strict reading says the recording is not collected. Declare it anyway. The app asks for the microphone, a reviewer will look for the matching line, and the answer stays right if the transcription service or its retention ever changes.
2. **Source code: counted under Other User Content.** The code is not typed into the app. turtl's backend reads it from GitHub after the owner connects a repository. It is still the owner's content, collected because of what they did in the app, and copies go to OpenAI and Supermemory. Since typed messages already make Other User Content a yes, this changes nothing on the label, but it belongs in the reasoning.
3. **Questions about the code: Other User Content, not Search History.** A question is sent to Supermemory as a search and kept as a chat message. It is a conversation with turtl, not a search box, so it sits with the other messages. If turtl ever adds a search field, declare Search History.
4. **Usage Data: no.** The backend keeps one row for each AI call and each voice turn (which model, how long it took, whether it failed), each account's estimated AI spend and code changes, and whether each push was delivered. These describe turtl's own work and enforce the account's limits; they are not used to study how people use the app, and nothing in the app reports taps or screens. If those rows are ever used to measure behaviour, or an analytics library is added, the answer becomes Product Interaction with the purpose Analytics.
5. **Device ID: declare the push token.** Expo's push token identifies one phone for as long as notifications stay on, and the push library sends Expo an installation id to get it. Neither is an advertising identifier, but both are device-level ids, so Device ID is the honest answer.
6. **The control token and the coding agent key: not a type of their own.** They are the owner's credentials for their own app and their own Capy account, kept encrypted and used only to act for them ([D16](data-practices.md#d16-what-an-owner-entrusts-to-turtl)). They are content the owner enters, so they sit under Other User Content, which is already a yes.

## Not verified

- Whether Convex, as the host, keeps the internet address of each request, and for how long. turtl's own code does not read it. Convex's policy pages need a browser to render and could not be read by this audit.
- Which switches are on in the production backend. It does not exist yet.

## What is not on turtl's label: customers' reports

A customer's report ([D8](data-practices.md#d8-customers-reports)) is collected by the **owner's** app, not by turtl's app on the App Store, so it does not appear on turtl's label. It is covered by turtl's privacy policy and terms instead. turtl's report form asks for no contact; a contact another form sends is turned into a reference and not kept.

An owner whose own app is on the App Store has to declare the report on that app's label: **Other User Content**, for App Functionality, and **Email Address** or **Other User Contact Info** if their own form asks for a contact. The instructions that come with the report form should say so (RC-25).

## The privacy manifest

`app.json` already declares no tracking and the reasons for the four "required reason" APIs (RC-34). Its list of collected data types is empty, and should repeat the label. These are the entries to put in `expo.ios.privacyManifests.NSPrivacyCollectedDataTypes`, all linked, not used to track, for App Functionality:

```json
[
  { "NSPrivacyCollectedDataType": "NSPrivacyCollectedDataTypeEmailAddress", "NSPrivacyCollectedDataTypeLinked": true, "NSPrivacyCollectedDataTypeTracking": false, "NSPrivacyCollectedDataTypePurposes": ["NSPrivacyCollectedDataTypePurposeAppFunctionality"] },
  { "NSPrivacyCollectedDataType": "NSPrivacyCollectedDataTypeName", "NSPrivacyCollectedDataTypeLinked": true, "NSPrivacyCollectedDataTypeTracking": false, "NSPrivacyCollectedDataTypePurposes": ["NSPrivacyCollectedDataTypePurposeAppFunctionality"] },
  { "NSPrivacyCollectedDataType": "NSPrivacyCollectedDataTypeUserID", "NSPrivacyCollectedDataTypeLinked": true, "NSPrivacyCollectedDataTypeTracking": false, "NSPrivacyCollectedDataTypePurposes": ["NSPrivacyCollectedDataTypePurposeAppFunctionality"] },
  { "NSPrivacyCollectedDataType": "NSPrivacyCollectedDataTypeDeviceID", "NSPrivacyCollectedDataTypeLinked": true, "NSPrivacyCollectedDataTypeTracking": false, "NSPrivacyCollectedDataTypePurposes": ["NSPrivacyCollectedDataTypePurposeAppFunctionality"] },
  { "NSPrivacyCollectedDataType": "NSPrivacyCollectedDataTypeAudioData", "NSPrivacyCollectedDataTypeLinked": true, "NSPrivacyCollectedDataTypeTracking": false, "NSPrivacyCollectedDataTypePurposes": ["NSPrivacyCollectedDataTypePurposeAppFunctionality"] },
  { "NSPrivacyCollectedDataType": "NSPrivacyCollectedDataTypeOtherUserContent", "NSPrivacyCollectedDataTypeLinked": true, "NSPrivacyCollectedDataTypeTracking": false, "NSPrivacyCollectedDataTypePurposes": ["NSPrivacyCollectedDataTypePurposeAppFunctionality"] }
]
```

A crash reporter would add `NSPrivacyCollectedDataTypeCrashData` and `NSPrivacyCollectedDataTypePerformanceData`. Read the libraries' `PrivacyInfo.xcprivacy` files again after any dependency change.
