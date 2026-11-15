# turtl

turtl is a mobile on-call app for people who own a live app and have no operations team. It tracks each incident as a series of steps, from detecting a problem to learning from it. `turtl` is the working name.

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

The `incidents` and `steps` tables are defined in `convex/schema.ts`. The stage list, statuses, validators, and types are defined once in `convex/constants.ts`, which both the Convex functions and the app import. Do not redefine them elsewhere.

`convex/_generated/` is committed; regenerate it with `npx convex dev` when you change the schema or functions.
