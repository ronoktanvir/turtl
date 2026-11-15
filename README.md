# turtl

turtl is a mobile on-call app for people who own a live app and have no operations team. It tracks each case (an outage, a bug report, or a feature request) as a series of steps, from detecting a problem to learning from it. `turtl` is the working name.

## Stack

- Expo (React Native) with Expo Router and TypeScript
- Convex for the backend and live queries
- npm, with a committed `package-lock.json`

## Run it

```sh
npm install
npx convex dev    # in one terminal: syncs convex/ and writes .env.local
npx expo start    # in another terminal
```

The app reads the backend URL from `EXPO_PUBLIC_CONVEX_URL`. `npx convex dev` writes it to `.env.local`, which Git ignores; `.env.example` shows the shape. If the variable is missing, the app shows a screen saying the backend URL is not configured.

## Data shapes

The `cases` and `steps` tables are defined in `convex/schema.ts`. The stage list, statuses, validators, and types are defined once in `convex/constants.ts`, which both the Convex functions and the app import. Do not redefine them elsewhere.

`convex/_generated/` is committed; regenerate it with `npx convex dev` when you change the schema or functions.

## Dev tools

Development-only controls create sample cases (one outage, one bug report, one feature request, each with its eight steps) and move them through their steps, so the app can be shown and tested without real detection. Two switches must both be on, or the app shows no trace of the tools:

- Server: the Convex environment variable `DEV_TOOLS_ENABLED` must be `true`. Without it every function in `convex/dev.ts` except `status` refuses to run. Turn it on for your deployment with `npx convex env set DEV_TOOLS_ENABLED true`.
- Client: the app renders the "Dev" pill only when `__DEV__` is true (a development build) or `EXPO_PUBLIC_DEV_TOOLS` is `1` (set it in `.env.local` or in the build environment for a release build), and only when the server reports the tools as enabled.

The pill opens a panel with New sample cases, Advance (one step on the first unfinished sample case), Auto-run (all unfinished sample cases to done, about one step every 1.2 seconds) and Reset samples (deletes the sample cases and their steps only).
