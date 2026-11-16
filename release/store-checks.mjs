import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The purpose strings the iOS build may carry. Add one here only when the app really asks for that permission.
export const PURPOSE_STRINGS = ["NSMicrophoneUsageDescription"];

const json = (root, file) => JSON.parse(readFileSync(join(root, file), "utf8"));

export function appConfigProblems(root) {
  const { expo } = json(root, "app.json");
  const problems = [];
  if (expo.ios?.bundleIdentifier !== "com.turtl.oncall") problems.push("app.json: ios.bundleIdentifier must stay com.turtl.oncall.");
  if (![expo.scheme].flat().includes("turtl")) problems.push("app.json: the turtl:// scheme must stay; sign-in returns through it.");
  if (!/^\d+\.\d+\.\d+$/.test(expo.version ?? "")) problems.push("app.json: version must look like 1.0.0.");
  if (expo.ios?.buildNumber !== undefined) problems.push("app.json: remove ios.buildNumber. EAS keeps the build number and raises it on every build.");
  if (expo.ios?.supportsTablet !== false) problems.push("app.json: ios.supportsTablet must be false. turtl ships for iPhone only.");
  if (expo.ios?.config?.usesNonExemptEncryption !== false) problems.push("app.json: ios.config.usesNonExemptEncryption must be false, the export compliance answer.");
  return [...problems, ...iconProblems(join(root, expo.icon ?? "missing"))];
}

export function iconProblems(path) {
  if (!existsSync(path)) return [`The app icon ${path} does not exist.`];
  const png = readFileSync(path);
  if (png.subarray(1, 4).toString("latin1") !== "PNG") return [`The app icon ${path} is not a PNG.`];
  const problems = [];
  if (png.readUInt32BE(16) !== 1024 || png.readUInt32BE(20) !== 1024) problems.push(`The app icon must be 1024 by 1024; it is ${png.readUInt32BE(16)} by ${png.readUInt32BE(20)}.`);
  if ([4, 6].includes(png[25]) || png.includes("tRNS", 8, "latin1")) problems.push("The app icon has transparency. Apple rejects an icon with an alpha channel; export it as an opaque PNG.");
  return problems;
}

function accessedApis(plist) {
  const found = {};
  for (const [, dict] of plist.matchAll(/<dict>((?:(?!<dict>)[\s\S])*?)<\/dict>/g)) {
    const type = /<key>NSPrivacyAccessedAPIType<\/key>\s*<string>([^<]+)<\/string>/.exec(dict)?.[1];
    const reasons = /<key>NSPrivacyAccessedAPITypeReasons<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(dict)?.[1];
    if (type) found[type] = [...(found[type] ?? []), ...[...(reasons ?? "").matchAll(/<string>([^<]+)<\/string>/g)].map((match) => match[1])];
  }
  return found;
}

function libraryManifests(dir, nested = false) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.name === "PrivacyInfo.xcprivacy") return [path];
    if (nested && entry.name === "node_modules") return [];
    return entry.isDirectory() || (entry.isSymbolicLink() && statSync(path).isDirectory()) ? libraryManifests(path, true) : [];
  });
}

// Apple reads only the app's own privacy manifest reliably, so it must repeat every reason its libraries declare.
export function privacyManifestProblems(root) {
  const declared = Object.fromEntries((json(root, "app.json").expo.ios?.privacyManifests?.NSPrivacyAccessedAPITypes ?? []).map((entry) => [entry.NSPrivacyAccessedAPIType, entry.NSPrivacyAccessedAPITypeReasons ?? []]));
  const files = existsSync(join(root, "node_modules")) ? libraryManifests(join(root, "node_modules")) : [];
  if (!files.length) return ["No library privacy manifest was found under node_modules. Install the dependencies before checking."];
  const problems = [];
  for (const file of files.sort()) {
    for (const [type, reasons] of Object.entries(accessedApis(readFileSync(file, "utf8")))) {
      for (const reason of reasons) {
        if (!declared[type]?.includes(reason)) problems.push(`app.json: ios.privacyManifests must declare ${type} with reason ${reason}, which ${file.slice(root.length).replace(/^[\\/]/, "")} uses.`);
      }
    }
  }
  return [...new Set(problems)];
}

