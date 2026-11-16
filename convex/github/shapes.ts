import { REPOSITORY_PATTERN } from "./config";

export type Installation = { installationId: number; accountLogin: string; repositorySelection: "all" | "selected" };
export type Repository = { fullName: string; private?: boolean };

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
    suspended: installation.suspended_at != null,
  };
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
