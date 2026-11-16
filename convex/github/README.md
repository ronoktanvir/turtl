# GitHub App: linking a person's repositories

turtl used to reach GitHub with one token for the whole deployment (`GITHUB_TOKEN`), so one person's turtl could read one person's code. This module lets each GitHub account grant turtl access to the repositories it chooses, through a GitHub App, ties that access to the turtl account that connected it, and takes it back on Disconnect.

**What exists now:** the app's definition, installation tokens, the webhook receiver, the one function that picks the credential for a repository (now per owner), the repository listing, and Connect GitHub: the flow that ties an installation to a turtl account, the repository picker in Add project, and Disconnect in the gear sheet. All of it is proven against a stand-in for GitHub (`scripts/github-app/stub.mjs`), in tests and on a local Convex backend. **Nothing has run against real GitHub**, because the app does not exist yet: only Ronok can create it. The checks to run once it exists are [below](#checks-to-run-once-the-app-exists).

## Files

- `app-manifest.json`: the GitHub App's definition, in GitHub's manifest format, with `https://YOUR-DEPLOYMENT.convex.site` standing in for the deployment's HTTP address.
- `config.ts`: reads the variables and decides whether the app is absent, incomplete or ready, and whether Connect GitHub can run; the addresses GitHub may send a person back to.
- `jwt.ts`: signs the app's JWT (RS256) with Web Crypto. Takes the key as GitHub hands it out (PKCS#1) or as PKCS#8.
- `api.ts`: every GitHub call the module makes: as the app (JWT), as an installation (its token), as the person (a user token), and with the client id and secret (the code exchange and token revocation).
- `tokens.ts`: the installation token cache. The only file that touches `githubInstallationTokens`.
- `access.ts`: `repositoryAccess(ctx, "owner/name", owner)`, the one place that decides which credential reaches a repository, and `check`, which reports what is configured.
- `links.ts`: which turtl account may use which installation, and the project owner lookup `repositoryAccess` uses.
- `permission.ts`: asks GitHub, with the installation's token, what the GitHub user behind an account may change now: before turtl changes a repository for them, on refresh, and once for a link made before turtl asked.
- `connect.ts`: Connect GitHub. The only file with public functions (the app's six), plus the records behind them and `disconnectAccount` for account deletion.
- `secrets.ts`: random states and tickets, their SHA-256, and the PKCE challenge.
- `webhook.ts`: signature check and payload reading, with no Convex imports.
- `http.ts`: `POST /github/webhook`, `GET /github/setup` and `GET /github/callback`, registered from `convex/http.ts`.
- `installations.ts`: the records: applying a delivery, coverage, the repository list.
- `sync.ts`: `refresh`, which reads an installation's repositories from GitHub and makes the records match.
- `schema.ts`: six tables, spread into `convex/schema.ts`.
- `scripts/github-app/link.mjs` prints the prefilled registration link; `stub.mjs` is the stand-in GitHub (it also plays the person's browser on github.com); `prove-local.mjs` runs the module on a local Convex backend. The tests are `tests/github-app.test.mjs`, `tests/github-connect.test.mjs` and `tests/github-push-access.test.mjs` (the second security review's finding 16, performed and refused), sharing `tests/github-harness.mjs`.
- The app's side: `data/github/` (live and example), `components/github/ConnectGithub.tsx` (Add project) and `components/github/GithubSettings.tsx` (the gear sheet).

## The app

| Setting | Value | Why |
| --- | --- | --- |
| Contents | Read and write | Reading code (`codeNetwork/build.ts`, onboarding: a commit, the file tree, file contents) needs read. Merging a pull request (`PUT /pulls/{n}/merge`) needs write, and GitHub lists it under Contents. Reading one pull request is allowed by Contents too. |
| Checks | Read-only | `GET /commits/{sha}/check-runs`, shown on the pull request card and required to pass before a merge. |
| Commit statuses | Read-only | `GET /commits/{sha}/status`, the older kind of check. |
| Metadata | Read-only | GitHub requires it for every app. |
| Events | none subscribed | `installation` and `installation_repositories` reach every GitHub App without a subscription, and they are the only two turtl reads. |
| Webhook | `<site>/github/webhook` | Active, with a secret. |
| Callback URLs | `<site>/api/auth/callback/github`, then `<site>/github/callback` | The first is Sign in with GitHub (the accounts work, Convex Auth's path). The second is Connect GitHub. Both flows send `redirect_uri` explicitly, so their order does not matter. |
| Setup URL | `<site>/github/setup`, also on update | Where GitHub sends a person after they install or change the app. Connect GitHub continues from there. |
| Request user authorization during installation | off | With it on, GitHub drops the setup URL and sends the code to the first callback URL, which is Sign in with GitHub's. Connect GitHub asks for the authorization itself, from the setup page. |
| Installable by | any account | A private app can only be installed on its owner's account. |

turtl never opens a pull request with this app: Capy opens it, through Capy's own GitHub connection. So Pull requests is not requested at all. Workflows is not requested either, which means GitHub will refuse a merge from turtl for a pull request that changes a file under `.github/workflows/`; the owner merges that one on GitHub.

Connect GitHub needed **no change to the manifest and no new permission**: the callback URL was already in it, and the reads a user token makes (`GET /user`, `GET /user/installations`, `GET /user/installations/{id}/repositories`), uninstalling (`DELETE /app/installations/{id}`, as the app) and revoking a user token (`DELETE /applications/{client_id}/token`, with the client id and secret) need no permission an app asks for. Checking what a person may change needs none either: `GET /user/{account_id}` needs no permission, and `GET /repos/{owner}/{repo}/collaborators/{username}/permission` needs Metadata (read), which every app has. Both take an installation token.

What turtl cannot check with these permissions is whether someone **owns an organization**: `GET /orgs/{org}/memberships/{username}` and `GET /user/memberships/orgs/{org}` need the organization's Members permission. turtl does not ask for it, so turtl never uninstalls its app from an organization (Disconnect, below).

## Which credential reaches a repository

`repositoryAccess(ctx, repo, owner)` in `access.ts` decides. `owner` is the project or case turtl acts for (`{ appId }` or `{ caseId }`; the owner is the project's `apps.ownerId`, the rule in `convex/access.ts`), or an account (`{ account }`). `convex/pullRequests.ts`, `convex/codeNetwork/build.ts` and `convex/onboarding/` (inspect, prepare, the merge in projects) ask it.

1. **No GitHub App variable is set** (`GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`): every repository gets the deployment's `GITHUB_TOKEN`, exactly as before. GitHub is not asked anything and no table is read, whatever the owner. This is the hosted demo today.
2. **Any of them is set**: `GITHUB_TOKEN` is never used for a repository again. If the id or the key is missing or unreadable, access is refused with a message that names the variable.
3. **The app is ready, accounts off** (`AUTH_REQUIRED` unset): the repository gets a token of the installation that covers it, as before; the owner is not asked. If turtl's records show no active installation for it, turtl asks GitHub once (`GET /repos/{owner}/{repo}/installation`); GitHub's answer is recorded and wins. No installation means no access: "turtl's GitHub App is not installed on owner/name".
4. **The app is ready, accounts on** (`AUTH_REQUIRED=true`): the same, and the installation must also be linked to the project's owner through Connect GitHub, and allow that repository for them (below). Otherwise: "owner/name is not one of the repositories this project's owner connected to turtl" (`not_connected`), and no token is minted. A project with no owner reaches nothing.
5. **Changing a repository, accounts on.** `repositoryAccess(ctx, repo, owner, "change")` is what the two Merge taps (`pullRequests.ts`, `onboarding/projects.ts`) and starting a coding agent's work (`prTracking/codingAgent.ts`, for fixes and preparations) ask for. After rule 4, `permission.ts` asks GitHub with the installation's token who the linked GitHub user is now (`GET /user/{account_id}`, by the id GitHub confirmed at Connect, never the login, which can change hands) and what they may do in the repository (`GET /repos/{owner}/{repo}/collaborators/{login}/permission`). Only `admin` or `write` (GitHub maps maintain to write) goes ahead. Anything else, including no clear answer from GitHub, is refused in plain words (`cannot_push`: "You can no longer change owner/name on GitHub, so turtl will not change it for you..."), and the repository leaves the person's link. turtl does not rely on the coding agent to refuse someone who can only read a repository.

The records only route a repository to an installation. GitHub decides what an installation token can reach, so a stale record can cause a refused request and never a wider one.

## Connect GitHub

### The flow

```mermaid
sequenceDiagram
    participant App as turtl app (signed in)
    participant Convex as turtl backend
    participant Browser as system browser
    participant GitHub
    App->>Convex: github.connect.begin({ returnTo })
    Convex-->>App: github.com/apps/<slug>/installations/new?state
    App->>Browser: open it
    Browser->>GitHub: choose "Only select repositories", install
    GitHub-->>Browser: redirect to /github/setup?installation_id&setup_action&state
    Browser->>Convex: GET /github/setup (the installation id is not read)
    Convex-->>Browser: redirect to /login/oauth/authorize?client_id&redirect_uri&state&code_challenge
    Browser->>GitHub: authorize turtl (once; later it answers at once)
    GitHub-->>Browser: redirect to /github/callback?code&state
    Browser->>Convex: GET /github/callback
    Convex->>GitHub: exchange the code (client secret + PKCE verifier) for a user token
    Convex->>GitHub: GET /user, /user/installations, /user/installations/{id}/repositories
    Convex->>GitHub: revoke the user token
    Convex-->>Browser: redirect to turtl://add-project?github=connected&ticket
    Browser->>App: deep link
    App->>Convex: github.connect.finish({ ticket })
```

1. **Begin.** `api.github.connect.begin` (an action, so the state comes from real randomness) takes the caller's account from `requireAccount`, stores an attempt (the account, a SHA-256 of a random 32-byte state, a PKCE verifier, where to send the person back, 15 minutes to live) and returns GitHub's install page with the state. With `start: "authorize"` it returns GitHub's authorize page instead (step 2's redirect, without the install page), for someone whose installation already exists; the app offers it as "Already installed? Confirm on GitHub". A new attempt replaces the account's earlier ones. `returnTo` is `"app"` (`turtl://add-project`) or, on the web, the page's origin, accepted only for `localhost`, `127.0.0.1` or `[::1]`, and with accounts on only when this backend itself runs on this machine (`standInOnly` in `convex/demoSettings.ts`); nothing else, because a ticket sent elsewhere could be used by whoever started the attempt. A hosted web build would add its origin in `config.ts`.
2. **Setup.** GitHub sends the person to `/github/setup` with the installation id and the state. The id is never read: anyone can type one. With the state of an attempt still waiting, the page redirects to GitHub's authorize page (`client_id`, `redirect_uri=<site>/github/callback`, the same state, an S256 `code_challenge`). Without one (expired, unknown, or a person who changed the installation on GitHub without coming from turtl) it shows "Go back to turtl" and reads nothing. `setup_action=request` (an organization's owner must approve) sends the person back with `github=requested`.
3. **Callback.** `/github/callback` takes the attempt by the state's hash, once: a second callback with the same state, or one after 15 minutes, gets "This link has expired" and writes nothing. No `code` (the person pressed Cancel) ends the attempt with `github=cancelled`. Otherwise it exchanges the code for a user token with `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` and the PKCE verifier, reads who the person is, every installation of turtl's app they can reach (`GET /user/installations`, up to 10 pages), and in each the repositories they can reach (`GET /user/installations/{id}/repositories`, up to 10 pages), records them, and revokes the token whatever happened. The token is never stored. GitHub's lists are the confirmation: a forged installation id gets nowhere because it is never in them.
4. **Ticket.** For each installation (up to 20, not suspended) it writes an **inactive** link: the account that started, the GitHub user (their id, which never changes, and their login), and, unless the installation is on the person's own account, the repositories in it. GitHub lists every repository the person can reach, reading included, with their permissions in each; with accounts on the link keeps only those they can change (`push`, `maintain` or `admin`), at most 100, marks when GitHub said so (`checkedAt`), and remembers the rest with why (`leftOut`). In the single-owner demo it keeps everything GitHub listed, as before. It stores the SHA-256 of a new random ticket (10 minutes to live) and redirects to `turtl://add-project?github=connected&ticket=<ticket>` (or the web origin's `/add-project`). With nothing confirmed it redirects with `github=none` or `github=failed`.
5. **Finish.** `api.github.connect.finish({ ticket })` (a mutation) finds the attempt by the ticket's hash and requires that it is confirmed, unexpired and **started by the account now calling**. It makes the links active (replacing the account's earlier link to the same installation) and marks the attempt finished. Every refusal has the same message, so a ticket cannot be probed.
6. **Pick.** `api.github.connect.repositories` (a query) lists the caller's repositories: every repository an installation on their own account covers, and in an organization only those they can change. `api.github.connect.refresh` (an action) reads the caller's installations from GitHub again first and, with accounts on, asks GitHub again what the caller can change in each organization (at most once every five minutes per link), dropping what they no longer can. It returns `leftOut`: each repository GitHub listed that turtl left out, with a sentence the picker shows under the list ("You can read this repository but not change it, so turtl cannot open pull requests on it."). Choosing one fills in the project's repository in Add project. "Choose different repositories on GitHub" opens the installation's settings page on GitHub.
7. **Status.** `api.github.connect.status` (a query) says whether Connect GitHub is set up (`configured`), whether accounts are on, whether the caller is signed in, and their connections (the GitHub account, who connected, the settings page). The app draws nothing GitHub-related when `configured` is false, so the demo's screens are unchanged.
8. **Disconnect.** `api.github.connect.disconnect` (an action) and `internal.github.connect.disconnectAccount({ account })` (the same, for account deletion, RC-23) go through every installation the account is linked to. With accounts on, turtl uninstalls only an installation on the person's own GitHub account that no other account uses (`DELETE /app/installations/{id}`, as the app), then marks it deleted, with its cached token, repository rows and links deleted. From an organization's installation, someone else's, or one another account still uses, turtl removes only this account's links and the installation's cached token, and the answer's `stillInstalled` says, in a sentence the gear sheet shows, that turtl is still installed there and who can remove it ("Only an owner of acme can remove it, in acme's settings on GitHub."). No link means no token: `repositoryAccess` mints nothing for that installation on this account's behalf afterwards. In the single-owner demo every installation no other account uses is uninstalled, as before. If GitHub does not confirm an uninstall, nothing is removed for that installation and the answer says so (`failed`), so it can be run again. In the single-owner demo, disconnecting is an owner decision: it needs the owner passcode, and a passcode must be set first.
9. **Uninstalled on GitHub.** The `installation.deleted` webhook, or GitHub answering 404 for the installation, removes its links too.

