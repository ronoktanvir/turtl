// Strips secrets from repository content before any of it leaves for OpenAI or Supermemory: the code map's labels and
// documents (codeNetwork/build.ts), the onboarding inspection (onboarding/inspect.ts, onboarding/detect.ts) and the
// names a project's turtl.json gives its checks. Pure: no imports.
//
// Files that are secrets by nature are left out whole, and nothing from them leaves: not their content, not a line of
// them, not their name. In everything else these are masked, and line breaks are kept so line numbers still point at
// the same lines:
// - private key blocks;
// - tokens with a known prefix (GitHub, GitLab, OpenAI, Anthropic, Stripe, AWS, Google, Slack, and others), even when a
//   string is split across lines;
// - the password in a URL (scheme://user:password@host, the user may be empty), and a key or token in a URL's query;
// - the credential after Bearer, Basic, Token or Bot, as in an Authorization header;
// - a value given to a name such as password, secret, token, api key or authorization, quoted or not (code, JSON,
//   YAML, env files, shell, INI, Dockerfiles), escaped quotes included, a passphrase with spaces included;
// - a random-looking value given to a weaker name (key, salt, dsn, signature, pin);
// - a quoted base64 string that decodes to user:password;
// - random-looking runs of 20 or more characters, and hex runs of 32 to 39 or 48 and more.
//
// What stays, so the text is still worth reading: names, paths, URLs without credentials, version numbers, UUIDs, commit
// hashes (40 hex), hashes given to a name such as integrity, checksum or sha256, long identifiers made of words, and
// values that only point at a secret (${VAR}, process.env.X, {{ secrets.X }}). Callers mask first and cut after.

export const MASK = "[secret removed]";

export type SourceText = { path: string; content: string };

const SECRET_NAMES = [
  /(^|\/)\.env(\.(?!example$|sample$|template$|defaults?$)[^/]+)?$/i,
  /(^|\/)\.(envrc|dev\.vars|secrets?)$/i,
  /\.(pem|key|p8|p12|pfx|jks|keystore|kdbx|ovpn|tfstate|tfvars|mobileprovision|gpg|enc|age)$/i,
  /\.secrets?$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)\.(npmrc|pypirc|netrc|htpasswd|git-credentials|dockercfg)$/i,
  /(^|\/)(credentials|secrets?)(\.(json|ya?ml|toml|ini|txt|xml|plist|env|ts|js|mjs|cjs|py|rb|php|go|sh))?$/i,
  /(^|\/)[^/]*(service[-_]?account|firebase-adminsdk)[^/]*\.json$/i,
  /(^|\/)(google-services\.json|GoogleService-Info\.plist|local\.settings\.json|kubeconfig)$/i,
  /(^|\/)\.(kube\/config|docker\/config\.json|aws\/config)$/i,
];

/** True for a file whose whole content is credentials, such as .env, a private key or secrets.yml. */
export function isSecretFile(path: string): boolean {
  return SECRET_NAMES.some((pattern) => pattern.test(path));
}

const keepLines = (match: string) => MASK + "\n".repeat((match.match(/\n/g) ?? []).length);

const PRIVATE_KEY = /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY( BLOCK)?-----[\s\S]*?(-----END \1PRIVATE KEY( BLOCK)?-----|$)/g;

