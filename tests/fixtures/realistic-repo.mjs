// A small Expo and Convex booking app's repository, as an owner would connect it to turtl: what the masking in
// convex/codeNetwork/redact.ts must leave alone (ordinary), and the same kinds of files with secrets in them (planted).
// Every value that looks like a key is made up here at run time; none is real.

const cycle = (prefix, length, alphabet = "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8vW0xY") => prefix + Array.from({ length }, (_, i) => alphabet[(i * 7 + 3) % alphabet.length]).join("");
const hex = (length) => cycle("", length, "0123456789abcdef3f9a1c7e5b2d8f4a");
const UUID = "6f1e8a52-3c4d-4e2b-9a7f-1b2c3d4e5f60";
const SRI = "sha512-" + cycle("", 86, "Zq9Xw2Lr7Kp4Vm8Tn3Bs6Hd1Jf5Gc0Ya+/") + "==";

/** Files with nothing secret in them: each must come through character for character. */
export const ordinary = [
  {
    path: "package.json",
    content: JSON.stringify(
      {
        name: "acme-booking",
        version: "1.4.2",
        private: true,
        main: "expo-router/entry",
        scripts: { start: "expo start --dev-client", "convex:dev": "convex dev", test: "jest --runInBand", lint: "eslint . --ext .ts,.tsx" },
        dependencies: {
          expo: "~51.0.28",
          "expo-router": "~3.5.23",
          convex: "^1.16.0",
          react: "18.2.0",
          "react-native": "0.74.5",
          "@react-native-async-storage/async-storage": "1.23.1",
          "@expo-google-fonts/inter": "^0.2.3",
          "react-native-safe-area-context": "4.10.5",
        },
        devDependencies: { typescript: "~5.3.3", "@types/react": "~18.2.79", jest: "^29.7.0" },
      },
      null,
      2,
    ),
  },
  {
    path: "app.json",
    content: JSON.stringify(
      {
        expo: {
          name: "Acme Booking",
          slug: "acme-booking",
          scheme: "acmebooking",
          version: "1.4.2",
          runtimeVersion: { policy: "appVersion" },
          ios: { bundleIdentifier: "com.acmebooking.app", buildNumber: "42", supportsTablet: false },
          android: { package: "com.acmebooking.app", versionCode: 42, adaptiveIcon: { foregroundImage: "./assets/adaptive-icon.png", backgroundColor: "#0B1F33" } },
          updates: { url: `https://u.expo.dev/${UUID}` },
          plugins: ["expo-router", ["expo-font", { fonts: ["./assets/fonts/Inter_600SemiBold.ttf", "./assets/fonts/SpaceMono-Regular.ttf"] }]],
          extra: { eas: { projectId: UUID }, router: { origin: false } },
        },
      },
      null,
      2,
    ),
  },
  {
    path: "eas.json",
    content: JSON.stringify({ cli: { version: ">= 10.0.0" }, build: { development: { developmentClient: true, distribution: "internal" }, production: { autoIncrement: true } }, submit: { production: { ios: { ascAppId: "6478123456" } } } }, null, 2),
  },
  {
    path: "convex/schema.ts",
    content: `import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  bookings: defineTable({
    customerId: v.id("customers"),
    startsAt: v.number(),
    status: v.union(v.literal("held"), v.literal("confirmed"), v.literal("cancelled")),
    confirmationToken: v.optional(v.string()),
  })
    .index("by_customer_and_start", ["customerId", "startsAt"])
    .index("by_confirmation_token", ["confirmationToken"]),
  customers: defineTable({ email: v.string(), passwordHash: v.string(), name: v.string() }).index("by_email", ["email"]),
});
`,
  },
  {
    path: "convex/http.ts",
    content: `import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();
const CONTROL_SECRET_NAME = "PROTECTED_APP_CONTROL_SECRET";

const authorized = (request: Request) => request.headers.get("Authorization") === \`Bearer \${process.env[CONTROL_SECRET_NAME]}\`;

http.route({ path: "/api/health", method: "GET", handler: httpAction(async () => new Response(JSON.stringify({ ok: true }))) });
http.route({
  path: "/api/journey-check",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!authorized(request)) return new Response("Unauthorized", { status: 401 });
    const runId = crypto.randomUUID();
    const result = await ctx.runAction(internal.checks.bookAndConfirm, { runId });
    if (!result.ok) console.error(JSON.stringify({ code: "JOURNEY_FAILED", runId, step: result.step }));
    return new Response(JSON.stringify(result), { status: result.ok ? 200 : 500 });
  }),
});

export default http;
`,
  },
  {
    path: "convex/bookings.ts",
    content: `import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const TOKEN_TTL_MS = 15 * 60_000;
const MAX_TOKENS_PER_CUSTOMER = 5;

export const getBookingsForCustomerByDateRangeV2 = query({
  args: { customerId: v.id("customers"), from: v.number(), to: v.number() },
  handler: async (ctx, { customerId, from, to }) =>
    await ctx.db
      .query("bookings")
      .withIndex("by_customer_and_start", (q) => q.eq("customerId", customerId).gte("startsAt", from).lt("startsAt", to))
      .take(50),
});

export const confirm = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const booking = await ctx.db.query("bookings").withIndex("by_confirmation_token", (q) => q.eq("confirmationToken", token)).unique();
    if (!booking) throw new Error("This confirmation link has expired.");
    await ctx.db.patch(booking._id, { status: "confirmed", confirmationToken: undefined });
    return { ok: true, ttl: TOKEN_TTL_MS, max: MAX_TOKENS_PER_CUSTOMER };
  },
});
`,
  },
  {
    path: "app/(auth)/sign-in.tsx",
    content: `import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { t } from "../../i18n";

export default function SignIn() {
  const [password, setPassword] = useState("");
  const passwordMinLength = 12;
  return (
    <View style={{ padding: 16, backgroundColor: "#0B1F33" }}>
      <Text style={{ fontFamily: "Inter_600SemiBold" }}>{t("signIn.title")}</Text>
      <TextInput secureTextEntry textContentType="password" autoComplete="current-password" placeholder={t("signIn.password")} value={password} onChangeText={setPassword} />
      {password.length > 0 && password.length < passwordMinLength && <Text>{t("signIn.passwordHint")}</Text>}
    </View>
  );
}
`,
  },
  {
    path: "i18n/en.json",
    content: JSON.stringify(
      {
        signIn: { title: "Sign in", password: "Password", passwordHint: "At least 12 characters", forgotPassword: "Forgot your password?", newPassword: "new password" },
        booking: { tokenExpired: "Your link expired. Ask for a new one.", resetToken: "Reset code" },
      },
      null,
      2,
    ),
  },
  {
    path: ".github/workflows/deploy.yml",
    content: `name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11 # v4.1.1
      - uses: actions/setup-node@60edb5dd545a775178f52524783378180af0d1f8 # v4.0.2
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx convex deploy --cmd 'npm run build'
        env:
          CONVEX_DEPLOY_KEY: \${{ secrets.CONVEX_DEPLOY_KEY }}
          EXPO_TOKEN: \${{ secrets.EXPO_TOKEN }}
`,
  },
  {
    path: "docker-compose.yml",
    content: `services:
  db:
    image: postgres@sha256:${hex(64)}
    environment:
      POSTGRES_USER: booking
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:-}
      POSTGRES_DB: booking
    ports:
      - "5432:5432"
  api:
    build: .
    environment:
      - DATABASE_URL=postgres://booking@db:5432/booking
      - SESSION_SECRET=\${SESSION_SECRET}
      - TOKEN_TTL=3600
`,
  },
  {
    path: "config/app.yml",
    content: `server:
  port: 8080
  timeout: 30s
auth:
  token_ttl: 3600
  session_cookie: booking_session
  password_min_length: 12
  password_policy: strong
features:
  recommendations: true
  recommendations_timeout_ms: 1500
kubernetes:
  env:
    - name: DATABASE_URL
      valueFrom:
        secretKeyRef:
          name: booking-db
          key: url
`,
  },
  {
    path: ".env.example",
    content: `# Copy to .env.local and fill in.
CONVEX_DEPLOYMENT=
EXPO_PUBLIC_CONVEX_URL=https://your-deployment.convex.cloud
OPENAI_API_KEY=
STRIPE_SECRET_KEY=your-stripe-secret-key
PROTECTED_APP_CONTROL_SECRET=
`,
  },
  {
    path: "README.md",
    content: `# Acme Booking

[![CI](https://github.com/acme/booking/actions/workflows/deploy.yml/badge.svg)](https://github.com/acme/booking/actions/workflows/deploy.yml)

Set the control secret on the deployment: \`npx convex env set PROTECTED_APP_CONTROL_SECRET "$(openssl rand -hex 32)"\`.
The journey check calls \`POST /api/journey-check\` with \`Authorization: Bearer <the control secret>\`.
The Expo project is ${UUID}; builds run on EAS.
`,
  },
  {
    path: "package-lock.json",
    content: `{
  "name": "acme-booking",
  "lockfileVersion": 3,
  "packages": {
    "node_modules/convex": {
      "version": "1.16.0",
      "resolved": "https://registry.npmjs.org/convex/-/convex-1.16.0.tgz",
      "integrity": "${SRI}"
    }
  }
}
`,
  },
  {
    path: "yarn.lock",
    content: `"convex@npm:^1.16.0":
  version: 1.16.0
  resolution: "convex@npm:1.16.0"
  checksum: 10c0/${hex(128)}
`,
  },
  {
    path: "settings.py",
    content: `import os

SECRET_KEY = os.environ["DJANGO_SECRET_KEY"]
DEBUG = False
ALLOWED_HOSTS = ["api.acmebooking.com"]
PASSWORD_HASHERS = ["django.contrib.auth.hashers.Argon2PasswordHasher"]
SESSION_COOKIE_AGE = 1209600
`,
  },
];

