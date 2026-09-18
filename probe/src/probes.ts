import { existsSync, readFileSync } from "node:fs";
import type { RpcPeer } from "./rpc.js";
import type { ClientCalls } from "./stubs.js";
import type { MockLlmEvidence } from "./mock-llm.js";
import { schema } from "./schema.js";

/**
 * Verdicts are binary by design — every method is actually invoked.
 *   pass     answered correctly (schema-valid)
 *   partial  answered but malformed, works-but-not-advertised, needs real
 *            credentials to exercise fully, or bypassed an offered client
 *            capability with internal tools
 *   fail     advertised-but-fails, required method broken, permission bypass
 *            under a configured ask policy, or the turn can't run without a
 *            real account (not CI-probeable)
 *   na       not implemented (method_not_found) or nothing happened this run
 *            to observe — a statement of fact, never a question mark
 */
export type Status = "pass" | "partial" | "fail" | "na";
export interface MethodResult {
  status: Status;
  note?: string;
  latencyMs?: number;
  /** true when an `na` verdict is itself a definitive protocol answer
   *  (the endpoint answered method_not_found) — counts toward exercised
   *  coverage, unlike "no session"/"agent never X" which mean untested. */
  definitive?: boolean;
}
export interface ViolationRec {
  where: "response" | "notification" | "request" | "client-response" | "client-request" | "envelope";
  method: string;
  path: string;
  msg: string;
}
/** Evidence for the Lody extension surface (acp-extension-core): what the
 *  agent advertised under `agentCapabilities._meta.lody`, which `_lody/*`
 *  endpoints answered, and which `_meta.lody.*` keys showed up on wire
 *  traffic. Extension stats are reported alongside the ACP cells — they are
 *  deliberately outside CELL_MAP and never touch score or tier. */
export interface LodyProbeInfo {
  /** raw `agentCapabilities._meta.lody` feature map ({} when absent). */
  advertised: Record<string, any>;
  /** `_lody/*` methods that gave any answer (ok or structured error). */
  answered: string[];
  /** `_lody/*` methods that returned method_not_found. */
  missing: string[];
  /** `_meta.lody.*` feature keys observed on agent notifications. */
  observed: string[];
}

/** Generic extension surface — vendor-agnostic evidence that an agent
 *  extends ACP. Namespaces are collected from `agentCapabilities._meta`,
 *  top-level `initialize._meta`, and `authMethods[*]._meta` (reported as
 *  `auth:<key>`); wire evidence is every `_meta.<ns>.<key>` pair seen on
 *  agent traffic. No per-vendor rules — lody is just one namespace here. */
export interface ExtSurface {
  advertised: string[];
  observed: string[];
}

export interface ProbeContext {
  rpc: RpcPeer;
  calls: ClientCalls;
  initResult: any; // initialize response
  lody?: LodyProbeInfo;
  ext?: ExtSurface;
  sessionId?: string;
  sessionModes?: any;
  sessionConfigOptions?: any;
  /** exact params sent to session/new — resume/load must replay them so
   *  agents that fingerprint sessions by creation params see a match. */
  sessionNewParams?: any;
  /** controlled workspace the session runs in (sessionFiles land here). */
  sessionCwd: string;
  /** true once we've actively configured an ask-before-act policy —
   *  only then does "agent never asked permission" become evidence. */
  askPolicy: boolean;
  /** stdio MCP fixture: command spec + marker file the fixture appends to. */
  mcpServer?: { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> };
  mcpMarker?: string;
  /** model-side evidence from the mock LLM: which tools the agent exposed and
   *  which calls it received back — absent when the probe ran without a mock. */
  mcpLlmEvidence?: MockLlmEvidence;
  /** true when session/prompt was answered but the turn is account-gated —
   *  the endpoint exists, downstream probes must not treat it as "ran". */
  promptBlocked?: boolean;
  updates: Array<{ method: string; params: any }>; // observed notifications
  results: Record<string, MethodResult>;
  violations: ViolationRec[];
  dishonesty: Array<{ claim: string; detail: string }>;
}

const REQ_TIMEOUT = 15_000;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: boolean; value?: T; err?: any; latencyMs: number }> {
  const t0 = Date.now();
  try {
    const value = await fn();
    return { ok: true, value, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, err, latencyMs: Date.now() - t0 };
  }
}
const code = (e: any) => (typeof e?.code === "number" ? e.code : undefined);
const isMissing = (e: any) => code(e) === -32601;
/** a numeric JSON-RPC error proves the method exists — the dispatcher routed
 *  the call and a handler answered, whatever its reason for refusing. Only
 *  transport failures (timeout, exit, broken pipe) prove nothing. */
const isStructured = (e: any) => typeof code(e) === "number" && !(e as any)?.timeout;
const isAuth = (e: any) =>
  /auth|401|403|permission|quota|login|unauthorized|credential/i.test(String(e?.message ?? e)) ||
  code(e) === -32001;

function put(ctx: ProbeContext, key: string, r: MethodResult) {
  ctx.results[key] = r;
  const mark = { pass: "+", partial: "±", fail: "−", na: "·" }[r.status];
  console.log(`  ${mark} ${key.padEnd(22)} ${r.status.padEnd(9)} ${r.note ?? ""}`);
}

/** schema-check an agent's response to a client→agent method; record violations. */
function checkResponse(ctx: ProbeContext, method: string, result: any) {
  const def = schema.bindings.agent.get(method)?.response;
  if (!def || result === undefined) return;
  for (const v of schema.validate(result, def)) {
    ctx.violations.push({ where: "response", method, path: v.path, msg: v.msg });
  }
}

/** schema-check OUR request params before sending (self-check catches probe bugs). */
function checkRequestParams(ctx: ProbeContext, method: string, params: any) {
  const def = schema.bindings.agent.get(method)?.request;
  if (!def) return;
  for (const v of schema.validate(params ?? {}, def)) {
    ctx.violations.push({ where: "client-request", method, path: v.path, msg: v.msg });
  }
}

