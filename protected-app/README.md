# Still: the booking screen turtl protects

This Expo Router app is the customer-facing booking demo, not turtl's on-call UI. It has its own package and lockfile but **no Convex folder or separate backend**. Its customer calls use `api.bookingDemo.booking.*` from the root generated API. The booking backend and its namespaced tables live in `../convex/bookingDemo/` on turtl's deployment.

## Start it for the demo video: one command

From the repository root, with Node/npm installed:

```sh
EXPO_PUBLIC_CONVEX_URL=https://patient-kudu-956.convex.cloud npm --prefix protected-app run demo
```

That command installs this app's locked dependencies and starts Expo web. Open the local URL printed by Expo (normally `http://localhost:8081`). The deployment URL is supplied through the environment; it is never hard-coded in the app. This assumes the merged root booking backend has been deployed and configured by orca. No sign-in or model key is required.

If dependencies are already installed, skip the installation with:

```sh
EXPO_PUBLIC_CONVEX_URL=https://patient-kudu-956.convex.cloud npm --prefix protected-app run web
```

Alternatively, copy `.env.example` to `.env.local` in this folder and set the public Convex **API** URL there, then run `npm --prefix protected-app run demo`. Restart Expo after changing it. The API URL ends in `.convex.cloud`; do not use the `.convex.site/booking-demo` HTTP control URL for this frontend.

## Local backend and verification

Run the repository's root Convex backend locally, then supply its API URL rather than the hosted one:

```sh
EXPO_PUBLIC_CONVEX_URL=http://127.0.0.1:3210 npm --prefix protected-app run demo
```

The local backend must include the root `convex/bookingDemo/` functions. This frontend never deploys a backend, changes its settings, or receives control credentials. Its Metro configuration watches the repository parent only so it can load the root generated API proxy, resolving dependencies from this app's own installation.

Typechecks are separate:

```sh
npm run typecheck
npm --prefix protected-app run typecheck
```

The root TypeScript project excludes this folder so each app checks against its own dependencies. No root package script, on-call route, or Revyl configuration is changed.

## What to show

A customer chooses a treatment and a time, submits without signing in, and receives a confirmation backed by a stored booking. Prices and appointment slots are illustrative; no payment or personal information is collected. Multiple demo bookings may choose the same slot.

The optional service suggestions come from a simulated upstream provider inside the backend, not real AI. **The coupling is deliberately staged:** when `recommendationsEnabled` is true and the staged `providerTimeout` is on, the optional provider prevents booking. The customer sees “We couldn't save your spot.” and a structured error reference. Turning recommendations off restores booking even while that provider timeout remains on.

The independent **staged** `bookingStoreFailure` is the counterexample: the same visible failure persists with recommendations on or off and has code `BOOKING_STORE_UNAVAILABLE`. Do not present either switch as a real production outage or the flag recovery as a permanent repair.

Use turtl's existing development controls or its authenticated `/booking-demo` HTTP surface to stage/reset these backend conditions; this screen has no admin switches or credentials. See `../convex/bookingDemo/README.md` for the control boundary, environment configuration, and fixture-only server checks. Reload the page after changing the provider timeout to refresh suggestions; recovery-flag changes update live.

Below the booking card, "Report a problem" and "Request a feature" send a customer's words to turtl. That form lives in `report/`, a self-contained folder another owner can copy into their own app; `report/README.md` says how, what the customer sees, and what is sent. The demo sets its address from `EXPO_PUBLIC_CONVEX_URL` and its key from `EXPO_PUBLIC_TURTL_INTAKE_KEY`.

The root Revyl build remains the on-call app's build, not a proof of this booking screen. This frontend adds no Revyl project or native proof configuration.
