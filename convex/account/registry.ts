import type { FunctionReference, IndexNames, NamedTableInfo } from "convex/server";
import type { DataModel, Id, TableNames } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { codeNamespace } from "../codeNetwork/schema";
import { eraseIntakeWindows, eraseSignIn, type Progress } from "./erasers";

declare const process: { env: Record<string, string | undefined> };

// What deleting an account removes, module by module (convex/account/README.md). The job in deletion.ts walks these
// lists in order: for each project the account owns, every case's rows (caseErasers) and then the case; then the
// project's own rows (projectErasers) and then the project; then the account's rows (accountErasers), the sign-in
// records last. tests/account-deletion.test.mjs fails for a table in convex/schema.ts that no line here names and that
// is not exempt there with a reason.
//
// Adding a table is one line in the list for what it hangs off:
//   caseRows("myTable", "by_case")                       rows whose caseId is one of the project's cases
//   projectRows("myTable", "by_app")                     rows whose appId is the project (text: true when the field holds the id as text)
//   accountRows("myTable", "by_account")                 rows whose account field is the account id
//   call("project", "mine.project", ["myTable"], internal.mine.erase.project)
//   call("account", "mine.account", ["myTable"], internal.mine.erase.account)
// The index's first field must be the field named (the test checks). A call entry is an internal mutation taking
// { appId } or { account } that deletes a bounded batch of its rows and returns { done: true } once none are left; the
// job calls it again until it does. Each name is stored in the deletion record, so keep it stable.
//
// A new Supermemory namespace built from a project id is one line in `namespaces`.

type Index<T extends TableNames> = IndexNames<NamedTableInfo<DataModel, T>>;

export type RowsEraser = {
  kind: "rows";
  table: TableNames;
  index: string;
  /** The index's first field, which holds the case id, project id or account id. */
  field: string;
  /** The field holds the project id as text (codeNetworks.projectId). */
  text?: boolean;
  /** A field holding a file in Convex storage, deleted with the row. */
  file?: string;
};
export type InlineEraser = {
  kind: "inline";
  name: string;
  tables: TableNames[];
  erase: (ctx: MutationCtx, target: string, budget: number) => Promise<Progress>;
};
export type CallEraser = {
  kind: "call";
  name: string;
  tables: TableNames[];
  run: FunctionReference<"mutation", "internal", { appId: Id<"apps"> }, { done: boolean }> | FunctionReference<"mutation", "internal", { account: string }, { done: boolean }>;
};
export type Eraser = RowsEraser | InlineEraser | CallEraser;

const rows =
  (field: string) =>
  <T extends TableNames>(table: T, index: Index<T>, options: { field?: string; text?: boolean; file?: string } = {}): RowsEraser => ({
    kind: "rows",
    table,
    index: index as string,
    field: options.field ?? field,
    ...(options.text && { text: true }),
    ...(options.file && { file: options.file }),
  });
export const caseRows = rows("caseId");
export const projectRows = rows("appId");
export const accountRows = rows("account");
export const inline = (name: string, tables: TableNames[], erase: InlineEraser["erase"]): InlineEraser => ({ kind: "inline", name, tables, erase });
export function call(scope: "project", name: string, tables: TableNames[], run: FunctionReference<"mutation", "internal", { appId: Id<"apps"> }, { done: boolean }>): CallEraser;
export function call(scope: "account", name: string, tables: TableNames[], run: FunctionReference<"mutation", "internal", { account: string }, { done: boolean }>): CallEraser;
export function call(_scope: "project" | "account", name: string, tables: TableNames[], run: CallEraser["run"]): CallEraser {
  return { kind: "call", name, tables, run };
}

/** Everything that hangs off one case, removed before the case itself. */
export const caseErasers: Eraser[] = [
  caseRows("ownerNotices", "by_case_and_event"),
  caseRows("pushSends", "by_case"),
  caseRows("fixChatMessages", "by_case"),
  caseRows("voiceTurns", "by_case_and_start"),
  caseRows("evidence", "by_case"),
  caseRows("verifications", "by_case"),
  caseRows("actions", "by_case"),
  caseRows("proposals", "by_case"),
  caseRows("agentRuns", "by_case"),
  caseRows("councilReviews", "by_case"),
  caseRows("structuralFindings", "by_case"),
  caseRows("ownerDecisions", "by_case"),
  caseRows("contextUses", "by_case"),
  caseRows("pullRequests", "by_case"),
  caseRows("reportTriage", "by_case"),
  // Revyl's screenshots of the owner's app: the file in Convex storage goes with its row.
  caseRows("revylScreenshots", "by_case", { file: "storageId" }),
  caseRows("revylRuns", "by_case"),
  caseRows("stepAttempts", "by_case"),
  caseRows("steps", "by_case"),
];