### Why each piece is there

- **A forged installation id** gets nowhere: no handler reads the id from an address. Installations come only from what GitHub lists for the person's user token.
- **A link sent to a victim.** An attacker starts on their own account and sends the GitHub link to a victim, who installs on their repositories. GitHub confirms the victim and the ticket goes to the victim's device, not the attacker. `finish` requires the account that started, so the victim's turtl cannot use it, and the attacker never sees it. Nothing is linked.
- **The return address is fixed** at `begin`, by the signed-in app, from a short list. It is never taken from GitHub's redirect.
- **An organization member** gets only the repositories GitHub says they can change, because an installation token can change everything the installation covers. Someone who can only read a repository gets no link to it and no token for it.
- **A former collaborator** cannot have turtl change a repository: GitHub is asked again, by their id, before every merge and every coding agent's work.
- **A member's disconnect** cannot uninstall turtl from their organization: turtl cannot confirm who owns one, so it only unlinks.
- **No user token is kept**: it answers three questions and is revoked.

### Accounts

With `AUTH_REQUIRED` unset (the demo) every caller is `solo-owner`, so Connect GitHub files installations under that one account, and `repositoryAccess` does not look at links (rule 3). With `AUTH_REQUIRED=true` the functions above need a signed-in caller ("Sign in to continue."), and rule 4 applies. The client learns which from `status.accounts`; it does not call another slice's functions.