/** send a client→agent request: validate outbound params, then the response. */
async function callAgent(ctx: ProbeContext, method: string, params: any, timeout = REQ_TIMEOUT) {
  checkRequestParams(ctx, method, params);
  const r = await timed(() => ctx.rpc.request(method, params, timeout));
  if (r.ok) checkResponse(ctx, method, r.value);
  return r;
}

/** schema-check an agent→client request's params (called by the onRequest wrapper). */
export function checkAgentRequest(ctx: ProbeContext, method: string, params: any) {
  const b = schema.bindings.client.get(method);
  if (!b?.request) {
    ctx.violations.push({ where: "request", method, path: "", msg: `no schema binding for ${method}` });
    return;
  }
  for (const v of schema.validate(params ?? {}, b.request)) {
    ctx.violations.push({ where: "request", method, path: v.path, msg: v.msg });
  }
}

/** schema-check a notification from the agent (e.g. session/update). */
export function checkNotification(ctx: ProbeContext, method: string, params: any) {
  const b = schema.bindings.client.get(method);
  if (!b?.request) return; // unknown/ext notification — not a violation per se
  for (const v of schema.validate(params ?? {}, b.request)) {
    ctx.violations.push({ where: "notification", method, path: v.path, msg: v.msg });
  }
}

/** schema-check OUR response back to the agent (self-check). */
export function checkClientResponse(ctx: ProbeContext, method: string, result: any) {
  const def = schema.bindings.client.get(method)?.response;
  if (!def || result === undefined) return;
  for (const v of schema.validate(result, def)) {
    ctx.violations.push({ where: "client-response", method, path: v.path, msg: v.msg });
  }
}

/** record a JSON-RPC envelope violation reported by the peer. */
export function recordEnvelopeViolation(ctx: ProbeContext, msg: string) {
  ctx.violations.push({ where: "envelope", method: "-", path: "", msg });
}

/** map a method (or update kind) to the result key it affects. */
function resultKeyFor(method: string, updateKind?: string): string | null {
  const direct: Record<string, string> = {
    initialize: "initialize",
    authenticate: "authenticate",
    logout: "logout",
    "session/new": "session/new",
    "session/load": "session/load",
    "session/prompt": "session/prompt",
    "session/cancel": "cancel",
    "session/list": "session/list",
    "session/resume": "session/resume",
    "session/close": "session/close",
    "session/delete": "session/delete",
    "session/set_mode": "set_mode",
    "session/set_config_option": "set_config",
    "fs/read_text_file": "fs/read_text_file",
    "fs/write_text_file": "fs/write_text_file",
    "session/request_permission": "request_permission",
    "elicitation/create": "elicitation",
    "elicitation/complete": "elicitation",
  };
  if (direct[method]) return direct[method];
  if (method.startsWith("terminal/")) return "terminal/*";
  if (method === "session/update") {
    const m: Record<string, string> = {
      agent_message_chunk: "update:message",
      agent_thought_chunk: "update:message",
      tool_call: "update:tool_call",
      tool_call_update: "update:tool_call",
      plan: "update:plan",
      available_commands_update: "update:commands",
    };
    return m[updateKind ?? ""] ?? "update:message";
  }
  return null;
}

/** After all probes: any schema violation downgrades its method pass→partial. */
export function applyViolations(ctx: ProbeContext) {
  for (const v of ctx.violations) {
    const key = resultKeyFor(v.method);
    if (!key) continue;
    const r = ctx.results[key];
    if (r && r.status === "pass") {
      r.status = "partial";
      r.note = `${r.note ? r.note + " · " : ""}schema: ${v.path || "(root)"} ${v.msg}`.slice(0, 120);
    }
  }
}

const updatesOf = (ctx: ProbeContext, kind: string) =>
  ctx.updates.filter((u) => u.method === "session/update" && u.params?.update?.sessionUpdate === kind);

const toolCallsOfKind = (ctx: ProbeContext, kinds: string[]) =>
  updatesOf(ctx, "tool_call").filter((u) => kinds.includes(u.params?.update?.kind)).length;

/** Did a prompt turn complete (vs. blocked/never run)? */
const promptDone = (ctx: ProbeContext) =>
  !ctx.promptBlocked &&
  ["pass", "partial"].includes(ctx.results["session/prompt"]?.status ?? "");

/* ------------------------------------------------------------------ */

export async function probeInitialize(ctx: ProbeContext) {
  // generous timeout: this call absorbs cold-start cost (npx install, model
  // provider warmup). Later calls keep the tighter REQ_TIMEOUT.
  const r = await callAgent(
    ctx,
    "initialize",
    {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: "acp-probe", title: "ACP Probe", version: "0.1.0" },
    },
    90_000
  );
  if (!r.ok) {
    put(ctx, "initialize", isStructured(r.err)
      ? { status: "pass", note: `endpoint exists — returned error: ${String(r.err?.message ?? r.err).slice(0, 80)}`, latencyMs: r.latencyMs }
      : { status: "fail", note: `no valid response: ${String(r.err?.message ?? r.err)}`, latencyMs: r.latencyMs });
    return false;
  }
  const res: any = r.value;
  ctx.initResult = res;
  const problems: string[] = [];
  if (typeof res?.protocolVersion !== "number") problems.push("missing protocolVersion");
  if (!res?.agentCapabilities || typeof res.agentCapabilities !== "object") problems.push("missing agentCapabilities");
  if (!res?.agentInfo?.name) problems.push("missing agentInfo.name");
  if (problems.length) {
    put(ctx, "initialize", { status: "partial", note: problems.join("; "), latencyMs: r.latencyMs });
  } else {
    put(ctx, "initialize", { status: "pass", note: `v${res.protocolVersion} · ${res.agentInfo.name}${res.agentInfo.version ? " " + res.agentInfo.version : ""}`, latencyMs: r.latencyMs });
  }
  return true;
}

