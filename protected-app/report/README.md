# turtl's report form

Two buttons for your app, "Report a problem" and "Request a feature", that send your customers' words to turtl. turtl groups reports about the same thing into one case and shows them to you in the turtl app, with how many people wrote.

The booking demo in this repository uses it (`../app/index.tsx`). Any Expo or React Native app can.

## What to copy

One file: `ReportForm.tsx`. It needs only `react` and `react-native`, which every Expo app has. Put it anywhere in your app and render it where customers will find it, for example at the bottom of a help or settings screen:

```tsx
import { ReportForm } from "./ReportForm";

<ReportForm />
```

The colours at the bottom of the file are the demo's. Change them to your app's; nothing else depends on them. You can also change the words in `COPY`, but keep the notice above the Send button and its link.

## The two settings

Set them as environment variables in your app (for Expo, in `.env` or your EAS environment), or pass them as props:

| Setting | Prop | What it is |
| --- | --- | --- |
| `EXPO_PUBLIC_TURTL_INTAKE_KEY` | `intakeKey` | Your app's intake key, `tik_…`, one per project. Today it is issued by whoever runs turtl's backend (`npx convex run intake/keys:issue '{"appId":"<project id>"}'`); the turtl app does not show it yet. It only tells turtl which app a report is for. It is not a secret: it ships inside your app, and turtl's limits on how many reports a key and a sender can send are what stop abuse. |
| `EXPO_PUBLIC_TURTL_INTAKE_URL` | `endpoint` | `https://<turtl's deployment>.convex.site/intake/report`. |

Without both, the form still shows, and Send says "Reports aren't set up for this app yet." Restart Expo after changing an environment variable.

The booking demo works out the address from its own `EXPO_PUBLIC_CONVEX_URL`, because it shares turtl's backend. Your app does not: if your app has a Convex backend of its own, its address is not turtl's, so always set `EXPO_PUBLIC_TURTL_INTAKE_URL`.

## What the customer sees

1. Two buttons: "Report a problem" and "Request a feature".
2. Tapping one opens a box with a question ("What went wrong? …" or "What would make booking better for you?"), a text field of up to 2,000 characters, and this notice: their message goes to the team behind the app through turtl, turtl and the AI services it uses read it to sort reports, and they should leave out passwords, card numbers and other private details. The notice links to the part of turtl's privacy policy about the report form (`POLICY_URL`).
3. Send. Then "Thank you. Your report reached the team." and a link to send another. If sending fails, the reason in plain words, and nothing is lost from the text field.

The form does not ask for a name or an email address, and nobody can reply to a customer through it.

## What is sent

One `POST` to the endpoint with JSON:

| Field | What it is |
| --- | --- |
| `key` | Your intake key. |
| `text` | The customer's words, trimmed, at most 2,000 characters. |
| `kind` | `"bug"` or `"request"`: the button they pressed. A hint; turtl decides. |
| `reporterId` | A random id for this device, so one person writing twice counts once. On the web it is kept in `localStorage` (`still-reporter-id`); in a native app it lasts until the app is closed. |
| `reportId` | A random id for this message, so a retry is not counted twice. |

Nothing else: no name, email, account, location or device details. The endpoint also accepts an optional `contact` from forms that send one; turtl keeps only a keyed scrambled form of it, to count that person once, and never the address (see `convex/intake/README.md`).

turtl stores the words and sends them to OpenAI (to sort the report and suggest fixes) and to Supermemory (to match reports about the same thing). It never sends anything that identifies the customer to an AI service, and its alerts to you never quote a customer. You can delete any report from its case in the turtl app.

## Tell your customers

You decide to collect these reports, so your own privacy notice should say that customers' reports go to turtl and the AI services it uses. turtl's privacy policy has a section for this: <https://ronoktanvir.github.io/turtl/privacy/#if-you-use-the-report-form>.
