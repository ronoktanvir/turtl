# Accounts and sign-in

Sign-in runs on [Convex Auth](https://labs.convex.dev/auth) (`@convex-dev/auth`, pinned at 0.0.98, the stable line),
inside this backend. There is no separate sign-in service.

It matters only with `AUTH_REQUIRED=true` ("accounts mode", see `convex/access.ts`). With it unset, empty or `false` the
backend is the single-owner demo: the app's Login buttons go straight to Home, nobody signs in, and sign-up is refused,
because a deployment that holds an account refuses to run as the demo. Any other value turns accounts on.

## Methods

| Method | How | Files |
| --- | --- | --- |
| Email and password | Convex Auth's credentials flow. Passwords are hashed with Scrypt. With accounts on, a new account confirms its address with an emailed code before it can do anything. Reset by an emailed code. Both need the email service. | `password.ts`, `email.ts`, `codes.ts`, `confirmation.ts`, `confirmed.ts`, `rules.ts` |
| Sign in with Apple | The iPhone's own sheet (`expo-apple-authentication`). The app sends Apple's identity token and a nonce; `apple.ts` checks the token's signature against Apple's published keys, the issuer, the audience (the bundle id), the expiry, and that the token carries the SHA-256 of that nonce. Each nonce works once. The app also sends Apple's one-time authorization code, which is traded for Apple's refresh token so it can be revoked when the account is deleted, as Apple requires (`appleTokens.ts`). A failed trade never stops the sign-in. | `apple.ts`, `appleTokens.ts` |
| Sign in with GitHub | OAuth through the same GitHub App that reaches repositories (its client id and secret). The app opens GitHub in a browser sheet and comes back to `turtl://` with a one-time code. | `../auth.ts` |

Accounts are never merged by email: each method makes its own account. GitHub can hand over an address its user has
not verified, so linking on it would let someone take over another person's account.

## Emailed codes nobody else can spoil

turtl emails two kinds of code: one resets a password, one confirms a new password account's address. Both are turtl's
own (`codes.ts`), not Convex Auth's verification codes, and both follow the same rules (security reviews, findings 6,
7, 12 and 14):

- A code is 20 letters and digits from Crockford's alphabet, about 100 bits (`rules.ts`). Nobody can guess one, so
  wrong codes are not counted at all: there is no count of tries for a stranger to use up, and no address or account
  is ever locked by a wrong code.
- Nobody types it. Each email carries a `turtl://` link (`turtl://reset-password?email=…&emailCode=…`,
  `turtl://confirm-email?emailCode=…`) that opens the app on the right screen with the code filled in, and the code itself,
  to paste. A link never acts by itself: the person taps Set new password or Confirm email.
- Asking again never replaces or cancels a code already sent. Every code works until it expires, until it is used, or
  until another code of the same kind for that address is used; so a reset or a confirmation happens once.
- At most 5 emails of a kind go to one address in any 24 hours, and none within a minute of the last. Each code works
  for 24 hours, the same window, so whenever the limit stops another email, the newest one (sent less than 24 hours
  ago) still works until the oldest leaves the window and another can be sent. A stranger can use up the day's emails,
  but never leave the owner without a code that works.
- Codes are filed under a SHA-256 hash of the address, not under an account, and only their hash is kept
  (`authEmailCodes`). Deleting an account and signing up again does not reset the limit, and a code sent to an address
  confirms whichever password account holds that address now. The hourly sweep deletes each row once it is a day old.

A reset that works sets the new password, clears Convex Auth's count of wrong passwords for the account, ends every
session of the account, and signs in this device with a new session.

### The wrong-password lock

Convex Auth refuses an account's right password after 10 wrong ones in an hour (its `signIn.maxFailedAttempsPerHour`
setting), checked before the password. Anyone who knows an owner's address can keep that count spent. turtl leaves the
setting at 10: the reset above is now always open to the owner, and finishing one clears the count, so the lock costs
an owner one email, never their account. Raising the number would let a script guess more passwords an hour and would
not stop the lock (the script would send more); lowering it would lock out owners who mistype. What is left: someone
who keeps the count spent makes the owner use a reset to sign in on a new device. Sessions already open stay open.

## Confirming a password account's address

With `AUTH_REQUIRED=true`, a password sign-up makes an account that is held until its address is confirmed
(`confirmation.ts`). Convex Auth's `afterUserCreatedOrUpdated` callback (`../auth.ts`) writes an `authUnconfirmed` row in
the same transaction that makes the user, and sign-up emails the first code. While the row exists, `signedInAccount` in
`convex/access.ts` reads the account as signed out (`confirmed.ts`, called there and nowhere else), so it can make no
project, connect no GitHub, store no secret, give no AI permission and so spend nothing. The app shows one screen,
Check your email (`app/confirm-email.tsx`): enter or paste the code, send the email again (within the limits above),
start again with another address (which deletes this account at once through `convex/account`), or sign out.
`users.viewer` says `confirmed: false` for such an account. Accounts made with Sign in with Apple or GitHub are never
held. Password sign-up needs the email service: with accounts on and no `AUTH_RESEND_KEY` and `AUTH_EMAIL_FROM`, it is
refused, and Apple and GitHub still work.

- **Someone signs up with another person's address.** That person cannot sign up ("There's already an account"), so
  they reset the password (the code goes to them), which ends the other's sessions, and then confirm with any code in
  their inbox. Nothing the other person tries spoils those codes.
- **Never confirmed.** The hourly `sweep` starts deleting each account still held 7 days after sign-up, through
  account deletion's own job, which ends its sessions and frees the address at once.
