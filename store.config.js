// The listing that `eas metadata:push` sends. The words live in store.config.json; this file adds
// the three things that cannot be committed: the copyright holder, and App Review's contact and sign-in.
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const config = structuredClone(require("./store.config.json"));
const operator = require("./site/_data/operator.json");

if (operator.legal_name) config.apple.copyright = new Date().getFullYear() + " " + operator.legal_name;
else console.warn("store.config.js: legal_name is blank in site/_data/operator.json, so the copyright line is left out.");

const names = {
  firstName: "APP_REVIEW_FIRST_NAME",
  lastName: "APP_REVIEW_LAST_NAME",
  email: "APP_REVIEW_EMAIL",
  phone: "APP_REVIEW_PHONE",
  demoUsername: "APP_REVIEW_DEMO_USERNAME",
  demoPassword: "APP_REVIEW_DEMO_PASSWORD",
};
const values = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, (process.env[name] ?? "").trim()]));
const missing = Object.keys(names).filter((key) => !values[key]).map((key) => names[key]);

if (missing.length === Object.keys(names).length) {
  console.warn("store.config.js: no APP_REVIEW_* variable is set, so App Review's contact, sign-in, and notes are left out.");
} else if (missing.length > 0) {
  throw new Error("store.config.js: set " + missing.join(", ") + ", or unset every APP_REVIEW_* variable.");
} else {
  config.apple.review = { ...values, demoRequired: true, notes: readFileSync(join(__dirname, "store", "review-notes.txt"), "utf8").trim() };
}

module.exports = config;
