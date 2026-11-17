---
title: Privacy policy
description: What turtl collects, which services receive it, how long it is kept, and how to have it deleted.
permalink: /privacy/
root: ../
dated: true
---

turtl is an app for people who run a live app without an operations team. To do its job it has to read your code, check your live app, and send some of what it finds to other companies' services, including AI services. This page says exactly what, to whom, and why.

turtl is run by {% include blank.html value=site.data.operator.legal_name label="legal name" %} ("we"). Write to {% include blank.html value=site.data.operator.contact_email label="contact email" %} about anything on this page.

## The short version

- turtl sends parts of **your source code**, **the details of each case**, **what you write to it**, and **your voice recordings** to AI services run by other companies. It asks your permission first, and you can take it back.
- turtl does not sell your data, show ads, or track you across other apps and websites.
- turtl contains no advertising or analytics software.
- You can delete your account, and what turtl holds about you, from inside the app.

## What turtl collects

### About you

- **Your account.** The email address you sign in with. If you sign up with an email address and a password, you confirm the address with a code turtl emails you; until then the account opens nothing else. If you sign in with Apple or GitHub: the id it gives turtl for you, and your name, and from GitHub your profile picture, if it passes them on. If you sign in with a password, turtl stores a scrambled form of it that cannot be turned back into the password. turtl uses these to sign you in and to keep your projects yours.
- **A token from Apple,** if you sign in with Apple. turtl keeps it encrypted, only so that it can tell Apple to end turtl's access when you delete your account.
- **Your phone's notification address,** if you turn on notifications. It is a token that lets a notification reach your phone. turtl keeps one for each phone where you turned them on, and a phone receives notifications only while you are signed in on it.
- **On your phone,** turtl keeps your sign-in and the theme you chose in the iOS Keychain. It also remembers the address you last asked to reset, for 24 hours, so the link in the email can fill in only the code. The theme never leaves the phone, and the address leaves it only in the reset request itself.

### What you connect

