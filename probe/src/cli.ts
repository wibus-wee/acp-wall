#!/usr/bin/env node
import { writeFileSync, mkdirSync, readFileSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
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
import { buildReport } from "./report.js";
import { startMockLlm } from "./mock-llm.js";

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
const needsMock =
  has("--llm") ||
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

async function main() {
  let llm: Awaited<ReturnType<typeof startMockLlm>> | null = null;
  if (needsMock) {
    llm = await startMockLlm();
    env.OPENAI_BASE_URL = llm.url;
    env.ANTHROPIC_BASE_URL = llm.url.replace(/\/v1$/, "");
    console.log(`mock llm: ${llm.url}`);
  }
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

  const report = buildReport({
    harness: name,
    initResult: ctx.initResult,
    results: ctx.results,
    dishonesty: ctx.dishonesty,
    violations: ctx.violations,
    transcript: rpc.transcript,
  });

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
  if (has("--transcript")) {
    writeFileSync(out + ".transcript.jsonl", rpc.transcript.map((t) => JSON.stringify(t)).join("\n"));
  }
  rpc.close();
  llm?.close();

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
