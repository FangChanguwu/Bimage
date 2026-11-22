import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const MAX_FILES = 2500;
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;
const BLOCK_SIZE = 512;

function readString(buf: Buffer, offset: number, length: number): string {
  let end = offset;
  const max = Math.min(buf.length, offset + length);
  while (end < max && buf[end] !== 0) end++;
  return buf.subarray(offset, end).toString("utf8");
}

function readOctal(buf: Buffer, offset: number, length: number): number {
  const first = buf[offset];
  // GNU base-256 size encoding for large numbers
  if (first !== undefined && (first & 0x80) !== 0) {
    let value = BigInt(first & 0x7f);
    for (let i = 1; i < length; i++) {
      value = (value << 8n) | BigInt(buf[offset + i] ?? 0);
    }
    return Number(value);
  }
  const raw = readString(buf, offset, length).trim();
  if (!raw) return 0;
  const parsed = parseInt(raw, 8);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error("Invalid tar header numeric field");
  return parsed;
}

function isZeroBlock(buf: Buffer, offset: number): boolean {
  for (let i = 0; i < BLOCK_SIZE; i++) {
    if (buf[offset + i] !== 0) return false;
  }
  return true;
}

function parsePaxHeaders(data: Buffer): Record<string, string> {
  const result: Record<string, string> = {};
  const text = data.toString("utf8");
  let pos = 0;
  while (pos < text.length) {
    const space = text.indexOf(" ", pos);
    if (space < 0) break;
    const len = Number(text.slice(pos, space));
    if (!Number.isInteger(len) || len <= 0) break;
    const record = text.slice(space + 1, pos + len);
    const eq = record.indexOf("=");
    if (eq > 0) {
      const key = record.slice(0, eq);
      const val = record.slice(eq + 1).replace(/\n$/, "");
      result[key] = val;
    }
    pos += len;
  }
  return result;
}

function sanitizeRelativePath(entryPath: string): string {
  const normalized = entryPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized === ".") return "";
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.includes("\0")
  ) {
    throw new Error(`Unsafe archive entry path: ${entryPath}`);
  }
  const parts = normalized.split("/").filter((p) => p.length > 0 && p !== ".");
  if (parts.some((p) => p === "..")) {
    throw new Error(`Path traversal rejected in archive: ${entryPath}`);
  }
  return parts.join("/");
}

/**
 * Safely extracts a POSIX/USTAR .tar.gz archive into `destDir`.
 * Rejects symlinks, hardlinks, absolute paths, and path traversal.
 */
export function extractTarGz(archiveBuffer: Buffer, destDir: string): number {
  const tar = gunzipSync(archiveBuffer, { maxOutputLength: MAX_TOTAL_BYTES + 16 * 1024 * 1024 });
  const resolvedDest = path.resolve(destDir);
  mkdirSync(resolvedDest, { recursive: true });

  let offset = 0;
  let filesExtracted = 0;
  let totalBytes = 0;
  let nextLongName: string | null = null;
  let nextPax: Record<string, string> | null = null;

  while (offset + BLOCK_SIZE <= tar.length) {
    if (isZeroBlock(tar, offset)) {
      offset += BLOCK_SIZE;
      continue;
    }

    const nameField = readString(tar, offset, 100);
    const prefixField = readString(tar, offset + 345, 155);
    const size = readOctal(tar, offset + 124, 12);
    const typeFlagByte = tar[offset + 156] ?? 0;
    const typeFlag = typeFlagByte === 0 ? "0" : String.fromCharCode(typeFlagByte);

    const dataStart = offset + BLOCK_SIZE;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) {
      throw new Error("Truncated tar archive entry");
    }
    const content = tar.subarray(dataStart, dataEnd);
    const paddedSize = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    offset = dataStart + paddedSize;

    // GNU LongName
    if (typeFlag === "L") {
      nextLongName = content.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    // PAX extended header for next entry
    if (typeFlag === "x") {
      nextPax = parsePaxHeaders(content);
      continue;
    }
    // Global PAX header (ignore)
    if (typeFlag === "g") {
      continue;
    }

    const rawPath =
      nextPax?.path ||
      nextLongName ||
      (prefixField ? `${prefixField}/${nameField}` : nameField);
    nextLongName = null;
    nextPax = null;

    const relPath = sanitizeRelativePath(rawPath);
    if (!relPath) continue;

    const targetPath = path.resolve(resolvedDest, relPath);
    if (
      targetPath !== resolvedDest &&
      !targetPath.startsWith(resolvedDest + path.sep)
    ) {
      throw new Error(`Archive entry escapes destination: ${rawPath}`);
    }

    if (typeFlag === "5") {
      mkdirSync(targetPath, { recursive: true });
      continue;
    }

    if (typeFlag === "0") {
      filesExtracted++;
      totalBytes += content.length;
      if (filesExtracted > MAX_FILES) {
        throw new Error("Archive exceeds maximum allowed file count");
      }
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error("Archive exceeds maximum allowed extracted size");
      }
      mkdirSync(path.dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, content);
      continue;
    }

    throw new Error(`Unsupported or unsafe tar entry type '${typeFlag}': ${rawPath}`);
  }

  return filesExtracted;
}
