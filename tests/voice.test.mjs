import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { runInThisContext } from "node:vm";
import ts from "typescript";
import { ConvexError, v } from "convex/values";

function load(path, imports = {}) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  runInThisContext(`(function(require, exports, module) { ${outputText}\n})`, { filename: path })(
    (name) => { assert.ok(name in imports, `Unexpected import: ${name}`); return imports[name]; }, module.exports, module,
  );
  return module.exports;
}

const rules = load("../convex/voice/rules.ts");
const ear = load("../components/voice/ear.ts");
const progress = load("../convex/voice/progress.ts", { "../workflow": { MAX_ATTEMPTS: 3 } });

const ref = (path) => new Proxy({ path }, { get: (target, key) => key === "path" ? target.path : ref(`${path}.${String(key)}`) });
const define = (definition) => definition;
// The real access rule. With AUTH_REQUIRED unset, as here, its checks do nothing.
const access = load("../convex/access.ts", {
  "convex/values": { ConvexError, v },
  "./_generated/api": { internal: ref("internal") },
  "./_generated/server": { internalQuery: define, internalMutation: define },
  "./auth/confirmed": load("../convex/auth/confirmed.ts", {}),
});

function turnModule({ heard = "approve it", speech = { ok: true, audio: new ArrayBuffer(8) }, refusal = null } = {}) {
  const calls = { transcribe: 0, speak: 0 };
  const module = load("../convex/voice/turn.ts", {
    "convex/values": { v },
    "../_generated/api": { api: ref("api"), internal: ref("internal") },
    "../_generated/server": { action: define, internalMutation: define, query: define },
    // The public builders, without their demo check (convex/functions.ts), which tests/access-rules.test.mjs covers.
    "../functions": { action: define, query: define },
    "../access": access,
    // The single-owner demo's gate: every answer is yes. tests/consent-gate.test.mjs covers the refusals.
    "../consent/gate": { gateFor: () => ({ blocked: async () => refusal }) },
    "./openai": {
      transcribe: async () => { calls.transcribe += 1; return typeof heard === "string" ? { ok: true, text: heard } : heard; },
      speak: async () => { calls.speak += 1; return speech; },
      transcribeModelId: () => "transcribe-model",
      speechModelId: () => "speech-model",
    },
    "./rules": rules,
  });
  return { module, calls };
}

function fakeCtx({ begin = { ok: true, turnId: "turn1", title: "Customers can't complete bookings", appName: "Booking" } } = {}) {
  const log = [];
  return {
    log,
    runMutation: async (fn, args) => { log.push(["mutation", fn.path, args]); return fn.path === "internal.voice.turn.begin" ? begin : null; },
    runAction: async (fn, args) => { log.push(["action", fn.path, args]); return { id: "m2", role: "turtl", text: "The recovery fix is waiting on your decision.", at: 1 }; },
    runQuery: async (fn, args) => { log.push(["query", fn.path, args]); return null; },
  };
}

const clip = { caseId: "case1", audio: new ArrayBuffer(2000), mimeType: "audio/webm;codecs=opus", durationMs: 2500 };

async function withEnv(env, run) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key];
  try { return await run(); } finally { process.env = saved; }
}
const on = { VOICE_ENABLED: "true", OPENAI_API_KEY: "test-key" };

