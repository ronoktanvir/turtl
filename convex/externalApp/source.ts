import type { ExternalApp } from "./validators";

declare const process: { env: Record<string, string | undefined> };

export async function readSource(config: ExternalApp, revision: string) {
  if (!/^[a-f0-9]{40}$/.test(revision)) return { files: [], missing: ["The running revision is not a full commit SHA."] };
  const paths = config.sourcePaths ?? ["lib/game.ts", "app/api/answer/route.ts", "lib/db.ts", "db/schema.sql"];
  const results = await Promise.all(paths.slice(0, 12).map(async (path) => {
    if (!path || path.startsWith("/") || path.split("/").includes("..") || /(^|\/)\.env|\.pem$|\.key$/i.test(path)) return { path, error: "This source path is not allowed." };
    const url = `https://api.github.com/repos/${config.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${revision}`;
    const headers: Record<string, string> = { Accept: "application/vnd.github.raw+json", "User-Agent": "turtl" };
    const token = process.env[config.githubCredentialRef];
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      let response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      if (response.status === 401 && token) {
        delete headers.Authorization;
        response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      }
      if (!response.ok) return { path, error: `Source unavailable: GitHub HTTP ${response.status}.` };
      const source = await response.text();
      if (source.length > 60_000) return { path, error: "Source exceeds the 60 KB evidence limit." };
      return { path, source, url: `https://github.com/${config.repo}/blob/${revision}/${path}`, revision };
    } catch {
      return { path, error: "Source request failed or timed out." };
    }
  }));
  return { files: results.filter((row): row is typeof row & { source: string; url: string; revision: string } => typeof row.source === "string"), missing: results.filter((row) => row.error).map((row) => `${row.path}: ${row.error}`) };
}
