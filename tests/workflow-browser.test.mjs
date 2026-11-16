import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright-core";

test("recorded workflow is keyboard accessible with truthful edges and narrow independent lanes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turtl-workflow-"));
  const executablePath = process.env.CHROME_PATH ?? ["/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find(existsSync);
  assert.ok(executablePath, "Set CHROME_PATH to a Chromium executable");
  let browser;
  let server;
  try {
    await build({
      entryPoints: ["tests/fixtures/workflow-browser.jsx"], bundle: true, outfile: join(dir, "fixture.js"),
      platform: "browser", format: "iife", jsx: "automatic", resolveExtensions: [".web.tsx", ".tsx", ".web.ts", ".ts", ".web.js", ".js"],
      alias: { "react-native": "react-native-web", "react-native-svg": "react-native-svg/lib/module/elements.web.js", "@react-native/assets-registry/registry": "react-native-web/dist/modules/AssetRegistry/index.js" }, loader: { ".png": "dataurl" },
      define: { __DEV__: "true", "process.env": "{}", "process.env.NODE_ENV": '"development"' },
      plugins: [{ name: "unused-router", setup(build) {
        build.onResolve({ filter: /^expo-router$/ }, () => ({ path: "router", namespace: "fixture" }));
        build.onResolve({ filter: /NativeSvgSoundModule$/ }, () => ({ path: "android-sound", namespace: "fixture" }));
        build.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ contents: path === "router" ? "export function useRouter() { throw new Error('Routing is outside this isolated graph fixture'); }" : "export default { playTouchSound() { throw new Error('Android sound is outside this web fixture'); } };" }));
      } }],
    });
    const bundle = await readFile(join(dir, "fixture.js"));
    const font = await readFile("node_modules/@expo-google-fonts/capriola/400Regular/Capriola_400Regular.ttf");
    server = createServer((req, res) => {
      if (req.url === "/fixture.js") { res.setHeader("Content-Type", "text/javascript"); res.end(bundle); return; }
      if (req.url === "/font.ttf") { res.setHeader("Content-Type", "font/ttf"); res.end(font); return; }
      res.setHeader("Content-Type", "text/html");
      res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Local workflow fixture</title><style>@font-face{font-family:Capriola_400Regular;src:url(/font.ttf)}body{margin:0;background:#0A0A0A}#root{min-height:100vh}button:focus-visible{outline:3px solid #539bf5;outline-offset:3px}</style><div id="root"></div><script src="/fixture.js"></script></html>');
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" || /non-boolean attribute|does not recognize.*prop/i.test(message.text())) errors.push(message.text());
    });
    const screenshotDir = process.env.WORKFLOW_SCREENSHOT_DIR ?? join(homedir(), ".capy/work/workflow-screenshots");
    await mkdir(screenshotDir, { recursive: true });
    const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "page should not overflow horizontally");
    for (const width of [320, 375, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(base);
      try { await page.getByTestId("workflow-step-app-state").waitFor({ timeout: 10000 }); }
      catch (error) { throw new Error(`${error.message}\nBrowser errors: ${errors.join("; ")}`); }
      await page.evaluate(() => document.fonts.ready);
      const app = page.getByTestId("workflow-step-app-state");
      const error = page.getByTestId("workflow-step-error-window");
      const a = await app.boundingBox();
      const b = await error.boundingBox();
      assert.equal(Math.round(a.y), Math.round(b.y), "collectors should occupy the same row");
      assert.ok(a.x >= b.x + b.width || b.x >= a.x + a.width, "collector lanes should not overlap");
      for (const button of await page.getByRole("button").all()) {
        const bounds = await button.boundingBox();
        assert.ok(bounds.width >= 44 && bounds.height >= 44, "each target is at least 44px");
      }
      await page.waitForFunction(() => document.querySelectorAll('[data-testid^="workflow-edge-"]').length === 5);
      const svg = await page.getByTestId("workflow-graph").locator("svg").first().boundingBox();
      assert.ok(svg.width > 0 && svg.height > 0);
      assert.equal(await page.getByTestId("workflow-graph").locator("svg").first().getAttribute("aria-hidden"), "true");
      await noOverflow();
      await app.focus();
      assert.match(await app.getAttribute("aria-label"), /Collect application state, Working now/);
      assert.equal(await app.getAttribute("aria-expanded"), "false");
      await page.keyboard.press("Enter");
      assert.equal(await app.getAttribute("aria-expanded"), "true");
      const detail = await page.getByTestId("workflow-step-detail").innerText();
      assert.match(detail, /Tried 2 times/);
      assert.match(detail, /Built on what “Receive report” found/);
      assert.match(detail, /Runs after “Receive report”/);
      assert.doesNotMatch(detail, /attempt-detect-1|collect_app_state|detect_or_receive/, "owners never read raw ids");
      await noOverflow();
      await app.focus();
      await page.keyboard.press("Space");
      assert.equal(await app.getAttribute("aria-expanded"), "false");
      await page.screenshot({ path: join(screenshotDir, `local-fixture-running-${width}.png`), fullPage: true });
    }
    for (const [scenario, key, status] of [["waiting", "error-window", "Waiting"], ["failed", "error-window", "Stopped"], ["skipped", "investigate", "Skipped"], ["joined", "gather", "Done"]]) {
      await page.goto(`${base}/?scenario=${scenario}`);
      const node = page.getByTestId(`workflow-step-${key}`);
      await node.waitFor();
      assert.match(await node.innerText(), new RegExp(status));
      await node.click();
      const text = await page.getByTestId("workflow-step-detail").innerText();
      assert.match(text, new RegExp(status));
      if (scenario === "failed") assert.match(text, /recorded collector request failed/);
      if (scenario === "skipped") assert.match(text, /Skipped: Recorded skip/);
      if (scenario === "joined") {
        assert.match(text, /Built on what “Collect application state” and “Collect error window” found/);
        assert.match(text, /Recorded evidence reference/);
        assert.doesNotMatch(text, /attempt-app-state-2|attempt-error-window-1|evidence-gather/);
      }
      await noOverflow();
      await page.screenshot({ path: join(screenshotDir, `local-fixture-${scenario}-390.png`), fullPage: true });
    }
    await page.getByRole("button", { name: "Switch theme" }).click();
    await noOverflow();
    await page.screenshot({ path: join(screenshotDir, "local-fixture-light-390.png"), fullPage: true });
    await page.goto(`${base}/?scenario=malformed`);
    await page.getByTestId("workflow-step-a").waitFor();
    assert.match((await page.getByTestId("workflow-warning").allInnerTexts()).join(" "), /never recorded.*cycle/);
    await noOverflow();
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto(`${base}/?scenario=long-refs`);
    await page.getByTestId("workflow-step-gather").click();
    assert.match(await page.getByTestId("workflow-step-detail").innerText(), /Long recorded reference/);
    await noOverflow();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