export function easProblems(root) {
  const eas = json(root, "eas.json");
  const problems = [];
  if (eas.cli?.appVersionSource !== "remote") problems.push("eas.json: cli.appVersionSource must be remote, so build numbers are kept by EAS and not edited by hand.");
  for (const name of ["development", "preview", "production"]) {
    const profile = eas.build?.[name];
    if (!profile) {
      problems.push(`eas.json: the ${name} build profile is missing.`);
      continue;
    }
    if (profile.environment !== name) problems.push(`eas.json: ${name} must read the EAS "${name}" environment, which holds its backend address.`);
    if (profile.env?.EXPO_PUBLIC_APP_ENV !== name) problems.push(`eas.json: ${name} must set EXPO_PUBLIC_APP_ENV to ${name}.`);
    if (name === "development") continue;
    if (profile.autoIncrement !== true) problems.push(`eas.json: ${name} must set autoIncrement, so every build gets a new build number.`);
    for (const flag of ["EXPO_PUBLIC_DEV_TOOLS", "EXPO_PUBLIC_DATA_SOURCE"]) {
      if (profile.env?.[flag] !== undefined) problems.push(`eas.json: ${name} must not set ${flag}.`);
    }
  }
  if (eas.build?.development?.ios?.simulator !== true) problems.push("eas.json: development must build for the simulator.");
  if (eas.build?.preview?.distribution !== "internal") problems.push("eas.json: preview must use internal distribution.");
  if (eas.build?.production?.distribution !== "store") problems.push("eas.json: production must use store distribution.");
  return problems;
}

// A store build is always on live data, so it is safe only once the backend knows who is calling.
export function signInProblems(root) {
  return existsSync(join(root, "convex/auth.config.ts")) ? [] : ["convex/auth.config.ts does not exist, so the backend has no sign-in. A store build would let anyone into the app. Release after accounts and sign-in have merged."];
}

// Generates the iOS project in a scratch copy with the production environment and reads what Apple will read.
export function nativeProblems(root) {
  const scratch = mkdtempSync(join(tmpdir(), "turtl-prebuild-"));
  try {
    cpSync(root, scratch, { recursive: true, filter: (source) => ![".git", "node_modules", "ios", "android", ".expo", "protected-app"].some((name) => source === join(root, name)) });
    symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"));
    execFileSync("npx", ["expo", "prebuild", "--platform", "ios", "--no-install"], {
      cwd: scratch,
      stdio: "pipe",
      env: { ...process.env, CI: "1", EXPO_PUBLIC_APP_ENV: "production", EXPO_PUBLIC_CONVEX_URL: "https://production-backend.invalid", EXPO_PUBLIC_DEV_TOOLS: "", EXPO_PUBLIC_DATA_SOURCE: "" },
    });
    const plist = readFileSync(join(scratch, "ios/turtl/Info.plist"), "utf8");
    const project = readFileSync(join(scratch, "ios/turtl.xcodeproj/project.pbxproj"), "utf8");
    const manifestPath = join(scratch, "ios/turtl/PrivacyInfo.xcprivacy");
    const value = (key) => new RegExp(`<key>${key}</key>\\s*<(true|false)/>`).exec(plist)?.[1];
    const purposes = [...plist.matchAll(/<key>(NS\w+UsageDescription)<\/key>/g)].map((match) => match[1]);
    const problems = [];
    if (value("ITSAppUsesNonExemptEncryption") !== "false") problems.push("Info.plist: ITSAppUsesNonExemptEncryption is not false, so every upload would ask about export compliance.");
    for (const key of purposes.filter((key) => !PURPOSE_STRINGS.includes(key))) problems.push(`Info.plist: ${key} is present, but release/store-checks.mjs does not list it. Remove the plugin setting that adds it, or add it to PURPOSE_STRINGS if the app really asks for that permission.`);
    for (const key of PURPOSE_STRINGS.filter((key) => !purposes.includes(key))) problems.push(`Info.plist: ${key} is missing, and the app asks for that permission.`);
    if (/<key>UIBackgroundModes<\/key>/.test(plist)) problems.push("Info.plist: UIBackgroundModes is present. Apple asks why an app runs in the background; remove it or justify it here.");
    if (value("NSAllowsArbitraryLoads") === "true") problems.push("Info.plist: NSAllowsArbitraryLoads is on. The app must reach its backend over https only.");
    if (!/<string>turtl<\/string>/.test(/<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1] ?? "")) problems.push("Info.plist: the turtl URL scheme is missing.");
    if (!/TARGETED_DEVICE_FAMILY = "?1"?;/.test(project) || /TARGETED_DEVICE_FAMILY = "1,2";/.test(project)) problems.push("The Xcode project is not iPhone only (TARGETED_DEVICE_FAMILY must be 1).");
    if (!existsSync(manifestPath)) problems.push("ios/turtl/PrivacyInfo.xcprivacy was not generated.");
    else if (JSON.stringify(accessedApis(readFileSync(manifestPath, "utf8"))) !== JSON.stringify(Object.fromEntries(json(root, "app.json").expo.ios.privacyManifests.NSPrivacyAccessedAPITypes.map((entry) => [entry.NSPrivacyAccessedAPIType, entry.NSPrivacyAccessedAPITypeReasons])))) problems.push("ios/turtl/PrivacyInfo.xcprivacy does not carry the reasons app.json declares.");
    return problems;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
