import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

// With accounts on, another account's project or case reaches these screens as null, exactly like an id that does
// not exist (convex/access.ts). Each screen must say "not found" before anything that reads as an empty project or
// an idle case, and must not offer a control that only fails afterwards.

test("Preparation says a project it cannot see is not found, with no empty title and no 'not read yet'", () => {
  const prepare = source("../app/project/[projectId]/prepare.tsx");
  const notFound = prepare.indexOf("if (project === null)");
  assert.ok(notFound > 0, "Preparation checks for a missing project");
  assert.ok(notFound < prepare.indexOf("if (!onboarding)"), "the missing project is handled before the missing preparation");
  const branch = prepare.slice(notFound, prepare.indexOf("if (!onboarding)"));
  assert.ok(branch.includes('title="Project not found"'));
  assert.ok(branch.includes("This project is no longer available."));
  assert.ok(branch.includes('testID="prepare-not-found-back"'));
  assert.ok(!branch.includes("{title}"), "the not-found header does not use the project's (empty) name");
});

test("Investigate says a project it cannot see is not found, not that its code is unmapped", () => {
  const investigate = source("../app/project/[projectId]/investigate.tsx");
  const notFound = investigate.indexOf("project === null ?");
  assert.ok(notFound > 0, "Investigate checks for a missing project");
  assert.ok(notFound < investigate.indexOf("Loading the map of your code…"), "checked before waiting for the code network");
  assert.ok(notFound < investigate.indexOf("turtl has not mapped this project's code yet."));
  assert.ok(investigate.slice(notFound).includes("This project is no longer available."));
});

test("the running-fix screen says a case it cannot see is not found, not that nothing was approved", () => {
  const enacting = source("../app/review/[caseId]/enacting.tsx");
  const notFound = enacting.indexOf("if (c === null)");
  assert.ok(notFound > 0, "the running-fix screen checks for a missing case");
  assert.ok(notFound < enacting.indexOf("No fix has been approved for this case yet."));
  assert.ok(enacting.slice(notFound, enacting.indexOf("if (!c || !e)")).includes("This case could not be found."));
});

test("Investigate further says a case it cannot see is not found and offers no ask bar or New fix", () => {
  const chat = source("../app/review/[caseId]/chat.tsx");
  const notFound = chat.indexOf("if (c === null)");
  assert.ok(notFound > 0, "the chat checks for a missing case");
  const branch = chat.slice(notFound, chat.indexOf("return (", chat.indexOf("return (", notFound) + 1));
  assert.ok(branch.includes("This case could not be found."));
  assert.ok(!branch.includes("AskBar") && !branch.includes("New fix"), "nothing to ask or request on a case that is not there");
  assert.ok(notFound < chat.indexOf("<AskBar"), "checked before the ask bar is drawn");
});
