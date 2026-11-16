import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { chromium } from "playwright-core";
import { evidenceServer } from "./fixtures/evidence-http.mjs";

const config = JSON.parse(await readFile(new URL("../.convex/local/default/config.json", import.meta.url), "utf8"));
const backend = `http://127.0.0.1:${config.ports.cloud}`;
const base = process.env.UI_BASE_URL ?? "http://localhost:8081";
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname), "Capture only the local app");
const client = new ConvexHttpClient(backend);
client.setAdminAuth(config.adminKey);
const snapshot = (caseId) => client.query(makeFunctionReference("evidence/localProof:snapshot"), { caseId });
const getStep = (data, key) => data.steps.find((step) => step.key === key);
const collectors = ["collect_app_state", "collect_error_window"];
const dir = process.env.WORKFLOW_SCREENSHOT_DIR ?? join(homedir(), ".capy/work/workflow-screenshots");
const executablePath = process.env.CHROME_PATH ?? ["/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find(existsSync);
assert.ok(executablePath, "Set CHROME_PATH to a Chromium executable");
await mkdir(dir, { recursive: true });
const server = await evidenceServer();
const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
const records = { localOnly: true, backend, running: null, joined: null };
const errors = [];
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
page.setDefaultTimeout(7000);
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error" || /non-boolean attribute|does not recognize.*prop/i.test(message.text())) errors.push(message.text());
});

async function until(caseId, predicate, timeout = 35000) {
  const deadline = Date.now() + timeout;
  let data;
  while (Date.now() < deadline) {
    data = await snapshot(caseId);
    if (predicate(data)) return data;
    await delay(150);
  }
  throw new Error(`Local case did not reach its expected state: ${JSON.stringify(data?.steps.map(({ key, status }) => ({ key, status })))}`);
}

async function seed(source) {
  return client.mutation(makeFunctionReference("evidence/localProof:seed"), {
    base: source.base, label: source.name, mode: "parallel", includeContext: true,
  });
}

async function captureWidths(caseId, label, validate, deadline = Infinity) {
  const remaining = () => Math.max(1, Math.min(7000, deadline - Date.now()));
  await page.goto(`${base}/review/${encodeURIComponent(caseId)}`, { waitUntil: "domcontentloaded", timeout: remaining() });
  const plan = page.getByTestId("workflow-plan").first();
  await plan.waitFor({ timeout: remaining() });
  for (const width of [320, 375, 390]) {
    assert.ok(Date.now() < deadline, "Release held reads before the collector HTTP timeout");
    await page.setViewportSize({ width, height: 844 });
    await plan.scrollIntoViewIfNeeded({ timeout: remaining() });
    await validate(await snapshot(caseId));
    const app = plan.getByTestId("workflow-step-collect_app_state");
    const error = plan.getByTestId("workflow-step-collect_error_window");
    const [a, b] = await Promise.all([app.boundingBox(), error.boundingBox()]);
    assert.equal(Math.round(a.y), Math.round(b.y), "Independent collectors must occupy the same row");
    assert.ok(a.x >= b.x + b.width || b.x >= a.x + a.width, "Collector targets cannot overlap");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "No horizontal page overflow");
    const statuses = label.endsWith("running") ? "running" : "done";
    assert.match(await app.getAttribute("aria-label"), new RegExp(`, ${statuses}$`));
    assert.match(await error.getAttribute("aria-label"), new RegExp(`, ${statuses}$`));
    await page.screenshot({ path: join(dir, `${label}-${width}.png`), timeout: remaining() });
  }
  return plan;
}

