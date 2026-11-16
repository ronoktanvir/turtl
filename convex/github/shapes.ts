import { REPOSITORY_PATTERN } from "./config";

export type Installation = { installationId: number; accountLogin: string; repositorySelection: "all" | "selected"; accountType?: string };
export type Repository = { fullName: string; private?: boolean };
export type GithubUser = { id: number; login: string };

export const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

// GitHub's installation object, as a webhook or the API sends it.
export function installationOf(value: unknown): (Installation & { suspended: boolean }) | null {
  const installation = record(value);
  const account = record(installation?.account);
  const login = account?.login ?? account?.slug;
  const selection = installation?.repository_selection;
  if (!installation || !Number.isSafeInteger(installation.id) || typeof login !== "string" || !login) return null;
  if (selection !== "all" && selection !== "selected") return null;
  return {
    installationId: installation.id as number,
    accountLogin: login,
    repositorySelection: selection,
    ...(typeof account?.type === "string" && account.type && { accountType: account.type }),
    suspended: installation.suspended_at != null,
  };
}

// The GitHub id of the user or organization an installation is on, or null when GitHub did not say.
export function installationAccountId(value: unknown): number | null {
  const id = record(record(value)?.account)?.id;
  return Number.isSafeInteger(id) ? (id as number) : null;
}

export function userOf(value: unknown): GithubUser | null {
  const user = record(value);
  return user && Number.isSafeInteger(user.id) && typeof user.login === "string" && user.login ? { id: user.id as number, login: user.login } : null;
}

export function repositoriesOf(value: unknown): Repository[] | null {
  if (!Array.isArray(value)) return null;
  const repositories: Repository[] = [];
  for (const item of value) {
    const repository = record(item);
    const fullName = repository?.full_name;
    if (typeof fullName !== "string" || !REPOSITORY_PATTERN.test(fullName)) return null;
    repositories.push({ fullName, ...(typeof repository?.private === "boolean" && { private: repository.private }) });
  }
  return repositories;
}

/** A repository as GitHub lists it for a person, and whether that person may change it. */
export type PersonRepository = Repository & { canPush: boolean };

// GitHub's permissions object ({ admin, maintain, push, triage, pull }): only push, maintain or admin let a person
// change a repository. Anything else, or no answer at all, counts as reading only.
const pushes = (permissions: unknown) => {
  const granted = record(permissions);
  return granted?.push === true || granted?.maintain === true || granted?.admin === true;
};

/** GET /user/installations/{id}/repositories: each repository with the person's own permissions in it. */
export function personRepositoriesOf(value: unknown): PersonRepository[] | null {
  const repositories = repositoriesOf(value);
  if (!repositories || !Array.isArray(value)) return null;
  return repositories.map((repository, index) => ({ ...repository, canPush: pushes(record(value[index])?.permissions) }));
}

/** GET /repos/{owner}/{repo}/collaborators/{username}/permission: whether that person may change the repository, and
 * the id of the user GitHub answered for. The legacy permission is admin, write (which includes maintain), read or none. */
export function collaboratorPermissionOf(value: unknown): { canPush: boolean; userId: number | null } | null {
  const answer = record(value);
  if (typeof answer?.permission !== "string") return null;
  const user = record(answer.user);
  const userId = Number.isSafeInteger(user?.id) ? (user?.id as number) : null;
  return { canPush: answer.permission === "admin" || answer.permission === "write", userId };
}
