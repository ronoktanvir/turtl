# Screenshots

What Apple requires today, what to capture, and how. Nothing here has been captured yet: final screenshots come from the build that is submitted (RC-10 and RC-11 in [the checklist](review-checklist.md)).

## What Apple requires

Read on 15 November 2026 from [Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications).

| Rule | Value |
| --- | --- |
| Required for an iPhone app | At least one screenshot for **iPhone with Dynamic Island (medium display)** |
| That size, portrait | **1206 × 2622** pixels (iPhone 17, 17 Pro, 16 Pro) or **1179 × 2556** (iPhone 16, 15) |
| Optional larger size | iPhone with Dynamic Island (large display): 1320 × 2868, 1290 × 2796, or 1260 × 2736 |
| How many | 1 to 10 for each size |
| Format | `.png`, `.jpg`, or `.jpeg`, with no transparency |
| Other sizes | Scaled by Apple from the ones provided |
| iPad | Not needed. turtl does not declare iPad support |
| iPhone Duo | Not needed yet. Apple will require it from April 2027 for apps built with the iOS 27.1 SDK or later |

**Plan:** capture every shot at 1206 × 2622 on an iPhone 17 Pro simulator. Capture the same shots at 1320 × 2868 on an iPhone 17 Pro Max simulator as well, so the largest phones do not show a scaled image. The app is locked to portrait, so there are no landscape shots.

## The shots

Apple's rules for these, from the guidelines:

- They "should show the app in use, and not merely the title art, login page, or splash screen" (2.3.3). No shot is the sign-in screen.
- They show "fictional account information instead of data from a real person" (2.3.9). See "The data in the shots".
- No price and no claim that cannot be checked (2.3.7). No captions such as "the best" or "instant".
- Fit for all ages (2.3.8), and no other platform's devices or badges (2.3.10).

The first three appear in search results, so they carry the whole pitch.

| # | Screen | What must be on it | Caption |
| --- | --- | --- | --- |
| 1 | A case, Overview | The turtle, "Users affected", the case title, what it means for customers | On call for your app, so you don't have to be |
| 2 | Fixes for that case | Two or three fixes, one marked Recommended | It works out the cause and proposes the fix |
| 3 | One fix, open | Why, Trade-offs, Plan, and the Approve button | Nothing changes until you approve |
| 4 | A case, Logs | The failed step and the evidence behind the diagnosis | See the evidence, in plain words |
| 5 | A code change in progress | The pull request link, its checks, and Merge | Code changes arrive as a pull request |
| 6 | The case after the fix | "All clear" and the journey passing again | It checks that the fix worked |
| 7 | Investigate | The map of the code, with one part selected | Your code, explained in plain words |
| 8 | Chat on a case | A question and turtl's answer, with Talk visible | Ask about a case, out loud or in writing |
| 9 | Features | Customers' requests grouped into cases, with counts | Ten complaints, one case |
| 10 | Project home with the gear sheet open | "Who approves fixes", You selected | You decide what turtl does alone |

Captions go above the screenshot on a plain background in the app's colours (`theme/tokens.ts`), set in Capriola, the app's own font. Keep the phone frame out, or use Apple's own device frames from [Apple Design Resources](https://developer.apple.com/design/resources/). An overlay is allowed; a mock-up that is not the app is not.

Shots 7 and 8 depend on features that a backend setting switches on. If a feature is off in the build that is submitted, drop its shot.

## The data in the shots

Use the review account, on the backend the store build talks to. It holds one project connected to the demo app, so the shots match what the reviewer sees.

- **Owner:** a made-up name and a neutral profile picture. The photo compiled into the app today has to be gone first (RC-04).
- **Project:** a made-up business. A booking app works well because the demo app is one.
- **Customers' reports:** written for the shot. No real person's words, email, or phone number.
- **Repository:** a demo repository, not `ronoktanvir/turtl` and not a customer's.
- **Status bar:** 9:41, full battery, full signal. The script sets it.

Do not capture from the example data. Its four projects are named after real projects.

## How to capture

This needs a Mac with Xcode. It was written on Linux and **has not been run**; see "Not verified".

1. Build the app for the simulator and install it. The store build thread owns the build profiles; with a simulator profile it is:

   ```sh
   eas build --platform ios --profile <the simulator profile> --local --output turtl.tar.gz
   tar -xzf turtl.tar.gz
   xcrun simctl boot "iPhone 17 Pro"
   xcrun simctl install booted turtl.app
   ```

   Without EAS, `npx expo run:ios --configuration Release --device "iPhone 17 Pro"` does the same on a Mac. Either way the build must point at the backend that holds the review account, and must not set `EXPO_PUBLIC_DATA_SOURCE` or `EXPO_PUBLIC_DEV_TOOLS`.

2. Open the app in the simulator and sign in with the review account once. The simulator remembers it.

3. Run the script. It sets the status bar, opens each screen it can reach by link, waits for you to arrange the rest by hand, captures, and checks the size and that there is no transparency.

   ```sh
   store/screenshots/capture.sh "iPhone 17 Pro" <project id> <case id>
   store/screenshots/capture.sh "iPhone 17 Pro Max" <project id> <case id>
   ```

   Files land in `store/screenshots/out/<device>/`, numbered in the order above. That folder is ignored by git: the finished images are uploaded to App Store Connect, not committed.

4. Add the captions in a design tool, export at the same pixel size with no transparency, and upload them on the version's page in App Store Connect.

`eas metadata:push` can upload screenshots too, from a `screenshots` entry under `info.en-US` in `store.config.json`, keyed by App Store Connect's name for each display size. Upload by hand the first time, then run `eas metadata:pull` to see the keys App Store Connect uses, and add them to the file from then on.

## Not verified

- `capture.sh` has not been run. This machine has no macOS, Xcode, or simulator. Its shell syntax is checked (`bash -n`) and nothing else.
- The link each screen opens at. They are read from the routes under `app/` at the audited commit, and sign-in may add a step in front of them.
- The App Store Connect display-size keys for `eas metadata:push`, which is why the plan uploads by hand first.
