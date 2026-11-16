import assert from "node:assert/strict";
import { test } from "node:test";
import { createLoader, withEnv } from "./fixtures/convex-memory.mjs";
import { ordinary, planted, secrets } from "./fixtures/realistic-repo.mjs";

// Third security review, finding 22: an owner's own repository secrets reached OpenAI through the onboarding inspection.
// Each test sends what the reviewer's probe sent, or one of the gaps it found, through the real modules, and looks
// for the secret in what would leave turtl. Every value that looks like a key is made up here.

const load = createLoader();
const { MASK, isSecretFile, redactFiles, redactText } = load("convex/codeNetwork/redact.ts");
const detect = load("convex/onboarding/detect.ts");
const inspect = createLoader({
  "convex/codeNetwork/openai": { DEFAULT_MODEL: "gpt-6-luna", respond: async () => assert.fail("no model call") },
  "convex/consent/gate": { gateFor: () => assert.fail("no gate") },
  "convex/onboarding/github": { readRepository: async () => assert.fail("no GitHub read") },
})("convex/onboarding/inspect.ts");

const fake = (prefix, length, alphabet = "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY") => prefix + Array.from({ length }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join("");
const r24 = fake("", 24);
const hex32 = fake("", 32, "0123456789abcdef3f9a1c7e5b2d8f4a");
const ghp = fake("ghp_", 36);
const glpat = `glpat-${r24}`;

// What the inspection would send for these files, as inspect.ts:run computes it.
const prompt = (scoped, extra = {}) =>
  inspect.inspectionInput({ repo: "acme/app", sha: "abc123", folders: [], stack: detect.detectStack(scoped), scoped, hits: detect.scanSignals(scoped), ...extra });

// The reviewer's probe: a secrets file, a dependency fetched with a token, and a long line with a token past 200 characters.
const probe = [
  { path: "config/secrets.yml", content: "production:\n  test_account_password: Tr0ub4dor3x\n  seed_admin_pin: 482915\n" },
  { path: "package.json", content: JSON.stringify({ dependencies: { expo: "51.0.0", convex: `git+https://oauth2:${glpat}@gitlab.com/acme/convex.git` } }) },
  { path: "convex/http.ts", content: `console.error("upload failed ${"x".repeat(150)}", "${ghp}");\nexport default {};` },
];

test("the reviewer's probe: none of its three secrets, and nothing of the secrets file, is in the inspection's prompt", () => {
  const text = prompt(probe);
  for (const leak of ["Tr0ub4dor3x", "482915", glpat, "glpat-", ghp.slice(0, 8), "config/secrets.yml"]) {
    assert.equal(text.includes(leak), false, `${leak} is in the prompt`);
  }
  assert.match(text, /## The app's files \(2; 1 more hold secrets, so turtl does not send them\)/);
  assert.match(text, /package\.json depends on expo 51\.0\.0/, "a plain version is still there to read");
});

test("1. a file that is secret by nature gives no excerpt, no file name, no pattern match and no stack evidence", () => {
  // A secrets file whose lines match the readiness patterns, as the probe's did.
  const scoped = [
    { path: "config/secrets.yml", content: "fixtures:\n  test_account: demo-user\n  seed_password: hunter2hunter2\nhealth: '/health'\n" },
    { path: ".env.production", content: `FEATURE_FLAGS=on\nREADINESS_TOKEN=${r24}\n` },
    { path: "convex/http.ts", content: 'http.route({ path: "/health", method: "GET" });\n' },
  ];
  const hits = detect.scanSignals(scoped);
  assert.deepEqual(Object.values(hits).flat().map((hit) => hit.path), ["convex/http.ts"]);
  // Even when handed matches and evidence that name a secret file, the prompt carries none of them.
  const text = inspect.inspectionInput({
    repo: "acme/app",
    sha: "abc123",
    folders: [],
    stack: { id: "x", label: "Expo", supported: false, evidence: ["config/secrets.yml is a Python manifest", "convex/ holds Convex functions"] },
    scoped,
    hits: { ...hits, test_fixtures: [{ path: "config/secrets.yml", line: 2, text: "test_account: demo-user" }] },
  });
  for (const leak of ["config/secrets.yml", ".env.production", "demo-user", "hunter2hunter2", r24, "FEATURE_FLAGS"]) assert.equal(text.includes(leak), false, leak);
  assert.match(text, /convex\/ holds Convex functions/);
  assert.match(text, /2 more hold secrets/);
});

test("2. a line is masked before it is cut, so a token across the cut leaves nothing of itself", () => {
  // The token starts at character 190 of the line: cut first, its first ten characters would leave.
  const line = `console.error("${"y".repeat(173)}", "${ghp}");`;
  assert.ok(line.indexOf(ghp) < 200 && line.indexOf(ghp) + ghp.length > 200);
  const [hit] = detect.scanSignals([{ path: "convex/log.ts", content: line }]).error_logs;
  assert.equal(hit.text.includes("ghp_"), false, hit.text);
  assert.ok(hit.text.length <= 200);
  // The same for what inspectionInput is handed, and for a turtl.json name or description cut at 120 or 500.
  const handed = inspect.inspectionInput({ repo: "a/b", sha: "c", folders: [], stack: { label: "Expo", evidence: [] }, scoped: [], hits: { ...detect.scanSignals([]), error_logs: [{ path: "convex/log.ts", line: 1, text: line }] } });
  assert.equal(handed.includes("ghp_"), false);
  const manifest = detect.parseManifest(JSON.stringify({ version: 1, journeys: [{ name: `Book ${"z".repeat(110)} ${ghp}`, description: `${"w".repeat(495)} ${ghp}`, path: "/journey" }] }));
  assert.equal(JSON.stringify(manifest).includes("ghp_"), false);
});

test("3. stack evidence repeats no dependency address, and every string the inspection sends has been masked", () => {
  const scoped = [
    { path: "package.json", content: JSON.stringify({ dependencies: { expo: "~51.0.28", convex: `git+https://oauth2:${glpat}@gitlab.com/acme/convex.git`, express: `https://user:${r24}@npm.acme.dev/express.tgz` } }) },
    { path: `config/keys/sk-proj-${r24}${r24}.ts`, content: "export {};\n" },
    { path: "convex/health.ts", content: `// health check, staging key ${fake("sk-proj-", 40)}\nexport const health = "/health";\n` },
  ];
  const stack = detect.detectStack(scoped);
  assert.deepEqual(stack.evidence.filter((line) => line.startsWith("package.json")), [
    "package.json depends on expo ~51.0.28",
    "package.json depends on convex (from an address turtl does not repeat)",
    "package.json depends on express (from an address turtl does not repeat)",
  ]);
  const text = prompt(scoped, { repo: `acme/app-${glpat}`, folders: [`apps/${ghp}`] });
  for (const leak of [glpat, r24, ghp, "sk-proj-"]) assert.equal(text.includes(leak), false, leak);
  assert.ok(text.includes(`- config/keys/${MASK}.ts`), "a file's path is masked in the list");
  assert.ok(text.includes(`### config/keys/${MASK}.ts`), "and in its excerpt's heading");
});

test("4. the masking catches what the reviewer found it missed", () => {
  const cases = [
    ["YAML, unquoted", "database:\n  password: s3cretPassw0rd", "s3cretPassw0rd"],
    ["Compose environment, unquoted", "    environment:\n      POSTGRES_PASSWORD: Sup3rS3cretPw", "Sup3rS3cretPw"],
    ["Authorization: Bearer", `headers: { Authorization: "Bearer ${r24}" }`, r24],
    ["Authorization: Basic", 'headers: { Authorization: "Basic YWRtaW46aHVudGVyMg==" }', "YWRtaW46aHVudGVyMg"],
    ["a passphrase with spaces", 'password: "correct horse battery staple"', "correct horse"],
    ["a lower-case password", "DB_PASSWORD=hunterhunter", "hunterhunter"],
    ["an all-capitals value", 'API_KEY="X7K2P9M4Q8R3T6V1W5Z0"', "X7K2P9M4Q8R3T6V1W5Z0"],
    ["a plain key", `const key = "${r24}";`, r24],
    ["ENCRYPTION_KEY", `ENCRYPTION_KEY=${r24}`, r24],
    ["32 hex under any name", `const datadog = "${hex32}";`, hex32],
    ["JSON escaped in a string", `const body = "{\\"api_key\\":\\"${r24}\\"}";`, r24],
    ["a known prefix split across lines", `const k = "sk-proj-Ab3dE5fG" +\n  "${r24}";`, "Ab3dE5fG"],
    ["a key in a query string", `const url = "https://maps.example.com/api?key=${r24}";`, r24],
    ["a URL password with no user", "REDIS_URL=redis://:Sup3rS3cretPw@redis.example.com:6379", "Sup3rS3cretPw"],
    ["a short base64 user:password", 'const basic = "YWRtaW46aHVudGVyMg==";', "YWRtaW46aHVudGVyMg"],
    ["a secret starting with /", 'secret: "/9fK2pLm7Qx4Rz8Tv1Wb"', "9fK2pLm7Qx4Rz8Tv1Wb"],
    ["a key in a comment", `// staging key: ${r24}`, r24],
    ["a dict value under key", `CONFIG = {"key": "${r24}"}`, r24],
    ["a Kubernetes env value", "env:\n  - name: DB_PASSWORD\n    value: hunterhunter2", "hunterhunter2"],
  ];
  for (const [label, input, secret] of cases) {
    const { text, masked } = redactText(input);
    assert.equal(text.includes(secret), false, `${label}: ${text}`);
    assert.ok(masked > 0, label);
    assert.equal(text.split("\n").length, input.split("\n").length, `${label} keeps its lines`);
  }
  // Files that are secrets by nature, which the probe found sent.
  for (const path of ["config/secrets.ts", "src/secrets.js", ".envrc", ".dev.vars", "config/credentials.yml.enc", "local.settings.json"]) assert.ok(isSecretFile(path), path);
  for (const path of [".env.example", "convex/secrets.test.ts", "convex/github/secrets/store.ts", "docs/secrets.md", "app/password-reset.tsx"]) assert.ok(!isSecretFile(path), path);
});

test("4. on a realistic repository the ordinary files come through character for character, and every planted secret goes", () => {
  for (const file of ordinary) assert.equal(redactText(file.content).text, file.content, file.path);
  const sent = redactFiles(planted).files;
  const text = sent.map((file) => file.content).join("\n");
  for (const [name, value] of Object.entries(secrets)) assert.equal(text.includes(value), false, `${name} leaked`);
  // What stays around a masked secret: the name, the host, the rest of the line.
  assert.ok(text.includes(`password: ${MASK}\n  pool: 5`));
  assert.ok(text.includes(`git+https://oauth2:${MASK}@gitlab.com/acme/ui.git`));
  assert.ok(text.includes(`tiles?key=${MASK}&style=light`));
  assert.ok(text.includes(`- name: LOG_LEVEL\n    value: info`));
});

test("5. the code map leaves out a secret file whole, including its place in the map, and masks paths", async (t) => {
  const repo = [
    { path: "convex/booking.ts", content: `import { secrets } from "./secrets";\nimport { keys } from "./keys/${r24}";\nexport const book = () => secrets.stripe;\n` },
    { path: "convex/secrets.ts", content: `export const secrets = { stripe: "${fake("sk_live_", 28)}" };\n` },
    { path: `convex/keys/${r24}.ts`, content: "export const keys = {};\n" },
  ];
  const sent = { model: null, documents: null };
  const build = createLoader({
    "convex/github/access": { repositoryAccess: async () => ({ ok: true, token: undefined }) },
    "convex/codeNetwork/openai": {
      respond: async (_gate, request) => {
        sent.model = request.input;
        return { text: JSON.stringify({ clusters: [{ id: "booking", name: "Booking", summary: "Takes bookings." }], nodes: [] }), usage: { inputTokens: 1, outputTokens: 1 } };
      },
    },
    "convex/supermemory": { addDocuments: async (_gate, _namespace, documents) => ((sent.documents = documents), { count: documents.length, failed: 0 }) },
  })("convex/codeNetwork/build.ts");
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input);
    if (url.endsWith("/commits/HEAD")) return new Response(JSON.stringify({ sha: "abc" }));
    if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree: repo.map(({ path, content }) => ({ path, type: "blob", size: content.length })) }));
    const file = repo.find(({ path }) => url.endsWith("/" + path));
    return file ? new Response(file.content) : new Response("not found", { status: 404 });
  });
  const stored = [];
  // In the demo the gate asks once whether the deployment holds accounts (it is closed if so) before it says yes.
  const ctx = { runQuery: async (fn) => (fn.path === "internal.consent.gate.check" ? { ok: true, account: "solo-owner" } : null), runMutation: async (_fn, args) => void stored.push(args) };
  const result = await withEnv({ AUTH_REQUIRED: undefined, OPENAI_API_KEY: "stand-in", SUPERMEMORY_API_KEY: "stand-in" }, () => build.build.handler(ctx, { projectId: "apps:1", repo: "octo/app" }));
  assert.equal(result.outcome, "built", JSON.stringify(result));
  const out = [sent.model, JSON.stringify(sent.documents), JSON.stringify(stored)].join("\n");
  for (const leak of ["convex/secrets.ts", "sk_live_", r24]) assert.equal(out.includes(leak), false, leak);
  assert.ok(sent.model.includes(`## convex/keys/${MASK}.ts`));
});
