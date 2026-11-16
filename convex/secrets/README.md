# Secrets: what an owner entrusts to turtl

With accounts on (`AUTH_REQUIRED=true`) two things belong to an owner rather than to the deployment:

- **A project's control token** (`control_token`): the bearer token its app's protected routes (journey checks, flags, recovery hooks) answer to. turtl sends it only to that project's own live address.
- **An account's coding agent key** (`coding_agent_key`): the owner's own Capy API key. Every coding-agent thread for the account's projects, code changes and the onboarding preparation, starts with it.

The single-owner demo stores neither: it keeps sending `PROTECTED_APP_CONTROL_SECRET` and using `CAPY_API_KEY`, as before, and the functions here refuse with a sentence saying so.

## How a secret is kept

- **Sealed.** `seal.ts` encrypts with AES-GCM (Web Crypto) under `SECRETS_ENCRYPTION_KEY`, 32 random bytes in base64: make it with `openssl rand -base64 32`, set it once, and never change it (a sealed secret does not open under another key; owners would have to enter theirs again). Every seal has its own 12-byte IV and binds what it is and whose it is (`turtl-secret:<kind>:<appId or account>`) as additional data, so a sealed value copied onto another project's or account's row does not open there. Each row records which key sealed it (`keyId`, the start of the key's SHA-256), so a changed key is reported as such.
- **Sealed in an action.** Only actions have the platform's true randomness, so `project:setControlToken` and `account:setCodingAgentKey` are actions; the sealed value is written by the internal mutation `store:put`.
- **Write-only.** No public function returns a sealed value or a secret: `project:controlToken` and `account:codingAgent` answer only whether it is set, when, and (for a token) the one address it is sent to. `tests/project-secrets.test.mjs` fails if any file outside this folder reads the table.
- **Opened only where it is sent.** `open.ts`'s `openSecret` reads the sealed row through the internal query `store:sealedFor` and decrypts it inside the action about to send it: `convex/protectedApp/watched.ts` for a control token, `convex/prTracking/codingAgent.ts` for a coding agent key. Nothing stores, logs or returns the opened value.
- **One per slot, bound to the owner.** Setting replaces; removing deletes. A project's token is used only while the account that set it still owns the project.

## Files

- `schema.ts`: the `secrets` table (`kind`, `account`, `appId` for a project's secret, `sealed`, `keyId`, `setAt`), indexed by project and by account.
- `seal.ts`: the key, `seal` and `open`. No imports.
- `store.ts`: internal `put` and `sealedFor`, and the helpers that read a slot.
- `open.ts`: `openSecret(ctx, kind, scope)`.
- `project.ts`: `controlToken` (query), `setControlToken` (action), `removeControlToken` (mutation). Only the project's owner; another account's project reads as not available.
- `account.ts`: `codingAgent` (query), `setCodingAgentKey` (action), `removeCodingAgentKey` (mutation), for the signed-in account.
- `erase.ts`: the erasers for deleting a project or an account, below.
- `words.ts`: what the owner reads.
- `localProof.ts`: seeds and reads for `tests/project-secrets-local.integration.mjs`; refused anywhere but a localhost backend with `DEV_TOOLS_ENABLED`.

## Erasing

For account and project deletion (`convex/account/`), each removes up to 100 rows a call and returns `{ removed, more }`; call again while `more` is true:

- `internal.secrets.erase.forProject({ appId })`: the project's control token.
- `internal.secrets.erase.forAccount({ account })`: the account's coding agent key and every control token it set.

The monitor's per-project state has its own: `internal.protectedApp.watching.forgetProject({ appId })`.

## The app

The gear sheet's Coding agent row (`components/secrets/CodingAgentSettings.tsx`), the project's Control token row in Settings and on the Preparation screen (`components/secrets/ControlTokenSettings.tsx`), and a line on a code-change fix and on Preparation when no coding agent is connected (`components/secrets/CodingAgentNotice.tsx`). Data: `data/secrets/`. None of it shows in the demo or the example build.