// A prefix that only a credential starts with counts from 6 characters after it, so the first piece of a key split
// across lines ("ghp_abc123" + "...") goes too. Shorter, commoner prefixes need the token's usual length.
const KNOWN_TOKENS = [
  /\bgh[pousr]_[A-Za-z0-9]{6,}\b/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{6,}/g,
  /\bglpat-[A-Za-z0-9_-]{6,}/g, // GitLab
  /\bsk-ant-[A-Za-z0-9_-]{6,}/g, // Anthropic
  /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{6,}/g, // OpenAI
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{6,}/g, // Stripe
  /\bpk_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bwhsec_[A-Za-z0-9+/=]{6,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bxox[abprse]-[A-Za-z0-9-]{6,}/g, // Slack
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, // SendGrid
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g, // Hugging Face
  /\bshp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}\b/g, // Shopify
  /\bdop_v1_[a-f0-9]{64}\b/g, // DigitalOcean
  /\bsm_[A-Za-z0-9_]{20,}/g, // Supermemory
  /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}/g, // Resend
  /\b(?:gsk|xai|lin_api|sntrys|ntn|pscale_(?:tkn|pw|oauth))[_-][A-Za-z0-9_.=-]{20,}/g, // Groq, xAI, Linear, Sentry, Notion, PlanetScale
  /\bdp\.(?:pt|st|sa|ct|scrt)\.[A-Za-z0-9]{20,}/g, // Doppler
  /\bkey-[0-9a-f]{32}\b/g, // Mailgun
  /\bSK[0-9a-f]{32}\b/g, // Twilio API key
  /\b(?:prod|dev|preview|project):[a-z0-9-]+\|[A-Za-z0-9+/=_-]{20,}/g, // Convex deploy key
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // a signed token (JWT)
];

