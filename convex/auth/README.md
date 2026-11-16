# Accounts and sign-in

Sign-in runs on [Convex Auth](https://labs.convex.dev/auth) (`@convex-dev/auth`, pinned at 0.0.98, the stable line),
inside this backend. There is no separate sign-in service.

It matters only with `AUTH_REQUIRED=true` ("accounts mode", see `convex/access.ts`). Without it the backend is the
single-owner demo: the app's Login buttons go straight to Home and nobody signs in.

## Methods

| Method | How | Files |
| --- | --- | --- |
| Email and password | Convex Auth's credentials flow. Passwords are hashed with Scrypt. Reset by an emailed 8-digit code, only when an email service is set up. | `password.ts`, `email.ts`, `rules.ts` |
| Sign in with Apple | The iPhone's own sheet (`expo-apple-authentication`). The app sends Apple's identity token and a nonce; `apple.ts` checks the token's signature against Apple's published keys, the issuer, the audience (the bundle id), the expiry, and that the token carries the SHA-256 of that nonce. Each nonce works once. The app also sends Apple's one-time authorization code, which is traded for Apple's refresh token so it can be revoked when the account is deleted, as Apple requires (`appleTokens.ts`). A failed trade never stops the sign-in. | `apple.ts`, `appleTokens.ts` |
| Sign in with GitHub | OAuth through the same GitHub App that reaches repositories (its client id and secret). The app opens GitHub in a browser sheet and comes back to `turtl://` with a one-time code. | `../auth.ts` |

Accounts are never merged by email: each method makes its own account. GitHub can hand over an address its user has
not verified, so linking on it would let someone take over another person's account.

## Keeping a stranger from locking an owner out

Convex Auth refuses an account's password after 10 wrong ones in an hour, checked before the password, so anyone who
knows an owner's address can keep the right password refused. The reset is the owner's way back in, and turtl keeps it
open (`email.ts`):

- A reset code is never replaced while it still works: asking again sends nothing, and the code already in the
  owner's inbox keeps working (at most one email a minute either way).
- Wrong codes count against the code, not the address: each code takes 5 tries and is then dropped, and anyone may
  ask for a new one, which only the owner receives. Codes are checked by account (`accountId`), so Convex Auth's own
  count of wrong codes per address never applies.
- A reset that works clears the account's count of wrong passwords, so the new password works at once everywhere.

What is left: a stranger can still keep the password count spent, and can use up each new code with 5 wrong guesses
as soon as it is sent, so a determined script can delay a reset. Telling the owner's own phone apart from a stranger's
(App Attest, or a code bound to the device that asked) is out of scope for now. `authPasswordResets` holds one row per
account with a reset under way (when its code was asked for, how many tries it has had), deleted when the reset
succeeds.

Sign-up says "There's already an account for this email" plainly, with what to do next. A sign-up that works signs in at
once, so a refusal reads differently from success whatever its words; only a code emailed in both cases could hide it.
Sign-in and reset never reveal whether an address has an account.

## Limits on new accounts, and why there is no email check yet

With `AUTH_REQUIRED=true` the deployment makes at most `NEW_ACCOUNTS_PER_HOUR` and `NEW_ACCOUNTS_PER_DAY` new
accounts, by any method (`convex/spend/ceilings.ts`, called from the `afterUserCreatedOrUpdated` callback in
`../auth.ts`). Every spending limit is per account, so these and the deployment's daily model ceiling are what bound a
script that makes accounts.

Checking an email address before an account may spend needs an email to send, and an email service has not been
chosen. Reset switches on with `AUTH_RESEND_KEY` and `AUTH_EMAIL_FROM`; verification is not built to switch on with
them, because:

- Sign-up signs the person in at once, and the app has no screen to enter a code after it. Switching verification on
  from the backend alone would leave every new account unable to use AI, with nothing in the app to fix it, the moment
  reset was set up.
- The same two variables turn on reset. Coupling them would make "set up password reset" silently change who may spend.
- Sign in with Apple and GitHub accounts need their own rule: Apple confirms the address (or gives a private relay),
  GitHub may hand over an unconfirmed one.

What it needs: a "verify-email" step in the password provider (send a code with the Email provider, as reset does,
and mark `users.emailVerificationTime` when it is entered), a code screen after sign-up, a gate rule that refuses
spending for an unverified password account, and its own switch.

## What is stored

Convex Auth's tables (`schema.ts`): `users` (email, and a name and picture when Apple or GitHub passes one on),
`authAccounts` (which methods a person uses, Apple's or GitHub's id for them, a password hash), `authSessions`,
`authRefreshTokens`, `authVerificationCodes` (reset codes, hashed), `authVerifiers`, `authRateLimits`. And turtl's
`authAppleNonces`: hashes of Apple nonces already used, each deleted once its token has expired; and
`authAppleTokens`: Apple's refresh token for someone who signed in with Apple, only internal functions read it, and
it is revoked at Apple and deleted when the account is (`convex/account`). Deleting an account removes every row in
these tables that points at it, the `users` row last; a token whose session has ended signs nobody in
(`convex/access.ts`).

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
5. For Sign in with Apple's token revocation: `AUTH_APPLE_TEAM_ID` (the Apple Developer team id), and a Sign in with
   Apple key made under Certificates, Identifiers & Profiles > Keys: `AUTH_APPLE_KEY_ID` (its id) and
   `AUTH_APPLE_PRIVATE_KEY` (the contents of its .p8 file; line breaks may be spaces). Without them Sign in with Apple
   still works, but no token is kept, so deleting such an account cannot revoke it.
6. `AUTH_REQUIRED=true`.
7. Check with `npx convex run auth/settings:check`. It lists what is missing, by name only.

The App Review account: `npx convex run auth/review:ensureAccount '{"email":"…","password":"…"}'`. It creates
the account or sets a new password on it; sessions already open stay open.

## Tests

`tests/accounts.test.mjs` runs these modules against `tests/fixtures/auth-stand-in.mjs`, a stand-in for GitHub's
OAuth pages, Apple's keys and token endpoints, and Resend. `AUTH_STAND_IN_URL` points a deployment at the same stand-in; it must never
be set in production. With `AUTH_REQUIRED=true` the backend honours it only when it runs locally (its own address is
localhost, `convex/demoSettings.ts`), so a hosted deployment where it was set by mistake still asks Apple, GitHub and
Resend themselves.
