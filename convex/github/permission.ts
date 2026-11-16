import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { readCollaboratorPermission, readUserById } from "./api";
import { appConfig } from "./config";
import { signAppJwt, UNREADABLE_KEY } from "./jwt";
import { MAX_LINK_REPOSITORIES, type LeftOut } from "./links";
import type { Repository } from "./shapes";
import { installationToken } from "./tokens";

// What the GitHub user behind a turtl account may do in a repository now, asked of GitHub with the installation's own
// token (accounts on only). turtl's app can change every repository an installation covers, so before turtl changes
// anything for a person (starts a coding agent's work, merges a pull request) it asks GitHub whether that person
// could change the repository themself, and refuses when they cannot. Two calls, both allowed to an installation
// token with the permissions turtl's app already has:
//
// - GET /user/{account_id}: the user's login now, from the id GitHub confirmed when they connected. A login can change
//   and be taken by someone else; the id cannot.
// - GET /repos/{owner}/{repo}/collaborators/{login}/permission (Metadata: read): admin or write (which includes
//   maintain) can change the repository; read (which includes triage) and none cannot.
//
// Anything GitHub does not answer clearly counts as no, and turtl does nothing.

/** A link in someone else's account is asked about again on refresh at most this often. */
export const CHECK_EVERY_MS = 5 * 60_000;
const PARALLEL = 5;

export const CANNOT_CHANGE = (repo: string) =>
  `You can no longer change ${repo} on GitHub, so turtl will not change it for you. If you should be able to, ask an owner of ${repo.split("/")[0]} for write access, then connect GitHub again in turtl.`;
export const UNCONFIRMED = (repo: string) => `turtl could not confirm with GitHub that you can still change ${repo}, so it did not go ahead. Try again in a minute.`;

type Link = { githubUserId: number; githubLogin: string; own: boolean; repositories: string[]; checkedAt?: number };
type Refusal = { ok: false; reason: "not_connected" | "cannot_push" | "github_error"; message: string };

/** Which of `repos` the GitHub user with this id can change now, as GitHub answers the installation's token. */
export async function changeableNow(
  token: string,
  githubUserId: number,
  repos: string[],
): Promise<{ ok: true; login: string | null; can: (repo: string) => boolean } | { ok: false; message: string }> {
  const answers = new Map<string, boolean>();
  const can = (repo: string) => answers.get(repo.toLowerCase()) === true;
  if (repos.length === 0) return { ok: true, login: null, can };
  const user = await readUserById(token, githubUserId);
  // 404: the GitHub account no longer exists, so nobody can act as it.
  if (!user.ok) return user.status === 404 ? { ok: true, login: null, can } : { ok: false, message: user.message };
  for (let start = 0; start < repos.length; start += PARALLEL) {
    const batch = repos.slice(start, start + PARALLEL);
    const read = await Promise.all(batch.map((repo) => readCollaboratorPermission(token, repo, user.body.login)));
    for (const [index, answer] of read.entries()) {
      if (!answer.ok && answer.status !== 404) return { ok: false, message: answer.message };
      // GitHub answered for this user (by id), and says they can push, maintain or administer it.
      const yes = answer.ok && answer.body.canPush && (answer.body.userId === null || answer.body.userId === githubUserId);
      answers.set(batch[index].toLowerCase(), yes);
    }
  }
  return { ok: true, login: user.body.login, can };
}

/**
 * Asks GitHub again about every repository a link in someone else's account lists that the installation still covers,
 * and drops from the link those its GitHub user can no longer change. Returns the repositories the link keeps.
 */