- **Your source code.** You choose which GitHub repositories turtl may read, through turtl's GitHub app. turtl connects only the repositories you can change on GitHub, and checks with GitHub that you still can before it merges a pull request or asks a coding agent to change code. turtl reads up to a few hundred files from a repository. It keeps a map of your app in plain words: the names of its parts, a sentence about each, and file paths. It does not keep the code in its own database, but it does place a copy with a search service so it can answer your questions (see "Who receives your data"). Before any of your code leaves turtl, files that hold secrets, such as .env files and keys, are left out, and passwords, tokens and keys in the rest are masked. This works by pattern, so a secret written in an unusual way could still get through.
- **Your live app.** turtl calls your app regularly, as often as once a minute (and less often, at least every 15 minutes, while it keeps failing the same way), to check its health and to run tests of the journeys you chose. It keeps the results: whether each step passed, error codes, error counts, and which version is deployed, and, when your app does not answer, how many times in a row and what turtl saw (no reply in time, no connection, or the reply's status code).
- **Your app's control token and your coding agent's key,** if you add them. The control token lets turtl call your app's protected checks and recovery steps; turtl sends it only to your app's own address. The coding agent key is your own key for Capy, which writes the code changes you approve; turtl sends it only to Capy. turtl keeps both encrypted and never shows them again.
- **Your pull requests.** For a code change turtl proposed: its title, link, and whether its checks pass.
- **A practice project, if you make one.** turtl runs a small practice booking app for it itself, so you can break it on purpose and watch turtl fix it. It holds only the app's switches and test bookings, which are deleted straight away.

### What you write and say

- **Messages.** What you type to turtl about a case or about your code, and its replies.
- **Decisions, notes and preferences.** What you approved, declined, stopped, or merged, and when; a note you leave with a decision; and what you tell turtl matters to you about a project.
- **Your voice.** When you tap Talk, turtl records up to 30 seconds, turns it into text, and deletes the recording from your phone straight away. turtl does not keep the audio. The text becomes a message in the conversation.

### What your customers send

If you add turtl's report form to your own app, your customers can send a bug report or a feature request of up to 2,000 characters. turtl stores the report and a random id the form makes up, which lets turtl count one person once. turtl's form does not ask for a contact. If another form sends one, turtl turns it into a scrambled reference and does not keep the contact itself. See "If you use the report form".

### What turtl does not collect

turtl does not collect your location, your contacts, your photos, an advertising identifier, or a record of how you use the app. It does not read anything from your phone beyond what is listed above. It asks for two permissions, each only when you tap for it: the microphone, when you tap Talk, and notifications, when you tap Turn on notifications.

## Why turtl uses it

turtl uses what it collects only to do what you installed it for: to notice when your app breaks, work out why, propose and carry out the fixes you approve, check they worked, tell you when a case needs you, and answer your questions. It does not use your data for advertising or to build a profile of you, and it does not use it to train AI models.

## Notifications and emails

- **Notifications.** If you turn them on, turtl sends one when a case needs your decision, when a fix you allowed in advance has run and your app passed its check, when your app stops answering turtl's checks altogether, and when it answers them again. A notification shows the name of your project and one fixed sentence. It never shows your customers' words, your code, or an error. It goes through Expo's push service, which hands it to Apple. You can turn notifications off in the app's settings or in iOS Settings. Your phone's notification address is removed when you turn notifications off on that phone, sign out, reset your password, or delete your account, and it receives nothing once you are signed out.
- **Emails.** turtl sends you an email only to confirm your address when you sign up with one, and when you ask to reset your password. Each holds a link and a code and nothing else, and is sent through Resend. turtl keeps only scrambled copies of each code, of your address, and of its domain, for one day. If you ask for a password reset, turtl always sends the first one of the day; any more wait until tomorrow when it is busy, and a code already sent to you still works. An account made with an email address that is never confirmed is deleted after 7 days. turtl sends no newsletters or marketing.

## Who receives your data

Each of these services receives only what the table says. The first three are AI services, and turtl sends nothing to them until you allow it (see "Before turtl uses AI").

<div class="table-wrap" markdown="1">

| Service | What it receives | Why |
| --- | --- | --- |
| **OpenAI** (AI) | Excerpts of your source code, case details, your messages, notes and preferences, your customers' reports, and your voice recordings | To name the parts of your app, diagnose a problem, propose fixes, answer questions, sort customers' reports, and turn speech into text and text into speech |
| **Supermemory** (AI search) | Up to 30,000 characters of each source file, notes on past cases, your preferences, your questions about the code, and your customers' reports | To find the code, the past cases and the preferences that matter to a question or a new problem |
| **Capy** (AI coding agent) | The title of a case and the instructions for a code change you approved, or, when you add a project, a brief of the changes that prepare it. Capy then works in your repository through its own connection to GitHub, with your own Capy key | To write the change and open a pull request for you to review |
| **GitHub** | Your sign-in, if you choose GitHub; requests to read the repositories you chose and their pull requests; a check that you can still change a repository; a merge when you tap Merge; and removing turtl's app when you disconnect or delete your account | To sign you in, read your code, and carry out your decisions |
| **Revyl** | A request to run a test of your app on a phone in its cloud. It sends back screenshots | To check on a device that a fix worked |
| **Expo** | Your phone's notification address, and each notification: your project's name and one fixed sentence | To deliver notifications to your phone, through Apple |
| **Resend** | Your email address and a one-time code | To send the email that confirms your address when you sign up with a password, and the email that resets your password |
| **Apple** | Your sign-in, if you choose Apple, and the token turtl keeps, when you delete your account | To sign you in, and to end turtl's access when you delete your account |
| **Convex** | Everything turtl stores | It hosts turtl's database and files |

</div>

turtl's code can also ask Anthropic and Google for a second opinion on a diagnosis, and text through Keiki, but only in a demo we run for ourselves. turtl does not send your data to them.

Each of these companies handles what it receives under its own terms, which you can read here: [OpenAI](https://openai.com/policies/privacy-policy/), [Supermemory](https://supermemory.ai/privacy/), [Capy](https://capy.ai/privacy-policy), [GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement), [Revyl](https://revyl.com/privacy/), [Expo](https://expo.dev/privacy), [Resend](https://resend.com/legal/privacy-policy), [Apple](https://www.apple.com/legal/privacy/), [Convex](https://www.convex.dev/legal/privacy). We require each of them to protect your data at least as well as this policy does.

{% include review.html note="The last sentence is a promise Apple requires (guideline 5.1.1(i)). It is only true once you have accepted a data processing agreement with each vendor. None is on file today (RC-28)." %}

We also disclose data when the law requires it, and to a new operator if turtl is ever sold or merged, who would be bound by this policy.

## Before turtl uses AI

The first time you sign in, turtl shows you a screen that names each AI service, says what it receives, and links to its own privacy policy. turtl sends nothing to them until you tap Allow. The backend refuses every call to a service you have not allowed, not only the screen.

If you tap Not now, turtl still watches your app, runs its checks, and offers the recovery steps you set up, using its own rules. It cannot diagnose with AI, propose AI fixes, answer questions, or write code changes until you allow it.

You can read the list again, allow it, or take your permission back at any time: open a project, tap the gear, then AI services. Taking it back stops the next request. If turtl adds a service to the list, or changes what one receives, it asks you again before sending anything to it.

Each account also has limits on AI: a monthly allowance, a daily allowance ($2.50, plus $1.00 for its customers' reports), and a number of code changes it can start in a day. Settings shows where you stand. turtl always finds the cause of an outage its checks find on your own project, up to a small daily amount that nothing another account does can use up, unless turtl as a whole has reached the most it spends on AI in a day. When your app does not answer at all, turtl tells you but uses no AI on it: it cannot look into an app it cannot reach. When turtl does not use AI, it says why on the case and explains with its own rules. Your practice app may use up to $2.00 of your daily allowance; once it has, turtl still opens the case, explains it with its own rules, and tells you why.

## How long turtl keeps it

- **Voice recordings** are not kept. OpenAI's published policy says it keeps no copy of audio sent for transcription.
- **A customer's report** is kept until you delete it from its case, or delete your account.
- **Your phone's notification address** is removed when you turn notifications off on that phone, sign out, reset your password, or delete your account.
- **The codes turtl emails** are kept as scrambled copies for one day. **An account whose address is never confirmed** is deleted after 7 days.
- **Everything else** is kept until you delete your account, or ask us to delete it.
- **The other companies** keep what turtl sends them for as long as their own policies say. OpenAI's published policy is up to 30 days.

{% include review.html note="Two things to settle. First, decide whether to keep closed cases for as long as the account exists, or delete them after a set time, and say so here. Second, fill in how long Convex backups live (the blank under Deleting your account)." %}

## Deleting your account

Delete your account in the app: on Projects, tap your picture at the top, then Delete account. It is also at the bottom of a project's settings (the gear), under Account. turtl lists what will go, asks once more, and then signs you out.

Deleting your account removes:

- your projects, with every case, step, decision and message in them;
- the map of your code, and the screenshots turtl took of your app;
- your customers' reports;
- what turtl remembers about past problems and your preferences, including the copies of your code, case notes, preferences and customers' reports held by Supermemory;
- your control tokens and your coding agent key;
- turtl's access to your GitHub repositories: turtl removes its GitHub app from your own GitHub account, unless another turtl account still uses it. From an organization, turtl removes only your connection; its app stays installed there until an owner of the organization removes it in the organization's settings on GitHub;
- your notifications, on every phone;
- your account and the ways you sign in to it. If you signed in with Apple, turtl also tells Apple to end its access.

You are signed out on every phone at once. turtl stops everything it was doing for you, waits a few minutes so that nothing still running can write anything, and then deletes. If another service does not answer, turtl keeps asking it until it confirms. Afterwards turtl keeps only a record that an account was deleted and when, without your email address or anything else about you. Backups are overwritten within {% include blank.html value=site.data.operator.backup_retention_days label="number of days" %} days.

This cannot be undone. If you sign up again with the same address, you get a new, empty account.

{% include review.html note="Revoking a Sign in with Apple token needs the Apple key settings on the production backend (AUTH_APPLE_TEAM_ID, AUTH_APPLE_KEY_ID, AUTH_APPLE_PRIVATE_KEY). Without them turtl keeps no Apple token, so there is nothing to revoke and Apple keeps listing turtl under the person's Apple ID. The deletion has been proven against stand-ins for Apple, GitHub and Supermemory, not the real services (RC-23)." %}

## Your choices
{: #your-choices}

- **Take back permission for AI services**: open a project, tap the gear, then AI services. turtl stops sending new data from that moment.
- **Turn off notifications** in the same settings (Turn off on this phone), or in iOS Settings.
- **Turn off the microphone** in iOS Settings. You can still type.
- **Disconnect GitHub**: open a project, tap the gear, then Disconnect GitHub. turtl removes its GitHub app from your own GitHub account, unless another turtl account still uses it. From an organization, turtl removes only your connection and stops using GitHub for you; turtl's app stays installed there until an owner of that organization removes it in the organization's settings on GitHub. You can also remove turtl from your GitHub account's settings.
- **Delete a customer's report** from its case.
- **Delete your account** as described above. This cannot be undone.
- **Ask for a copy of your data, or for something to be corrected or deleted,** by writing to {% include blank.html value=site.data.operator.contact_email label="contact email" %}. We answer within 30 days.

## If you use the report form
{: #if-you-use-the-report-form}

When your customers send reports through turtl's form in your app, you decide what is collected and why, and turtl handles it for you. That makes you responsible for telling your customers, in your own privacy notice, that their reports go to turtl and to the AI services named above. turtl's form links to this page.

turtl sends the text of a report to OpenAI and Supermemory. It keeps no contact details, and its notifications to you never quote a customer.

A customer who wants a report deleted should ask you: you can delete it from its case, and turtl deletes its copy at Supermemory too. They can also ask us at {% include blank.html value=site.data.operator.contact_email label="contact email" %}.

## Security

Everything travels over encrypted connections. Only your account can reach your projects. Your app's control token, your coding agent key, and the token Apple gives turtl when you sign in with Apple are encrypted, and your sign-in on the phone is kept in the iOS Keychain. No system is perfectly secure; if we learn that your data was exposed, we will tell you without delay.

## Children

turtl is for adults who run an app. It is not for anyone under 18, and we do not knowingly collect data from children. If you believe a child has given us data, write to {% include blank.html value=site.data.operator.contact_email label="contact email" %} and we will delete it.

## Where your data is processed

turtl and the services above process data in the United States. If you use turtl from elsewhere, your data is transferred there.

{% include review.html note="Confirm the region of the production Convex deployment. If turtl will be offered in the EU or the UK, this section needs the legal basis for the transfer, and you need to decide your trader status for Apple (RC-37)." %}

## Your rights

Depending on where you live, you may have the right to see the data we hold about you, correct it, delete it, receive a copy, or object to how it is used. turtl gives everyone these rights, wherever they live. Use the controls above or write to {% include blank.html value=site.data.operator.contact_email label="contact email" %}. We do not sell personal data, and we do not share it for advertising. You may also complain to your local data protection authority.

## Changes

If we change this policy in a way that matters, such as adding a service that receives your data, we will tell you in the app before the change takes effect, and ask your permission again where the change needs it.

## Contact

{% include blank.html value=site.data.operator.legal_name label="legal name" %}<br>
{% include blank.html value=site.data.operator.contact_email label="contact email" %}{% if site.data.operator.postal_address != "" %}<br>{{ site.data.operator.postal_address }}{% endif %}