// scheme://user:password@host keeps the user (which may be empty, as in redis://:password@host) and drops the password.
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@'"`]*):([^\s@/'"`]+)@/gi;
const HAS_URL_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]*:[^\s@/'"`]+@/i;
// ?key=… or &access_token=… in an address.
const QUERY_SECRET = /([?&](?:key|api[-_]?key|apikey|token|access[-_]?token|auth[-_]?token|auth|secret|client[-_]?secret|password|passwd|pwd|sig|signature|private[-_]?key)=)([^&\s"'`#<>)]+)/gi;
// The credential in an Authorization header, quoted or not: "Bearer <token>", "Basic <base64>", "Token <token>".
const AUTH_SCHEME = /\b([Bb]earer|[Bb]asic|Token|Bot)([ \t]+)([A-Za-z0-9._~+/=-]{8,})/g;

// A name that holds a secret: password, secret, token, api key, and the like, in any case or separator style.
const SECRET_NAME = /(passw(or)?d|passphrase|passcode|^pass$|^pwd$|secret|token|api[-_]?key|apikey|access[-_]?key|private[-_]?key|signing[-_]?key|client[-_]?secret|credential|auth[-_]?key|authorization|bearer)/i;
// A weaker name: its value is a secret only when it also looks random.
const WEAK_NAME = /(^key$|[-_.]key$|[a-z0-9]Key$|salt|pepper|dsn|signature|^sig$|^pin$|[-_]pin$|cookie)/i;
// Names that contain one of those words but hold no secret.
const HARMLESS_NAME =
  /((ref|reference|name|id|ids|env|type|url|uri|endpoint|label|hint|placeholder|field|input|length|min|max|policy|rules?|count|limit|header|path|file|prefix|suffix|format|pattern|tokens|regex|re|schema|message|msg|error|title|description|desc|text|caption|tooltip|selector|mode|kind|style|scopes?|expiry|expires|expiration|ttl|lifetime|duration|timeout|age|seconds|secs|minutes|hours|days|ms|size|bytes|rounds|version|status|state|provider|strategy|method|algorithm|alg|audience|issuer|location|storage|strength|enabled|required|visible|shown|hidden)$|tokenizer)/i;

// name = "value", name: "value", "name": "value", name: Type = "value", name := "value", 'name' => 'value', and the same
// with escaped quotes inside a string ("{\"api_key\":\"value\"}").
const ASSIGNMENT = /(\\?["'`]?)([A-Za-z_$][\w$.-]*)\1(\s*(?::\s*[A-Za-z_$][\w$<>[\]|. ]*?)?\s*(?::=|=>|=|:)\s*)(\\?["'`])([^"'`\n\\]{1,500})\4/g;
// name: value or NAME=value with no quotes, one per line: YAML, env files, shell, INI, Dockerfiles, and comments.
const UNQUOTED = /^([ \t]*(?:(?:#|\/\/|--|;|\*)[ \t]*)?(?:-[ \t]+)?(?:(?:export|ENV|ARG|set)[ \t]+)?)(["']?)([A-Za-z_][\w.-]*)\2([ \t]*(?::|=)[ \t]*)(?!["'`\s])([^\n]*?)((?:[ \t]+#[^\n]*)?)[ \t]*$/gm;
// A secret given as a name and a value side by side: Kubernetes and Compose env lists, ECS task definitions.
const NAME_VALUE = /((?:^|[{,])[ \t]*-?[ \t]*["']?name["']?[ \t]*:[ \t]*["']?([A-Za-z_][\w.-]*)["']?[ \t]*(?:,|\n)[ \t]*["']?value["']?[ \t]*:[ \t]*)(["']?)([^\n"',}]+)\3/gm;
// A quoted base64 string, which may be user:password (the Basic credential).
const BASE64_QUOTED = /(["'`])([A-Za-z0-9+/]{12,}={0,2})\1/g;

// Runs of key-like characters, at least 20 long.
const LONG_RUN = /[A-Za-z0-9+/=_-]{20,}/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_INSIDE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// What a hash is called where it is written down: lockfiles, image digests, pinned commits.
const HASH_CONTEXT = /(^|[^A-Za-z0-9])(integrity|checksum|shasum|sha(1|256|384|512)?|hash|digest|etag|commit|revision|rev|h1)["']?\s*[:=@]?\s*["']?([0-9a-z]+\/)?$/i;

const STOP_WORDS = new Set(
  "a an the of to for in on at by with and or not no is are be your you we our this that it its if when must should can will use enter type here from".split(" "),
);
const PLACEHOLDER =
  /^(true|false|yes|no|on|off|null|nil|none|undefined|empty|n\/a|tbd|todo|changeme|change[-_ ]?me|change[-_ ]?this|example|sample|test|dummy|fake|placeholder|redacted|hidden|secret|secrets|password|passwd|passphrase|token|apikey|api[-_ ]key|key|string|required|optional|enabled|disabled|default|your[-_ ].*|my[-_ ].*|<[^>]*>|\[[^\]]*\]|\.+|-+|…)$/i;

function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

// A word, a number, a short piece, or words and numbers run together ("useQueryV2WithRetries", "400Regular"): each
// stretch of letters or digits is three characters or more on average, with few numbers in it. A random key switches
// between letters, capitals and digits every character or two.
function wordish(part: string): boolean {
  if (part.length <= 3 || /^\d+$/.test(part) || /^[a-z]+$/.test(part) || /^[A-Z]+$/.test(part)) return true;
  const stretches = part.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? [];
  const numbers = stretches.filter((stretch) => /^\d/.test(stretch)).length;
  return stretches.length > 0 && part.length / stretches.length >= 3 && numbers <= 2;
}

/** A run of letters and digits that a person did not choose: a key, not a name, a path, a version or a hash. */
function randomLooking(run: string, minimum = 20): boolean {
  if (run.length < minimum || UUID.test(run) || /^sha(1|256|384|512)-/i.test(run)) return false;
  // An address or a path with an id in it ("u.expo.dev/<uuid>") is judged without the id.
  const withoutIds = run.replace(UUID_INSIDE, "id");
  if (withoutIds !== run) return randomLooking(withoutIds, minimum);
  // Hex: a commit hash (40) and anything shorter than 32 stay; 32 to 39 and 48 or more (openssl rand -hex 32) go.
  if (/^[0-9a-f]+$/i.test(run)) return run.length >= 32 && run.length !== 40 && /\d/.test(run) && /[a-f]/i.test(run);
  // Letters with digits, or letters in both cases: a run of one case only, or of digits only, is a word or a number.
  if (!/[A-Za-z]/.test(run) || (!/\d/.test(run) && !(/[a-z]/.test(run) && /[A-Z]/.test(run)))) return false;
  // Mostly words joined by separators (a package path, a slug, an image size) is not random.
  const parts = run.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const letters = parts.reduce((sum, part) => sum + part.length, 0);
  const worded = parts.filter(wordish).reduce((sum, part) => sum + part.length, 0);
  if (letters === 0 || worded / letters >= 0.5) return false;
  return entropy(run) >= Math.min(4.2, Math.log2(run.length) * 0.75);
}

// A value that only points at a secret kept elsewhere, or is the name of one.
const reference = (value: string) =>
  /\$\{|\{\{|%\(|^\$[A-Za-z_{(]|^%[A-Za-z_]+%$|^!(Ref|Sub|GetAtt)\b|^@Microsoft\.KeyVault|^(process\.env|import\.meta\.env|os\.environ|ENV\[)/.test(value) ||
  (/^[A-Z][A-Z0-9_]*$/.test(value) && (value.includes("_") || value.length <= 12) && (value.match(/\d/g) ?? []).length / value.length < 0.25);

const pathLike = (value: string) => {
  if (!/^(\/|\.\.?\/|~\/)/.test(value)) return false;
  const parts = value.split("/").filter((part) => part && part !== "." && part !== "..");
  return parts.every((part) => /^[\w@.-]+$/.test(part)) && !randomLooking(parts.join(""), 12);
};

/** A value given to a secret name (password, token, …) that is the secret itself, not a stand-in or a pointer. */
function secretValue(raw: string): boolean {
  const value = raw.trim();
  if (value.length < 4 || value.includes(MASK) || reference(value) || PLACEHOLDER.test(value) || /^(.)\1+$/.test(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return HAS_URL_PASSWORD.test(value);
  if (pathLike(value)) return false;
  // A camelCase name ("accessToken", "hashedPassword") names something; a secret has digits or no such shape.
  if (/^[a-z]+(?:[A-Z][a-z]+)+$/.test(value)) return false;
  if (/\s/.test(value)) {
    // A passphrase is three to eight plain words; a sentence or a label has small words, capitals or punctuation.
    const words = value.toLowerCase().split(/\s+/);
    return words.length >= 3 && words.length <= 8 && !/[.!?:]$/.test(value) && !/^[A-Z][a-z]/.test(value) && !words.some((word) => STOP_WORDS.has(word));
  }
  return true;
}

// An unquoted value that is code, not a literal: a call, an expression, a property path, a type, or a variable.
function codeLike(value: string, name: string): boolean {
  const v = value.trim();
  if (/[(){}[\]<>;`]|=>|\?\.|&&|\|\||^[|>][-+]?$/.test(v) || /,$/.test(v)) return true;
  if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(v)) return true;
  if (/^(string|number|boolean|bigint|symbol|any|unknown|never|void|null|undefined|object|Date|Buffer|Uint8Array)(\s*\|\s*[\w.]+)*$/.test(v)) return true;
  if (/^(new|await|function|async|typeof|require)\b/.test(v)) return true;
  return v.replace(/[-_]/g, "").toLowerCase() === name.split(".").pop()!.replace(/[-_]/g, "").toLowerCase();
}

type Strength = "strong" | "weak" | null;
const strength = (name: string): Strength => {
  const last = name.split(".").pop() ?? name;
  if (HARMLESS_NAME.test(last)) return null;
  if (SECRET_NAME.test(last)) return "strong";
  return WEAK_NAME.test(last) ? "weak" : null;
};
const weakValue = (value: string) => !value.includes(MASK) && !reference(value) && (randomLooking(value.trim(), 12) || UUID.test(value.trim()));

const basicPair = (value: string) => {
  if (value.length % 4 !== 0) return false;
  const decode = (globalThis as { atob?: (data: string) => string }).atob;
  try {
    return !!decode && /^[\x21-\x39\x3b-\x7e]+:[\x20-\x7e]+$/.test(decode(value));
  } catch {
    return false;
  }
};

/** The text with secrets masked, and how many were masked. */
export function redactText(text: string): { text: string; masked: number } {
  let masked = 0;
  const hide = (value: string) => {
    masked++;
    return value;
  };
  let out = text.replace(PRIVATE_KEY, (match) => hide(keepLines(match)));
  for (const pattern of KNOWN_TOKENS) out = out.replace(pattern, () => hide(MASK));
  out = out.replace(URL_PASSWORD, (_match, scheme: string, user: string) => hide(`${scheme}${user}:${MASK}@`));
  out = out.replace(QUERY_SECRET, (match, lead: string, value: string) => (value.length >= 6 && !value.includes(MASK) && !reference(value) && !PLACEHOLDER.test(value) ? hide(`${lead}${MASK}`) : match));
  out = out.replace(AUTH_SCHEME, (match, scheme: string, gap: string, credential: string) =>
    !/^[A-Za-z]+$/.test(credential) && !credential.includes(MASK) ? hide(`${scheme}${gap}${MASK}`) : match,
  );
  out = out.replace(ASSIGNMENT, (match, quote: string, name: string, operator: string, open: string, value: string) => {
    const kind = strength(name);
    const secret = kind === "strong" ? secretValue(value) : kind === "weak" && weakValue(value);
    return secret ? hide(`${quote}${name}${quote}${operator}${open}${MASK}${open}`) : match;
  });
  out = out.replace(UNQUOTED, (match, lead: string, quote: string, name: string, operator: string, value: string, comment: string) => {
    const kind = strength(name);
    if (!value.trim() || codeLike(value, name)) return match;
    const secret = kind === "strong" ? secretValue(value) : kind === "weak" && weakValue(value);
    return secret ? hide(`${lead}${quote}${name}${quote}${operator}${MASK}${comment}`) : match;
  });
  out = out.replace(NAME_VALUE, (match, lead: string, name: string, quote: string, value: string) =>
    strength(name) === "strong" && !codeLike(value, name) && secretValue(value) ? hide(`${lead}${quote}${MASK}${quote}`) : match,
  );
  out = out.replace(BASE64_QUOTED, (match, quote: string, value: string) => (basicPair(value) ? hide(`${quote}${MASK}${quote}`) : match));
  out = out.replace(LONG_RUN, (run: string, offset: number, whole: string) => {
    if (!randomLooking(run) || HASH_CONTEXT.test(whole.slice(Math.max(0, offset - 24), offset))) return run;
    // A path whose folders are plain words keeps them, and loses only the random part ("convex/keys/<key>.ts").
    const segments = run.split("/");
    const folder = (segment: string) => /^[a-z][a-z0-9_-]*$/.test(segment) && !randomLooking(segment, 12);
    if (segments.length > 1 && segments.some(folder) && segments.every((segment) => folder(segment) || randomLooking(segment, 12))) {
      return segments.map((segment) => (folder(segment) ? segment : hide(MASK))).join("/");
    }
    return hide(MASK);
  });
  return { text: out, masked };
}

/** The text with secrets masked, for callers that only need the text. */
export const masked = (text: string) => redactText(text).text;

/** Files ready to leave turtl: secret files left out, secrets masked in the rest, in their paths too. */
export function redactFiles<T extends SourceText>(files: T[]): { files: T[]; skipped: string[]; masked: number } {
  const skipped: string[] = [];
  let count = 0;
  const kept: T[] = [];
  for (const file of files) {
    if (isSecretFile(file.path)) {
      skipped.push(file.path);
      continue;
    }
    const content = redactText(file.content);
    const path = redactText(file.path);
    count += content.masked + path.masked;
    kept.push(content.masked || path.masked ? { ...file, path: path.text, content: content.text } : file);
  }
  return { files: kept, skipped, masked: count };
}
