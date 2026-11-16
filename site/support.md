---
title: Support
description: How to reach a person about turtl, and answers to common questions.
permalink: /support/
root: ../
---

## Reach a person

Write to {% include blank.html value=site.data.operator.contact_email label="contact email" %}. Say which project it is about and what you saw, and attach a screenshot if you can. We reply within {% include blank.html value=site.data.operator.support_reply_days label="number of working days" %} working days.

If you think you have found a security problem, write to the same address and put "Security" in the subject line. Please do not post it in public first.

{% include blank.html value=site.data.operator.legal_name label="legal name" %}{% if site.data.operator.postal_address != "" %}<br>{{ site.data.operator.postal_address }}{% endif %}

## Common questions

### What does turtl need from me?

An account (email and password, Sign in with Apple, or GitHub; with an email address, you confirm it with a code turtl emails you), a GitHub repository, and a live app to watch. turtl reads the repositories you choose, checks the app regularly, and opens a case when a check fails or a customer reports a problem. To have turtl write code changes, add your own Capy key in Settings, under Coding agent. To see how it works first, tap Try a practice app on Projects before you add a project, or in Add project: turtl runs a small booking app for you to break on purpose and watch it fix.

### Why does turtl ask for my microphone?

Only so you can ask about a case out loud. It listens after you tap Talk, for up to 30 seconds at a time, and shows that it is listening. The recording is turned into text and is not kept. You can say no and type instead.

### Which AI services see my code?

OpenAI, Supermemory, and Capy, and only after you allow it on the screen turtl shows before it uses AI. The [privacy policy](../privacy/) lists what each one receives and why.

### How do I stop turtl sending my data to AI services?

Open a project, tap the gear, then under AI services tap Take back. turtl still watches your app, runs its checks, and offers the recovery steps you set up, but it cannot diagnose with AI, propose AI fixes, answer questions, or write code changes until you allow it again.

### Does turtl notice when my app is down?

turtl opens a case when one of your app's checks runs and fails, or when a customer reports a problem. If your app does not answer at all, no case opens and no notification is sent, so look at the project if you have not heard from turtl for a while.

### How do I reset my password?

On Log in, tap Forgot your password? and enter your address. turtl emails you a link and a code; the first reset email of the day is always sent, even on a busy day. Tap the link on the phone where you asked, or paste the code; some mail apps do not open turtl's link, and pasting always works.

### Can turtl change my app without asking?

No. A fix runs only when you approve it. A code change arrives as a pull request and merges only when you tap Merge and its checks pass. If you turn on Auto for a project, turtl may repeat one recovery it has already proven twice, at most three times, and it tells you each time. You can switch back to You in the same place.

### How do my customers' reports reach turtl?

Through a report form you add to your own app. Reports about the same problem are grouped into one case. You must tell your customers that their reports are sent to turtl; the [terms](../terms/) and the [privacy policy](../privacy/) explain why.

### How do I delete my account?

On Projects, tap your picture at the top, then Delete account. It is also at the bottom of a project's settings (the gear), under Account. turtl shows what will be deleted and asks once more. This deletes your projects, cases, messages, customers' reports, the copies our search provider holds, and turtl's access to GitHub, and cannot be undone. The [privacy policy](../privacy/) lists everything it removes. If you cannot sign in, write to us and we will delete it for you.

### How do I disconnect GitHub?

In the app, open a project, tap the gear, then Disconnect GitHub. turtl says what will stop and asks once more. turtl removes its app from your own GitHub account; from an organization it removes only your connection, and an owner of that organization removes the app on GitHub. You can also remove turtl from your GitHub account's settings under Applications.

### How do I turn notifications on or off?

Open a project and tap the gear. Under Notifications, tap Turn on notifications, or Turn off on this phone. iOS Settings can also turn them off. A notification says only your project's name and that a case needs you, or that a fix you allowed has run.