/** Everything that hangs off one project, removed after its cases and before the project itself. */
export const projectErasers: Eraser[] = [
  // Customers' reports and their triage (RC-25). The copies at Supermemory go with the reports_ namespace.
  projectRows("reports", "by_app_and_provider_event"),
  projectRows("reportTriage", "by_app_and_status"),
  // The report form's rate-limit counters, found through the project's keys, so before the keys.
  inline("intake.windows", ["intakeRateWindows"], eraseIntakeWindows),
  projectRows("intakeKeys", "by_app"),
  projectRows("intakeLocks", "by_app"),
  projectRows("intakeDays", "by_app_and_day"),
  projectRows("journeys", "by_app"),
  projectRows("actionCatalog", "by_app_and_type"),
  projectRows("permissions", "by_app"),
  projectRows("ownerPreferences", "by_app"),
  projectRows("preferenceSuggestions", "by_app_and_status"),
  projectRows("ownerDecisions", "by_app"),
  projectRows("recoveryMemories", "by_app_and_signature"),
  projectRows("contextSources", "by_app"),
  projectRows("agentRuns", "by_app"),
  projectRows("councilSettings", "by_app"),
  projectRows("councilReviews", "by_app"),
  projectRows("structuralFindings", "by_app"),
  projectRows("onboardingInspections", "by_app"),
  projectRows("onboardingPreparations", "by_app"),
  // The map of the code, and the questions asked about it. Its documents at Supermemory go with the code_ namespace.
  projectRows("codeNetworks", "by_project", { field: "projectId", text: true }),
  projectRows("codeChatMessages", "by_project_scope_and_at", { field: "projectId", text: true }),
  // The project's own control token, sealed (convex/secrets), and the monitor's note of why it last skipped the project.
  projectRows("secrets", "by_app_and_kind"),
  projectRows("watchedProjects", "by_app"),
  // A practice project's practice app: its switches, its token's hash, and any test booking its check left behind.
  projectRows("practiceApps", "by_app"),
  projectRows("practiceBookings", "by_app_and_fixture"),
];

/** The account's own rows, removed after its projects. The sign-in records go last. */
export const accountErasers: Eraser[] = [
  accountRows("pushTokens", "by_account_and_disabled"),
  accountRows("aiConsents", "by_account"),
  accountRows("modelSpend", "by_account_and_month"),
  accountRows("accountSpendDays", "by_account_and_day"),
  accountRows("codingThreads", "by_account_day_and_request"),
  // The account's coding agent key, sealed (convex/secrets). A project's control token went with the project above.
  accountRows("secrets", "by_account_and_kind"),
  inline("auth.signIn", ["authSessions", "authRefreshTokens", "authVerifiers", "authAccounts", "authVerificationCodes", "authPasswordResets", "authRateLimits", "users"], eraseSignIn),
];

/** Supermemory namespaces a project's data is written to, by the name the writer passes (convex/supermemory.ts adds
 * SUPERMEMORY_NAMESPACE_PREFIX). Each is deleted whole. A codeNetworks row's own namespace is deleted too. The writers'
 * modules are heavy to import here, so their names are repeated; tests/account-deletion.test.mjs checks they agree. */
export const namespaces: ((appId: Id<"apps">) => string)[] = [
  (appId) => `app_${appId}`, // incident memory: convex/memory/service.ts
  (appId) => `prefs_${appId}`, // the owner's preferences: preferenceNamespace in convex/learning/preferences.ts
  // customers' reports: reportsNamespace in convex/intake/triage.ts
  (appId) => `${process.env.INTAKE_NAMESPACE_PREFIX ?? ""}reports_${appId}`.replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 100),
  codeNamespace, // the map of the code: convex/codeNetwork/build.ts
];

/** Tables whose rows go through a deletion at a vendor (convex/account/vendors.ts), not through a list above. Their
 * rows stay until the vendor confirms, so the job still knows what to ask the vendor to delete. */
export const vendorTables: Record<"github" | "apple", TableNames[]> = {
  // Connect GitHub: internal.github.connect.disconnectAccount uninstalls every installation on the person's own GitHub
  // account that only this account uses and removes its token, repositories and links; from any other installation
  // (an organization's, or one others still use) it removes the account's links, with what they remember (the GitHub
  // user, the repositories, what was left out and why) and the cached token; and it forgets the connect attempts. A deleted installation keeps its row (so a replayed webhook cannot
  // revive it) with the GitHub login blanked.
  github: ["githubConnectAttempts", "githubInstallationLinks", "githubInstallations", "githubInstallationRepositories", "githubInstallationTokens"],
  // Sign in with Apple: each kept refresh token is revoked at Apple, then forgotten.
  apple: ["authAppleTokens"],
};

/** Tables the job itself walks: a project's cases, and the project. */
export const engineTables: TableNames[] = ["apps", "cases"];

export const callEntry = (scope: "project" | "account", name: string): CallEraser | undefined =>
  (scope === "project" ? projectErasers : accountErasers).find((entry): entry is CallEraser => entry.kind === "call" && entry.name === name);
