#!/usr/bin/env node
// Checks the App Store pack against the repository. Run it from anywhere:
//   node store/check.mjs             report problems; fail only on what is wrong in the pack itself
//   node store/check.mjs --release   also fail on blanks, open notes, and drift from the audit
//   node store/check.mjs --open      list the checklist's open lines for each owner
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const bytes = (text) => Buffer.byteLength(text, "utf8");
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });

const REQUIRED_ADVISORY = ["alcoholTobaccoOrDrugUseOrReferences", "contests", "gamblingSimulated", "horrorOrFearThemes", "matureOrSuggestiveThemes", "medicalOrTreatmentInformation", "profanityOrCrudeHumor", "sexualContentGraphicAndNudity", "sexualContentOrNudity", "violenceCartoonOrFantasy", "violenceRealistic", "violenceRealisticProlongedGraphicOrSadistic", "gambling", "unrestrictedWebAccess", "kidsAgeBand", "ageRatingOverride", "koreaAgeRatingOverride"];
const PRICE_WORDS = /\b(free|price|pricing|discount|sale|cheap)\b|[$€£]/i;
const REVIEW_VARIABLES = ["APP_REVIEW_FIRST_NAME", "APP_REVIEW_LAST_NAME", "APP_REVIEW_EMAIL", "APP_REVIEW_PHONE", "APP_REVIEW_DEMO_USERNAME", "APP_REVIEW_DEMO_PASSWORD"];
const OPTIONAL_BLANKS = ["postal_address"];

// Apple's limits on the listing, and the rules of guideline 2.3.7 a machine can check.
export function checkListing() {
  const problems = [];
  const { apple } = json("store.config.json");
  const info = apple.info["en-US"];
  const notes = read("store/review-notes.txt").trim();
  const keywords = info.keywords.join(",");
  const within = (label, size, min, max) => { if (size < min || size > max) problems.push(label + " is " + size + ", allowed " + min + " to " + max + "."); };
  within("The name's length", info.title.length, 2, 30);
  within("The subtitle's length", info.subtitle.length, 1, 30);
  within("The promotional text's length", info.promoText.length, 1, 170);
  within("The description's length", info.description.length, 10, 4000);
  within("The keywords' size in bytes", bytes(keywords), 1, 100);
  within("The review notes' size in bytes", bytes(notes), 2, 4000);
  within("The number of categories", apple.categories.length, 1, 2);
  for (const word of info.keywords) {
    if (word.length <= 2) problems.push("The keyword \"" + word + "\" is too short. Apple asks for more than two characters.");
    if (word.toLowerCase().includes(info.title.toLowerCase())) problems.push("The keyword \"" + word + "\" repeats the app's name.");
  }
  if (new Set(info.keywords.map((word) => word.toLowerCase())).size !== info.keywords.length) problems.push("A keyword is listed twice.");
  for (const [label, text] of [["name", info.title], ["subtitle", info.subtitle], ["promotional text", info.promoText], ["keywords", keywords]]) {
    if (PRICE_WORDS.test(text)) problems.push("The " + label + " mentions a price. Guideline 2.3.7 does not allow one there.");
  }
  if (/\[[^\]]*\]/.test(notes)) problems.push("The review notes contain a placeholder in square brackets.");
  for (const key of REQUIRED_ADVISORY) if (!(key in apple.advisory)) problems.push("The age rating answer \"" + key + "\" is missing.");
  return {
    problems,
    sizes: "name " + info.title.length + "/30, subtitle " + info.subtitle.length + "/30, promotional text " + info.promoText.length + "/170, keywords " + bytes(keywords) + "/100 bytes, description " + info.description.length + "/4000, review notes " + bytes(notes) + "/4000 bytes",
  };
}

