import { existsSync, readFileSync } from "node:fs";
import type { RpcPeer } from "./rpc.js";
import type { ClientCalls } from "./stubs.js";
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
export interface ProbeContext {
  rpc: RpcPeer;
  calls: ClientCalls;
  initResult: any; // initialize response
  sessionId?: string;
  sessionModes?: any;
  sessionConfigOptions?: any;
  /** controlled workspace the session runs in (sessionFiles land here). */
  sessionCwd: string;
  /** true once we've actively configured an ask-before-act policy —
   *  only then does "agent never asked permission" become evidence. */
  askPolicy: boolean;
  /** stdio MCP fixture: command spec + marker file the fixture appends to. */
  mcpServer?: { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> };
  mcpMarker?: string;
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
const isAuth = (e: any) =>
  /auth|401|403|permission|quota|login|unauthorized|credential/i.test(String(e?.message ?? e)) ||
  code(e) === -32001;

function put(ctx: ProbeContext, key: string, r: MethodResult) {
  ctx.results[key] = r;
  const mark = { pass: "✓", partial: "~", fail: "✗", na: "·" }[r.status];
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
    put(ctx, "initialize", { status: "fail", note: `no valid response: ${String(r.err?.message ?? r.err)}`, latencyMs: r.latencyMs });
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
        put(ctx, "authenticate", { status: "na", note: "not implemented", definitive: true });
      }
      return;
    }
    if (isAuth(r.err)) {
      put(ctx, "authenticate", { status: "partial", note: `endpoint exists — needs real credentials: ${String(r.err?.message ?? r.err).slice(0, 70)}`, latencyMs: r.latencyMs });
      return;
    }
    put(ctx, "authenticate", {
      status: advertised ? "fail" : "partial",
      note: advertised ? String(r.err?.message ?? r.err) : `rejects unknown methodId (endpoint exists): ${String(r.err?.message ?? r.err).slice(0, 60)}`,
      latencyMs: r.latencyMs,
    });
    return;
  }
  put(ctx, "authenticate", { status: "pass", note: `methodId=${methodId}`, latencyMs: r.latencyMs });
}

export async function probeSessionNew(ctx: ProbeContext) {
  const params: any = { cwd: ctx.sessionCwd, mcpServers: [] };
  if (ctx.mcpServer) params.mcpServers = [ctx.mcpServer];
  const r = await callAgent(ctx, "session/new", params);
  if (!r.ok) {
    put(ctx, "session/new", { status: "fail", note: String(r.err?.message ?? r.err), latencyMs: r.latencyMs });
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
        put(ctx, key, { status: "na", note: "not implemented", definitive: true });
      }
      return;
    }
    const msg = String(r.err?.message ?? r.err);
    // "invalid params" on a session-scoped call proves the endpoint exists and
    // validates input — it just has nothing live to operate on. The error code
    // is the reliable signal; message phrasing varies across harnesses.
    if (code(r.err) === -32602 || /(unknown|not found|invalid).{0,30}session|session.{0,30}(unknown|not found)/i.test(msg)) {
      put(ctx, key, { status: "partial", note: `endpoint exists — rejects unknown session: ${msg.slice(0, 60)}`, latencyMs: r.latencyMs });
      return;
    }
    put(ctx, key, {
      status: advertised ? "fail" : "partial",
      note: `${advertised ? "advertised but failed" : "endpoint exists but errored"}: ${msg.slice(0, 80)}`,
      latencyMs: r.latencyMs,
    });
    return;
  }
  put(ctx, key, {
    status: advertised ? "pass" : "partial",
    note: advertised ? passNote : "works but not advertised",
    latencyMs: r.latencyMs,
  });
}

