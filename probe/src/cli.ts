#!/usr/bin/env node
import { writeFileSync, mkdirSync, readFileSync, mkdtempSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir, platform } from "node:os";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RpcPeer } from "./rpc.js";
import { makeClientStubs, type ClientCalls } from "./stubs.js";
import {
  probeInitialize, probeAuthenticate, probeSessionNew, probeSessionLoad,
  probeSessionMgmt, probeSetMode, probeSetConfig, probeSessionPrompt,
  probeCancel, probeClientCalls, probeUpdateShapes, probeMcp, probeLogout,
  probeSessionFork, probeLoadReplay, probeProviders, probeNes,
  checkAgentRequest, checkNotification, checkClientResponse, applyViolations,
  recordEnvelopeViolation,
  type ProbeContext,
} from "./probes.js";
import { buildReport, type Report } from "./report.js";
import { startMockLlm } from "./mock-llm.js";
import { ensureCa } from "./mitm.js";

const args = process.argv.slice(2);
function arg(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const has = (flag: string) => args.includes(flag);

// --entry <registry.json>: resolve cmd/name/env/sessionFiles from a registry
// entry. ${MOCK_LLM_URL} is substituted once the mock is up; ${REPO_ROOT} lets
// run cmds reference repo files even though the agent spawns in a temp cwd.
const REPO_ROOT = process.cwd();
const entryPath = arg("--entry");
const entry = entryPath
  ? (JSON.parse(readFileSync(entryPath, "utf8")) as {
      name?: string;
      run?: string;
      env?: Record<string, string>;
      sessionFiles?: Record<string, unknown>;
    })
  : undefined;
if (entry) {
  if (entry.run && !arg("--cmd")) args.push("--cmd", entry.run);
  if (entry.name && !arg("--name")) args.push("--name", entry.name);
}
// --mitm: transparent SNI proxy — model-API domains get TLS-terminated into
// the mock, everything else relays untouched. Needs no harness cooperation.
const useMitm = has("--mitm") || process.env.ACP_MITM === "1";
const needsMock =
  has("--llm") || useMitm ||
  (entry !== undefined && JSON.stringify({ env: entry.env, sessionFiles: entry.sessionFiles }).includes("${MOCK_LLM_URL}"));

const cmd = arg("--cmd") ?? "";
if (!cmd || has("--help")) {
  console.log(`acp-probe — ACP conformance probe (schema-driven)

usage:
  acp-probe --cmd "<agent command>" [options]

options:
  --cmd CMD        command that starts the agent speaking ACP on stdio
  --entry FILE     registry entry json — provides run cmd, name, env
  --mock-llm URL   substitute \${MOCK_LLM_URL} in entry env with this URL
  --name NAME      harness name for the report (default: derived from cmd)
  --out FILE       report path (default: reports/<name>.json)
  --env K=V        extra env for the agent (repeatable)
  --llm            start mock LLM; sets OPENAI_BASE_URL + ANTHROPIC_BASE_URL
  --mitm           (linux) transparent SNI proxy: model domains → mock, rest relayed
  --mitm-domains   extra impersonated hosts, comma-separated
  --transcript     also write the full transcript to <out>.transcript.jsonl
`);
  process.exit(cmd ? 0 : 1);
}

const env: NodeJS.ProcessEnv = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--env" && args[i + 1]) {
    const [k, ...v] = args[i + 1].split("=");
    env[k] = v.join("=");
  }
}
const name = arg("--name") ?? cmd.split(/\s+/).pop()!.replace(/[^\w.-]+/g, "-").replace(/\.ts$/, "");
const out = arg("--out") ?? `reports/${name}.report.json`;

// A mid-suite rejection is a data point, never a crash: the report must ship.
process.on("unhandledRejection", (e) => {
  console.error(`  [unhandled rejection swallowed: ${String(e).slice(0, 120)}]`);
});

interface MitmHandle {
  port: number;
  caCrt: string;
  logPath: string;
  child: ChildProcess;
  rules: Array<{ bin: string; args: string[] }>;
  closed: boolean;
}

const sudo = (bin: string, a: string[]) => {
  try {
    execFileSync("sudo", ["-n", bin, ...a], { stdio: ["ignore", "ignore", "pipe"] });
    return true;
  } catch {
    return false;
  }
};

/** Linux-only: spawn the SNI proxy as `nobody` (so iptables owner-match can
 * exempt its upstream connections) and REDIRECT all outbound :443 into it. */
