#!/usr/bin/env node
// install-dist.mjs — fetch a registry agent's distribution for this platform.
//   binary → download archive, verify sha256, extract into .cache/agents/<id>/
//   npx/uvx → no-op (the run command self-installs)
// Prints the resolved run command on stdout (last line).
//
// usage: node tools/install-dist.mjs registry/agents/<id>.json

import { readFileSync, existsSync, mkdirSync, chmodSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const entryPath = resolve(process.argv[2]);
const entry = JSON.parse(readFileSync(entryPath, "utf8"));
const cacheDir = join(root, ".cache", "agents", entry.name);

function platformKey() {
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
  const arch = { arm64: "aarch64", x64: "x86_64" }[process.arch];
  if (!os || !arch) throw new Error(`unsupported platform ${process.platform}/${process.arch}`);
  return `${os}-${arch}`;
}

const dist = entry.dist;
if (!dist || dist.type === "npx" || dist.type === "uvx") {
  // nothing to fetch — the run command self-installs
  console.log(entry.run);
  process.exit(0);
}

if (dist.type !== "binary") throw new Error(`unknown dist type ${dist.type}`);

const spec = dist.per_platform[platformKey()];
if (!spec) throw new Error(`no binary for ${platformKey()}`);

const binPath = join(cacheDir, spec.cmd.replace(/^\.\//, ""));
if (existsSync(binPath)) {
  console.error(`cached: ${binPath}`);
  console.log(entry.run);
  process.exit(0);
}

mkdirSync(cacheDir, { recursive: true });
const archivePath = join(cacheDir, "dist.archive");
console.error(`downloading ${spec.archive}`);
execFileSync("curl", ["-fsSL", spec.archive, "-o", archivePath], { stdio: "inherit" });

if (spec.sha256) {
  const got = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  if (got !== spec.sha256) throw new Error(`sha256 mismatch: got ${got}, want ${spec.sha256}`);
  console.error("sha256 ok");
}

if (spec.archive.endsWith(".zip")) {
  execFileSync("unzip", ["-o", "-q", archivePath, "-d", cacheDir], { stdio: "inherit" });
} else {
  execFileSync("tar", ["-xzf", archivePath, "-C", cacheDir], { stdio: "inherit" });
}
try {
  chmodSync(binPath, 0o755);
} catch {}
writeFileSync(join(cacheDir, "SOURCE"), `${spec.archive}\n${spec.sha256 ?? ""}\n`);
console.error(`installed → ${binPath}`);
console.log(entry.run);
