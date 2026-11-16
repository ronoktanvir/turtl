import assert from "node:assert/strict";
import { test } from "node:test";
import { createLoader, withEnv } from "./fixtures/convex-memory.mjs";

// RC-22: secrets are stripped from repository content before it goes to OpenAI or Supermemory. The samples are the
// kinds of files a small app's repository holds; ordinary code must come through unchanged.

const load = createLoader();
const { MASK, isSecretFile, redactFiles, redactText } = load("convex/codeNetwork/redact.ts");

// Assembled at run time so this file does not itself look like it holds keys.
const fake = (prefix, length, alphabet = "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY") => prefix + Array.from({ length }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join("");
const KEYS = {
  github: fake("ghp_", 36),
  githubPat: fake("github_pat_", 60),
  openai: fake("sk-proj-", 48),
  anthropic: fake("sk-ant-api03-", 40),
  stripe: fake("sk_live_", 28),
  stripeWebhook: fake("whsec_", 32),
  aws: "AKIA" + "QX7RTV2ZLMN4PB3K",
  google: fake("AIza", 35),
  slack: fake("xoxb-1234567890-", 24),
  sendgrid: "SG." + fake("", 22) + "." + fake("", 43),
  jwt: "eyJ" + fake("", 20) + ".eyJ" + fake("", 30) + "." + fake("", 32),
  convex: "prod:happy-otter-123|" + fake("", 40),
  random: fake("", 40, "Zq9Xw2Lr7Kp4Vm8Tn3Bs6Hd1Jf5Gc0Ya"),
};

const ordinaryCode = `import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { requireAccount } from "./access";

declare const process: { env: Record<string, string | undefined> };

const TOKEN_HEADER = "Authorization";
const MAX_TOKENS = 4096;
export const DEFAULT_MODEL = "gpt-5.4-mini";
const API_URL = "https://api.github.com/repos/octo/app/pulls";
const COMMIT = "3d01f6404fede6e87f619bfd6cb5ae521b12b64a";
const RUN_ID = "123e4567-e89b-12d3-a456-426614174000";

// Signs the owner in. The password itself never leaves this function.
export const signIn = mutation({
  args: { email: v.string(), password: v.string() },
  handler: async (ctx, { email, password }) => {
    const apiKey = process.env.OPENAI_API_KEY;
    const token = await getToken(ctx, email);
    const headers = { Authorization: \`Bearer \${apiKey}\`, "Content-Type": "application/json" };
    const credentialRef = "PROTECTED_APP_CONTROL_SECRET";
    const passwordMinLength = 12;
    const maxOutputTokens = 16_000;
    if (password.length < passwordMinLength) throw new Error("Use a longer password.");
    return { token, headers, credentialRef, maxOutputTokens };
  },
});

export function PasswordField() {
  return <TextInput secureTextEntry textContentType="password" placeholder="Password" autoComplete="password" />;
}

const steps = ["create-booking-and-confirm", "recommendations-timeout", "cleanup-fixture-run"];
const fontName = "Capriola_400Regular";
const path = "../../components/project/OwnerPasscodeSettings";
`;

test("ordinary code comes through unchanged, character for character", () => {
  const result = redactText(ordinaryCode);
  assert.equal(result.masked, 0);
  assert.equal(result.text, ordinaryCode);
});

test("tokens with a known prefix are masked wherever they appear", () => {
  for (const [kind, key] of Object.entries(KEYS)) {
    const text = `const client = createClient({ value: process.env.X ?? "${key}" });\nconsole.log("using ${key}");`;
    const result = redactText(text);
    assert.ok(!result.text.includes(key), `${kind} leaked: ${result.text}`);
    assert.ok(result.text.includes(MASK), kind);
    assert.equal(result.text.split("\n").length, 2);
  }
});

test("a private key block is masked and the line numbers after it still match", () => {
  const pem = ["-----BEGIN RSA PRIVATE KEY-----", ...Array.from({ length: 6 }, (_, i) => fake(`MIIE${i}`, 60)), "-----END RSA PRIVATE KEY-----"].join("\n");
  const text = `// Signs the app JWT.\nconst KEY = \`${pem}\`;\nexport const sign = (body) => jwt(body, KEY);\n`;
  const result = redactText(text);
  assert.ok(!result.text.includes("MIIE0"));
  assert.equal(result.text.split("\n").length, text.split("\n").length);
  assert.equal(result.text.split("\n")[9], "export const sign = (body) => jwt(body, KEY);");
  const openssh = redactText("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----");
  assert.ok(!openssh.text.includes("b3BlbnNzaC1rZXktdjEAAAAA"));
});

test("a password inside a URL is masked and the rest of the address kept", () => {
  const text = `const DATABASE_URL = "postgres://booking:Sup3rS3cret!@db.internal:5432/booking";\nredis.connect("redis://default:hunter2hunter2@cache:6379");`;
  const result = redactText(text);
  assert.ok(!result.text.includes("Sup3rS3cret!"));
  assert.ok(!result.text.includes("hunter2hunter2"));
  assert.ok(result.text.includes(`postgres://booking:${MASK}@db.internal:5432/booking`));
  assert.ok(result.text.includes(`redis://default:${MASK}@cache:6379`));
});

test("strings assigned to secret-looking names are masked, in code, JSON, YAML and env files", () => {
  const samples = [
    [`const password = "hunter22";`, `const password = "${MASK}";`],
    [`const ADMIN_PASSWORD: string = "correct-horse-battery-staple";`, `const ADMIN_PASSWORD: string = "${MASK}";`],
    [`export const config = { apiKey: 'f81d4fae7dec11d0a765', region: "us-east-1" };`, `export const config = { apiKey: '${MASK}', region: "us-east-1" };`],
    [`{ "client_secret": "Zq9Xw2Lr7Kp4Vm8T", "client_id": "turtl-web" }`, `{ "client_secret": "${MASK}", "client_id": "turtl-web" }`],
    [`webhook_secret: "s3cr3t-value-here"`, `webhook_secret: "${MASK}"`],
    [`STRIPE_SECRET=rk9Xw2Lr7Kp4Vm8T`, `STRIPE_SECRET=${MASK}`],
    [`export AUTH_TOKEN=Ab12Cd34Ef56`, `export AUTH_TOKEN=${MASK}`],
  ];
  for (const [input, expected] of samples) assert.equal(redactText(input).text, expected, input);
  // Names that only look like secrets, and values that are not secrets, stay.
  for (const kept of [
    `const tokenName = "access_token";`,
    `const secretRef = "PROTECTED_APP_CONTROL_SECRET";`,
    `const apiKeyEnv = "OPENAI_API_KEY";`,
    `password: "",`,
    `api_key: "your-api-key-here",`,
    `const token = "\${process.env.TOKEN}";`,
    `PASSWORD_MIN=12`,
    `token = nextToken;`,
  ]) assert.equal(redactText(kept).text, kept, kept);
});

test("long random strings are masked; long words, paths, slugs and commit hashes are not", () => {
  const random = redactText(`const seed = "${KEYS.random}";`);
  assert.equal(random.text, `const seed = "${MASK}";`);
  for (const kept of [
    `const id = "getFunctionNameFromReferenceOrThrow";`,
    `import x from "@babel/plugin-transform-react-jsx-development-7";`,
    `const COMMIT = "3d01f6404fede6e87f619bfd6cb5ae521b12b64a";`,
    `const slug = "booking-demo-recommendations-timeout-2026";`,
  ]) assert.equal(redactText(kept).text, kept, kept);
});

test("files that are secrets by nature are left out whole, templates are kept and masked", () => {
  for (const path of [".env", ".env.local", "apps/web/.env.production", "certs/server.pem", "ios/AuthKey_ABC123.p8", "deploy/id_ed25519", ".npmrc", "config/credentials.json", "secrets.yml", "infra/terraform.tfstate", "firebase-adminsdk-x1y2.json", "ios/GoogleService-Info.plist"]) {
    assert.ok(isSecretFile(path), path);
  }
  for (const path of [".env.example", "src/env.ts", "convex/secrets.test.ts", "docs/credentials.md", "app/password-reset.tsx", "convex/access.ts"]) {
    assert.ok(!isSecretFile(path), path);
  }
  const { files, skipped, masked } = redactFiles([
    { path: ".env", content: `OPENAI_API_KEY=${KEYS.openai}` },
    { path: ".env.example", content: `OPENAI_API_KEY=\nDATABASE_PASSWORD=Sup3rS3cret99\n` },
    { path: "convex/booking.ts", content: ordinaryCode },
  ]);
  assert.deepEqual(skipped, [".env"]);
  assert.deepEqual(files.map((file) => file.path), [".env.example", "convex/booking.ts"]);
  assert.equal(files[0].content, `OPENAI_API_KEY=\nDATABASE_PASSWORD=${MASK}\n`);
  assert.equal(files[1].content, ordinaryCode, "an unchanged file is passed on as it was");
  assert.equal(masked, 1);
});

const repoWithSecrets = [
  { path: "convex/booking.ts", content: `import { stripe } from "./stripe";\nconst STRIPE_KEY = "${KEYS.stripe}";\nexport const book = () => stripe(STRIPE_KEY);\n` },
  { path: "convex/stripe.ts", content: `export const stripe = (key) => ({ key, client: "${KEYS.jwt}" });\n` },
  { path: "credentials.json", content: `{ "private_key": "${KEYS.random}" }` },
];
const leaked = (text) => [KEYS.stripe, KEYS.jwt, KEYS.random].filter((key) => text.includes(key));

test("the onboarding inspection sends excerpts and pattern matches with their secrets masked", () => {
  const inspect = createLoader({
    "convex/codeNetwork/openai": { DEFAULT_MODEL: "gpt-6-luna", respond: async () => assert.fail("no model call") },
    "convex/consent/gate": { gateFor: () => assert.fail("no gate") },
    "convex/onboarding/github": { readRepository: async () => assert.fail("no GitHub read") },
  })("convex/onboarding/inspect.ts");
  const hits = { error_logs: [], health_check: [{ path: "convex/booking.ts", line: 2, text: `const STRIPE_KEY = "${KEYS.stripe}";` }], readiness_check: [], journey_checks: [], feature_flags: [], recovery_hooks: [], test_fixtures: [] };
  const text = inspect.inspectionInput({ repo: "octo/app", sha: "abc", folders: [], stack: { label: "Expo and Convex", evidence: [] }, scoped: repoWithSecrets, hits });
  assert.deepEqual(leaked(text), []);
  assert.ok(text.includes(`### convex/booking.ts (4 lines)\n1| import { stripe } from "./stripe";\n2| const STRIPE_KEY = "${MASK}";`), "lines keep their numbers");
  assert.ok(!text.includes("### credentials.json"), "a secret file is not excerpted");
});

test("the code map build sends OpenAI and Supermemory the code with its secrets masked", async (t) => {
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
    if (url.includes("/git/trees/")) return new Response(JSON.stringify({ tree: repoWithSecrets.map(({ path, content }) => ({ path, type: "blob", size: content.length })) }));
    const file = repoWithSecrets.find(({ path }) => url.endsWith("/" + path));
    return file ? new Response(file.content) : new Response("not found", { status: 404 });
  });
  const ctx = { runQuery: async () => null, runMutation: async () => null };
  const result = await withEnv({ AUTH_REQUIRED: undefined, OPENAI_API_KEY: "stand-in", SUPERMEMORY_API_KEY: "stand-in" }, () =>
    build.build.handler(ctx, { projectId: "apps:1", repo: "octo/app" }),
  );
  assert.equal(result.outcome, "built", JSON.stringify(result));
  assert.ok(sent.model.includes(`const STRIPE_KEY = "${MASK}";`));
  assert.deepEqual(leaked(sent.model), []);
  const documents = sent.documents.map((document) => document.content).join("\n");
  assert.ok(documents.includes(`const STRIPE_KEY = "${MASK}";`));
  assert.deepEqual(leaked(documents), []);
});
