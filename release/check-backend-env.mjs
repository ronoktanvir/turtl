#!/usr/bin/env node
// Checks the names of the environment variables set on a Convex deployment against release/backend-env.mjs.
// It asks Convex for names only and never reads, prints, or stores a value.
//
//   CONVEX_DEPLOY_KEY=... node release/check-backend-env.mjs      the deployment that key belongs to
//   node release/check-backend-env.mjs --prod                     this project's production deployment, with your Convex login
//   node release/check-backend-env.mjs --deployment <name>        any deployment you can reach
//   npx convex env list --names-only | node release/check-backend-env.mjs --stdin
//   node release/check-backend-env.mjs --write-table              rewrite the table in backend-runbook.md from backend-env.mjs
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { deploymentProblems, markdownTable, variables } from "./backend-env.mjs";

const args = process.argv.slice(2);
if (args.includes("--write-table")) {
  const runbook = new URL("backend-runbook.md", import.meta.url);
  writeFileSync(runbook, readFileSync(runbook, "utf8").replace(/(<!-- variables:start -->)[\s\S]*?(<!-- variables:end -->)/, (_, start, end) => `${start}\n${markdownTable()}\n${end}`));
  console.log("Rewrote the table in release/backend-runbook.md.");
  process.exit(0);
}
let listing;
if (args.includes("--stdin")) {
  listing = readFileSync(0, "utf8");
} else {
  const result = spawnSync("npx", ["convex", "env", "list", "--names-only", ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error(`Convex could not list this deployment's variable names (exit ${result.status ?? "unknown"}).`);
    console.error((result.stderr || String(result.error ?? "")).trim());
    process.exit(2);
  }
  listing = result.stdout;
}

const names = [...new Set(listing.split("\n").map((line) => line.split("=")[0].trim()).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))];
const problems = deploymentProblems(names);

console.log(`Variable names set on this deployment: ${names.length}. Values were not read.`);
for (const row of variables) {
  const set = names.includes(row.name);
  if (!set && row.production === "optional") continue;
  const verdict = row.production === "never" ? (set ? "REMOVE " : "unset  ") : set ? "set    " : row.production === "required" ? "MISSING" : "unset  ";
  console.log(`  ${verdict}  ${row.name} (${row.production === "never" ? "never set" : row.production})`);
}
if (problems.length) {
  console.error(`\nThis deployment is not ready for production:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log("\nThe variable names match the table.");