## Installation tokens

`installationToken` in `tokens.ts` returns the cached token while it has more than five minutes left, and otherwise signs the app's JWT, asks GitHub for a new token (`POST /app/installations/{id}/access_tokens`) and stores it with GitHub's expiry. GitHub issues them for one hour.

The JWT is RS256, issued 60 seconds in the past against clock drift, expires nine minutes ahead (GitHub allows ten), and names `GITHUB_APP_ID` as its issuer.

Tokens live in `githubInstallationTokens`, apart from the installation rows, so a function that returns installations cannot return a token by accident. Only `tokens.ts` names that table, the only public functions are the six in `connect.ts` and none returns a token, and a test fails if any of that stops being true. A token is never logged, never passed to the scheduler (whose arguments are stored), and never part of `check`'s answer. Any change to an installation that arrives by webhook drops its cached token.

## The webhook

`POST <site>/github/webhook`.

- Without `GITHUB_APP_WEBHOOK_SECRET` every delivery gets 503.
- The signature (`X-Hub-Signature-256`, HMAC-SHA256 of the raw body) is checked before anything is read from the body, with a comparison that takes the same time wherever a forgery differs. A wrong, missing or malformed signature gets 401 and touches no table.
- A delivery is applied once. Its `X-GitHub-Delivery` id and a SHA-256 of its body are stored; either one seen again answers `duplicate` and changes nothing. The body digest matters because GitHub signs only the body, so a captured delivery could otherwise be sent again under a new id.
- `installation`: `created`, `new_permissions_accepted` and `unsuspend` make the installation active and record its repositories; `suspend` suspends it; `deleted` marks it deleted and removes its repositories and links. A deleted installation keeps its row and never becomes active again from a webhook, because GitHub never reuses an installation id.
- `installation_repositories`: `added` and `removed` change the repository rows. When the installation switches between all repositories and selected ones, GitHub does not say which repositories were lost, so turtl schedules `sync.refresh` to read them back. It does the same for a delivery that lists more than 2,000 repositories.
- `ping` answers `pong`. Any other signed event answers `ignored` and is stored nowhere.