// Planted secrets: made up, and shaped like the real thing.
export const secrets = {
  yamlPassword: "Sup3rS3cretPw",
  composePassword: "devpassw0rd",
  bearer: cycle("", 24),
  passphrase: "correct horse battery staple",
  stripe: cycle("sk_live_", 28),
  dependency: cycle("glpat-", 24),
  queryKey: cycle("", 24, "Zq9Xw2Lr7Kp4Vm8Tn3Bs6Hd1Jf5Gc0Ya"),
  hexKey: hex(32),
  escaped: cycle("", 20, "Kp4Vm8Tn3Bs6Hd1Jf5Gc0YaZq9Xw2Lr7"),
  k8s: "hunterhunter2",
  sentry: hex(32),
};

/** The same kinds of files, each with a secret written into it the way owners do. */
export const planted = [
  { path: "config/database.yml", content: `production:\n  adapter: postgresql\n  host: db.internal\n  username: booking\n  password: ${secrets.yamlPassword}\n  pool: 5\n` },
  { path: "docker-compose.override.yml", content: `services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: ${secrets.composePassword}\n` },
  { path: "convex/payments.ts", content: `const headers = { Authorization: "Bearer ${secrets.bearer}", "Content-Type": "application/json" };\nconst stripe = new Stripe("${secrets.stripe}");\nconst admin = { password: "${secrets.passphrase}" };\n` },
  { path: "packages/web/package.json", content: JSON.stringify({ dependencies: { "@acme/ui": `git+https://oauth2:${secrets.dependency}@gitlab.com/acme/ui.git` } }) },
  { path: "lib/maps.ts", content: `export const tileUrl = "https://maps.example.com/tiles?key=${secrets.queryKey}&style=light";\nconst datadog = "${secrets.hexKey}";\n` },
  { path: "convex/webhook.ts", content: `const body = "{\\"api_key\\":\\"${secrets.escaped}\\",\\"event\\":\\"booking\\"}";\n` },
  { path: "deploy/k8s.yml", content: `env:\n  - name: DB_PASSWORD\n    value: ${secrets.k8s}\n  - name: LOG_LEVEL\n    value: info\n` },
  { path: "sentry.config.ts", content: `Sentry.init({ dsn: "https://${secrets.sentry}@o123456.ingest.sentry.io/4504" });\n` },
];