- **The App Review account**, whose address may not be a real mailbox: `auth/review:ensureAccount` confirms the account
  it makes. Any one account can be confirmed by its address:
  `npx convex run auth/confirmation:markConfirmed '{"email":"…"}'`. Neither counts against a ceiling.
- **Accounts made before this existed** have no `authUnconfirmed` row, so they count as confirmed. There were none in
  production.

## Ceilings on new accounts

With `AUTH_REQUIRED=true` the deployment admits new accounts through three ceilings, each per clock hour and per UTC
day (`convex/spend/ceilings.ts`), so filling one never shuts another:

| What | Variables | Default |
| --- | --- | --- |
| Password sign-ups, before the address is confirmed | `PASSWORD_SIGNUPS_PER_HOUR`, `PASSWORD_SIGNUPS_PER_DAY` | 40, 200 |
| Password accounts confirming their address | `CONFIRMED_SIGNUPS_PER_HOUR`, `CONFIRMED_SIGNUPS_PER_DAY` | 20, 100 |
| Sign-ups with Apple or GitHub | `NEW_ACCOUNTS_PER_HOUR`, `NEW_ACCOUNTS_PER_DAY` | 20, 100 |

A script of throwaway password sign-ups fills only the first, which holds up only other password sign-ups for the rest
of that day; Apple and GitHub sign-ups, and real people confirming, still get in. Someone with many real mailboxes (one
domain that takes every address is enough) can also fill the second and stop password accounts confirming for the day,
each confirmed account bringing its own allowances, which the deployment's spend ceilings bound. Only many Apple IDs or
GitHub accounts fill the third.

## What is stored

Convex Auth's tables (`schema.ts`): `users` (email, and a name and picture when Apple or GitHub passes one on),
`authAccounts` (which methods a person uses, Apple's or GitHub's id for them, a password hash), `authSessions`,
`authRefreshTokens`, `authVerificationCodes` (not used by turtl's own codes), `authVerifiers`, `authRateLimits`. And turtl's
`authAppleNonces`: hashes of Apple nonces already used, each deleted once its token has expired; and
`authAppleTokens`: Apple's refresh token for someone who signed in with Apple, sealed with AES-GCM under
`SECRETS_ENCRYPTION_KEY` and bound to that person (`appleTokens.ts`, with `convex/secrets/seal.ts`; without the key no
token is kept), only internal functions read it, and it is opened only to be revoked at Apple and deleted when the
account is (`convex/account`). Tokens kept before they were sealed are sealed in place by
`npx convex run auth/appleTokens:sealKept`. `authUnconfirmed`: a password account still waiting to confirm its
address, deleted when it does or with the account. `authEmailCodes`: the hash of each code emailed in the last day,
under a hash of the address, deleted a day after it was sent. Deleting an account removes every row in
these tables that points at it, the `users` row last; a token whose session has ended signs nobody in
(`convex/access.ts`).

On the phone the session is kept in the iOS Keychain (`data/account/storage.ts`).

## The app's side

`data/account` says who is signed in (`useAccount()`), signs in and out (`useAccountActions()`), and lets other
parts of the app clear what they keep for the person before the session ends (`onSignOut()`).
`components/account/AccountGate.tsx` keeps signed-out people on Login, keeps a password account that has not
confirmed its address on Check your email (status `unconfirmed`), and makes a store build refuse a backend with
accounts off.

The backend's own questions: `users.mode` (before sign-in: accounts on or off, GitHub set up, the email service set
up), `users.viewer` (the signed-in person, or null, with `confirmed`), `users.account` (the account id through
`internal.access.account`), and Check your email's `auth/confirmation:status`, `confirm`, `resend` and `startOver`.

Sign-up says "There's already an account for this email" plainly, with what to do next. A sign-up that works signs in
at once, so a refusal reads differently from success whatever its words. Sign-in and reset never reveal whether an
address has an account.

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
4. `AUTH_RESEND_KEY` and `AUTH_EMAIL_FROM`, for password reset and for confirming a new password account's address.
   Without them, password reset is off and nobody can sign up with a password.
5. For Sign in with Apple's token revocation: `AUTH_APPLE_TEAM_ID` (the Apple Developer team id), and a Sign in with
   Apple key made under Certificates, Identifiers & Profiles > Keys: `AUTH_APPLE_KEY_ID` (its id) and
   `AUTH_APPLE_PRIVATE_KEY` (the contents of its .p8 file; line breaks may be spaces). Without them Sign in with Apple
   still works, but no token is kept, so deleting such an account cannot revoke it.
6. `AUTH_REQUIRED=true`.
7. Check with `npx convex run auth/settings:check`. It lists what is missing, by name only.

The App Review account: `npx convex run auth/review:ensureAccount '{"email":"…","password":"…"}'`. It creates
the account or sets a new password on it, and marks its address confirmed; sessions already open stay open.

## Tests

`tests/accounts.test.mjs` runs these modules against `tests/fixtures/auth-stand-in.mjs`, a stand-in for GitHub's
OAuth pages, Apple's keys and token endpoints, and Resend. `tests/email-codes.test.mjs` performs the attacks on reset
and confirmation codes, the email limits and the ceilings, against the same stand-in. `AUTH_STAND_IN_URL` points a deployment at the same stand-in; it must never
be set in production. With `AUTH_REQUIRED=true` the backend honours it only when it runs locally (its own address is
localhost, `convex/demoSettings.ts`), so a hosted deployment where it was set by mistake still asks Apple, GitHub and
Resend themselves.
