#!/usr/bin/env node
// Checks the environment variables set on a Convex deployment against release/backend-env.mjs. It asks Convex for the
// names, and for the value of only the variables whose row names the exact value production needs (AUTH_REQUIRED,
// which is not a secret). It never reads a secret's value, and never prints or stores a value.
//
//   CONVEX_DEPLOY_KEY=... node release/check-backend-env.mjs      the deployment that key belongs to
//   node release/check-backend-env.mjs --prod                     this project's production deployment, with your Convex login
//   node release/check-backend-env.mjs --deployment <name>        any deployment you can reach
//   npx convex env list --names-only | node release/check-backend-env.mjs --stdin
//   node release/check-backend-env.mjs --write-table              rewrite the table in backend-runbook.md from backend-env.mjs
//
// With --stdin the check sees what it is given: names only, or NAME=value lines, of which it keeps only the values of
// rows that name an exact value.
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
const fromStdin = args.includes("--stdin");
let listing;
if (fromStdin) {
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

const lines = listing.split("\n");
const names = [...new Set(lines.map((line) => line.split("=")[0].trim()).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))];

// The values production pins, read one by one. Only rows that name an exact value, and never a secret's.
const pinned = variables.filter((row) => row.exactly !== undefined && !row.secret && names.includes(row.name));
const values = {};
for (const row of pinned) {
  if (fromStdin) {
    const line = lines.find((candidate) => candidate.startsWith(row.name + "="));
    if (line !== undefined) values[row.name] = line.slice(row.name.length + 1).replace(/\r$/, "");
    continue;
  }
  const result = spawnSync("npx", ["convex", "env", "get", row.name, ...args], { encoding: "utf8" });
  // The value is printed with one line break after it; anything else around it is part of the value.
  if (result.status === 0 && result.stdout.endsWith("\n")) values[row.name] = result.stdout.slice(0, -1);
}

const problems = deploymentProblems(names, values);

console.log(`Variable names set on this deployment: ${names.length}. Values read: ${Object.keys(values).join(", ") || "none"} (never printed).`);
for (const row of variables) {
  const set = names.includes(row.name);
  if (!set && row.production === "optional") continue;
  const verdict = row.production === "never" ? (set ? "REMOVE " : "unset  ") : set ? "set    " : row.production === "required" ? "MISSING" : "unset  ";
  const exact = row.exactly === undefined || !set ? "" : row.name in values ? (values[row.name] === row.exactly ? `, exactly "${row.exactly}"` : `, NOT exactly "${row.exactly}"`) : `, value not read: check it is exactly "${row.exactly}"`;
  console.log(`  ${verdict}  ${row.name} (${row.production === "never" ? "never set" : row.production}${exact})`);
}
if (problems.length) {
  console.error(`\nThis deployment is not ready for production:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log("\nThe variables match the table.");
