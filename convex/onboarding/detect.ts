// Plain functions the onboarding inspection runs over a repository before any model sees it. The only import is the
// masking (convex/codeNetwork/redact.ts, itself import-free), so tests load this file with that one beside it.
//
// Nothing from a file that is secret by nature (.env, a key, secrets.yml) is read here: it gives no pattern match and no
// stack evidence. Every line and name that can leave is masked before it is cut.

import { isSecretFile, masked } from "../codeNetwork/redact";

export const READINESS_ITEMS = [
  { key: "error_logs", label: "Structured error logs with identifiers" },
  { key: "health_check", label: "Health check" },
  { key: "readiness_check", label: "Readiness check" },
  { key: "journey_checks", label: "Checks for the important user journeys" },
  { key: "feature_flags", label: "Feature flags" },
  { key: "recovery_hooks", label: "Recovery hooks" },
  { key: "test_fixtures", label: "Test accounts and fixtures" },
] as const;

export type ItemKey = (typeof READINESS_ITEMS)[number]["key"];
export type ItemStatus = "found" | "missing" | "unknown";
export type RepoFile = { path: string; content: string };
export type Hit = { path: string; line: number; text: string };
export type FileRef = { path: string; line?: number };
export type Item = { key: ItemKey; status: ItemStatus; note: string; files: FileRef[] };
export type Stack = { id: string; label: string; supported: boolean; evidence: string[] };

export const SUPPORTED_STACK = "expo-convex";
export const MANIFEST_FILE = "turtl.json";

const MAX_HITS_PER_ITEM = 14;
const MAX_HITS_PER_FILE = 3;
const SKIPPED = /(^|\/)(node_modules|dist|build|\.next|\.expo|_generated|vendor|coverage|ios|android|\.git)\//;
const LOCKFILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock)$/;
const TEXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|py|rb|go|rs|java|kt|swift|sql|ya?ml|toml|md|sh|prisma|graphql)$|(^|\/)(Dockerfile|Procfile|Gemfile|requirements\.txt|go\.mod|\.env\.example)$/i;
const TEST_PATH = /(\.(spec|test)\.[cm]?[jt]sx?$|(^|\/)(e2e|__tests__|tests?)\/|playwright\.config|cypress|\.maestro\/|(^|\/)detox)/i;

// Owner input: "https://github.com/owner/name", optionally ".git", or ".../tree/<branch>/<folder>".
export function parseGithubUrl(input: string): { repo: string; folder?: string } | null {
  const match = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/[^/]+\/(.+?))?\/?$/i.exec(input.trim());
  if (!match) return null;
  const folder = match[3] ? normalizeFolders([decodeURIComponent(match[3])])[0] : undefined;
  return { repo: `${match[1]}/${match[2]}`, ...(folder && { folder }) };
}