try {
  await page.goto(`${base}/review/local-workflow-warmup`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const runSource = server.add(`ui-running-${randomUUID().slice(0, 8)}`, { holdFlags: true, holdErrors: true });
  let runCreated;
  let runStarted;
  try {
    runCreated = await seed(runSource);
    const running = await until(runCreated.caseId, (data) => collectors.every((key) => getStep(data, key).status === "running") &&
      ["flags", "errors"].every((resource) => runSource.events.some((event) => event.resource === resource && !event.finishedAt)), 6500);
    const attempts = collectors.map((key) => getStep(running, key).currentAttempt);
    runStarted = Math.min(...runSource.events.filter((event) => ["flags", "errors"].includes(event.resource)).map((event) => event.startedAt));
    const capturedAt = [];
    const validate = (data) => {
      for (const [index, key] of collectors.entries()) {
        assert.equal(getStep(data, key).status, "running");
        assert.equal(getStep(data, key).currentAttempt._id, attempts[index]._id);
      }
      assert.equal(getStep(data, "gather_context").status, "pending");
      assert.equal(getStep(data, "gather_context").currentAttempt, null);
      assert.equal(data.actions.length, 0);
      capturedAt.push(Date.now());
    };
    await captureWidths(runCreated.caseId, "local-connected-running", validate, runStarted + 8500);
    validate(await snapshot(runCreated.caseId));
    records.running = { ...runCreated, capturedAt, attempts: attempts.map(({ _id, status, startedAt }) => ({ id: _id, statusAtCapture: status, startedAt })), gatherStatusAtCapture: "pending" };
  } finally {
    runSource.release();
    if (records.running) records.running.releasedAt = Date.now();
  }
  const completedRun = await until(runCreated.caseId, (data) => data.case.status === "waiting_for_owner");
  records.running.completedAttempts = collectors.map((key) => {
    const attempt = getStep(completedRun, key).currentAttempt;
    return { id: attempt._id, startedAt: attempt.startedAt, finishedAt: attempt.finishedAt, status: attempt.status };
  });
  assert.ok(Math.max(...records.running.completedAttempts.map((attempt) => attempt.startedAt)) < Math.min(...records.running.completedAttempts.map((attempt) => attempt.finishedAt)), "Recorded collector attempts must overlap");
  assert.equal(completedRun.actions.length, 0);
  records.running.http = runSource.events.map(({ resource, startedAt, finishedAt, status }) => ({ resource, startedAt, finishedAt, status }));

  const retrySource = server.add(`ui-retry-joined-${randomUUID().slice(0, 8)}`, { failErrors: 1 });
  const retryCreated = await seed(retrySource);
  const joined = await until(retryCreated.caseId, (data) => data.case.status === "waiting_for_owner");
  const app = getStep(joined, "collect_app_state").currentAttempt;
  const error = getStep(joined, "collect_error_window").currentAttempt;
  const joinAttempt = getStep(joined, "gather_context").currentAttempt;
  const errorAttempts = joined.attempts.filter((attempt) => attempt.stepId === getStep(joined, "collect_error_window")._id).sort((a, b) => a.attempt - b.attempt);
  assert.equal(joined.attempts.filter((attempt) => attempt.stepId === getStep(joined, "collect_app_state")._id).length, 1);
  assert.deepEqual(errorAttempts.map(({ attempt, status }) => ({ attempt, status })), [{ attempt: 1, status: "failed" }, { attempt: 2, status: "done" }]);
  assert.deepEqual(new Set(joinAttempt.inputRefs), new Set([app._id, error._id]));
  assert.equal(joinAttempt.inputRefs.length, 2);
  assert.equal(joinAttempt.status, "done");
  assert.ok(joinAttempt.output.facts);
  assert.ok(joinAttempt.output.recall);
  assert.ok(joinAttempt.output.context.uses.length > 0);
  assert.equal(joined.actions.length, 0);
  const plan = await captureWidths(retryCreated.caseId, "local-connected-joined", (data) => {
    assert.equal(data.case.status, "waiting_for_owner");
    assert.equal(data.actions.length, 0);
  });
  await plan.getByTestId("workflow-step-gather_context").focus();
  await page.keyboard.press("Enter");
  const detail = plan.getByTestId("workflow-step-detail");
  await detail.scrollIntoViewIfNeeded();
  const detailText = await detail.innerText();
  assert.ok(detailText.includes(app._id) && detailText.includes(error._id));
  assert.ok(!detailText.includes(errorAttempts[0]._id), "The failed attempt cannot be represented as a consumed successful input");
  await page.screenshot({ path: join(dir, "local-connected-joined-details-390.png") });
  await detail.getByText("Consumed attempt IDs", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(dir, "local-connected-joined-inputs-390.png") });
  records.joined = {
    ...retryCreated, status: joined.case.status,
    appAttempt: { id: app._id, attempt: app.attempt, status: app.status, startedAt: app.startedAt, finishedAt: app.finishedAt },
    errorAttempts: errorAttempts.map(({ _id, attempt, status, startedAt, finishedAt }) => ({ id: _id, attempt, status, startedAt, finishedAt })),
    join: { id: joinAttempt._id, status: joinAttempt.status, startedAt: joinAttempt.startedAt, finishedAt: joinAttempt.finishedAt, inputRefs: joinAttempt.inputRefs, outputKeys: Object.keys(joinAttempt.output).sort(), contextUses: joinAttempt.output.context.uses.length },
    http: retrySource.events.map(({ resource, startedAt, finishedAt, status }) => ({ resource, startedAt, finishedAt, status })),
    actions: joined.actions.length,
  };
  assert.deepEqual(errors, []);
  await writeFile(join(dir, "local-connected-proof.json"), JSON.stringify(records, null, 2));
  console.log(JSON.stringify(records));
} finally {
  await browser.close();
  await server.close();
}
