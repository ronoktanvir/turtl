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

- turtl sends parts of **your source code**, **the details of each case**, and **your voice recordings** to AI services run by other companies. It asks your permission first, and you can take it back.
- turtl does not sell your data, show ads, or track you across other apps and websites.
- turtl contains no advertising or analytics software.
- You can delete your account and what turtl holds about you from inside the app.

{% include review.html note="The first and last points depend on work that is not finished: the permission screen (checklist RC-26) and account deletion (RC-23). Do not publish them as fact until both are in the build you submit." %}

## What turtl collects

### About you

- **Your account.** The email address you sign in with, your name if you give one or if Apple or GitHub passes it on, and the id Apple or GitHub gives turtl for your account. turtl uses these to sign you in and to keep your projects yours.
- **A passcode, if you set one.** turtl stores a scrambled form of it that cannot be turned back into the passcode. Your phone keeps the passcode itself in its secure storage.

{% include review.html note="Sign-in is being built. Confirm this list against what the accounts work stores before launch (RC-12, RC-19)." %}

### What you connect

- **Your source code.** When you connect a GitHub repository, turtl reads up to 200 source files from it. It keeps a map of your app in plain words: the names of its parts, a sentence about each, and file paths. It does not keep the code in its own database, but it does place a copy with a search service so it can answer your questions (see "Who receives your data").
- **Your live app.** turtl calls your app about once a minute to check its health and to run a test of the journey you chose. It keeps the results: whether each step passed, error codes, error counts, and which version is deployed.
- **Your pull requests.** For a code change turtl proposed: its title, link, and whether its checks pass.

### What you write and say

- **Messages.** What you type to turtl about a case or about your code, and its replies.
- **Decisions.** What you approved, declined, stopped, or merged, and when.
- **Your voice.** When you tap Talk, turtl records up to 30 seconds, turns it into text, and deletes the recording from your phone straight away. turtl does not keep the audio. The text becomes a message in the conversation.

### What your customers send

If you add turtl's report form to your own app, your customers can send a bug report or a feature request of up to 2,000 characters, and may leave an email address or other contact. turtl stores the report, the contact, and a random id that lets it count one person once. See "If you use the report form".

### What turtl does not collect

turtl does not collect your location, your contacts, your photos, an advertising identifier, or a record of how you use the app. It does not read anything from your phone beyond what is listed above. The microphone is the only permission it asks for, and only when you tap Talk.

{% include review.html note="When push notifications are added, turtl will collect a device token to deliver them. Add it here and to the App Privacy answers at that point (RC-12)." %}

## Why turtl uses it

turtl uses what it collects only to do what you installed it for: to notice when your app breaks, work out why, propose and carry out the fixes you approve, check they worked, and answer your questions. It does not use your data for advertising or to build a profile of you, and it does not use it to train AI models.

## Who receives your data

turtl cannot work without these services. Each one receives only what the table says.

<div class="table-wrap" markdown="1">

| Service | What it receives | Why |
| --- | --- | --- |
| **OpenAI** (AI) | Excerpts of your source code, case details, your messages, your customers' reports, and your voice recordings | To name the parts of your app, diagnose a problem, propose fixes, answer questions, sort customers' reports, and turn speech into text and text into speech |
| **Supermemory** (AI search) | Up to 30,000 characters of each source file, notes on past cases, your questions about the code, and your customers' reports | To find the code and the past cases that matter to a question or a new problem |
| **Capy** (AI coding agent) | The title of a case and the instructions for a code change you approved. Capy then works in your repository through its own connection to GitHub | To write the change and open a pull request for you to review |
| **GitHub** | Requests to read your repository and your pull requests, and to merge a pull request when you tap Merge | To read your code and carry out your decision |
| **Revyl** | A request to run a test of your app on a phone in its cloud. It sends back screenshots | To check on a device that a fix worked |
| **Keiki** (uses AI) | A notice of one or two sentences, such as the name of your app and the title of a case, and the phone number alerts go to | To text you when a case needs you |
| **Convex** | Everything turtl stores | It hosts turtl's database and files |

</div>

Each of these companies handles what it receives under its own terms, which you can read here: [OpenAI](https://openai.com/policies/privacy-policy/), [Supermemory](https://supermemory.ai/privacy/), [Capy](https://capy.ai/privacy-policy), [GitHub](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement), [Revyl](https://revyl.com/privacy/), [Keiki](https://onkeiki.com/privacy), [Convex](https://www.convex.dev/legal/privacy). We require each of them to protect your data at least as well as this policy does.

{% include review.html note="The last sentence is a promise Apple requires (guideline 5.1.1(i)). It is only true once you have accepted a data processing agreement with each vendor. None is on file today (RC-28)." %}

We also disclose data when the law requires it, and to a new operator if turtl is ever sold or merged, who would be bound by this policy.

turtl sends nothing to these services until you say it may. The first time you use turtl it shows you this list and asks. If you say no, turtl still shows you your cases and the results of its checks, but it cannot diagnose, propose fixes, or answer questions.

{% include review.html note="This paragraph describes the permission screen, which is not built yet. Rewrite it to match what the screen really does, including what still works after someone says no (RC-26)." %}

## How long turtl keeps it

- **Voice recordings** are not kept. OpenAI's published policy says it keeps no copy of audio sent for transcription.
- **Everything else** is kept until you delete it, delete your account, or ask us to delete it.
- **When you delete your account,** turtl deletes your projects, cases, messages, decisions, the map of your code, and screenshots from its own database, and deletes the copies of your code, case notes, and customers' reports held by Supermemory. Backups are overwritten within {% include blank.html value=site.data.operator.backup_retention_days label="number of days" %} days.
- **The other companies** keep what turtl sends them for as long as their own policies say. OpenAI's published policy is up to 30 days.

{% include review.html note="Three things to settle. First, today nothing is ever deleted, in turtl or in Supermemory: the deletion described here has to be built (RC-23). Second, decide whether to keep closed cases forever or delete them after a set time, and say so here. Third, fill in how long Convex backups live." %}

## Your choices
{: #your-choices}

- **Take back permission for AI services** in the app's settings. turtl stops sending new data from that moment.
- **Turn off the microphone** in iOS Settings. You can still type.
- **Delete your account** in the app's settings. This cannot be undone.
- **Ask for a copy of your data, or for something to be corrected or deleted,** by writing to {% include blank.html value=site.data.operator.contact_email label="contact email" %}. We answer within 30 days.
- **Disconnect GitHub** in the app's settings, or remove turtl from your GitHub account.

{% include review.html note="The first, third, and fifth controls do not exist in the app yet (RC-23, RC-26). Remove any that will not be in the build you submit." %}

## If you use the report form

When your customers send reports through turtl's form in your app, you decide what is collected and why, and turtl handles it for you. That makes you responsible for telling your customers, in your own privacy notice, that their reports go to turtl and to the AI services named above.

turtl sends the text of a report to OpenAI and Supermemory. It does not send a customer's contact details to any AI service, and its alerts to you never quote a customer.

A customer who wants a report deleted should ask you. You can ask us at {% include blank.html value=site.data.operator.contact_email label="contact email" %}, and so can they.

{% include review.html note="A customer's contact is stored as written, with no encryption beyond the database's own, and there is no control for deleting one report (RC-25)." %}

## Security

Everything travels over encrypted connections. Access to your projects is limited to your account. Secrets that turtl needs on your phone are kept in the iOS Keychain. No system is perfectly secure; if we learn that your data was exposed, we will tell you without delay.

{% include review.html note="The second sentence depends on the access checks in the accounts work, which have not landed (RC-30)." %}

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