/** authenticate is always invoked — an auth error still proves the endpoint
 *  exists; method_not_found means it doesn't. */
export async function probeAuthenticate(ctx: ProbeContext) {
  const methods = ctx.initResult?.authMethods;
  const advertised = Array.isArray(methods) && methods.length > 0;
  const methodId = advertised ? (methods[0]?.id ?? methods[0]) : "acp-probe-noauth";
  const r = await callAgent(ctx, "authenticate", { methodId });
  if (!r.ok) {
    if (isMissing(r.err)) {
      if (advertised) {
        ctx.dishonesty.push({ claim: "authMethods", detail: "advertised but authenticate → method_not_found" });
        put(ctx, "authenticate", { status: "fail", note: "authMethods advertised but method absent", latencyMs: r.latencyMs });
      } else {
        put(ctx, "authenticate", { status: "fail", note: "not implemented", definitive: true, latencyMs: r.latencyMs });
      }
      return;
    }
    const msg = String(r.err?.message ?? r.err);
    put(ctx, "authenticate", isStructured(r.err)
      ? { status: "pass", note: advertised ? `endpoint exists — returned error: ${msg.slice(0, 70)}` : `rejects unknown methodId (endpoint exists): ${msg.slice(0, 60)}`, latencyMs: r.latencyMs }
      : { status: "fail", note: `no valid response: ${msg.slice(0, 80)}`, latencyMs: r.latencyMs });
    return;
  }
  put(ctx, "authenticate", { status: "pass", note: `methodId=${methodId}`, latencyMs: r.latencyMs });
}

export async function probeSessionNew(ctx: ProbeContext) {
  const params: any = { cwd: ctx.sessionCwd, mcpServers: [] };
  if (ctx.mcpServer) params.mcpServers = [ctx.mcpServer];
  ctx.sessionNewParams = params;
  const r = await callAgent(ctx, "session/new", params);
  if (!r.ok) {
    const msg = String(r.err?.message ?? r.err);
    put(ctx, "session/new", isStructured(r.err)
      ? { status: "pass", note: `endpoint exists — ${isAuth(r.err) ? "account-gated" : "returned error"}: ${msg.slice(0, 70)}`, latencyMs: r.latencyMs }
      : { status: "fail", note: `no valid response: ${msg.slice(0, 80)}`, latencyMs: r.latencyMs });
    return;
  }
  const sid = r.value?.sessionId;
  ctx.sessionModes = r.value?.modes;
  ctx.sessionConfigOptions = r.value?.configOptions;
  if (typeof sid === "string" && sid) {
    ctx.sessionId = sid;
    put(ctx, "session/new", { status: "pass", note: `sessionId=${sid.slice(0, 12)}`, latencyMs: r.latencyMs });
  } else {
    put(ctx, "session/new", { status: "partial", note: "response missing sessionId", latencyMs: r.latencyMs });
  }
}

/** capability flags come in two shapes: true, or {} carrying option details. */
const capOn = (caps: any, flag: string) => {
  const v = caps?.[flag];
  return v === true || (typeof v === "object" && v !== null);
};

/** Shared verdict for an always-invoked optional method: call it, then judge. */
function verdictAlways(
  ctx: ProbeContext,
  key: string,
  r: Awaited<ReturnType<typeof callAgent>>,
  advertised: boolean,
  claim: string,
  passNote?: string
) {
  if (!r.ok) {
    if (isMissing(r.err)) {
      if (advertised) {
        ctx.dishonesty.push({ claim, detail: `advertised but ${key} → method_not_found` });
        put(ctx, key, { status: "fail", note: "advertised but method_not_found", latencyMs: r.latencyMs });
      } else {
        put(ctx, key, { status: "fail", note: "not implemented", definitive: true, latencyMs: r.latencyMs });
      }
      return;
    }
    const msg = String(r.err?.message ?? r.err);
    // Any structured JSON-RPC error is a conforming answer: the dispatcher
    // routed the call and a handler refused it for its own reason — unknown
    // session, account gate, internal state. That proves the endpoint EXISTS;
    // whether it also *works* is the agent's business, not protocol support.
    // Only a transport failure (timeout, exit, malformed reply) proves
    // nothing.
    if (!isStructured(r.err)) {
      put(ctx, key, { status: "fail", note: `no valid response: ${msg.slice(0, 80)}`, latencyMs: r.latencyMs });
      return;
    }
    const flavor = code(r.err) === -32602 || /(unknown|not found|invalid).{0,30}session|session.{0,30}(unknown|not found)/i.test(msg)
      ? "rejects unknown session"
      : isAuth(r.err) ? "account-gated" : "returned error";
    put(ctx, key, { status: "pass", note: `endpoint exists — ${flavor}: ${msg.slice(0, 70)}`, latencyMs: r.latencyMs });
    return;
  }
  put(ctx, key, {
    status: "pass",
    note: advertised ? passNote : "works but not advertised",
    latencyMs: r.latencyMs,
  });
}

export async function probeSessionLoad(ctx: ProbeContext) {
  const advertised = ctx.initResult?.agentCapabilities?.loadSession === true;
  const r = await callAgent(ctx, "session/load", {
    cwd: ctx.sessionCwd,
    sessionId: ctx.sessionId ?? "probe-session",
    mcpServers: ctx.sessionNewParams?.mcpServers ?? [],
  });
  verdictAlways(ctx, "session/load", r, advertised, "loadSession");
}

/** session/{list,resume,close,delete} — gated by sessionCapabilities for the
 *  dishonesty flag, but always invoked. Destructive ops run on a disposable
 *  session so the working session survives. */
