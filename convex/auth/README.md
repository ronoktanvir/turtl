# Accounts and sign-in

Sign-in runs on [Convex Auth](https://labs.convex.dev/auth) (`@convex-dev/auth`, pinned at 0.0.98, the stable line),
inside this backend. There is no separate sign-in service.

It matters only with `AUTH_REQUIRED=true` ("accounts mode", see `convex/access.ts`). Without it the backend is the
single-owner demo: the app's Login buttons go straight to Home and nobody signs in.

## Methods

| Method | How | Files |
| --- | --- | --- |
| Email and password | Convex Auth's credentials flow. Passwords are hashed with Scrypt. Reset by an emailed 8-digit code, only when an email service is set up. | `password.ts`, `email.ts`, `rules.ts` |
| Sign in with Apple | The iPhone's own sheet (`expo-apple-authentication`). The app sends Apple's identity token and a nonce; `apple.ts` checks the token's signature against Apple's published keys, the issuer, the audience (the bundle id), the expiry, and that the token carries the SHA-256 of that nonce. Each nonce works once. | `apple.ts` |
| Sign in with GitHub | OAuth through the same GitHub App that reaches repositories (its client id and secret). The app opens GitHub in a browser sheet and comes back to `turtl://` with a one-time code. | `../auth.ts` |

Accounts are never merged by email: each method makes its own account. GitHub can hand over an address its user has
not verified, so linking on it would let someone take over another person's account.

## What is stored

Convex Auth's tables (`schema.ts`): `users` (email, and a name and picture when Apple or GitHub passes one on),
`authAccounts` (which methods a person uses, Apple's or GitHub's id for them, a password hash), `authSessions`,
`authRefreshTokens`, `authVerificationCodes` (reset codes, hashed), `authVerifiers`, `authRateLimits`. And turtl's
`authAppleNonces`: hashes of Apple nonces already used, each deleted once its token has expired.

On the phone the session is kept in the iOS Keychain (`data/account/storage.ts`).

## The app's side

`data/account` says who is signed in (`useAccount()`), signs in and out (`useAccountActions()`), and lets other
parts of the app clear what they keep for the person before the session ends (`onSignOut()`).
`components/account/AccountGate.tsx` keeps signed-out people on Login, and makes a store build refuse a backend
with accounts off.

The backend's own questions: `users.mode` (before sign-in: accounts on or off, GitHub set up, reset set up),
`users.viewer` (the signed-in person, or null), `users.account` (the account id through `internal.access.account`).

## Setting it up on a deployment

The variables, and whether production needs them, are in `release/backend-env.mjs`.

1. Make the token keys once (they never leave your machine except into the deployment):

   ```sh
   node -e 'import("jose").then(async({generateKeyPair,exportPKCS8,exportJWK})=>{const k=await generateKeyPair("RS256",{extractable:true});const priv=await exportPKCS8(k.privateKey);const pub=await exportJWK(k.publicKey);process.stdout.write(JSON.stringify({JWT_PRIVATE_KEY:priv.trimEnd().replace(/\n/g," "),JWKS:JSON.stringify({keys:[{use:"sig",...pub}]})}))})' > auth-keys.json
   ```

   Set `JWT_PRIVATE_KEY` and `JWKS` from that file with `npx convex env set "NAME=value"` (the `NAME=value` form,
   because the key starts with a dash), then delete the file. Changing the keys later signs everyone out.
2. `SITE_URL`: the turtl site, `https://ronoktanvir.github.io/turtl`.
3. `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET`: the GitHub App's client id and a client secret. The app's callback
   URL list must include `https://<deployment>.convex.site/api/auth/callback/github`.
4. Optional, for password reset: `AUTH_RESEND_KEY` and `AUTH_EMAIL_FROM`.
5. `AUTH_REQUIRED=true`.
6. Check with `npx convex run auth/settings:check`. It lists what is missing, by name only.

The App Review account: `npx convex run auth/review:ensureAccount '{"email":"…","password":"…"}'`. It creates
the account or sets a new password on it; sessions already open stay open.

## Tests

`tests/accounts.test.mjs` runs these modules against `tests/fixtures/auth-stand-in.mjs`, a stand-in for GitHub's
OAuth pages, Apple's keys and Resend. `AUTH_STAND_IN_URL` points a deployment at the same stand-in; it must never
be set in production. With `AUTH_REQUIRED=true` the backend honours it only when it runs locally (its own address is
localhost, `convex/demoSettings.ts`), so a hosted deployment where it was set by mistake still asks Apple, GitHub and
Resend themselves.