async function setupMitm(mockPort: number): Promise<MitmHandle | null> {
  if (platform() !== "linux") {
    console.log("  [mitm] linux-only — skipped on this platform");
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), "acp-mitm-"));
  chmodSync(dir, 0o777);
  mkdirSync(join(dir, "certs"));
  chmodSync(join(dir, "certs"), 0o777);
  try {
    ensureCa(dir);
  } catch {
    console.log("  [mitm] openssl unavailable — skipped");
    return null;
  }
  chmodSync(join(dir, "ca.crt"), 0o644);
  chmodSync(join(dir, "ca.key"), 0o644);
  const logPath = join(dir, "mitm.jsonl");
  // nobody can't traverse /home/runner/work — run a copy from the 0777 dir
  const mitmJs = join(dir, "mitm.js");
  writeFileSync(mitmJs, readFileSync(fileURLToPath(new URL("./mitm.js", import.meta.url))));
  chmodSync(mitmJs, 0o755);
  const extra = arg("--mitm-domains");
  const child = spawn("sudo", [
    "-n", "-u", "nobody", process.execPath, mitmJs,
    "--mock-port", String(mockPort), "--ca-dir", dir, "--log", logPath,
    ...(extra ? ["--domains", extra] : []),
  ], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((res) => {
    let acc = "";
    const done = (p: number) => { res(p); };
    child.stdout!.on("data", (c) => {
      acc += c;
      const m = acc.match(/PORT=(\d+)/);
      if (m) done(Number(m[1]));
    });
    child.once("exit", () => done(0));
    child.once("error", () => done(0));
    setTimeout(() => done(0), 10000);
  });
  if (!port) {
    console.log("  [mitm] proxy failed to start (sudo/nobody missing?) — skipped");
    return null;
  }
  const mkRule = (dest: string) => [
    "-t", "nat", "-A", "OUTPUT", "-p", "tcp", "--dport", "443",
    "!", "-d", dest, "-m", "owner", "!", "--uid-owner", "nobody",
    "-j", "REDIRECT", "--to-ports", String(port),
  ];
  const rules: MitmHandle["rules"] = [];
  const v4 = mkRule("127.0.0.0/8");
  if (!sudo("iptables", v4)) {
    console.log("  [mitm] iptables redirect failed — skipped");
    child.kill();
    return null;
  }
  rules.push({ bin: "iptables", args: v4 });
  const v6 = mkRule("::1");
  if (sudo("ip6tables", v6)) rules.push({ bin: "ip6tables", args: v6 });
  // system CA store covers Go/Rust/OpenSSL harnesses; Node/Python get env below
  sudo("cp", [join(dir, "ca.crt"), "/usr/local/share/ca-certificates/acp-probe-mitm.crt"]);
  sudo("update-ca-certificates", []);
  console.log(`  [mitm] transparent proxy :${port} — model domains → mock :${mockPort}, rest relayed`);
  return { port, caCrt: join(dir, "ca.crt"), logPath, child, rules, closed: false };
}

function teardownMitm(m: MitmHandle | null) {
  if (!m || m.closed) return;
  m.closed = true;
  for (const r of m.rules) {
    sudo(r.bin, r.args.map((a) => (a === "-A" ? "-D" : a)));
  }
  try { m.child.kill(); } catch { /* already dead */ }
}