export async function probeSessionMgmt(ctx: ProbeContext) {
  const caps = ctx.initResult?.agentCapabilities?.sessionCapabilities ?? {};
  const probe = async (key: string, method: string, flag: string, params: (sid: string) => any) => {
    const r = await callAgent(ctx, method, params(ctx.sessionId ?? "probe-session"));
    verdictAlways(ctx, key, r, capOn(caps, flag), `sessionCapabilities.${flag}`);
  };
  await probe("session/list", "session/list", "list", () => ({}));
  // resume must replay the creation params verbatim: agents that fingerprint a
  // live session by (cwd, mcpServers) treat a mismatch as "recreate me", which
  // tears down the only session we have — a zero-turn session then can't resume
  // and every later op answers Session not found.
  await probe("session/resume", "session/resume", "resume", (sid) => ({ sessionId: sid, cwd: ctx.sessionCwd, mcpServers: ctx.sessionNewParams?.mcpServers ?? [] }));
  let disposable = ctx.sessionId ?? "probe-session";
  const extra = await callAgent(ctx, "session/new", { cwd: ctx.sessionCwd, mcpServers: [] });
  if (extra.ok && extra.value?.sessionId) disposable = extra.value.sessionId;
  await probe("session/close", "session/close", "close", () => ({ sessionId: disposable }));
  await probe("session/delete", "session/delete", "delete", () => ({ sessionId: disposable }));
}

export async function probeSetMode(ctx: ProbeContext) {
  const modes = ctx.sessionModes?.availableModes;
  const advertised = Array.isArray(modes) && modes.length > 0;
  const label = (m: any) => `${m?.id ?? m} ${m?.name ?? ""}`;
  // prefer an ask-before-act mode: it arms the permission probe too.
  // word boundaries — "model" contains "mode", "preview" contains "review".
  const askish = advertised
    ? modes.find((m: any) => /\b(ask|confirm|manual|review|approve|permission)\b/i.test(label(m)))
    : undefined;
  const current = ctx.sessionModes?.currentModeId;
  const target = askish ?? (advertised ? modes.find((m: any) => (m.id ?? m) !== current) ?? modes[0] : undefined);
  const modeId = target?.id ?? target ?? "probe-nonexistent-mode";
  const r = await callAgent(ctx, "session/set_mode", { sessionId: ctx.sessionId ?? "probe-session", modeId });
  verdictAlways(ctx, "set_mode", r, advertised, "session modes", `modeId=${modeId}`);
  if (r.ok && askish) ctx.askPolicy = true;
}

export async function probeSetConfig(ctx: ProbeContext) {
  const opts = ctx.sessionConfigOptions;
  const advertised = Array.isArray(opts) && opts.length > 0;
  const optLabel = (o: any) => `${o?.id ?? ""} ${o?.name ?? ""} ${o?.category ?? ""}`;
  const optVal = (v: any) => `${v?.value ?? v} ${v?.name ?? ""}`;
  const modeish = advertised
    ? opts.find((o: any) => /\b(mode|permission|approval|access|autonomy)\b/i.test(optLabel(o)))
    : undefined;
  const opt = modeish ?? opts?.[0];
  const askishVal = Array.isArray(opt?.options)
    ? opt.options.find((v: any) => /\b(ask|manual|review|confirm|approve|permission)\b/i.test(optVal(v)))
    : undefined;
  const params: any = { sessionId: ctx.sessionId ?? "probe-session", configId: opt?.id ?? "probe-nonexistent-config" };
  if (opt?.type === "boolean") {
    params.type = "boolean";
    params.value = !(opt.currentValue === true);
  } else if (opt) {
    params.value = askishVal?.value ?? askishVal ?? opt.options?.[0]?.value ?? opt.options?.[0] ?? opt.currentValue;
  } else {
    params.value = "probe";
  }
  const r = await callAgent(ctx, "session/set_config_option", params);
  verdictAlways(ctx, "set_config", r, advertised, "session configOptions", opt ? `configId=${opt.id}=${params.value}` : undefined);
  if (r.ok && askishVal) ctx.askPolicy = true;
}

const PROMPTS = [
  "__probe__ use your tools — run a shell command",
  "__probe__ use your tools — read PROBE_CANARY.txt",
  "__probe__ use your tools — write a file probe-out.txt",
];

/** Three sequential turns: the mock LLM rotates which tool it invokes, giving
 *  coverage of bash/read/write paths and their client-side calls. An
 *  account-gated turn is PARTIAL — the endpoint demonstrably exists (it gave
 *  a domain answer, not method_not_found); only the credentials are missing.
 *  The wall measures protocol support, not someone's subscription. */
export async function probeSessionPrompt(ctx: ProbeContext) {
  if (!ctx.sessionId) {
    // never got a session — prompt is untested, not missing. The failure is
    // already recorded on session/new; double-counting it here is a false
    // "doesn't implement prompt" signal.
    put(ctx, "session/prompt", { status: "na", note: "no session — prompt untested" });
    return;
  }
  let first: Awaited<ReturnType<typeof callAgent>> | null = null;
  let ran = 0;
  let firstErr: any = null;
  for (let i = 0; i < PROMPTS.length; i++) {
    const r = await callAgent(
      ctx,
      "session/prompt",
      { sessionId: ctx.sessionId, prompt: [{ type: "text", text: PROMPTS[i] }] },
      30_000
    );
    if (!r.ok) {
      if (i === 0) firstErr = r;
      break;
    }
    ran++;
    first ??= r;
  }
  if (!first) {
    const e = firstErr?.err;
    if (isStructured(e)) {
      // a structured error is a conforming answer — the endpoint exists and a
      // handler refused the turn (account gate, model config, internal state).
      // The turn didn't run, so downstream probes must not assume it did.
      ctx.promptBlocked = true;
      put(ctx, "session/prompt", {
        status: "pass",
        note: `endpoint exists — turn ${isAuth(e) ? "blocked by account gate" : "errored"}: ${String(e?.message ?? e).slice(0, 90)}`,
        latencyMs: firstErr?.latencyMs,
      });
    } else {
      put(ctx, "session/prompt", {
        status: "fail",
        note: `no valid response: ${String(e?.message ?? e ?? "prompt failed")}`,
        latencyMs: firstErr?.latencyMs,
      });
    }
    return;
  }
  const stop = first.value?.stopReason;
  const canary = ctx.updates.some(
    (u) => u.method === "session/update" && JSON.stringify(u.params).includes("CANARY_ACK")
  );
  const base = `${ran}/${PROMPTS.length} turns · stopReason=${stop}${canary ? " · canary round-trip verified" : ""}`;
  if (typeof stop !== "string" || !stop) {
    put(ctx, "session/prompt", { status: "partial", note: `missing stopReason · ${base}`, latencyMs: first.latencyMs });
  } else {
    put(ctx, "session/prompt", { status: "pass", note: base, latencyMs: first.latencyMs });
  }
}