Answers are JSON: `{ ok: true, outcome: "applied" | "duplicate" | "ignored" | "pong" }` or `{ ok: false, error: { code, message } }`.

## Creating the app

Only the owner of the GitHub account can do this. It takes about five minutes. You need the HTTP address of the Convex deployment the app will serve, which looks like `https://<name>.convex.site`. The addresses can be changed later in the app's settings, so the app can be created against one deployment and moved.

1. In the repository, print the link and open it in a browser signed in to GitHub as the account that should own the app:

   ```sh
   node scripts/github-app/link.mjs --site https://<name>.convex.site
   ```

   Add `--org <organization>` to create it under an organization.
2. GitHub's "Register new GitHub App" form opens with everything filled in. Change nothing except:
   - **Webhook secret**: GitHub cannot take this from a link. Run `openssl rand -hex 32`, paste the result into "Secret", and keep it for step 4.
   - **GitHub App name**: it is filled in as "turtl on-call". "turtl" alone is taken by a GitHub user. If GitHub says the name is taken, pick another; the slug in step 3 follows the name.
   - Check that "Where can this GitHub App be installed?" says **Any account**, that both callback URLs are listed, that "Request user authorization (OAuth) during installation" is **off**, and that "Redirect on update" is **on**.

   Press **Create GitHub App**.
