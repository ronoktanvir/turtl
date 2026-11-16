# App Privacy answers

The answers to the App Privacy questions in App Store Connect, in Apple's own categories, taken from [the audit](data-practices.md). Apple shows them on the product page as the privacy label.

Someone has to type these into App Store Connect by hand: `eas metadata:push` does not send them. They describe the build that is submitted, so the table says which answers wait for work that has not landed. Run the audit again on the submitted commit before typing them in (RC-12 in [the checklist](review-checklist.md)).

Apple's definitions used here were read on 15 November 2026 from [App privacy details on the App Store](https://developer.apple.com/app-store/app-privacy-details/).

## The two questions that frame the rest

**Do you or your third-party partners collect data from this app?** Yes.

**Is any of it used to track?** No. turtl has no advertising or analytics library, reads no advertising identifier, and shares nothing with a data broker. It does not need the App Tracking Transparency prompt.

## The answers

Apple asks three things about each type that is collected: what it is used for, whether it is linked to the person's identity, and whether it is used to track them. Every type turtl collects has the same three answers: **App Functionality**, **linked**, **not used to track**.

| Apple's category | Apple's data type | Collected | What it is in turtl | Depends on |
| --- | --- | --- | --- | --- |
| Contact Info | Email Address | **Yes** | The address the owner signs in with | Accounts (TUR-57). Not collected at the audited commit |
| Contact Info | Name | **Yes**, if turtl stores it | The name Apple or GitHub passes on at sign-in | Accounts (TUR-57). Answer "no" if the accounts work stores no name |
| Identifiers | User ID | **Yes** | The account's id, and the id Apple or GitHub gives turtl for it | Accounts (TUR-57) |
| User Content | Audio Data | **Yes** | The recording made after the owner taps Talk. See "Judgment calls" | In the code today, behind `VOICE_ENABLED` |
| User Content | Other User Content | **Yes** | What the owner types to turtl, the text of what they say, their decisions, and the code in the repository they connect | In the code today |
| Identifiers | Device ID | No, **then yes** | The token Apple issues so a notification can reach the phone | Push notifications (TUR-64) |
| Diagnostics | Crash Data | No, **then yes** | Crash reports | Crash reporting (TUR-65) |
| Diagnostics | Performance Data | No, **then yes** | Launch time and hangs, if the crash reporter gathers them | Crash reporting (TUR-65) |

What Apple will show at launch, if accounts have landed and push and crash reporting have not:

> **Data Linked to You:** Contact Info, User Content, Identifiers
>
> **Data Used to Track You:** none

## Not collected, and why