// The listing, the app's links, and the pages must name the same three addresses.
export function checkPages() {
  const problems = [];
  const info = json("store.config.json").apple.info["en-US"];
  const base = info.marketingUrl.replace(/\/$/, "");
  for (const [key, max] of [["marketingUrl", 255], ["supportUrl", 255], ["privacyPolicyUrl", 255], ["privacyChoicesUrl", 255]]) {
    if (!info[key]?.startsWith("https://")) problems.push(key + " must be an https address.");
    else if (info[key].length > max) problems.push(key + " is longer than " + max + " characters.");
  }
  if (info.privacyPolicyUrl !== base + "/privacy/") problems.push("privacyPolicyUrl should be " + base + "/privacy/.");
  if (info.supportUrl !== base + "/support/") problems.push("supportUrl should be " + base + "/support/.");
  const [choicesPage, choicesAnchor] = info.privacyChoicesUrl.split("#");
  if (choicesPage !== info.privacyPolicyUrl || !choicesAnchor) problems.push("privacyChoicesUrl should point at a heading on the privacy policy.");
  else if (!read("site/privacy.md").includes("{: #" + choicesAnchor + "}")) problems.push("site/privacy.md has no heading with the id \"" + choicesAnchor + "\".");
  const links = read("components/legal/links.ts");
  if (!links.includes("\"" + base + "\"")) problems.push("components/legal/links.ts does not use " + base + ", the address in store.config.json.");
  for (const page of ["privacy", "terms", "support"]) {
    if (!existsSync(join(root, "site", page + ".md"))) problems.push("site/" + page + ".md is missing.");
    else if (!read("site/" + page + ".md").includes("permalink: /" + page + "/")) problems.push("site/" + page + ".md is not published at /" + page + "/.");
    if (!links.includes("/" + page + "/")) problems.push("components/legal/links.ts has no link to /" + page + "/.");
  }
  const register = json("store/data-practices.json");
  const policy = read("site/privacy.md");
  for (const service of register.services) {
    if (service.inPrivacyPolicy && !policy.includes("**" + service.name + "**")) problems.push("The privacy policy's table does not name " + service.name + ", which the audit lists.");
  }
  return { problems };
}

// What Ronok still has to fill in or settle.
export function checkBlanks() {
  const operator = json("site/_data/operator.json");
  const blanks = Object.keys(operator).filter((key) => operator[key] === "" && !OPTIONAL_BLANKS.includes(key));
  const notes = {};
  for (const file of readdirSync(join(root, "site")).filter((name) => name.endsWith(".md") && name !== "README.md")) {
    const count = read("site/" + file).split("{% include review.html").length - 1;
    if (count > 0) notes["site/" + file] = count;
  }
  return { blanks, notes, notesShown: operator.show_review_notes === true, variables: REVIEW_VARIABLES.filter((name) => !process.env[name]) };
}

