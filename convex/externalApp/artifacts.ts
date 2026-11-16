import { unzipSync, Unzlib } from "fflate";
import { parseProbeResult, type ProbeResult } from "./validators";
import { MAX_ARCHIVE_BYTES } from "./probeClient";

const MAX_PNG_BYTES = 1_000_000;
const MAX_RESULT_BYTES = 128 * 1024;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function validatePng(bytes: Uint8Array, viewport: { width: number; height: number }): { width: number; height: number } {
  if (!bytes.length || bytes.length > MAX_PNG_BYTES || bytes.length < 45) throw new Error("PNG is missing, truncated or larger than 1 MB.");
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) throw new Error("Screenshot is not a PNG.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  if (width !== viewport.width || height !== viewport.height || width > 2000 || height > 2000 || !width || !height) throw new Error("PNG pixel dimensions do not match the browser viewport.");
  let offset = 8, seenHeader = false, seenEnd = false, color = 0;
  const imageData: Uint8Array[] = [];
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) throw new Error("PNG chunk is truncated.");
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== view.getUint32(offset + 8 + length)) throw new Error("PNG chunk checksum is invalid.");
    if (!seenHeader && type !== "IHDR") throw new Error("PNG header is missing.");
    if (type === "IHDR") {
      if (seenHeader || length !== 13 || data[8] !== 8 || ![2, 6].includes(data[9]) || data[10] || data[11] || data[12]) throw new Error("PNG uses an unsupported or malformed pixel format.");
      seenHeader = true;
      color = data[9];
    } else if (type === "IDAT") {
      imageData.push(data);
    } else if (type === "IEND") {
      if (length || !imageData.length || offset + 12 !== bytes.length) throw new Error("PNG end is malformed.");
      seenEnd = true;
    } else if (type !== "PLTE" && /^[A-Z]/.test(type)) {
      throw new Error("PNG has an unknown critical chunk.");
    }
    offset += length + 12;
  }
  if (!seenHeader || !seenEnd || offset !== bytes.length) throw new Error("PNG is incomplete.");
  const rowBytes = 1 + width * (color === 6 ? 4 : 3);
  const expected = rowBytes * height;
  let decoded = 0;
  const decoder = new Unzlib((chunk) => {
    if (decoded + chunk.length > expected) throw new Error("PNG pixel data exceeds its dimensions.");
    for (let at = (rowBytes - decoded % rowBytes) % rowBytes; at < chunk.length; at += rowBytes) {
      if (chunk[at] > 4) throw new Error("PNG scanline filter is invalid.");
    }
    decoded += chunk.length;
  });
  imageData.forEach((chunk, index) => decoder.push(chunk, index === imageData.length - 1));
  if (decoded !== expected) throw new Error("PNG pixel data is truncated.");
  return { width, height };
}

export type ArtifactScreenshot = ProbeResult["screenshots"][number] & {
  bytes?: Uint8Array;
  pixelWidth?: number;
  pixelHeight?: number;
  unavailableReason?: string;
};

export function extractArtifact(bytes: Uint8Array): { result: ProbeResult; screenshots: ArtifactScreenshot[] } {
  if (!bytes.length || bytes.length > MAX_ARCHIVE_BYTES) throw new Error("Probe artifact is empty or too large.");
  const names = new Set<string>();
  let total = 0;
  const files = unzipSync(bytes, { filter: (entry) => {
    if (names.has(entry.name)) throw new Error("Probe artifact has duplicate paths.");
    names.add(entry.name);
    if (names.size > 10) throw new Error("Probe artifact has too many files.");
    if (entry.name === "screenshots/" && entry.originalSize === 0) return false;
    if (entry.name !== "result.json" && !/^screenshots\/[A-Za-z0-9][A-Za-z0-9_-]*\.png$/.test(entry.name)) throw new Error("Probe artifact has an unexpected path.");
    if (entry.originalSize > (entry.name === "result.json" ? MAX_RESULT_BYTES : MAX_PNG_BYTES)) throw new Error("Probe artifact entry is too large.");
    total += entry.originalSize;
    if (total > 8 * MAX_PNG_BYTES + MAX_RESULT_BYTES) throw new Error("Probe artifact expands beyond its limit.");
    return true;
  } });
  const manifest = files["result.json"];
  if (!manifest || manifest.length > MAX_RESULT_BYTES) throw new Error("Probe artifact is missing result.json.");
  const result = parseProbeResult(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest)));
  if (Object.keys(files).some((name) => name !== "result.json" && !result.screenshots.some((shot) => shot.file === name))) throw new Error("Probe artifact has an unlisted screenshot.");
  const screenshots = result.screenshots.map((shot): ArtifactScreenshot => {
    const png = files[shot.file];
    if (!png) return { ...shot, unavailableReason: "The artifact did not contain this screenshot." };
    try {
      const size = validatePng(png, result.viewport);
      return { ...shot, bytes: png, pixelWidth: size.width, pixelHeight: size.height };
    } catch (error) {
      return { ...shot, unavailableReason: error instanceof Error ? error.message : "PNG validation failed." };
    }
  });
  return { result, screenshots };
}