export async function probeSessionLoad(ctx: ProbeContext) {
  const advertised = ctx.initResult?.agentCapabilities?.loadSession === true;
  const r = await callAgent(ctx, "session/load", {
    cwd: ctx.sessionCwd,
    sessionId: ctx.sessionId ?? "probe-session",
    mcpServers: [],
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
  await probe("session/resume", "session/resume", "resume", (sid) => ({ sessionId: sid, cwd: ctx.sessionCwd, mcpServers: [] }));
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
 *  coverage of bash/read/write paths and their client-side calls. A turn that
 *  can only run with a real account is a fail — the wall runs on CI, not on
 *  someone's monthly quota. */
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
    put(ctx, "session/prompt", {
      status: "fail",
      note: isAuth(e)
        ? `turn needs a real account — not CI-probeable: ${String(e?.message ?? e).slice(0, 90)}`
        : String(e?.message ?? e ?? "prompt failed"),
      latencyMs: firstErr?.latencyMs,
    });
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
  if (ctx.results["session/prompt"]?.status === "fail") {
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
  ctx.rpc.notify("session/cancel", { sessionId: ctx.sessionId });
  const r = await p;
  if (!r.ok) {
    put(ctx, "cancel", {
      status: "fail",
      note: `cancel prompt errored: ${String(r.err?.message ?? r.err).slice(0, 90)}`,
      latencyMs: r.latencyMs,
    });
    return;
  }
  const stop = r.value?.stopReason;
  if (stop === "cancelled") {
    put(ctx, "cancel", { status: "pass", note: `cancelled in ${r.latencyMs}ms`, latencyMs: r.latencyMs });
  } else {
    put(ctx, "cancel", { status: "fail", note: `turn ended stopReason=${stop} — cancel not honored`, latencyMs: r.latencyMs });
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
    mcpServers: [],
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
    mcpServers: [],
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
    put(ctx, "load:replay", { status: "partial", note: `${method} succeeded but replayed no conversation` });
  }
}

/** providers/list|set|disable — UNSTABLE surface (agentCapabilities.providers).
 *  set/disable run against a probe-owned providerId so they cannot disturb the
 *  real provider routing; they still prove the endpoint exists. */
export async function probeProviders(ctx: ProbeContext) {
  const advertised = capOn(ctx.initResult?.agentCapabilities ?? {}, "providers");
  const results: string[] = [];
  const list = await callAgent(ctx, "providers/list", {});
  if (!list.ok && isMissing(list.err)) {
    put(ctx, "providers", { status: "na", note: "not implemented", definitive: true });
    return;
  }
  results.push(list.ok ? `list→${Array.isArray(list.value?.providers) ? list.value.providers.length : "?"} providers` : `list errored`);
  const set = await callAgent(ctx, "providers/set", { providerId: "acp-probe", apiType: "openai", baseUrl: "http://127.0.0.1:9/v1" });
  results.push(set.ok ? "set ok" : `set: ${String(set.err?.message ?? set.err).slice(0, 40)}`);
  const disable = await callAgent(ctx, "providers/disable", { providerId: "acp-probe" });
  results.push(disable.ok ? "disable ok" : `disable: ${String(disable.err?.message ?? disable.err).slice(0, 40)}`);
  const okCount = [list, set, disable].filter((x) => x.ok).length;
  const allMissing = [set, disable].every((x) => !x.ok && isMissing(x.err)) && !list.ok;
  if (allMissing) {
    put(ctx, "providers", { status: "na", note: "not implemented", definitive: true });
  } else if (okCount === 3) {
    put(ctx, "providers", { status: advertised ? "pass" : "partial", note: advertised ? results.join(" · ") : `works but not advertised · ${results.join(" · ")}` });
  } else {
    put(ctx, "providers", { status: advertised ? "fail" : "partial", note: `${advertised ? "advertised but failed — " : ""}${results.join(" · ")}` });
  }
}

/** nes/* — UNSTABLE Next-Edit-Suggestions surface. nes/start + nes/suggest are
 *  the two meaningful request endpoints; accept/reject are notifications. */
export async function probeNes(ctx: ProbeContext) {
  const advertised = capOn(ctx.initResult?.agentCapabilities ?? {}, "nes");
  const start = await callAgent(ctx, "nes/start", { workspaceUri: `file://${ctx.sessionCwd}` });
  if (!start.ok && isMissing(start.err)) {
    put(ctx, "nes", { status: "na", note: "not implemented", definitive: true });
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
  put(ctx, "nes", {
    status: start.ok && suggest.ok ? (advertised ? "pass" : "partial") : advertised ? "fail" : "partial",
    note: (advertised && !(start.ok && suggest.ok) ? "advertised but failed — " : "") + note,
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
 *  session/new. Whether the agent actually connected is recorded in the
 *  marker file the fixture appends to. */
export async function probeMcp(ctx: ProbeContext) {
  if (!ctx.mcpMarker) {
    put(ctx, "mcp", { status: "na", note: "no fixture configured" });
    return;
  }
  await wait(2000); // give the agent a moment to spawn + handshake
  const events = existsSync(ctx.mcpMarker)
    ? readFileSync(ctx.mcpMarker, "utf8").trim().split("\n").map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean) as Array<{ event: string }>
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
  if (names.has("tools/call")) {
    put(ctx, "mcp", { status: "pass", note: `stdio handshake + tool call · ${capNote}${relay}` });
  } else if (names.has("initialize") || names.has("initialized")) {
    put(ctx, "mcp", { status: "pass", note: `stdio handshake observed · ${capNote}${relay}` });
  } else if (names.has("spawned")) {
    put(ctx, "mcp", { status: "partial", note: `fixture spawned but never initialized · ${capNote}${relay}` });
  } else if (ctx.calls.mcpRelayCalls.length > 0) {
    put(ctx, "mcp", { status: "partial", note: `no stdio fixture use; client relay ×${ctx.calls.mcpRelayCalls.length} · ${capNote}` });
  } else {
    put(ctx, "mcp", { status: "na", note: `agent never touched the stdio fixture · ${capNote}` });
  }
}

/** logout is the last agent call — it may terminate the session/process.
 *  No capability flag exists for it: ok → pass, method_not_found → na. */
export async function probeLogout(ctx: ProbeContext) {
  const r = await callAgent(ctx, "logout", {});
  if (!r.ok) {
    put(ctx, "logout", {
      status: isMissing(r.err) ? "na" : "partial",
      note: isMissing(r.err) ? "not implemented" : `endpoint exists but errored: ${String(r.err?.message ?? r.err).slice(0, 70)}`,
      latencyMs: r.latencyMs,
    });
    return;
  }
  put(ctx, "logout", { status: "pass", latencyMs: r.latencyMs });
}