async function main() {
  let llm: Awaited<ReturnType<typeof startMockLlm>> | null = null;
  if (needsMock) {
    llm = await startMockLlm();
    env.OPENAI_BASE_URL = llm.url;
    env.ANTHROPIC_BASE_URL = llm.url.replace(/\/v1$/, "");
    console.log(`mock llm: ${llm.url}`);
  }
  let mitm: MitmHandle | null = null;
  if (useMitm && llm) {
    mitm = await setupMitm(Number(new URL(llm.url).port));
    if (mitm) {
      // per-runtime CA trust: every SDK family gets its own pointer
      env.NODE_EXTRA_CA_CERTS = mitm.caCrt;
      env.SSL_CERT_FILE = mitm.caCrt;
      env.REQUESTS_CA_BUNDLE = mitm.caCrt;
      env.CURL_CA_BUNDLE = mitm.caCrt;
      env.GIT_SSL_CAINFO = mitm.caCrt;
    }
  }
  process.on("exit", () => teardownMitm(mitm));
  // controlled session workspace FIRST: ${WORK_DIR} substitution in env,
  // run cmd and sessionFiles all resolve against it. The agent is spawned
  // here, session/new's cwd points here — the real repo stays untouched.
  const workDir = mkdtempSync(join(tmpdir(), "acp-probe-"));
  const mockUrl = arg("--mock-llm") ?? llm?.url ?? "";
  const subst = (s: string) =>
    s
      .replaceAll("${MOCK_LLM_URL}", mockUrl)
      .replaceAll("${REPO_ROOT}", REPO_ROOT)
      .replaceAll("${WORK_DIR}", workDir);
  for (const [k, v] of Object.entries(entry?.env ?? {})) {
    env[k] = subst(v);
  }
  const runCmd = subst(cmd);

  writeFileSync(join(workDir, "PROBE_CANARY.txt"), "CANARY-7729\n");
  mkdirSync(join(workDir, "probe-scratch", "nested"), { recursive: true });
  writeFileSync(join(workDir, "probe-scratch", "doomed.txt"), "probe scratch\n");
  for (const [rel, content] of Object.entries(entry?.sessionFiles ?? {})) {
    const p = join(workDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, subst(typeof content === "string" ? content : JSON.stringify(content, null, 2)));
  }
  console.log(`acp-probe · ${name}\n$ ${runCmd}\n  workspace: ${workDir}\n`);

  const rpc = RpcPeer.launch(runCmd, env, workDir);
  const calls: ClientCalls = {
    fsReads: [], fsWrites: [], terminalCreates: [], terminalCalls: [],
    permissionRequests: [], elicitations: [], mcpRelayCalls: [], elicitationCompletes: [],
  };
  const mcpMarker = join(workDir, ".mcp-marker.jsonl");
  const ctx: ProbeContext = {
    rpc, calls, updates: [], results: {}, violations: [], dishonesty: [],
    initResult: null,
    sessionCwd: workDir,
    askPolicy: Object.keys(entry?.sessionFiles ?? {}).length > 0,
    mcpServer: {
      name: "acp-probe-mcp",
      command: process.execPath,
      args: [join(REPO_ROOT, "probe", "dist", "fixtures", "mcp-server.js")],
      env: [{ name: "MCP_MARKER", value: mcpMarker }],
    },
    mcpMarker,
  };

  const stubs = makeClientStubs(calls);
  rpc.onRequest = async (method, params) => {
    checkAgentRequest(ctx, method, params);
    const result = await stubs(method, params);
    checkClientResponse(ctx, method, result);
    return result;
  };
  rpc.onNotify = (method, params) => {
    ctx.updates.push({ method, params });
    checkNotification(ctx, method, params);
  };
  rpc.onEnvelopeViolation = (msg) => recordEnvelopeViolation(ctx, msg);
  rpc.onExit = (code) => console.log(`  [agent exited: ${code}]`);

  const step = async (label: string, fn: () => unknown | Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      console.log(`  [${label} crashed: ${String(e).slice(0, 100)} — continuing]`);
    }
  };

  await step("initialize", () => probeInitialize(ctx));
  const alive = ctx.results["initialize"] != null && ctx.results["initialize"].status !== "fail";
  if (alive) {
    await step("authenticate", () => probeAuthenticate(ctx));
    await step("session/new", () => probeSessionNew(ctx));
    await step("session/load", () => probeSessionLoad(ctx));
    await step("session-mgmt", () => probeSessionMgmt(ctx));
    await step("set_mode", () => probeSetMode(ctx));
    await step("set_config", () => probeSetConfig(ctx));
    await step("session/prompt", () => probeSessionPrompt(ctx));
    await step("cancel", () => probeCancel(ctx));
    await step("session/fork", () => probeSessionFork(ctx));
    await step("load:replay", () => probeLoadReplay(ctx));
    await step("client-calls", () => probeClientCalls(ctx));
    await step("update-shapes", () => probeUpdateShapes(ctx));
    await step("providers", () => probeProviders(ctx));
    await step("nes", () => probeNes(ctx));
    await step("mcp", () => probeMcp(ctx));
    // logout last — it may terminate the agent/session
    await step("logout", () => probeLogout(ctx));
  }
  applyViolations(ctx);

  let transport: Report["transport"] | undefined;
  if (mitm != null) {
    const impersonated: string[] = [];
    let impersonations = 0;
    let relayed = 0;
    let drops = 0;
    try {
      for (const line of readFileSync(mitm.logPath, "utf8").split("\n")) {
        if (line.length === 0) continue;
        const rec = JSON.parse(line) as { action?: string; sni?: string };
        const action = String(rec.action ?? "");
        if (action === "impersonate") {
          impersonations += 1;
          const sni = String(rec.sni ?? "");
          if (!impersonated.includes(sni)) impersonated.push(sni);
        } else if (action === "relay") relayed += 1;
        else if (["drop", "dns-fail", "unreachable", "mint-fail"].includes(action)) drops += 1;
      }
    } catch { /* log is best effort */ }
    transport = { mitm: { port: mitm.port, impersonated, impersonations, relayed, drops } };
  }

  const report = buildReport({
    harness: name,
    initResult: ctx.initResult,
    results: ctx.results,
    dishonesty: ctx.dishonesty,
    violations: ctx.violations,
    transcript: rpc.transcript,
    transport,
  });

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
  if (has("--transcript")) {
    writeFileSync(out + ".transcript.jsonl", rpc.transcript.map((t) => JSON.stringify(t)).join("\n"));
  }
  rpc.close();
  llm?.close();
  teardownMitm(mitm);

  console.log(`\n  score ${report.score}/100 · tier ${report.tier.toUpperCase()}`);
  if (report.dishonesty.length) {
    console.log(`  ⚠ dishonesty: ${report.dishonesty.map((d) => d.claim).join(", ")}`);
  }
  if (report.violations.length) {
    console.log(`  ⚠ schema violations: ${report.violations.length}`);
  }
  console.log(`  → ${out}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exit(2);
});
