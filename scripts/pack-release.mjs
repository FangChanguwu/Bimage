import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..");
const outDir = path.join(ROOT, "release-artifacts");

const rootPkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const backendPkg = JSON.parse(readFileSync(path.join(ROOT, "backend", "package.json"), "utf8"));
const version = rootPkg.version;
const tag = `v${version}`;

const requiredPaths = [
  path.join(ROOT, "backend", "dist", "index.js"),
  path.join(ROOT, "backend", "dist", "launcher.js"),
  path.join(ROOT, "backend", "package.json"),
  path.join(ROOT, "frontend", "dist", "index.html"),
];
for (const req of requiredPaths) {
  if (!existsSync(req)) {
    console.error(`Missing build output: ${path.relative(ROOT, req)}. Run 'npm run build' first.`);
    process.exit(1);
  }
}

function writeOctal(buf, offset, length, value) {
  const str = value.toString(8).padStart(length - 1, "0");
  buf.write(str.slice(-(length - 1)), offset, length - 1, "ascii");
  buf[offset + length - 1] = 0;
}

function makeTarHeader(name, size, typeFlag) {
  const header = Buffer.alloc(512, 0);
  const nameBuf = Buffer.from(name, "utf8");
  if (nameBuf.length <= 100) {
    nameBuf.copy(header, 0);
  } else {
    // Split into USTAR prefix (155) + name (100)
    const slash = name.lastIndexOf("/", 155);
    if (slash <= 0 || name.length - slash - 1 > 100) {
      throw new Error(`Archive path too long for USTAR header: ${name}`);
    }
    Buffer.from(name.slice(0, slash), "utf8").copy(header, 345);
    Buffer.from(name.slice(slash + 1), "utf8").copy(header, 0);
  }
  writeOctal(header, 100, 8, typeFlag === "5" ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.fill(0x20, 148, 156); // checksum placeholder
  header[156] = typeFlag.charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");

  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i];
  const chkStr = checksum.toString(8).padStart(6, "0");
  header.write(chkStr, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

const chunks = [];

function addBuffer(archivePath, data) {
  const clean = archivePath.replace(/\\/g, "/");
  chunks.push(makeTarHeader(clean, data.length, "0"));
  chunks.push(data);
  const rem = data.length % 512;
  if (rem !== 0) chunks.push(Buffer.alloc(512 - rem, 0));
}

function addFile(fsPath, archivePath) {
  addBuffer(archivePath, readFileSync(fsPath));
}

function addDirectory(fsDir, archivePrefix) {
  const entries = readdirSync(fsDir).sort();
  for (const name of entries) {
    const full = path.join(fsDir, name);
    const rel = `${archivePrefix}/${name}`;
    const st = statSync(full);
    if (st.isDirectory()) {
      addDirectory(full, rel);
    } else if (st.isFile()) {
      if (name.endsWith(".map")) continue; // omit source maps from runtime bundle
      addFile(full, rel);
    }
  }
}

const releaseManifest = {
  version,
  tag,
  builtAt: new Date().toISOString(),
  backendDependencies: backendPkg.dependencies || {},
};
addBuffer("release.json", Buffer.from(JSON.stringify(releaseManifest, null, 2) + "\n", "utf8"));
addFile(path.join(ROOT, "backend", "package.json"), "backend/package.json");
addDirectory(path.join(ROOT, "backend", "dist"), "backend/dist");
if (existsSync(path.join(ROOT, "backend", "contracts"))) {
  addDirectory(path.join(ROOT, "backend", "contracts"), "backend/contracts");
}
addDirectory(path.join(ROOT, "frontend", "dist"), "frontend/dist");

// End-of-archive two 512-byte zero blocks
chunks.push(Buffer.alloc(1024, 0));

const tarBuffer = Buffer.concat(chunks);
const gzBuffer = gzipSync(tarBuffer, { level: 9 });

mkdirSync(outDir, { recursive: true });
const archiveName = `bimage-${tag}.tar.gz`;
const archivePath = path.join(outDir, archiveName);
writeFileSync(archivePath, gzBuffer);

const sha256 = createHash("sha256").update(gzBuffer).digest("hex");
const checksumsPath = path.join(outDir, "checksums.txt");
writeFileSync(checksumsPath, `${sha256}  ${archiveName}\n`, "utf8");

console.log(`Packed ${archiveName} (${(gzBuffer.length / 1024).toFixed(1)} KB)`);
console.log(`SHA-256: ${sha256}`);