3. On the app's settings page:
   - Note the **App ID** (a number) and the **Client ID**.
   - Note the slug: the last part of the app's public link, `https://github.com/apps/<slug>`.
   - Press **Generate a new client secret** and copy it now; GitHub shows it once.
   - Under "Private keys" press **Generate a private key**. A `.pem` file downloads.
   - Leave "Expire user authorization tokens" as GitHub sets it (on). turtl revokes the one user token it gets straight away, so it does not matter for turtl.
4. Set the values on the Convex deployment (add `--prod` or `--deployment <name>` for the deployment you mean). A command with no value asks for it, which keeps a secret out of the shell history:

   ```sh
   npx convex env set GITHUB_APP_ID <App ID>
   npx convex env set GITHUB_APP_SLUG <slug>
   npx convex env set GITHUB_APP_PRIVATE_KEY --from-file <path to the .pem file>
   npx convex env set GITHUB_APP_WEBHOOK_SECRET      # paste the secret from step 2
   npx convex env set AUTH_GITHUB_ID <Client ID>     # Connect GitHub, and Sign in with GitHub
   npx convex env set AUTH_GITHUB_SECRET             # paste the client secret from step 3
   ```

   Then delete the `.pem` file. GitHub can make a new key at any time. Connect GitHub appears in the app once all six are set; with only the first four, Add project stays a typed address.
