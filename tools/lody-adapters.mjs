#!/usr/bin/env node
// Clone + build Lody ACP adapters into .cache/adapters/<name>/ so wall entries
// can run the lody-speaking builds instead of upstream packages.
//
//   node tools/lody-adapters.mjs <name|all>
//
// Each adapter prints its `run` command; wire it via registry/overrides/<id>.json.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = join(root, ".cache", "adapters");

const ADAPTERS = {
  codex: {
    repo: "https://github.com/LodyAI/acp-extension-codex",
    build: "npm install --no-audit --no-fund && node build.mjs",
    entry: "dist/index.js",
    run: "node ${REPO_ROOT}/.cache/adapters/codex/dist/index.js",
  },
  claude: {
    repo: "https://github.com/LodyAI/acp-extension-claude",
    build: "npm install --no-audit --no-fund && npm run build",
    entry: "dist/index.js",
    run: "node ${REPO_ROOT}/.cache/adapters/claude/dist/index.js",
  },
  grok: {
    repo: "https://github.com/LodyAI/acp-extension-grok",
    // Pure-JS stdio proxy — no compile step, but needs the official runtime.
    build: "npm install --no-audit --no-fund",
    entry: "src/index.js",
    runtime: "@xai-official/grok@1.0.36",
    run: "node ${REPO_ROOT}/.cache/adapters/grok/src/index.js",
  },
  pi: {
    repo: "https://github.com/LodyAI/acp-extension-pi",
    build: "npm install --no-audit --no-fund && npm run build",
    entry: "dist/index.js",
    run: "node ${REPO_ROOT}/.cache/adapters/pi/dist/index.js",
  },
  kimi: {
    repo: "https://github.com/LodyAI/acp-extension-kimi",
    // pnpm isn't preinstalled everywhere — npx fetches the pinned version.
    build: "npx -y pnpm@10.33.0 install && npx -y pnpm@10.33.0 --filter @moonshot-ai/kimi-code build",
    entry: "apps/kimi-code/dist/main.mjs",
    run: "node ${REPO_ROOT}/.cache/adapters/kimi/apps/kimi-code/dist/main.mjs acp",
  },
};

const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: "inherit" });

function ensureClone(name, repo) {
  const dir = join(cacheDir, name);
  if (existsSync(join(dir, ".git"))) {
    sh("git pull --ff-only", dir);
  } else {
    mkdirSync(cacheDir, { recursive: true });
    sh(`git clone --depth 1 ${repo} ${JSON.stringify(dir)}`, root);
  }
  return dir;
}

function installGrokRuntime() {
  const rtDir = join(cacheDir, "grok-runtime");
  mkdirSync(rtDir, { recursive: true });
  writeFileSync(join(rtDir, "package.json"), '{ "dependencies": {} }\n');
  sh(`npm install --no-audit --no-fund ${ADAPTERS.grok.runtime}`, rtDir);
  const bin = join(rtDir, "node_modules", ".bin", "grok");
  if (!existsSync(bin)) throw new Error(`grok runtime bin missing at ${bin}`);
  return bin;
}

const targets = process.argv[2] === "all" || !process.argv[2]
  ? Object.keys(ADAPTERS)
  : [process.argv[2]];

for (const name of targets) {
  const a = ADAPTERS[name];
  if (!a) {
    console.error(`unknown adapter ${name} — pick: ${Object.keys(ADAPTERS).join(", ")}`);
    process.exit(1);
  }
  const dir = ensureClone(name, a.repo);
  if (a.build) sh(a.build, dir);
  if (!existsSync(join(dir, a.entry))) throw new Error(`${name}: ${a.entry} missing after build`);
  if (a.runtime) {
    const bin = installGrokRuntime();
    console.log(`${name}: GROK_PATH=${bin}`);
  }
  console.log(`${name}: run = ${a.run}`);
}
