# What App Review reads, apart from the app

Everything Apple reads or asks for when turtl is submitted, other than the build itself. It was first written from the code at commit `3d01f64` on 15 November 2026; the commit the audit now describes is `auditedCommit` in [`data-practices.json`](data-practices.json), and every code link in `store/*.md` is pinned to it.

| File | What it is |
| --- | --- |
| [`data-practices.md`](data-practices.md) | The audit: what turtl collects, where it goes, and how long it is kept, with a link to the line of code behind every claim |
| [`data-practices.json`](data-practices.json) | The same outside services as data: each one's name, what it receives, why, its settings, and its policy. The AI permission screen is built from it: `convex/consent/services.ts` imports it, and asks permission for every service marked `needsPermission` |
| [`app-privacy.md`](app-privacy.md) | The answers to App Store Connect's App Privacy questions, in Apple's categories, and the privacy manifest values for the build |
| [`review-checklist.md`](review-checklist.md) | Apple's guidelines, line by line: what is true today, what is missing, and which piece of work closes it |
| [`review-notes.txt`](review-notes.txt) | The notes the reviewer reads |
| [`screenshots.md`](screenshots.md) | The sizes Apple requires, the ten shots and their captions, and how to capture them |
| [`check.mjs`](check.mjs) | Checks all of the above against the repository |
| [`../store.config.json`](../store.config.json) | The listing: name, subtitle, description, keywords, categories, age rating answers, and the three addresses |
| [`../store.config.js`](../store.config.js) | Adds what cannot be committed: the copyright holder, and App Review's contact and sign-in |
| [`../site/`](../site/README.md) | The privacy policy, terms of use, and support page |
| [`../components/legal/`](../components/legal/LegalLinks.tsx) | The Privacy policy, Terms, and Support links in the app's gear sheet |

## The three addresses

| Page | Address |
| --- | --- |
| Privacy policy | https://ronoktanvir.github.io/turtl/privacy/ |
| Terms of use | https://ronoktanvir.github.io/turtl/terms/ |
| Support | https://ronoktanvir.github.io/turtl/support/ |

They are written in three places that have to agree: `store.config.json`, `components/legal/links.ts`, and the `permalink` of each page in `site/`. A test in `tests/store-listing.test.mjs` fails if they do not. To move to a domain of turtl's own, change the address in the first two and point the domain at GitHub Pages.

## Checking it

```sh
node store/check.mjs             # is the pack consistent with itself and the code?
node store/check.mjs --release   # is it ready to submit? Fails on every blank, open note, and open checklist line
node store/check.mjs --open      # the checklist's open lines, for each owner
```

| Line | What it checks | Fails the plain run |
| --- | --- | --- |
| Listing | Apple's limits on the name, subtitle, promotional text, description, keywords, and review notes; no price in the name, subtitle, promotional text, or keywords; every required age rating answer | Yes |
| Addresses | The listing, the app's links, and the pages name the same addresses; every service in the audit is named in the privacy policy | Yes |
| Code references | Every link in `store/*.md` points at the audited commit, and its line still contains the text in the link's title | Yes |
| Since the audit | Audited files that have changed, and outside addresses, settings, and libraries the audit has not seen | No |
| Blanks | Empty values in `site/_data/operator.json` | No |
| Notes on the pages | "To confirm before launch" notes still shown | No |
| Review variables | Which `APP_REVIEW_*` variables are not set in this shell | No |
| Checklist | Open lines, for each owner | No |

`tests/store-listing.test.mjs` (in `npm run test:ci` and `npm run test:ui`) checks only the first two, so another pull request cannot fail because the audit has aged.

### When the code changes

A new outside address, setting, or library under "Since the audit" means data may be going somewhere new. For each one:

1. Read the code that uses it and add what it sends to `data-practices.md`.
2. Add it to `data-practices.json`: under a service, or under `otherHosts`, `otherSettings`, or `libraries` with a word on why it is not a data flow.
3. If it is a new service that receives personal data, add it to the table in `site/privacy.md` and to `app-privacy.md` if it changes an answer. A service marked `needsPermission: true` joins the AI permission screen by itself, and every account is asked again (`convex/consent/README.md`); `tests/consent-gate.test.mjs` pins which services are asked and which are named as used without asking, so change it with the list.

To move the whole audit to a newer commit, replace the commit id in `data-practices.json` and in every link, then run the check. It names each link whose line no longer holds its text, and the line the text has moved to.

## What Ronok fills in

| Where | What |
| --- | --- |
| `site/_data/operator.json` | `legal_name`, `contact_email`, `governing_law`, `effective_date`, `backup_retention_days`, `support_reply_days`, and optionally `postal_address`. [`site/README.md`](../site/README.md) says what each one is |
| `site/_data/operator.json` | `show_review_notes`: set to `false` once every note on the pages is settled |
| Repository settings | Settings → Pages → Source: GitHub Actions, so the pages are published |
| The shell that runs `eas metadata:push` | `APP_REVIEW_FIRST_NAME`, `APP_REVIEW_LAST_NAME`, `APP_REVIEW_EMAIL`, `APP_REVIEW_PHONE` (with country code, such as +1 555 010 0000), `APP_REVIEW_DEMO_USERNAME`, `APP_REVIEW_DEMO_PASSWORD`. Never commit them |
| The checklist | Every line marked **Ronok** |

## Sending the listing to App Store Connect

This needs an Apple Developer membership and an app record in App Store Connect, neither of which exists yet. `eas.json` already points `eas submit` at the dynamic file (`submit.production.ios.metadataPath` is `./store.config.js`). Then, with the six variables above set:

```sh
npx eas-cli metadata:lint   # checks the file against Expo's schema, offline
npx eas-cli metadata:push   # sends it
```

`store.config.js` leaves the reviewer's details out when none of the six variables is set, and stops with the missing names when only some are. It takes the copyright line from `legal_name` and the notes from `review-notes.txt`.

`eas metadata:push` does not send the App Privacy answers, the price, the countries, or the trader status for the European Union. Those are typed into App Store Connect (RC-12, RC-07, RC-37, and RC-38 in the checklist).

## Choices made in the listing

Each of these is Ronok's to change.

- **Name: "turtl".** An app called "Turtl: Private File Sharing" is already on the App Store, so Apple may refuse the bare name. "turtl: on-call for your app" is 27 characters and would fit. See RC-13.
- **Subtitle: "On-call for your live app".** 25 of 30 characters, and no claim that cannot be checked.
- **Categories: Developer Tools, then Productivity.** The people turtl is for run software, even when they cannot read code. Business is the alternative if turtl is aimed at owners who would not look under Developer Tools.
- **Keywords.** Eleven, 99 of 100 bytes. No brand names and nothing that repeats the name, the subtitle, or a category, since Apple indexes those already.
- **No price anywhere.** turtl is free at launch, and the store shows that itself.
- **Released by hand.** `automaticRelease` is `false`, so an approved build waits for Ronok.

## The age rating answers

Every answer is "none" or "no", which Apple rates 4+. Three of them a reviewer might question:

- **Messaging and chat: no.** Apple's definition is "Users can directly communicate with one another". An owner talks to turtl, not to another person.
- **User-generated content: no.** Apple's definition is "the broad distribution of content created by users". Nothing an owner or their customer writes is shown to anyone but that owner.
- **Unrestricted web access: no.** The app has no browser. Links open in Safari; signing in with GitHub opens GitHub's own page in the system's sign-in sheet and comes back to the app.

turtl is still for adults, and the terms say 18 and over. That is a condition of use, not a content rating.