test("spoken decisions are recognised as commands, questions about them are not", () => {
  for (const [said, kind] of [
    ["Approve it.", "approve"], ["Okay, approve it.", "approve"], ["Go ahead and do it", "approve"], ["Ship it!", "approve"],
    ["Yes, approve fix one", "approve"], ["Can you approve the recommended fix?", "approve"], ["Please apply the fix", "approve"],
    ["Merge it", "merge"], ["Could you merge the pull request?", "merge"], ["Stop the fix", "stop"], ["Roll it back", "stop"],
    ["Don't approve it", "decline"], ["Reject that one", "decline"],
  ]) assert.equal(rules.ownerCommand(said), kind, said);
  for (const asked of ["What are you stuck on?", "Should I approve fix 2?", "What happens if I approve it?", "Why did the merge fail", "Which fix do you recommend?", "How long until verify finishes"]) {
    assert.equal(rules.ownerCommand(asked), null, asked);
  }
  for (const kind of ["approve", "decline", "merge", "stop"]) {
    assert.match(rules.COMMAND_REPLIES[kind], /^I can't/);
    assert.match(rules.COMMAND_REPLIES[kind], /tap (Approve|Merge|Stop)/);
  }
  assert.match(rules.COMMAND_REPLIES.approve, /passcode/);
  assert.ok(rules.endsConversation("That's all, thanks"));
  assert.ok(rules.endsConversation("Stop listening."));
  assert.ok(!rules.endsConversation("Stop the fix"));
});

test("a spoken approval is answered with where the button is and never reaches a decision", async () => {
  const { module, calls } = turnModule({ heard: "Okay, approve it." });
  const ctx = fakeCtx();
  const result = await withEnv(on, () => module.talk.handler(ctx, clip));
  assert.equal(result.ok, true);
  assert.equal(result.command, "approve");
  assert.equal(result.reply, rules.COMMAND_REPLIES.approve);
  assert.equal(calls.transcribe, 1);
  assert.equal(calls.speak, 1);
  const touched = ctx.log.map(([kind, path]) => `${kind} ${path}`);
  assert.ok(!touched.some((call) => call.startsWith("action")), "a command never asks the case chat model");
  assert.deepEqual([...new Set(touched)].sort(), ["mutation internal.fixes.addMessage", "mutation internal.voice.runs.record", "mutation internal.voice.turn.begin", "mutation internal.voice.turn.finish"]);
  const messages = ctx.log.filter(([, path]) => path === "internal.fixes.addMessage").map(([, , args]) => [args.role, args.text]);
  assert.deepEqual(messages, [["owner", "Okay, approve it."], ["turtl", rules.COMMAND_REPLIES.approve]]);
  const runs = ctx.log.filter(([, path]) => path === "internal.voice.runs.record").map(([, , args]) => args.taskType);
  assert.deepEqual(runs, ["voice_transcription", "voice_speech"]);
});

test("a spoken question goes to the same case chat as typed text", async () => {
  const { module } = turnModule({ heard: "What are you stuck on?" });
  const ctx = fakeCtx();
  const result = await withEnv(on, () => module.talk.handler(ctx, clip));
  assert.equal(result.ok, true);
  assert.equal(result.command, null);
  assert.equal(result.reply, "The recovery fix is waiting on your decision.");
  const action = ctx.log.find(([kind]) => kind === "action");
  assert.deepEqual([action[1], action[2]], ["api.fixes.investigate", { caseId: "case1", message: "What are you stuck on?" }]);
});

test("voice code never calls an owner decision", () => {
  const forbidden = /decisions\.|approveFix|declineFix|mergePullRequest|stopEnactment|ownerPasscode|permissions\.|pullRequests\./;
  for (const dir of ["../convex/voice/", "../components/voice/"]) {
    for (const file of readdirSync(new URL(dir, import.meta.url))) {
      if (!/\.tsx?$/.test(file)) continue;
      assert.doesNotMatch(readFileSync(new URL(dir + file, import.meta.url), "utf8"), forbidden, dir + file);
    }
  }
});

test("refusals: switch off, key missing, oversized clip, unknown type, rate limit", async () => {
  const { module, calls } = turnModule();
  const ctx = fakeCtx();
  const off = await withEnv({ VOICE_ENABLED: undefined, OPENAI_API_KEY: "k" }, () => module.talk.handler(ctx, clip));
  assert.deepEqual(off, { ok: false, reason: "Talking with turtl is switched off on this backend. Type your question instead.", retry: false });
  const keyless = await withEnv({ VOICE_ENABLED: "true", OPENAI_API_KEY: undefined }, () => module.talk.handler(ctx, clip));
  assert.match(keyless.reason, /needs an OpenAI key/);
  const long = await withEnv(on, () => module.talk.handler(ctx, { ...clip, durationMs: rules.MAX_CLIP_MS + 5_000 }));
  assert.match(long.reason, /longer than turtl takes/);
  const big = await withEnv(on, () => module.talk.handler(ctx, { ...clip, audio: new ArrayBuffer(rules.MAX_CLIP_BYTES + 1) }));
  assert.match(big.reason, /longer than turtl takes/);
  const odd = await withEnv(on, () => module.talk.handler(ctx, { ...clip, mimeType: "video/quicktime" }));
  assert.match(odd.reason, /can't read/);
  assert.equal(calls.transcribe, 0);
  assert.equal(ctx.log.length, 0);

  const limited = fakeCtx({ begin: { ok: false, reason: "You've talked with turtl 20 times about this case in the last 10 minutes, which is the limit." } });
  const refused = await withEnv(on, () => module.talk.handler(limited, clip));
  assert.equal(refused.ok, false);
  assert.equal(refused.retry, false);
  assert.equal(calls.transcribe, 0);

  const recent = Array.from({ length: rules.MAX_TURNS_PER_WINDOW }, (_, i) => ({ _id: "t" + i }));
  const db = {
    get: async () => ({ _id: "case1", title: "t", appId: "app1" }),
    query: () => ({ withIndex: () => ({ take: async () => recent }) }),
    insert: async () => { throw new Error("must not insert past the limit"); },
  };
  const begun = await module.begin.handler({ db }, { caseId: "case1" });
  assert.equal(begun.ok, false);
  assert.match(begun.reason, /which is the limit/);
});

test("a failed speech call still returns the reply as text and says so", async () => {
  const { module } = turnModule({ heard: "Which fix do you recommend?", speech: { ok: false, reason: "the model call returned HTTP 500" } });
  const ctx = fakeCtx();
  const result = await withEnv(on, () => module.talk.handler(ctx, clip));
  assert.equal(result.audio, null);
  assert.match(result.speechError, /on screen only/);
  const speech = ctx.log.find(([, path, args]) => path === "internal.voice.runs.record" && args.taskType === "voice_speech");
  assert.equal(speech[2].ok, false);
});

test("silence is not sent to the case chat", async () => {
  const { module } = turnModule({ heard: "  " });
  const ctx = fakeCtx();
  const result = await withEnv(on, () => module.talk.handler(ctx, clip));
  assert.deepEqual(result, { ok: false, reason: "turtl didn't hear a question. Ask again, or end the conversation.", retry: true });
  assert.ok(!ctx.log.some(([, path]) => path === "internal.fixes.addMessage" || path === "api.fixes.investigate"));
});

test("the case chat's work state names the running step, what it waits for, and the last error", () => {
  const step = (key, title, purpose, status, attempt, dependsOn = []) => ({ _id: "s-" + key, key, title, purpose, status, dependsOn, currentAttemptId: attempt?._id, currentAttempt: attempt ?? null });
  const failed = { _id: "a1", stepId: "s-gather", attempt: 1, status: "failed", startedAt: 1_000, finishedAt: 46_000, error: "Timed out after 45 s; outcome unknown.", _creationTime: 1_000 };
  const retry = { _id: "a2", stepId: "s-gather", attempt: 2, status: "running", startedAt: 47_000, _creationTime: 47_000 };
  const steps = [
    step("detect", "Detect or receive a request", "detect_or_receive", "done", { _id: "a0", attempt: 1 }),
    step("gather", "Gather context", "gather_context", "running", retry, ["detect"]),
    step("investigate", "Investigate", "investigate", "pending", null, ["gather"]),
  ];
  const work = progress.describeWork("investigating", steps, [failed, retry], 77_000);
  assert.deepEqual(work.active, [{ step: "Gather context", status: "running", attempt: 2, maxAttempts: 3, runningFor: "30 seconds", waitingFor: "its own work to finish; no result has come back yet", latestNote: null }]);
  assert.equal(work.now, "Gather context is running (attempt 2 of 3, for 30 seconds), waiting for its own work to finish; no result has come back yet.");
  const stopped = steps.map((s) => s.key === "gather" ? { ...s, status: "failed", currentAttempt: { ...retry, attempt: 3, status: "failed", error: "x" } } : s);
  assert.equal(progress.describeWork("unresolved", stopped, [failed], 77_000).now, "Nothing is running. Gather context failed on its last attempt and will not run again on its own.");
  assert.deepEqual(work.blocked, [{ step: "Investigate", waitingOn: ["Gather context"] }]);
  assert.deepEqual(work.lastError, { step: "Gather context", attempt: 1, error: "Timed out after 45 s; outcome unknown.", ago: "31 seconds", stillCurrent: false, lateResult: false });

  const approval = step("execute", "Authorize and execute", "authorize_and_execute", "waiting", { _id: "a3", attempt: 1, startedAt: 70_000 });
  const waiting = progress.describeWork("waiting_for_owner", [approval], [], 70_000 + 373_000).active[0];
  assert.equal(waiting.waitingFor, "the owner's decision: Approve on a fix, behind the passcode");
  assert.equal(waiting.runningFor, "6 minutes");
});

test("hands-free turn taking: send after a pause, give up on silence, cap the clip", () => {
  let state = ear.freshEar();
  const feed = (samples) => samples.map(([durationMs, db]) => { const r = ear.hear(state, { durationMs, db }, 30_000); state = r.ear; return r.next; });
  assert.deepEqual(feed([[0, -70], [100, -70], [200, -20], [400, -22], [600, -25], [800, -70]]), ["listen", "listen", "listen", "listen", "listen", "listen"]);
  assert.deepEqual(feed([[2_100, -70], [2_200, -70]]), ["send", "send"]);
  state = ear.freshEar();
  assert.deepEqual(feed([[0, -80], [29_800, -80]]), ["listen", "give_up"]);
  state = ear.freshEar();
  assert.deepEqual(feed([[0, -20], [1_000, -20], [29_800, -20]]), ["listen", "listen", "send"]);
  assert.equal(ear.levelOf(undefined), 0);
  assert.equal(ear.levelOf(-10), 1);
});

test("long replies are spoken in whole sentences and the rest stays on screen", () => {
  const long = Array.from({ length: 60 }, (_, i) => `Sentence ${i} explains one more detail about the case.`).join(" ");
  const spoken = rules.spokenText(long);
  assert.ok(spoken.length <= rules.MAX_SPOKEN_CHARS);
  assert.match(spoken, /detail about the case\. The rest is on screen\.$/);
  assert.equal(rules.spokenText("Short answer."), "Short answer.");
  assert.equal(rules.clipExtension("audio/webm;codecs=opus"), "webm");
  assert.equal(rules.clipExtension("audio/mp4"), "m4a");
  assert.equal(rules.clipExtension("text/plain"), null);
});

test("a refusal to listen does not offer typing, which the same gate refuses", async () => {
  const reason = "this account has used its $20.00 of AI this month, so turtl sends nothing more until 1 December";
  const { module, calls } = turnModule({ refusal: reason });
  const result = await withEnv(on, () => module.talk.handler(fakeCtx(), clip));
  assert.deepEqual(result, { ok: false, reason: `turtl can't listen: ${reason}.`, retry: false });
  assert.equal(calls.transcribe, 0, "nothing was sent");
  assert.doesNotMatch(result.reason, /type/);
});