export async function probeCancel(ctx: ProbeContext) {
  if (!ctx.sessionId) {
    put(ctx, "cancel", { status: "na", note: "no sessionId" });
    return;
  }
  // a turn that cannot start has nothing to cancel — auth/quota-blocked
  // prompt makes cancel untestable, not absent
  if (ctx.promptBlocked || ctx.results["session/prompt"]?.status === "fail") {
    put(ctx, "cancel", { status: "na", note: "no turn to cancel" });
    return;
  }
  // __probe_slow__ makes the mock hold its response ~8s so the cancel lands
  // mid-turn. callAgent attaches handlers immediately — no rejection window.
  const p = callAgent(
    ctx,
    "session/prompt",
    { sessionId: ctx.sessionId, prompt: [{ type: "text", text: "__probe_slow__ hold this turn open" }] },
    25_000
  );
  await wait(400);
  // outbound notifications get the same self-check as requests — a malformed
  // cancel must surface as our bug, not silently pass through
  checkRequestParams(ctx, "session/cancel", { sessionId: ctx.sessionId });
  ctx.rpc.notify("session/cancel", { sessionId: ctx.sessionId });
  const r = await p;
  if (!r.ok) {
    // the setup prompt never produced a turn — nothing was provably in-flight
    // for cancel to interrupt, so the verdict is untestable either way
    put(ctx, "cancel", {
      status: "na",
      note: `no turn to cancel — prompt errored: ${String(r.err?.message ?? r.err).slice(0, 90)}`,
      latencyMs: r.latencyMs,
    });
    return;
  }
  const stop = r.value?.stopReason;
  if (stop === "cancelled") {
    put(ctx, "cancel", { status: "pass", note: `cancelled in ${r.latencyMs}ms`, latencyMs: r.latencyMs });
  } else if ((r.latencyMs ?? 0) < 1000) {
    // turn ended before the ~400ms cancel could land — nothing was provably
    // in-flight to cancel, so "not honored" can't be distinguished from "too fast"
    put(ctx, "cancel", { status: "na", note: `turn ended stopReason=${stop} in ${r.latencyMs}ms — before cancel could land`, latencyMs: r.latencyMs });
  } else {
    put(ctx, "cancel", { status: "fail", note: `turn ended stopReason=${stop} after ${r.latencyMs}ms — cancel not honored`, latencyMs: r.latencyMs });
  }
}

/** Reverse-direction probes: evaluate what the agent called on the client.
 *  fs/terminal are CLIENT capabilities — an agent with internal tools may
 *  legally bypass them; that gets a factual partial note, not a question mark.
 *  permission is different: bypassing an ask policy is a fail. */
export function probeClientCalls(ctx: ProbeContext) {
  const { calls } = ctx;
  const fileOps = toolCallsOfKind(ctx, ["read", "edit", "delete", "move", "search"]);
  const execOps = toolCallsOfKind(ctx, ["execute"]);
  const permWorthy = toolCallsOfKind(ctx, ["execute", "edit", "delete", "move"]);

  if (calls.fsReads.length > 0) {
    const abs = calls.fsReads.every((c) => typeof c.path === "string" && c.path.startsWith("/"));
    put(ctx, "fs/read_text_file", { status: abs ? "pass" : "partial", note: `${calls.fsReads.length} call(s)${abs ? "" : " · non-absolute path!"}` });
  } else if (fileOps > 0) {
    put(ctx, "fs/read_text_file", { status: "partial", note: `bypassed client fs — ran ${fileOps} file op(s) internally` });
  } else {
    put(ctx, "fs/read_text_file", { status: "na", note: "agent never delegated a file read" });
  }
  if (calls.fsWrites.length > 0) {
    const abs = calls.fsWrites.every((c) => typeof c.path === "string" && c.path.startsWith("/"));
    put(ctx, "fs/write_text_file", { status: abs ? "pass" : "partial", note: `${calls.fsWrites.length} call(s)` });
  } else if (fileOps > 0) {
    put(ctx, "fs/write_text_file", { status: "partial", note: "no client-side write observed; internal tools used" });
  } else {
    put(ctx, "fs/write_text_file", { status: "na", note: "agent never delegated a file write" });
  }
  if (calls.terminalCreates.length > 0) {
    const sawOutput = calls.terminalCalls.some((c) => c.method === "terminal/output" || c.method === "terminal/wait_for_exit");
    put(ctx, "terminal/*", { status: sawOutput ? "pass" : "partial", note: `create×${calls.terminalCreates.length} lifecycle×${calls.terminalCalls.length}` });
  } else if (execOps > 0) {
    put(ctx, "terminal/*", { status: "partial", note: `bypassed client terminal — ran ${execOps} exec tool call(s) internally` });
  } else {
    put(ctx, "terminal/*", { status: "na", note: "agent never used a client terminal" });
  }
  if (calls.permissionRequests.length > 0) {
    put(ctx, "request_permission", { status: "pass", note: `${calls.permissionRequests.length} request(s)` });
  } else if (ctx.askPolicy && permWorthy > 0) {
    put(ctx, "request_permission", {
      status: "fail",
      note: `ran ${permWorthy} permission-worthy tool call(s) without session/request_permission despite ask policy`,
    });
  } else if (ctx.askPolicy) {
    put(ctx, "request_permission", { status: "na", note: "ask policy set but no permission-worthy tool ran" });
  } else {
    put(ctx, "request_permission", { status: "na", note: "agent never asked; no ask policy configured" });
  }
  if (calls.elicitations.length > 0) {
    put(ctx, "elicitation", { status: "pass", note: `${calls.elicitations.length} elicitation(s)` });
  } else {
    put(ctx, "elicitation", { status: "na", note: "agent never elicited" });
  }
}

