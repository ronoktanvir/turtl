# Hackathon log

- **Project:** turtl
- **What it does:** A mobile on-call app for people who own a live app and have no operations team, tracking each incident as a series of steps from detection to learning.
- **Live app:** not deployed
- **Repo:** https://github.com/ronoktanvir/turtl
- **Frontend:** not deployed
- **Convex deployment:** not deployed
- **Components:** none
- **Convex features:** schema, tables, indexes, queries, realtime queries
- **Auth:** none
- **AI models:** none
- **Started:** 2026-11-15T20:37:34Z
- **Last updated:** 2026-11-15T20:38:55Z

## Log

### 2026-11-15 - 296ab0f
Scaffolded the Expo Router app in TypeScript with a root layout and a home screen (`app.json`, `package.json`, `app/_layout.tsx`, `app/index.tsx`).

### 2026-11-15 - e4361a4
Wired the app to Convex and defined the incident model: an `incidents` table and a `steps` table with a `by_incident` index, with the eight stages and the incident and step statuses defined once in `convex/constants.ts`. The home screen shows a live incident count from the `incidents.list` query, and shows a notice when the backend URL is not configured. The README documents the stack and how to run it. Convex features: schema, tables, indexes, query, realtime queries (`convex/schema.ts`, `convex/incidents.ts`, `app/index.tsx`, `app/_layout.tsx`).