// Every code reference in store/*.md is a link pinned to the audited commit, whose title is text
// that line must contain. This confirms each one against that commit.
export function checkReferences() {
  const problems = [];
  const { auditedCommit } = json("store/data-practices.json");
  const files = new Set();
  let count = 0;
  try { git("cat-file", "-e", auditedCommit + "^{commit}"); } catch { return { problems, count, files, unavailable: "The audited commit " + auditedCommit.slice(0, 7) + " is not in this clone, so the references could not be checked. Fetch the full history." }; }
  const cache = new Map();
  const linesOf = (path) => {
    if (!cache.has(path)) { try { cache.set(path, git("show", auditedCommit + ":" + path).split("\n")); } catch { cache.set(path, null); } }
    return cache.get(path);
  };
  const link = /\[([^\]]+?):(\d+)\]\(https:\/\/github\.com\/ronoktanvir\/turtl\/blob\/([0-9a-f]{40})\/([^#)\s]+)#L(\d+) "([^"]*)"\)/g;
  for (const doc of readdirSync(join(root, "store")).filter((name) => name.endsWith(".md"))) {
    for (const [, shownPath, shownLine, sha, path, line, anchor] of read("store/" + doc).matchAll(link)) {
      count++;
      files.add(path);
      const where = "store/" + doc + ": " + path + ":" + line;
      if (sha !== auditedCommit) problems.push(where + " is pinned to " + sha.slice(0, 7) + ", not the audited commit.");
      else if (shownPath !== path || shownLine !== line) problems.push(where + " is shown as " + shownPath + ":" + shownLine + ".");
      else if (!linesOf(path)) problems.push(where + " names a file that does not exist at the audited commit.");
      else if (!(linesOf(path)[Number(line) - 1] ?? "").includes(anchor)) {
        const found = linesOf(path).flatMap((text, index) => (text.includes(anchor) ? [index + 1] : []));
        problems.push(where + " does not contain \"" + anchor + "\"" + (found.length ? ". It is on line " + found.join(", ") + "." : " anywhere in the file."));
      }
    }
  }
  return { problems, count, files };
}

// What has changed in the code since the audit: audited files that were edited, and outside hosts,
// settings, and libraries the audit has not seen. Each one means the audit needs another look.
export function checkDrift(auditedFiles = new Set()) {
  const register = json("store/data-practices.json");
  const drift = [];
  let changed = [];
  try { changed = git("diff", "--name-only", register.auditedCommit, "--", ...auditedFiles).split("\n").filter(Boolean); } catch { /* the commit is not in this clone; checkReferences reports it */ }
  for (const file of changed) drift.push("Changed since the audit: " + file);

  const sources = git("ls-files", "--cached", "--others", "--exclude-standard", "--", ...register.scope.filter((path) => path !== "package.json")).split("\n")
    .filter((file) => /\.(ts|tsx|js|mjs|json)$/.test(file) && !file.startsWith("convex/_generated/") && !/\.test\./.test(file) && !/package(-lock)?\.json$/.test(file) && existsSync(join(root, file)));
  const hosts = new Map();
  const settings = new Map();
  const note = (map, key, file, index) => { if (!map.has(key)) map.set(key, file + ":" + (index + 1)); };
  for (const file of sources) {
    read(file).split("\n").forEach((line, index) => {
      for (const match of line.matchAll(/https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)) note(hosts, match[1].toLowerCase(), file, index);
      for (const match of line.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})\b/g)) note(settings, match[1], file, index);
      for (const match of line.matchAll(/\benv\[["']([A-Z][A-Z0-9_]{2,})["']\]/g)) note(settings, match[1], file, index);
      for (const match of line.matchAll(/["'`]([A-Z][A-Z0-9_]*_(?:API_KEY|TOKEN|SECRET|ENABLED|MODEL|WORKFLOW_ID))["'`]/g)) note(settings, match[1], file, index);
    });
  }
  const knownHosts = new Set([...register.services.flatMap((service) => service.hosts), ...Object.keys(register.otherHosts)]);
  const knownSettings = new Set([...register.services.flatMap((service) => service.settings), ...Object.keys(register.otherSettings)]);
  for (const [host, where] of hosts) if (!knownHosts.has(host)) drift.push("An outside address the audit has not seen: " + host + " (" + where + ")");
  for (const [name, where] of settings) if (!knownSettings.has(name)) drift.push("A setting the audit has not seen: " + name + " (" + where + ")");
  for (const manifest of ["package.json", "protected-app/package.json"]) {
    for (const name of Object.keys(json(manifest).dependencies ?? {})) if (!(name in register.libraries)) drift.push("A library the audit has not seen: " + name + " (" + manifest + ")");
  }
  const appVersion = json("app.json").expo.version;
  const storeVersion = json("store.config.json").apple.version;
  if (appVersion !== storeVersion) drift.push("store.config.json describes version " + storeVersion + ", and app.json builds " + appVersion + ".");
  return { drift, scanned: sources.length };
}

// The checklist's unticked lines, under every owner named in bold at the end of each.
export function openLines() {
  const byOwner = new Map();
  let item = "";
  let ticked = 0;
  let open = 0;
  for (const line of read("store/review-checklist.md").split("\n")) {
    if (line.startsWith("### ")) item = line.slice(4).split(" · ")[0];
    if (line.startsWith("- [x] ")) ticked++;
    if (!line.startsWith("- [ ] ")) continue;
    open++;
    const owners = [...line.matchAll(/\*\*((?:TUR-\d+)|Ronok|Unowned)\*\*/g)].map((match) => match[1]);
    const text = line.slice(6).replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\s*\*\*(?:TUR-\d+|Ronok|Unowned)\*\*(?:,? (?:then|with|and|after) \*\*(?:TUR-\d+|Ronok|Unowned)\*\*)*\s*$/, "");
    for (const owner of owners.length ? owners : ["No owner named"]) {
      if (!byOwner.has(owner)) byOwner.set(owner, []);
      byOwner.get(owner).push(item + ": " + text + (owners.length > 1 ? " (with " + owners.filter((other) => other !== owner).join(", ") + ")" : ""));
    }
  }
  return { byOwner, ticked, open };
}

function main(args) {
  const release = args.includes("--release");
  const errors = [];
  const warnings = [];
  const say = (label, text) => console.log((label + " ").padEnd(22, ".") + " " + text);
  const list = (items) => items.forEach((item) => console.log("    " + item));

  if (args.includes("--open")) {
    const { byOwner } = openLines();
    for (const [owner, lines] of [...byOwner].sort()) { console.log("\n" + owner + " (" + lines.length + ")"); list(lines); }
    return 0;
  }

  const listing = checkListing();
  say("Listing", listing.problems.length ? listing.problems.length + " wrong" : "fits Apple's limits (" + listing.sizes + ")");
  list(listing.problems);
  errors.push(...listing.problems);

  const pages = checkPages();
  say("Addresses", pages.problems.length ? pages.problems.length + " wrong" : "the listing, the app, and the pages agree");
  list(pages.problems);
  errors.push(...pages.problems);

  const references = checkReferences();
  say("Code references", references.unavailable ?? (references.problems.length ? references.problems.length + " wrong of " + references.count : references.count + " links match the audited commit"));
  list(references.problems);
  errors.push(...references.problems);
  if (references.unavailable) warnings.push(references.unavailable);

  const { drift, scanned } = checkDrift(references.files);
  say("Since the audit", drift.length ? drift.length + " to look at again" : "nothing new in " + scanned + " source files");
  list(drift);
  warnings.push(...drift);

  const blanks = checkBlanks();
  say("Blanks", blanks.blanks.length ? blanks.blanks.length + " to fill in site/_data/operator.json: " + blanks.blanks.join(", ") : "none");
  warnings.push(...blanks.blanks.map((key) => "Blank: " + key));
  const noteCount = Object.values(blanks.notes).reduce((sum, count) => sum + count, 0);
  say("Notes on the pages", blanks.notesShown ? noteCount + " still shown (" + Object.entries(blanks.notes).map(([file, count]) => file + " " + count).join(", ") + ")" : "switched off");
  if (blanks.notesShown) warnings.push("show_review_notes is still true");
  say("Review variables", blanks.variables.length ? blanks.variables.length + " not set here: " + blanks.variables.join(", ") : "all six set");
  warnings.push(...blanks.variables.map((name) => "Not set: " + name));

  const open = openLines();
  say("Checklist", open.open + " lines open, " + open.ticked + " ticked (" + [...open.byOwner].sort().map(([owner, lines]) => owner + " " + lines.length).join(", ") + ")");
  if (open.open > 0) warnings.push(open.open + " checklist lines are open");

  const failed = errors.length + (release ? warnings.length : 0);
  console.log(failed ? "\n" + (release ? "Not ready to submit: " : "Failed: ") + failed + " to resolve." : "\nThe pack is consistent." + (warnings.length ? " " + warnings.length + " things remain before submission; --release fails on them." : ""));
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