export function normalizeFolders(folders: string[]): string[] {
  const clean = folders
    .map((folder) => folder.trim().replace(/^\.?\/+/, "").replace(/\/+$/, ""))
    .filter((folder) => folder.length > 0);
  for (const folder of clean) {
    if (folder.split("/").some((part) => part === ".." || part === ".")) throw new Error(`"${folder}" is not a folder inside the repository.`);
    // Folder names are written into the coding agent's brief, so nothing that could end a quote or start a new line.
    if (folder.length > 200 || /[\u0000-\u001f\u007f`"<>\\]/.test(folder)) throw new Error("A folder name can't contain quotes, backticks, angle brackets or line breaks.");
  }
  return [...new Set(clean)];
}

export function readable(path: string, size = 0): boolean {
  return !SKIPPED.test(path) && !LOCKFILES.test(path) && TEXT.test(path) && size <= 150_000;
}

export const inFolders = (path: string, folders: string[]) =>
  folders.length === 0 || folders.some((folder) => path === folder || path.startsWith(`${folder}/`));

function resolveImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const parts = from.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return parts.join("/");
}

// The app's files: everything under its folders, plus files elsewhere that import from them (one hop), such
// as a shared HTTP router that mounts the app's routes. With no folders the whole repository is the app.
export function scopeFiles(files: RepoFile[], folders: string[]): RepoFile[] {
  if (folders.length === 0) return files;
  const importer = /(?:from\s+|require\(\s*|import\(\s*)["']([^"']+)["']/g;
  return files.filter((file) => {
    if (inFolders(file.path, folders)) return true;
    for (const match of file.content.matchAll(importer)) {
      const target = resolveImport(file.path, match[1]);
      if (target && folders.some((folder) => target === folder || target.startsWith(`${folder}/`))) return true;
    }
    return false;
  });
}

function dependencies(content: string): Record<string, string> {
  try {
    const parsed = JSON.parse(content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    return { ...parsed.dependencies, ...parsed.devDependencies };
  } catch {
    return {};
  }
}

// A dependency's version as package.json writes it, repeated only when it is a plain version or range ("~51.0.28",
// "^1.2", "latest"). Anything else (an address to fetch it from, an alias) can carry a token, so it is not repeated.
const versionOf = (spec: unknown) =>
  typeof spec === "string" && /^[\w.^~<>=*| -]{1,40}$/.test(spec) ? masked(spec) : "(from an address turtl does not repeat)";

// Names the stack from manifests in the app's files. Only Expo with a Convex backend is prepared automatically.
export function detectStack(scoped: RepoFile[]): Stack {
  const evidence: string[] = [];
  const found = new Set<string>();
  const note = (id: string, why: string) => {
    found.add(id);
    const shown = masked(why);
    if (!evidence.includes(shown)) evidence.push(shown);
  };
  for (const file of scoped) {
    if (isSecretFile(file.path)) continue;
    const name = file.path.split("/").pop() ?? "";
    if (name === "package.json") {
      const deps = dependencies(file.content);
      const has = (dep: string) => dep in deps;
      if (has("expo")) note("expo", `${file.path} depends on expo ${versionOf(deps.expo)}`);
      if (has("convex")) note("convex-client", `${file.path} depends on convex ${versionOf(deps.convex)}`);
      if (has("next")) note("nextjs", `${file.path} depends on next ${versionOf(deps.next)}`);
      if (has("express")) note("express", `${file.path} depends on express ${versionOf(deps.express)}`);
      if (has("pg") || has("postgres") || has("@vercel/postgres") || has("@neondatabase/serverless")) note("postgres", `${file.path} uses a Postgres driver`);
      if (has("@supabase/supabase-js")) note("supabase", `${file.path} depends on @supabase/supabase-js`);
      if (has("firebase")) note("firebase", `${file.path} depends on firebase`);
      if (has("vite") && !has("expo")) note("vite", `${file.path} depends on vite`);
      if (has("react-native") && !has("expo")) note("react-native", `${file.path} depends on react-native without expo`);
    }
    if (name === "app.json" && /"expo"\s*:/.test(file.content)) note("expo", `${file.path} is an Expo app config`);
    if (/(^|\/)convex\/[^/]+.*\.ts$/.test(file.path) && !file.path.includes("_generated")) note("convex", `${file.path.slice(0, file.path.lastIndexOf("/") + 1)} holds Convex functions`);
    if (name.endsWith(".sql")) note("sql", `${file.path} is a SQL schema`);
    if (name === "requirements.txt" || name === "pyproject.toml") note("python", `${file.path} is a Python manifest`);
    if (name === "Gemfile") note("ruby", `${file.path} is a Ruby manifest`);
    if (name === "go.mod") note("go", `${file.path} is a Go module`);
  }
  const has = (id: string) => found.has(id);
  const convex = has("convex");
  if (has("expo") && convex) {
    return { id: SUPPORTED_STACK, label: "Expo with a Convex backend", supported: true, evidence };
  }
  const parts: string[] = [];
  if (has("nextjs")) parts.push("Next.js");
  else if (has("expo")) parts.push("Expo");
  else if (has("react-native")) parts.push("React Native");
  else if (has("vite")) parts.push("Vite");
  if (has("express")) parts.push("Express");
  if (convex) parts.push("Convex");
  if (has("supabase")) parts.push("Supabase");
  if (has("firebase")) parts.push("Firebase");
  if (has("postgres")) parts.push("Postgres");
  else if (has("sql")) parts.push("a SQL database");
  if (has("python")) parts.push("Python");
  if (has("ruby")) parts.push("Ruby");
  if (has("go")) parts.push("Go");
  if (parts.length === 0) return { id: "unknown", label: "a stack turtl could not recognise", supported: false, evidence };
  const label = parts.length === 1 ? parts[0] : `${parts[0]} with ${parts.slice(1).join(" and ")}`;
  return { id: label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), label, supported: false, evidence };
}

const SIGNALS: Record<ItemKey, RegExp[]> = {
  error_logs: [
    /console\.error\(|logger\.(error|warn)\(|\b(pino|winston|bunyan|@sentry\/|Sentry\.capture)/,
    /\b(requestId|request_id|traceId|trace_id|correlationId|correlation_id|errorId|runId)\b/,
    /\bcode\s*:\s*["'][A-Z][A-Z0-9_]{3,}["']/,
  ],
  health_check: [/["'`][^"'`\s]*\/(health|healthz|healthcheck|livez|ping)["'`/?]/i],
  readiness_check: [/["'`][^"'`\s]*\/(ready|readyz|readiness)["'`/?]/i, /\breadiness\b/i],
  journey_checks: [/journey[-_ ]?check|smoke[-_ ]?test|synthetic (check|monitor)/i, /\b(playwright|cypress|detox|maestro)\b/i],
  feature_flags: [/feature[-_ ]?flags?|launchdarkly|unleash|growthbook|statsig|isFeatureEnabled/i, /["'`][^"'`\s]*\/flags["'`/?]|\b[a-z]\w*Enabled\b/],
  recovery_hooks: [/["'`][^"'`\s]*\/(flags|kill-?switch|maintenance|restart|rollback|recover\w*|disable\w*)["'`/?]/i, /\b(killSwitch|maintenanceMode|rollback|restartService)\b/],
  test_fixtures: [/fixture|test[-_ ]?(account|user)|demo[-_ ]?user|\bseed(ed|ing)?\b/i],
};

/** A pattern match's line is cut to this many characters, after its secrets are masked. */
export const HIT_CHARS = 200;

// Lines that look like evidence for each item. Matches are candidates for the model to judge, not findings. A file that
// is secret by nature gives none, and each line is masked before it is cut, so no secret is cut in two.
export function scanSignals(scoped: RepoFile[]): Record<ItemKey, Hit[]> {
  const hits = Object.fromEntries(READINESS_ITEMS.map((item) => [item.key, [] as Hit[]])) as Record<ItemKey, Hit[]>;
  for (const file of scoped) {
    if (file.path.endsWith(".md") || isSecretFile(file.path)) continue;
    const perFile = new Map<ItemKey, number>();
    if (TEST_PATH.test(file.path)) {
      hits.journey_checks.push({ path: file.path, line: 1, text: "test file" });
      perFile.set("journey_checks", 1);
    }
    const lines = file.content.split("\n");
    lines.forEach((raw, index) => {
      const text = raw.trim();
      if (!text || text.length > 400) return;
      for (const item of READINESS_ITEMS) {
        if ((perFile.get(item.key) ?? 0) >= MAX_HITS_PER_FILE) continue;
        if (!SIGNALS[item.key].some((pattern) => pattern.test(text))) continue;
        hits[item.key].push({ path: file.path, line: index + 1, text: masked(text).slice(0, HIT_CHARS) });
        perFile.set(item.key, (perFile.get(item.key) ?? 0) + 1);
      }
    });
  }
  for (const item of READINESS_ITEMS) {
    const spread = new Map<string, Hit[]>();
    for (const hit of hits[item.key]) spread.set(hit.path, [...(spread.get(hit.path) ?? []), hit]);
    const ordered: Hit[] = [];
    for (let round = 0; ordered.length < MAX_HITS_PER_ITEM && round < MAX_HITS_PER_FILE; round++) {
      for (const list of spread.values()) if (list[round] && ordered.length < MAX_HITS_PER_ITEM) ordered.push(list[round]);
    }
    hits[item.key] = ordered;
  }
  return hits;
}

export function manifestPath(folders: string[]): string {
  return folders.length ? `${folders[0]}/${MANIFEST_FILE}` : MANIFEST_FILE;
}

// Keeps only citations of files turtl actually read, with a line inside the file. A "found" item left with no
// confirmed file becomes "unknown": turtl does not repeat a claim it cannot point to.
export function confirmItems(items: Item[], scoped: RepoFile[]): Item[] {
  const lineCounts = new Map(scoped.map((file) => [file.path, file.content.split("\n").length]));
  return READINESS_ITEMS.map(({ key }) => {
    const item = items.find((candidate) => candidate.key === key);
    if (!item) return { key, status: "unknown" as const, note: "turtl got no judgement for this item.", files: [] };
    const files = item.files
      .filter((file) => lineCounts.has(file.path))
      .map((file) => (file.line && file.line > 0 && file.line <= lineCounts.get(file.path)! ? file : { path: file.path }))
      .filter((file, index, all) => all.findIndex((other) => other.path === file.path && other.line === file.line) === index)
      .slice(0, 6);
    if (item.status === "found" && files.length === 0) {
      return { key, status: "unknown" as const, note: `${item.note} turtl could not confirm a file for this, so it is marked unknown.`, files: [] };
    }
    return { key, status: item.status, note: item.note, files: item.status === "found" ? files : [] };
  });
}

// Used when no model answered: a pattern match is reported as a lead, and nothing is called missing.
export function ruleItems(hits: Record<ItemKey, Hit[]>): Item[] {
  return READINESS_ITEMS.map(({ key }) =>
    hits[key].length
      ? { key, status: "found" as const, note: "A file pattern matched this; no model judged whether it is complete.", files: hits[key].slice(0, 4).map(({ path, line }) => ({ path, line })) }
      : { key, status: "unknown" as const, note: "No file pattern matched, and without a model turtl cannot say it is missing.", files: [] },
  );
}

/**
 * The one name a turtl.json may give as its bearer token. It equals CREDENTIAL_REF in convex/protectedApp/client.ts,
 * which refuses every other name when a request is made: a project's file must never choose which of the
 * deployment's secrets is sent to that project's server. With accounts on it stands for the project's own control
 * token, which its owner enters in turtl; in the single-owner demo, for the deployment's variable of that name.
 */
export const MANIFEST_CREDENTIAL_REF = "PROTECTED_APP_CONTROL_SECRET";

/** turtl reads at most this many entries of each list in turtl.json (journeys, flags, recovery hooks). */
export const MAX_MANIFEST_ENTRIES = 20;
/** A larger turtl.json is not read at all. */
export const MAX_MANIFEST_BYTES = 1_000_000;

export type ManifestCheck = { name: string; description?: string; path: string; authenticated?: boolean };
export type ManifestSwitch = ManifestCheck & { field: string };
export type Manifest = {
  version: 1;
  credentialRef?: string;
  health?: ManifestCheck;
  readiness?: ManifestCheck;
  journeys: ManifestCheck[];
  flags: ManifestSwitch[];
  recoveryHooks: ManifestSwitch[];
};

// turtl.json, written by the preparation pull request. Paths are relative to the live app URL. Each list keeps its
// first MAX_MANIFEST_ENTRIES usable entries, and `note` says what was left out.
export function parseManifest(text: string): { ok: true; manifest: Manifest; note?: string } | { ok: false; reason: string } {
  if (text.length > MAX_MANIFEST_BYTES) return { ok: false, reason: `${MANIFEST_FILE} is larger than ${MAX_MANIFEST_BYTES / 1_000_000} MB, so turtl did not read it.` };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: `${MANIFEST_FILE} is not valid JSON.` };
  }
  const object = raw as Record<string, unknown> | null;
  if (!object || typeof object !== "object" || object.version !== 1) return { ok: false, reason: `${MANIFEST_FILE} must be an object with "version": 1.` };
  const path = (value: unknown) => typeof value === "string" && value.startsWith("/") && !value.includes("..") && !/^\/\//.test(value);
  const check = (value: unknown, fallbackName: string): ManifestCheck | null => {
    const entry = value as Record<string, unknown> | null;
    if (!entry || typeof entry !== "object" || !path(entry.path)) return null;
    // Names and descriptions reach the models that diagnose cases and propose fixes, so they are masked, then cut.
    return {
      name: typeof entry.name === "string" && entry.name.trim() ? masked(entry.name.trim()).slice(0, 120) : fallbackName,
      ...(typeof entry.description === "string" && { description: masked(entry.description).slice(0, 500) }),
      path: entry.path as string,
      ...(entry.authenticated === true && { authenticated: true }),
    };
  };
  const switches = (value: unknown, label: string): ManifestSwitch[] =>
    (Array.isArray(value) ? value : []).flatMap((entry) => {
      const base = check(entry, label);
      const field = (entry as Record<string, unknown>)?.field ?? (entry as Record<string, unknown>)?.name;
      return base && typeof field === "string" && /^[A-Za-z_][\w]*$/.test(field) ? [{ ...base, field }] : [];
    });
  const credentialRef = object.credentialRef;
  if (credentialRef !== undefined && credentialRef !== MANIFEST_CREDENTIAL_REF) {
    return { ok: false, reason: `credentialRef must be ${MANIFEST_CREDENTIAL_REF}, the one setting turtl sends to a watched app. It names the setting and is never the secret itself.` };
  }
  const health = check(object.health, "Health check");
  const readiness = check(object.readiness, "Readiness check");
  const lists = {
    journeys: (Array.isArray(object.journeys) ? object.journeys : []).flatMap((entry) => {
      const journey = check(entry, "Journey");
      return journey ? [journey] : [];
    }),
    flags: switches(object.flags, "Feature flag"),
    recoveryHooks: switches(object.recoveryHooks, "Recovery hook"),
  };
  const over = (Object.entries(lists) as [keyof typeof lists, unknown[]][]).filter(([, list]) => list.length > MAX_MANIFEST_ENTRIES);
  const words = { journeys: "journeys", flags: "flags", recoveryHooks: "recovery hooks" };
  return {
    ok: true,
    manifest: {
      version: 1,
      ...(credentialRef !== undefined && { credentialRef: credentialRef as string }),
      ...(health && { health }),
      ...(readiness && { readiness }),
      journeys: lists.journeys.slice(0, MAX_MANIFEST_ENTRIES),
      flags: lists.flags.slice(0, MAX_MANIFEST_ENTRIES),
      recoveryHooks: lists.recoveryHooks.slice(0, MAX_MANIFEST_ENTRIES),
    },
    ...(over.length > 0 && {
      note: `${MANIFEST_FILE} lists ${over.map(([key, list]) => `${list.length} ${words[key]}`).join(" and ")}. turtl checks only the first ${MAX_MANIFEST_ENTRIES} of each list.`,
    }),
  };
}