/** session/fork — fork the working session; a conformant implementation hands
 *  back a NEW independent sessionId. Forking after the turn means the fork
 *  carries real conversation history. */
export async function probeSessionFork(ctx: ProbeContext) {
  const caps = ctx.initResult?.agentCapabilities?.sessionCapabilities ?? {};
  const advertised = capOn(caps, "fork");
  if (!ctx.sessionId) {
    put(ctx, "session/fork", { status: "na", note: "no session to fork" });
    return;
  }
  const r = await callAgent(ctx, "session/fork", {
    sessionId: ctx.sessionId,
    cwd: ctx.sessionCwd,
    mcpServers: ctx.sessionNewParams?.mcpServers ?? [],
  });
  verdictAlways(ctx, "session/fork", r, advertised, "sessionCapabilities.fork");
  if (r.ok && r.value?.sessionId === ctx.sessionId) {
    put(ctx, "session/fork", { status: "partial", note: "returned the SAME sessionId — not a real fork", latencyMs: r.latencyMs });
  }
}

/** session/load (or /resume) replay: loading a session is supposed to replay
 *  its durable conversation as session/update notifications — this is what
 *  separates a real session store from a stub that returns ok and loses state. */
export async function probeLoadReplay(ctx: ProbeContext) {
  const priorLoad = ctx.results["session/load"];
  const priorResume = ctx.results["session/resume"];
  const method = priorLoad && priorLoad.status !== "na" ? "session/load"
    : priorResume && priorResume.status !== "na" ? "session/resume" : null;
  if (!ctx.sessionId || !method) {
    put(ctx, "load:replay", { status: "na", note: "no loadable session" });
    return;
  }
  const before = ctx.updates.length;
  const r = await callAgent(ctx, method, {
    sessionId: ctx.sessionId,
    cwd: ctx.sessionCwd,
    mcpServers: ctx.sessionNewParams?.mcpServers ?? [],
  });
  if (!r.ok) {
    put(ctx, "load:replay", { status: "na", note: `${method} errored: ${String(r.err?.message ?? r.err).slice(0, 60)}` });
    return;
  }
  const replayed = ctx.updates.slice(before).filter((u) => u.method === "session/update");
  const kinds = [...new Set(replayed.map((u) => u.params?.update?.sessionUpdate))].filter(Boolean);
  if (replayed.length > 0) {
    put(ctx, "load:replay", { status: "pass", note: `${replayed.length} replayed update(s): ${kinds.join(", ")}` });
  } else {
    // A zero-history session has nothing to replay — silence is unprovable,
    // not non-conforming. Only when the turn actually produced history does an
    // empty replay show a real gap.
    const hadHistory = ctx.updates.slice(0, before).some((u) => u.method === "session/update" && u.params?.sessionId === ctx.sessionId);
    put(ctx, "load:replay", hadHistory
      ? { status: "partial", note: `${method} succeeded but replayed no conversation` }
      : { status: "na", note: `${method} ok — no history to replay` });
  }
}

/** providers/list|set|disable — UNSTABLE surface (agentCapabilities.providers).
 *  set/disable run against a probe-owned providerId so they cannot disturb the
 *  real provider routing; they still prove the endpoint exists. */
export async function probeProviders(ctx: ProbeContext) {
  const results: string[] = [];
  const list = await callAgent(ctx, "providers/list", {});
  if (!list.ok && isMissing(list.err)) {
    put(ctx, "providers", { status: "fail", note: "not implemented", definitive: true, latencyMs: list.latencyMs });
    return;
  }
  results.push(list.ok ? `list→${Array.isArray(list.value?.providers) ? list.value.providers.length : "?"} providers` : `list errored`);
  const set = await callAgent(ctx, "providers/set", { providerId: "acp-probe", apiType: "openai", baseUrl: "http://127.0.0.1:9/v1" });
  results.push(set.ok ? "set ok" : `set: ${String(set.err?.message ?? set.err).slice(0, 40)}`);
  const disable = await callAgent(ctx, "providers/disable", { providerId: "acp-probe" });
  results.push(disable.ok ? "disable ok" : `disable: ${String(disable.err?.message ?? disable.err).slice(0, 40)}`);
  const allMissing = [set, disable].every((x) => !x.ok && isMissing(x.err)) && !list.ok;
  const anyAnswer = [list, set, disable].some((x) => x.ok || isStructured(x.err));
  if (allMissing) {
    put(ctx, "providers", { status: "fail", note: "not implemented", definitive: true });
  } else {
    const allOk = [list, set, disable].every((x) => x.ok);
    put(ctx, "providers", { status: anyAnswer ? "pass" : "fail", note: `${anyAnswer ? (allOk ? "" : "endpoint exists — ") : "no valid response — "}${results.join(" · ")}` });
  }
}

/** nes/* — UNSTABLE Next-Edit-Suggestions surface. nes/start + nes/suggest are
 *  the two meaningful request endpoints; accept/reject are notifications. */
