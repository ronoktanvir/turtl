// Strips secrets from repository content before any of it leaves for OpenAI or Supermemory: the code map's labels and
// documents (codeNetwork/build.ts) and the onboarding inspection (onboarding/inspect.ts). Pure: no imports.
//
// Files that are secrets by nature are left out whole. In everything else these are masked, and line breaks are kept
// so line numbers still point at the same lines:
// - private key blocks;
// - tokens with a known prefix (GitHub, OpenAI, Anthropic, Stripe, AWS, Google, Slack, and others);
// - the password in a URL (scheme://user:password@host);
// - a string assigned to a name such as password, secret, token or api key, when the string looks like a secret;
// - long, random-looking strings.

export const MASK = "[secret removed]";

export type SourceText = { path: string; content: string };

const SECRET_NAMES = [
  /(^|\/)\.env(\.(?!example$|sample$|template$|defaults?$)[^/]+)?$/i,
  /\.(pem|key|p8|p12|pfx|jks|keystore|kdbx|ovpn|tfstate|tfvars|mobileprovision|gpg)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)\.(npmrc|pypirc|netrc|htpasswd|git-credentials|dockercfg)$/i,
  /(^|\/)(credentials|secrets?)(\.(json|ya?ml|toml|ini|txt|xml|plist|env))?$/i,
  /(^|\/)[^/]*(service[-_]?account|firebase-adminsdk)[^/]*\.json$/i,
  /(^|\/)(google-services\.json|GoogleService-Info\.plist)$/i,
];

/** True for a file whose whole content is credentials, such as .env or a private key. */
export function isSecretFile(path: string): boolean {
  return SECRET_NAMES.some((pattern) => pattern.test(path));
}

const keepLines = (match: string) => MASK + "\n".repeat((match.match(/\n/g) ?? []).length);

const PRIVATE_KEY = /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY( BLOCK)?-----[\s\S]*?(-----END \1PRIVATE KEY( BLOCK)?-----|$)/g;

const KNOWN_TOKENS = [
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic
  /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, // OpenAI
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, // Stripe
  /\bwhsec_[A-Za-z0-9+/=]{16,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, // SendGrid
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g, // Hugging Face
  /\bshp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}\b/g, // Shopify
  /\bdop_v1_[a-f0-9]{64}\b/g, // DigitalOcean
  /\bsm_[A-Za-z0-9_]{20,}/g, // Supermemory
  /\b(?:prod|dev|preview|project):[a-z0-9-]+\|[A-Za-z0-9+/=_-]{20,}/g, // Convex deploy key
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // a signed token (JWT)
];

// scheme://user:password@host keeps the user and drops the password.
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@'"`]+):([^\s@/'"`]+)@/gi;
const HAS_URL_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:[^\s@/'"`]+@/i;

// A name that holds a secret: password, secret, token, api key, and the like, in any case or separator style.
const SECRET_NAME = /(passw(or)?d|passphrase|^pass$|^pwd$|secret|token|api[-_]?key|apikey|access[-_]?key|private[-_]?key|signing[-_]?key|client[-_]?secret|credential|auth[-_]?key|authorization|bearer)/i;
// Names that contain one of those words but hold no secret.
const HARMLESS_NAME = /((ref|reference|name|id|ids|env|type|url|uri|endpoint|label|hint|placeholder|field|input|length|min|max|policy|rules?|count|limit|header|path|file|prefix|suffix|format|pattern|tokens)$|tokenizer)/i;

// name = "value", name: "value", "name": "value", name: Type = "value", name := "value".
const ASSIGNMENT = /(["'`]?)([A-Za-z_$][\w$.-]*)\1(\s*(?::\s*[A-Za-z_$][\w$<>[\]|. ]*?)?\s*(?::=|=|:)\s*)(["'`])([^"'`\n]{1,500})\4/g;
// NAME=value on its own line, as in an env file or a shell script. Upper-case names only, so code is not read as one.
const ENV_LINE = /^([ \t]*(?:export[ \t]+)?)([A-Z][A-Z0-9_]*)([ \t]*=[ \t]*)([^\s"'`#;][^\s#;]*)[ \t]*$/gm;

function looksSecret(value: string): boolean {
  if (value.length < 6 || /\s/.test(value)) return false;
  if (value.includes("${") || value.startsWith("/") || value.startsWith("./") || value.includes(MASK)) return false;
  if (/^[A-Z][A-Z0-9_]*$/.test(value)) return false; // the name of an environment variable
  if (/^(true|false|null|undefined|none|changeme|example|placeholder|your[-_].*|<.*>|x+|\*+)$/i.test(value)) return false;
  if (/^https?:\/\//i.test(value) && !HAS_URL_PASSWORD.test(value)) return false;
  return /\d/.test(value) || (/[A-Z]/.test(value) && /[a-z]/.test(value)) || /[^A-Za-z0-9.-]/.test(value) || value.length >= 16;
}

const secretName = (name: string) => {
  const last = name.split(".").pop() ?? name;
  return SECRET_NAME.test(last) && !HARMLESS_NAME.test(last);
};

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

// Runs of key-like characters, at least 32 long. A path or a long identifier has no digits or little randomness, so
// it stays; a random key (base64, base62) does not. Hex counts only from 48 characters, past a commit hash.
const LONG_RUN = /[A-Za-z0-9+/=_-]{32,}/g;

function randomLooking(run: string): boolean {
  if (/^[0-9a-f]+$/i.test(run)) return run.length >= 48;
  if (!/\d/.test(run) || !/[A-Za-z]/.test(run)) return false;
  // Words and numbers joined by separators (a package path, a slug) are not random: each part is one or the other.
  const parts = run.split(/[-_/+=]+/).filter(Boolean);
  if (parts.length > 1 && parts.every((part) => /^[A-Za-z]+$/.test(part) || /^\d+$/.test(part) || part.length <= 3)) return false;
  return entropy(run) >= 4.2;
}

/** The text with secrets masked, and how many were masked. */
export function redactText(text: string): { text: string; masked: number } {
  let masked = 0;
  const count = (value: string) => {
    masked++;
    return value;
  };
  let out = text.replace(PRIVATE_KEY, (match) => count(keepLines(match)));
  for (const pattern of KNOWN_TOKENS) out = out.replace(pattern, () => count(MASK));
  out = out.replace(URL_PASSWORD, (_match, scheme: string, user: string) => count(`${scheme}${user}:${MASK}@`));
  out = out.replace(ASSIGNMENT, (match, quote: string, name: string, operator: string, open: string, value: string) =>
    secretName(name) && looksSecret(value) ? count(`${quote}${name}${quote}${operator}${open}${MASK}${open}`) : match,
  );
  out = out.replace(ENV_LINE, (match, lead: string, name: string, operator: string, value: string) =>
    secretName(name) && looksSecret(value) ? count(`${lead}${name}${operator}${MASK}`) : match,
  );
  out = out.replace(LONG_RUN, (run) => (randomLooking(run) ? count(MASK) : run));
  return { text: out, masked };
}

/** Files ready to leave turtl: secret files left out, secrets masked in the rest. */
export function redactFiles<T extends SourceText>(files: T[]): { files: T[]; skipped: string[]; masked: number } {
  const skipped: string[] = [];
  let masked = 0;
  const kept: T[] = [];
  for (const file of files) {
    if (isSecretFile(file.path)) {
      skipped.push(file.path);
      continue;
    }
    const result = redactText(file.content);
    masked += result.masked;
    kept.push(result.masked ? { ...file, content: result.text } : file);
  }
  return { files: kept, skipped, masked };
}
