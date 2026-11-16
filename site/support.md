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

A GitHub repository and a live app to watch. turtl reads the repository, checks the app about once a minute, and opens a case when a check fails.

### Why does turtl ask for my microphone?

Only so you can ask about a case out loud. It listens after you tap Talk, for up to 30 seconds at a time, and shows that it is listening. The recording is turned into text and is not kept. You can say no and type instead.

### Which AI services see my code?

OpenAI, Supermemory, and Capy. The [privacy policy](../privacy/) lists what each one receives and why.

### How do I stop turtl sending my data to AI services?

Open a project, tap the gear, and turn off AI services. turtl will still show your cases and the results of its checks, but it cannot diagnose, propose fixes, or answer questions.

### Can turtl change my app without asking?

No. A fix runs only when you approve it. A code change arrives as a pull request and merges only when you tap Merge and its checks pass. If you turn on Auto for a project, turtl may repeat one recovery it has already proven twice, at most three times, and it tells you each time. You can switch back to You in the same place.

### How do my customers' reports reach turtl?

Through a report form you add to your own app. Reports about the same problem are grouped into one case. You must tell your customers that their reports are sent to turtl; the [terms](../terms/) and the [privacy policy](../privacy/) explain why.

### How do I delete my account?

Open a project, tap the gear, then Account, then Delete account. This deletes your projects, cases, and messages, and cannot be undone. If you cannot sign in, write to us and we will delete it for you.

### How do I disconnect GitHub?

In the app, open a project, tap the gear, then Account. You can also remove turtl from your GitHub account's settings under Applications.

{% include review.html note="Four answers describe controls that are not in the app yet: turning off AI services (checklist RC-26), deleting an account (RC-23), and disconnecting GitHub in two places. Change each answer to match the build you submit." %}