export async function probeNes(ctx: ProbeContext) {
  const start = await callAgent(ctx, "nes/start", { workspaceUri: `file://${ctx.sessionCwd}` });
  if (!start.ok && isMissing(start.err)) {
    put(ctx, "nes", { status: "fail", note: "not implemented", definitive: true, latencyMs: start.latencyMs });
    return;
  }
  const suggest = await callAgent(ctx, "nes/suggest", {
    sessionId: ctx.sessionId ?? "probe-session",
    uri: `file://${ctx.sessionCwd}/PROBE_CANARY.txt`,
    version: 1,
    position: { line: 0, character: 0 },
    triggerKind: "manual",
  });
  const note = `start ${start.ok ? "ok" : String(start.err?.message ?? start.err).slice(0, 40)} · suggest ${suggest.ok ? "ok" : String(suggest.err?.message ?? suggest.err).slice(0, 40)}`;
  const anyAnswer = start.ok || suggest.ok || isStructured(start.err) || isStructured(suggest.err);
  put(ctx, "nes", {
    status: anyAnswer ? "pass" : "fail",
    note: (anyAnswer && !(start.ok && suggest.ok) ? "endpoint exists — " : "") + note,
  });
}

/** Notification-shape probes: what session/update variants were observed. */
export function probeUpdateShapes(ctx: ProbeContext) {
  const chunks = updatesOf(ctx, "agent_message_chunk").length + updatesOf(ctx, "agent_thought_chunk").length;
  const tools = updatesOf(ctx, "tool_call").length + updatesOf(ctx, "tool_call_update").length;
  const plans = updatesOf(ctx, "plan").length + updatesOf(ctx, "plan_update").length + updatesOf(ctx, "plan_removed").length;
  const cmds = updatesOf(ctx, "available_commands_update").length;
  const usage = updatesOf(ctx, "usage_update").length;

  // a missing-chunk fail requires a turn that actually COMPLETED —
  // cancelled/blocked turns never had the chance to stream
  put(ctx, "update:message", {
    status: chunks > 0 ? "pass" : promptDone(ctx) ? "fail" : "na",
    note: chunks ? `${chunks} chunk(s)` : promptDone(ctx) ? "turn completed but no agent_message_chunk" : "no completed turn",
  });
  put(ctx, "update:tool_call", { status: tools > 0 ? "pass" : "na", note: tools ? `${tools} update(s)` : "no tool calls this run" });
  put(ctx, "update:plan", { status: plans > 0 ? "pass" : "na", note: plans ? `${plans}` : "none emitted" });
  put(ctx, "update:commands", { status: cmds > 0 ? "pass" : "na", note: cmds ? `${cmds}` : "none emitted" });
  put(ctx, "update:usage", { status: usage > 0 ? "pass" : "na", note: usage ? `${usage}` : "none emitted" });
}

/** MCP: the probe's stdio fixture server is passed via mcpServers in
 *  session/new. The fixture marks every protocol step it observes, so the
 *  cell grades an evidence ladder, not a boolean:
 *    tools/call    full client→agent→MCP→tool→result chain          → pass
 *    tools/list    connect + discovery — protocol duties proven,
 *                  invocation unexercised                           → pass
 *                  (but partial when the mock proves the tool was
 *                  exposed to the model and the call never arrived,
 *                  or the tool was discovered yet never exposed)
 *    initialize    transport handshake only, tools never discovered → partial
 *    spawned       process launched, handshake never completed      → partial
 *    nothing       never touched — lazy connect is spec-legal, so   → na
 *                  "didn't" can't be distinguished from "can't"
 */
export async function probeMcp(ctx: ProbeContext) {
  if (!ctx.mcpMarker) {
    put(ctx, "mcp", { status: "na", note: "no fixture configured" });
    return;
  }
  await wait(2000); // give the agent a moment to spawn + handshake
  const events = existsSync(ctx.mcpMarker)
    ? readFileSync(ctx.mcpMarker, "utf8").trim().split("\n").map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean) as Array<{ event: string; name?: string; method?: string }>
    : [];
  const names = new Set(events.map((e) => e.event));
  const caps = ctx.initResult?.agentCapabilities?.mcpCapabilities ?? {};
  const capNote = [
    caps.http && "http",
    caps.sse && "sse",
    caps.acp && "acp-relay",
  ].filter(Boolean).join("+") || "no mcpCapabilities";
  // MCP-over-ACP: agents advertising mcpCapabilities.acp take mcp/message
  // themselves; agents may also relay THROUGH the client (mcp/connect|message).
  const relay = ctx.calls.mcpRelayCalls.length > 0 ? ` · client relay ×${ctx.calls.mcpRelayCalls.length}` : "";
  // odd traffic is worth surfacing: methods the fixture doesn't model
  const unexpected = [...new Set(events.filter((e) => e.event === "other").map((e) => e.method).filter(Boolean))];
  const extra = unexpected.length ? ` · unexpected methods: ${unexpected.join(",")}` : "";

  const called = events.filter((e) => e.event === "tools/call").map((e) => e.name).filter(Boolean) as string[];
  const llm = ctx.mcpLlmEvidence;
  const isFixtureTool = (n: string) => /probe_noop/i.test(n);
  const issuedFixtureCall = llm?.issuedCalls.some((c) => isFixtureTool(c.name)) ?? false;
  // undefined = no model-side evidence (no mock, or agent never sent tools);
  // false = tools were offered but the fixture tool was never among them
  const offeredToModel = llm && llm.seenTools.size > 0 ? [...llm.seenTools].some(isFixtureTool) : undefined;

  if (called.length > 0) {
    const alien = called.filter((n) => !isFixtureTool(n));
    put(ctx, "mcp", {
      status: "pass",
      note: `stdio handshake + tool call${alien.length ? ` (unexpected: ${alien.join(",")})` : ""} · ${capNote}${relay}${extra}`,
    });
  } else if (issuedFixtureCall) {
    // the model invoked it — the call died between model and MCP server
    put(ctx, "mcp", { status: "partial", note: `model called fixture tool — call never reached server · ${capNote}${relay}${extra}` });
  } else if (names.has("tools/list")) {
    if (offeredToModel === false) {
      put(ctx, "mcp", { status: "partial", note: `handshake + discovery ok — fixture tool never exposed to model · ${capNote}${relay}${extra}` });
    } else {
      put(ctx, "mcp", { status: "pass", note: `stdio handshake + tool discovery · call unexercised · ${capNote}${relay}${extra}` });
    }
  } else if (names.has("initialize") || names.has("initialized")) {
    put(ctx, "mcp", { status: "partial", note: `stdio handshake only — tools never discovered · ${capNote}${relay}${extra}` });
  } else if (names.has("spawned")) {
    put(ctx, "mcp", { status: "partial", note: `fixture spawned but never initialized · ${capNote}${relay}${extra}` });
  } else if (ctx.calls.mcpRelayCalls.length > 0) {
    put(ctx, "mcp", { status: "partial", note: `no stdio fixture use; client relay ×${ctx.calls.mcpRelayCalls.length} · ${capNote}` });
  } else {
    put(ctx, "mcp", { status: "na", note: `agent never touched the stdio fixture · ${capNote}` });
  }
}

