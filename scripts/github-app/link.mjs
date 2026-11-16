#!/usr/bin/env node
// Prints the link that opens GitHub's "Register new GitHub App" form with turtl's settings filled in, built from
// convex/github/app-manifest.json.
//   node scripts/github-app/link.mjs --site https://<deployment>.convex.site [--name "turtl on-call"] [--homepage <url>] [--org <organization>] [--manifest]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PLACEHOLDER_SITE = "https://YOUR-DEPLOYMENT.convex.site";

export const readManifest = () => JSON.parse(readFileSync(new URL("../../convex/github/app-manifest.json", import.meta.url), "utf8"));

// The manifest with its placeholder host replaced by a Convex deployment's HTTP address.
export const withSite = (manifest, site) => JSON.parse(JSON.stringify(manifest).replaceAll(PLACEHOLDER_SITE, site.replace(/\/+$/, "")));

// GitHub's registration form reads these query parameters; it cannot take a webhook secret this way.
export function registrationUrl(manifest, organization) {
  const params = new URLSearchParams({
    name: manifest.name,
    description: manifest.description,
    url: manifest.url,
    public: String(manifest.public),
    webhook_active: String(manifest.hook_attributes.active),
    webhook_url: manifest.hook_attributes.url,
    setup_url: manifest.setup_url,
    setup_on_update: String(manifest.setup_on_update),
    request_oauth_on_install: String(manifest.request_oauth_on_install),
  });
  for (const callback of manifest.callback_urls) params.append("callback_urls[]", callback);
  for (const event of manifest.default_events) params.append("events[]", event);
  for (const [permission, level] of Object.entries(manifest.default_permissions)) params.set(permission, level);
  return `https://github.com/${organization ? `organizations/${organization}/` : ""}settings/apps/new?${params}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const option = (name) => {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? undefined : process.argv[index + 1];
  };
  const site = option("site");
  const manifest = { ...withSite(readManifest(), site ?? PLACEHOLDER_SITE), ...(option("name") && { name: option("name") }), ...(option("homepage") && { url: option("homepage") }) };
  if (!site) console.error(`No --site given: the addresses still hold the placeholder ${PLACEHOLDER_SITE}.`);
  console.log(process.argv.includes("--manifest") ? JSON.stringify(manifest, null, 2) : registrationUrl(manifest, option("org")));
}