export async function recheckLink(ctx: ActionCtx, token: string, account: string, installationId: number, link: Link): Promise<{ ok: true; repositories: string[] } | { ok: false; message: string }> {
  const covered: Repository[] = await ctx.runQuery(internal.github.installations.repositories, { installationId });
  const shown = new Map(covered.map((repository) => [repository.fullName.toLowerCase(), repository.fullName]));
  const kept = link.repositories.slice(0, MAX_LINK_REPOSITORIES);
  // A repository the installation no longer covers is out of reach of its token anyway, and stays as it is.
  const asked = kept.filter((name) => shown.has(name));
  const answer = await changeableNow(token, link.githubUserId, asked.map((name) => shown.get(name) ?? name));
  if (!answer.ok) return answer;
  const drop: LeftOut[] = [
    ...asked.filter((name) => !answer.can(name)).map((name) => ({ fullName: shown.get(name) ?? name, why: "lost" as const })),
    ...link.repositories.slice(MAX_LINK_REPOSITORIES).map((name) => ({ fullName: shown.get(name) ?? name, why: "too_many" as const })),
  ];
  await ctx.runMutation(internal.github.links.recheck, {
    account,
    installationId,
    githubUserId: link.githubUserId,
    drop,
    checkedAt: Date.now(),
    ...(answer.login && { githubLogin: answer.login }),
  });
  const gone = new Set(drop.map((entry) => entry.fullName.toLowerCase()));
  return { ok: true, repositories: link.repositories.filter((name) => !gone.has(name)) };
}

/** For refresh: asks GitHub again about the account's link to one installation, if it is in someone else's account
 * and GitHub was last asked more than CHECK_EVERY_MS ago. */
export async function recheckIfDue(ctx: ActionCtx, account: string, installationId: number): Promise<{ ok: true } | { ok: false; message: string }> {
  const link: Link | null = await ctx.runQuery(internal.github.links.linkFor, { account, installationId });
  if (!link || link.own || (link.checkedAt !== undefined && Date.now() - link.checkedAt < CHECK_EVERY_MS)) return { ok: true };
  const app = appConfig();
  if (app.state !== "ready") return { ok: false, message: "turtl's GitHub App is not configured on this deployment." };
  const jwt = await signAppJwt(app.appId, app.privateKey);
  if (!jwt) return { ok: false, message: UNREADABLE_KEY };
  const token = await installationToken(ctx, jwt, installationId);
  if (!token.ok) return { ok: false, message: token.message };
  const checked = await recheckLink(ctx, token.body, account, installationId, link);
  return checked.ok ? { ok: true } : checked;
}

/**
 * The person check inside repositoryAccess, with accounts on, once an installation linked to the account covers the
 * repository and its token is in hand. "read": a link made before turtl asked GitHub what the person may change is
 * asked about once, now. "change": GitHub is asked about this repository now, every time; a repository the person can
 * no longer change leaves their link.
 */
export async function personMay(ctx: ActionCtx, token: string, account: string, installationId: number, repo: string, purpose: "read" | "change"): Promise<{ ok: true } | Refusal> {
  const link: Link | null = await ctx.runQuery(internal.github.links.linkFor, { account, installationId });
  if (!link) return { ok: false, reason: "not_connected", message: `${repo} is not one of the repositories this project's owner connected to turtl.` };
  if (!link.own && link.checkedAt === undefined) {
    const checked = await recheckLink(ctx, token, account, installationId, link);
    if (!checked.ok) return { ok: false, reason: "github_error", message: UNCONFIRMED(repo) };
    if (!checked.repositories.includes(repo.toLowerCase())) return { ok: false, reason: "cannot_push", message: CANNOT_CHANGE(repo) };
  }
  if (purpose === "read") return { ok: true };
  const answer = await changeableNow(token, link.githubUserId, [repo]);
  if (!answer.ok) return { ok: false, reason: "github_error", message: UNCONFIRMED(repo) };
  if (answer.can(repo)) return { ok: true };
  if (!link.own) {
    await ctx.runMutation(internal.github.links.recheck, { account, installationId, githubUserId: link.githubUserId, drop: [{ fullName: repo, why: "lost" }] });
  }
  return { ok: false, reason: "cannot_push", message: CANNOT_CHANGE(repo) };
}