/** Lody extension surface (github.com/LodyAI/acp-extension-core). The contract
 *  advertises optional features under `agentCapabilities._meta.lody` and keeps
 *  custom traffic in the `_lody/*` namespace for what standard ACP cannot
 *  carry. The probe reads the advertisement, then knocks on the read-only
 *  `_lody/*` endpoints — a `method_not_found` means unspoken, any domain
 *  answer (even "unknown session") proves the endpoint is wired. Session-scoped
 *  calls get the working sessionId like every other probe; on a fresh probe
 *  session `goal: pause` has no goal to touch, so it stays read-only in
 *  practice. `steer`/`subagents/cancel`/`subagents/output` are skipped — they
 *  mutate or need live task ids, and "exists" evidence isn't worth a
 *  side-effecting call. */
export async function probeLody(ctx: ProbeContext) {
  const advertised =
    (ctx.initResult?.agentCapabilities?._meta?.lody as Record<string, any> | undefined) ?? {};
  const feats = Object.keys(advertised);
  const info: LodyProbeInfo = { advertised, answered: [], missing: [], observed: [] };
  ctx.lody = info;

  // Generic extension surface — every _meta namespace, not only lody.
  const capMeta = ctx.initResult?.agentCapabilities?._meta ?? {};
  const topMeta = ctx.initResult?._meta ?? {};
  const authNs = ((ctx.initResult?.authMethods ?? []) as any[]).flatMap((m) =>
    Object.keys(m?._meta ?? {}).map((k) => `auth:${k}`),
  );
  ctx.ext = {
    advertised: [...new Set([...Object.keys(capMeta), ...Object.keys(topMeta), ...authNs])].sort(),
    observed: [],
  };

  const sid = ctx.sessionId ?? "probe-session";
  const calls: Array<[string, any]> = [
    ["_lody/rate_limits/get", {}],
    ["_lody/subagents/list", { sessionId: sid }],
    ["_lody/session/history/read", { sessionId: sid }],
    ["_lody/session/goal", { sessionId: sid, action: "pause" }],
  ];
  for (const [method, params] of calls) {
    // callAgent's schema checks no-op on unbound methods — extension traffic
    // is contract-checked by acp-extension-core, not the ACP schema.
    const r = await callAgent(ctx, method, params, 8_000);
    if (r.ok) info.answered.push(method);
    else if (isMissing(r.err)) info.missing.push(method);
    else if (isStructured(r.err)) info.answered.push(method); // domain answer — endpoint exists
    // timeout/transport errors are inconclusive: neither answered nor absent
  }

  const observed = new Set<string>();
  const extObserved = new Set<string>();
  for (const u of ctx.updates) {
    const um = (u.params?.update?._meta ?? u.params?._meta) as Record<string, any> | undefined;
    if (!um || typeof um !== "object") continue;
    for (const [ns, v] of Object.entries(um)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        for (const k of Object.keys(v)) {
          extObserved.add(`${ns}.${k}`);
          if (ns === "lody") observed.add(k);
        }
      } else extObserved.add(ns);
    }
  }
  info.observed = [...observed];
  ctx.ext.observed = [...extObserved];

  const featList = feats
    .map((f) => `${f}${typeof advertised[f]?.version === "number" ? " v" + advertised[f].version : ""}`)
    .join(", ");
  const nsNote = info.answered.length
    ? `_lody/* answered: ${info.answered.map((m) => m.slice(6)).join(", ")}`
    : "_lody/* silent";
  if (feats.length > 0) {
    put(ctx, "lody", {
      status: "pass",
      note: `${feats.length} feature(s) advertised: ${featList} · ${nsNote}${info.observed.length ? ` · on wire: ${info.observed.join(", ")}` : ""}`,
    });
  } else if (info.answered.length > 0 || info.observed.length > 0) {
    const bits = [info.answered.length ? nsNote : "", info.observed.length ? `on wire: ${info.observed.join(", ")}` : ""].filter(Boolean).join(" · ");
    put(ctx, "lody", { status: "partial", note: `${bits} — but no _meta.lody capabilities advertised` });
  } else {
    put(ctx, "lody", { status: "na", note: "no _meta.lody capabilities; _lody/* unanswered", definitive: true });
  }
}

/** logout is the last agent call — it may terminate the session/process.
 *  No capability flag exists for it: ok → pass, method_not_found → na. */
export async function probeLogout(ctx: ProbeContext) {
  const r = await callAgent(ctx, "logout", {});
  if (!r.ok) {
    put(ctx, "logout", {
      status: isStructured(r.err) && !isMissing(r.err) ? "pass" : "fail",
      note: isMissing(r.err) ? "not implemented" : isStructured(r.err) ? `endpoint exists — returned error: ${String(r.err?.message ?? r.err).slice(0, 70)}` : `no valid response: ${String(r.err?.message ?? r.err).slice(0, 70)}`,
      definitive: isMissing(r.err),
      latencyMs: r.latencyMs,
    });
    return;
  }
  put(ctx, "logout", { status: "pass", latencyMs: r.latencyMs });
}
