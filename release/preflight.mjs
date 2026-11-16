#!/usr/bin/env node
// Checks the repository is fit to release, without any credential.
//
//   node release/preflight.mjs              every check; exits 1 when one fails
//   node release/preflight.mjs --advisory   the quick checks as GitHub warnings; always exits 0 (pull request CI)
import { fileURLToPath } from "node:url";
import { tableProblems } from "./backend-env.mjs";
import { appConfigProblems, easProblems, nativeProblems, privacyManifestProblems, signInProblems } from "./store-checks.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const advisory = process.argv.includes("--advisory");

const checks = [
  ["Store configuration in app.json", () => appConfigProblems(root)],
  ["Privacy manifest covers every library", () => privacyManifestProblems(root)],
  ["Build profiles in eas.json", () => easProblems(root)],
  ["Backend variable table matches convex/", () => tableProblems(root)],
  ...(advisory ? [] : [
    ["Sign-in exists", () => signInProblems(root)],
    ["Generated iOS project (Info.plist and privacy manifest)", () => nativeProblems(root)],
  ]),
];

let failed = 0;
for (const [title, run] of checks) {
  const problems = run();
  failed += problems.length;
  if (advisory) {
    for (const problem of problems) console.log(`::warning title=Release readiness::${problem}`);
    continue;
  }
  console.log(`${problems.length ? "FAIL" : "ok  "}  ${title}`);
  for (const problem of problems) console.log(`      - ${problem}`);
}
if (advisory) console.log(failed ? `${failed} release readiness warning(s). They do not fail this run; the release workflow will stop on them.` : "Release readiness: nothing to warn about.");
else if (failed) process.exit(1);