5. Install the app on the repositories that deployment already uses: open `https://github.com/apps/<slug>/installations/new`, choose the account, choose "Only select repositories", pick them, and press Install. **Do this straight after step 4**: from the moment a `GITHUB_APP_*` variable is set, the deployment stops using `GITHUB_TOKEN` for repositories. On the hosted demo that means `ronoktanvir/turtl` must be installed, or pull request tracking there reports "not installed". (On a deployment with accounts on, connect from the app instead, so the installation is linked to your account.)
6. Run the checks below.

| Value | Where it comes from | Variable on the Convex deployment |
| --- | --- | --- |
| App ID | App settings, "About" | `GITHUB_APP_ID` |
| Slug | The app's public link | `GITHUB_APP_SLUG` |
| Private key | "Generate a private key" (the `.pem` file) | `GITHUB_APP_PRIVATE_KEY` |
| Webhook secret | You chose it in step 2 | `GITHUB_APP_WEBHOOK_SECRET` |
| Client ID | App settings, "About" | `AUTH_GITHUB_ID` |
| Client secret | "Generate a new client secret" | `AUTH_GITHUB_SECRET` |

A production deployment should not have `GITHUB_TOKEN` at all. Then there is nothing to fall back to if the app's variables go missing.

## Checks to run once the app exists

None of these has been run, because each needs the real app.

1. `npx convex run github/access:check` answers `app: "ready"`, `connect: "ready"` and `github: { ok: true, slugMatches: true, permissionsMatch: true }`. That is GitHub accepting a JWT signed with the real key, and the app's permissions matching the manifest.
2. In the app's settings, Advanced, Recent Deliveries: the `installation` delivery from step 5 shows response 200 with `"outcome":"applied"`. Press Redeliver: 200 with `"outcome":"duplicate"`.
3. `npx convex run github/access:check '{"repo":"<owner>/<installed repo>"}'` answers `repository: { ok: true, source: "installation" }`. The same for a repository you did not select answers `reason: "not_installed"`.
4. `npx convex run github/sync:refresh '{"installationId":<id>}'` lists exactly the repositories you selected. The id is the number at the end of the installation's settings address on GitHub.
5. A case with a pull request on an installed repository refreshes in turtl and shows its checks. This is the first real proof that Contents, Checks and Commit statuses are enough to read a pull request; GitHub's reference says so, and `X-Accepted-GitHub-Permissions` on a refused response would say what is missing.
6. The owner's Merge tap merges a test pull request whose checks pass.
7. `codeNetwork/build:build` reads a **private** installed repository. File contents come from `raw.githubusercontent.com` with the installation token, which no test here can prove.
8. On GitHub: add a repository to the installation, remove one, switch between all and selected repositories, suspend, unsuspend, uninstall. After each, `npx convex run github/installations:repositories '{"installationId":<id>}'` matches, and after the uninstall check 3 answers `not_installed`.
9. Install with "All repositories" on an account and confirm the `installation` delivery lists them. If it does not, the list still fills on first use and on `sync.refresh`.
10. **Connect GitHub, on a phone build.** Add project, Connect GitHub: GitHub's install page opens; install on one repository; GitHub asks to authorize turtl (the first time only); the phone offers to open turtl, which shows the repository picker. This proves what the stand-in assumes and GitHub's documentation does not say outright: that GitHub carries the `state` from the install address to the setup address. If the setup page instead says "Go back to turtl" with nothing connected, the state was dropped (see Known limits).
11. Connect again with the app already installed on that account: GitHub shows the installation's settings; press Save. The same question as 10, for updates. Then "Already installed? Confirm on GitHub": GitHub answers at once (already authorized) and the picker appears.
12. Install on an organization where you are a member but not an owner: the app comes back with "GitHub asked your organization's owner to approve turtl" (`setup_action=request`).
13. In the gear sheet, Disconnect: the installation disappears from GitHub's "Installed GitHub Apps", and `npx convex run github/tokens:cached '{"installationId":<id>}'` prints nothing.
14. With accounts on, a second account sees no connection and cannot pick or reach the first account's repositories.
15. With accounts on, connect as an organization member with **read** access to one installed repository: the picker does not offer it and says "You can read this repository but not change it". Then, as a member with write access, connect, have an owner change you to read on GitHub, and tap Merge on a case's pull request: turtl refuses before reading the pull request. This proves GitHub's answers to `GET /user/installations/{id}/repositories` (`permissions`) and `GET /repos/{owner}/{repo}/collaborators/{username}/permission` (with an installation token) match the documentation, and what the second answers for a user with no access at all (`none` or 404; turtl treats both as no).
16. Disconnect as that member: the organization's installation stays in its "Installed GitHub Apps", and the gear sheet says who can remove it.

