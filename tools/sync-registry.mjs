#!/usr/bin/env node
// sync-registry.mjs — pull the official ACP registry and emit probe-ready
// entries under registry/agents/<id>.json.
//
//   official agent ──► run recipe (npx / uvx / binary-per-platform)
//   registry/overrides/<id>.json ──► deep-merged on top (env, disabled, notes)
//
// usage: node tools/sync-registry.mjs [--registry-json path-or-url]
//        default: https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json

import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const SRC = arg("--registry-json", "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json");
const agentsDir = join(root, "registry", "agents");
const overridesDir = join(root, "registry", "overrides");

const cacheFile = join(root, "data", "acp-registry.json");
const src = await (async () => {
  if (/^https?:/.test(SRC)) {
    try {
      const r = await fetch(SRC);
      if (!r.ok) throw new Error(`fetch ${SRC} → ${r.status}`);
      const j = await r.json();
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(j));
      return j;
    } catch (e) {
      if (existsSync(cacheFile)) {
        console.warn(`fetch failed (${e.message}) — using cached ${cacheFile}`);
        return JSON.parse(readFileSync(cacheFile, "utf8"));
      }
      throw e;
    }
  }
  return JSON.parse(readFileSync(resolve(SRC), "utf8"));
})();

const overrides = {};
if (existsSync(overridesDir)) {
  for (const f of readdirSync(overridesDir).filter((f) => f.endsWith(".json"))) {
    overrides[f.replace(/\.json$/, "")] = JSON.parse(readFileSync(join(overridesDir, f), "utf8"));
  }
}

function recipe(id, dist) {
  const d = dist || {};
  if (d.npx?.package) {
    return {
      install: null,
      run: ["npx", "-y", d.npx.package, ...(d.npx.args ?? [])].join(" "),
      dist: { type: "npx", package: d.npx.package, args: d.npx.args ?? [] },
    };
  }
  if (d.uvx?.package) {
    return {
      install: "node tools/install-dist.mjs " + `registry/agents/${id}.json`,
      run: ["uvx", d.uvx.package, ...(d.uvx.args ?? [])].join(" "),
      dist: { type: "uvx", package: d.uvx.package, args: d.uvx.args ?? [] },
    };
  }
  if (d.binary) {
    const platKey = `${{ darwin: "darwin", linux: "linux", win32: "windows" }[process.platform]}-${{ arm64: "aarch64", x64: "x86_64" }[process.arch]}`;
    const spec = d.binary[platKey] ?? Object.values(d.binary)[0];
    const cmd = spec?.cmd ?? `./${id}`;
    const args = spec?.args ?? [];
    return {
      install: `node tools/install-dist.mjs registry/agents/${id}.json`,
      run: [`\${REPO_ROOT}/.cache/agents/${id}/${cmd.replace(/^\.\//, "")}`, ...args].join(" "),
      dist: { type: "binary", per_platform: d.binary },
    };
  }
  return { install: null, run: null, dist: { type: "none" } };
}

mkdirSync(agentsDir, { recursive: true });
for (const f of readdirSync(agentsDir).filter((f) => f.endsWith(".json"))) rmSync(join(agentsDir, f));

let n = 0, skipped = [];
for (const a of src.agents ?? []) {
  const r = recipe(a.id, a.distribution);
  const ov = overrides[a.id] ?? {};
  if (!r.run && !ov.run) { skipped.push(a.id); continue; }
  const entry = {
    name: a.id,
    display: a.name,
    vendor: (a.authors ?? []).join(", ") || null,
    version: a.version,
    description: a.description ?? null,
    repo: a.repository?.replace(/^https:\/\/github\.com\//, "") ?? null,
    website: a.website ?? null,
    icon: a.icon ?? null,
    license: a.license ?? null,
    install: "install" in ov ? ov.install : ov.run ? null : r.install,
    run: ov.run ?? r.run,
    env: ov.env ?? {},
    sessionFiles: ov.sessionFiles ?? null,
    dist: r.dist,
    disabled: ov.disabled ?? false,
    selftest: false,
    notes: ov.notes ?? null,
    _synced: `acp-registry ${src.version} · ${new Date().toISOString().slice(0, 10)}`,
  };
  writeFileSync(join(agentsDir, `${a.id}.json`), JSON.stringify(entry, null, 2) + "\n");
  n++;
}
console.log(`synced ${n} agent entr${n === 1 ? "y" : "ies"} → registry/agents/`);
if (skipped.length) console.log(`skipped (no launch recipe): ${skipped.join(", ")}`);

// Hand-written entries (registry/*.json — not in the upstream registry) ride
// the same publish path: copy them in so CI's agents-dir enumeration sees
// them. fixture-* and _schema stay out.
let hand = 0;
for (const f of readdirSync(join(root, "registry")).filter((f) => f.endsWith(".json") && !f.startsWith("fixture-") && !f.startsWith("_"))) {
  const e = JSON.parse(readFileSync(join(root, "registry", f), "utf8"));
  writeFileSync(join(agentsDir, f), JSON.stringify({ ...e, _synced: `hand-written · ${new Date().toISOString().slice(0, 10)}` }, null, 2) + "\n");
  hand++;
}
if (hand) console.log(`carried ${hand} hand-written entr${hand === 1 ? "y" : "ies"} → registry/agents/`);
