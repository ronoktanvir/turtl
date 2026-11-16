import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const caseId = process.env.WORKFLOW_CASE_ID;
assert.ok(caseId, "Set WORKFLOW_CASE_ID to a real local Convex case ID");
const base = process.env.UI_BASE_URL ?? "http://localhost:8081";
const label = (process.env.WORKFLOW_LABEL ?? "connected").replace(/[^a-z0-9-]/gi, "-");
const dir = process.env.WORKFLOW_SCREENSHOT_DIR ?? join(homedir(), ".capy/work/workflow-screenshots");
const executablePath = process.env.CHROME_PATH ?? ["/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find(existsSync);
assert.ok(executablePath, "Set CHROME_PATH to a Chromium executable");
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || /non-boolean attribute|does not recognize.*prop/i.test(message.text())) errors.push(message.text());
  });
  for (const width of [320, 375, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${base}/review/${encodeURIComponent(caseId)}`);
    const plan = page.getByTestId("workflow-plan").first();
    await plan.waitFor();
    await page.evaluate(() => document.fonts.ready);
    await plan.scrollIntoViewIfNeeded();
    assert.equal(await plan.getByTestId("workflow-graph").locator("svg").first().getAttribute("aria-hidden"), "true");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "connected page should not overflow horizontally");
    const collectors = plan.locator('[data-testid="workflow-step-collect_app_state"], [data-testid="workflow-step-collect_error_window"]');
    if (await collectors.count() === 2) {
      const [a, b] = await Promise.all([collectors.nth(0).boundingBox(), collectors.nth(1).boundingBox()]);
      assert.equal(Math.round(a.y), Math.round(b.y), "recorded collectors should share a row");
    }
    await page.screenshot({ path: join(dir, `${label}-${width}.png`) });
    if (width === 390) {
      const joinNode = plan.locator('[data-testid="workflow-step-gather_context"]');
      const target = await joinNode.count() ? joinNode : plan.getByRole("button").first();
      await target.focus();
      await page.keyboard.press("Enter");
      await plan.getByTestId("workflow-step-detail").waitFor();
      await plan.getByTestId("workflow-step-detail").scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(dir, `${label}-details-${width}.png`) });
      console.log(JSON.stringify({ caseId, stepLabels: await plan.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))), screenshotDirectory: dir }));
    }
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