## Testing

```sh
node --test tests/github-app.test.mjs tests/github-connect.test.mjs tests/github-push-access.test.mjs   # also part of npm run test:ci
CONVEX_AGENT_MODE=anonymous npx convex dev                             # a local backend, in one terminal
node scripts/github-app/prove-local.mjs [--port 8208]                  # in another
```

The tests run this folder's real functions against the stub served over HTTP and an in-memory copy of the tables, with a signed-in caller or none. The stub verifies each JWT with the app's public key the way GitHub documents it, issues codes only to a registered callback URL with an S256 challenge, exchanges each code once with the client secret and the verifier, and answers user-token reads only with what that person can reach. `browse()` in `stub.mjs` plays the person's browser through GitHub's pages and turtl's. `prove-local.mjs` repeats the main paths on a local Convex backend, where Convex's own runtime signs the JWT, verifies the webhook, serves the setup and callback pages and writes the tables; it refuses to run against anything but a local backend, and runs with accounts off because a local backend has no sign-in. Both set `GITHUB_API_URL` to point the module at the stub (it moves the github.com pages and the code exchange too). Leave that variable unset on a real deployment.

## Known limits

- **The state through GitHub's install page.** "Connect GitHub" relies on GitHub passing `state` from `github.com/apps/<slug>/installations/new?state=…` to the setup URL. GitHub documents the `state` parameter on the install address as a way to "preserve the state" across install and update, but not that the setup URL receives it. If it does not, the setup page says "Go back to turtl" and nothing connects from that tap; the installation itself is made, and "Already installed? Confirm on GitHub" (which starts at the authorize page, fully documented) then connects it. If check 10 fails, make the authorize start the default in `ConnectGithub.tsx`.
- **Reading after access ends.** No event tells turtl that a person lost write access in an organization. turtl asks GitHub before it changes anything, and on refresh (at most every five minutes per link). Until one of those, turtl may still read that repository for the person's project (the map of the code, pull request status). Within an organization, a link covers only the repositories the person could change when they connected (or at the last check); to add one later, connect again. On the person's own account every repository the installation covers is theirs, so changes made on GitHub show up on refresh.
- **Links made before turtl asked about write access** (no `checkedAt`) may list repositories the person can only read. Each is checked with GitHub the first time `repositoryAccess` uses it, or on refresh; what the person cannot change leaves the link. A link on the person's own account needs no check.
- **The `github_app_authorization` webhook** (a person revoked their authorization of the app) is not read. turtl holds no user token, so there is nothing to drop; links stay until Disconnect or uninstall.
- **Capy is a separate grant.** The pull request that fixes a case is opened by Capy through Capy's own access to the repository (`CAPY_API_KEY` and a Capy project that holds it). Installing turtl's GitHub App does not give Capy that access. Reading code, tracking a pull request and merging work for any installed repository; "open the pull request" works only where Capy can already reach the repository.
- **Disconnect and other accounts.** An installation another turtl account still uses stays installed; only the caller's links go. An organization's installation is never uninstalled by turtl, even when no turtl account uses it any more: an owner of the organization removes it on GitHub.
- **A hosted web build** cannot connect GitHub until its origin is added to `returnAddress` in `config.ts`; only this computer's addresses and `turtl://` are accepted.
- `sync.refresh` reads at most 10,000 repositories of one installation; the picker shows at most 500 per installation; one connection reads at most 1,000 installations and 1,000 repositories in each, and links at most 20.
- `githubWebhookDeliveries` grows by one row per installation event and is never pruned. A valid signature is needed to add a row. Finished and failed connect attempts are deleted when the same account starts again or disconnects.