| Apple's data type | Why the answer is no |
| --- | --- |
| Phone Number | The app never asks for one. The number alerts go to is a setting of the backend today ([D12](data-practices.md#d12-the-alert-phone-number)). **This becomes yes** if the app starts asking each owner for a number |
| Physical Address, Other User Contact Info | Never asked for |
| Health, Fitness, Payment Info, Credit Info, Other Financial Info | Nothing of the kind exists in the app |
| Precise Location, Coarse Location | The app has no location permission and the backend does not read the caller's address |
| Sensitive Info, Contacts, Photos or Videos | Never asked for and never read |
| Emails or Text Messages | Owners cannot message each other. The alert turtl sends an owner is turtl's own words |
| Gameplay Content | Not a game |
| Customer Support | Support is by email, outside the app |
| Browsing History | The app has no browser |
| Search History | See "Judgment calls" |
| Purchase History | Nothing is sold |
| Product Interaction, Advertising Data, Other Usage Data | No analytics. See "Judgment calls" |
| Other Diagnostic Data | None collected from the app |
| Environment Scanning, Hands, Head | Not used |
| Other Data Types | None |

## Judgment calls

Each of these could be answered the other way. The recommendation is the answer that is safest if Apple or a user checks it against the app.

1. **Audio Data: declare it.** Apple counts data as collected when it is kept "for a period longer than what is necessary to service the transmitted request in real time". turtl keeps no audio, and OpenAI's published policy lists no retention for transcription, so a strict reading says the recording is not collected. Declare it anyway. The app asks for the microphone, a reviewer will look for the matching line, and the answer stays right if the transcription service or its retention ever changes.
2. **Source code: counted under Other User Content.** The code is not typed into the app. turtl's backend reads it from GitHub after the owner connects a repository. It is still the owner's content, collected because of what they did in the app, and copies go to OpenAI and Supermemory. Since typed messages already make Other User Content a yes, this changes nothing on the label, but it belongs in the reasoning.
3. **Questions about the code: Other User Content, not Search History.** A question is sent to Supermemory as a search and kept as a chat message. It is a conversation with turtl, not a search box, so it sits with the other messages. If turtl ever adds a search field, declare Search History.
4. **Usage Data: no.** The backend keeps one row for each AI call and each voice turn: which model, how long it took, whether it failed. These describe turtl's own work on a request, are not used to study how people use the app, and nothing in the app reports taps or screens. If those rows are ever used to measure behaviour, or an analytics library is added, the answer becomes Product Interaction with the purpose Analytics.
5. **Name: only if it is stored.** Sign in with Apple and GitHub can both pass a name. If the accounts work discards it, answer no.

## Not verified

- Whether Convex, as the host, keeps the internet address of each request, and for how long. turtl's own code does not read it. Convex's policy pages need a browser to render and could not be read by this audit.
- Which switches are on in the hosted backend. It is off limits to this crew.

## What is not on turtl's label: customers' reports

A customer's report and contact ([D8](data-practices.md#d8-customers-reports)) are collected by the **owner's** app, not by turtl's app on the App Store, so they do not appear on turtl's label. They are covered by turtl's privacy policy and terms instead.

An owner whose own app is on the App Store has to declare them on that app's label: **Other User Content** for the report, and **Email Address** or **Other User Contact Info** for the contact, both for App Functionality. The instructions that come with the report form should say so (RC-25).

## For the store build: the privacy manifest

This is the store build thread's file, not this pull request's. The values are here so they can be copied.

A build has to declare why its libraries call four of Apple's "required reason" APIs. Expo's guide says Apple does not always read the declarations inside the libraries themselves, so they should be repeated in the app's own configuration. These reasons were read from the `PrivacyInfo.xcprivacy` files of the libraries installed at the audited commit (`expo-constants`, `expo-file-system`, and `react-native`). Read them again after any dependency change.

The manifest should also repeat the label: no tracking, and the same data types. Add the three account types when accounts land.

```json
{
  "expo": {
    "ios": {
      "privacyManifests": {
        "NSPrivacyTracking": false,
        "NSPrivacyTrackingDomains": [],
        "NSPrivacyCollectedDataTypes": [
          {
            "NSPrivacyCollectedDataType": "NSPrivacyCollectedDataTypeAudioData",
            "NSPrivacyCollectedDataTypeLinked": true,
            "NSPrivacyCollectedDataTypeTracking": false,
            "NSPrivacyCollectedDataTypePurposes": ["NSPrivacyCollectedDataTypePurposeAppFunctionality"]
          },
          {
            "NSPrivacyCollectedDataType": "NSPrivacyCollectedDataTypeOtherUserContent",
            "NSPrivacyCollectedDataTypeLinked": true,
            "NSPrivacyCollectedDataTypeTracking": false,
            "NSPrivacyCollectedDataTypePurposes": ["NSPrivacyCollectedDataTypePurposeAppFunctionality"]
          }
        ],
        "NSPrivacyAccessedAPITypes": [
          {
            "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryUserDefaults",
            "NSPrivacyAccessedAPITypeReasons": ["CA92.1"]
          },
          {
            "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryFileTimestamp",
            "NSPrivacyAccessedAPITypeReasons": ["0A2A.1", "3B52.1", "C617.1"]
          },
          {
            "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryDiskSpace",
            "NSPrivacyAccessedAPITypeReasons": ["85F4.1", "E174.1"]
          },
          {
            "NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategorySystemBootTime",
            "NSPrivacyAccessedAPITypeReasons": ["35F9.1"]
          }
        ]
      }
    }
  }
}
```

The account types to add are `NSPrivacyCollectedDataTypeEmailAddress`, `NSPrivacyCollectedDataTypeName`, and `NSPrivacyCollectedDataTypeUserID`. Push adds `NSPrivacyCollectedDataTypeDeviceID`. Crash reporting adds `NSPrivacyCollectedDataTypeCrashData` and `NSPrivacyCollectedDataTypePerformanceData`.
