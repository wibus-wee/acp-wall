import { existsSync, readFileSync } from "node:fs";
import type { RpcPeer } from "./rpc.js";
import type { ClientCalls } from "./stubs.js";
import type { MockLlmEvidence } from "./mock-llm.js";
import { schema } from "./schema.js";
import { STATUS, COLUMNS } from "./evidence.js";
import { startHttpMcpFixture, type McpEvent } from "./mcp-fixture.js";

export type Status = "pass" | "partial" | "fail" | "na" | "observed" | "blocked" | "unsupported" | "error";
export interface MethodResult {
  status: Status;
  note?: string;
  latencyMs?: number;
  advertised?: boolean;
  reason?: string;
  blockedBy?: string;
  errorCode?: number;
  definitive?: boolean;
}
export interface ViolationRec {
  where: "response" | "notification" | "request" | "client-response" | "client-request" | "envelope";
  method: string;
  path: string;
  msg: string;
  resultKey?: string;
}
export interface Attempt {
  method: string;
  scenario?: string;
  at: string;
  outcome: "success" | "error";
  errorCode?: number;
  latencyMs: number;
}
export interface ProbeProfile { id: string; configId: string; value: string; description: string }
export interface ScenarioEvidence {
  id: string;
  profile: string;
  sessionId?: string;
  configuration?: Record<string, unknown>;
  result: MethodResult;
  callbacks: Record<string, number>;
  notifications: string[];
  tools: Array<{ id: string; name?: string; status?: string; detail?: string }>;
  mcpEvents?: McpEvent[];
  diagnostics?: string[];
  model?: { issuedTools: string[]; skippedCalls: string[] };
}
export interface LodyProbeInfo {
  advertised: Record<string, any>;
  answered: string[];
  missing: string[];
  observed: string[];
}
export interface ExtSurface { advertised: string[]; observed: string[] }
export interface ProbeContext {
  rpc: RpcPeer;
  calls: ClientCalls;
  initResult: any;
  lody?: LodyProbeInfo;
  ext?: ExtSurface;
  sessionId?: string;
  sessionModes?: any;
  sessionConfigOptions?: any;
  sessionNewParams?: any;
  sessionCwd: string;
  askPolicy: boolean;
  authenticate?: boolean;
  discover?: boolean;
  scenario?: string;
  scenarios?: ScenarioEvidence[];
  probeProfiles?: ProbeProfile[];
  attempts?: Attempt[];
  mcpServer?: { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> };
  mcpMarker?: string;
  mcpLlmEvidence?: MockLlmEvidence;
  promptBlocked?: boolean;
  updates: Array<{ method: string; params: any }>;
  results: Record<string, MethodResult>;
  violations: ViolationRec[];
  dishonesty: Array<{ claim: string; detail: string }>;
}

const REQ_TIMEOUT = 15_000;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function timed<T>(fn: () => Promise<T>): Promise<{ ok: boolean; value?: T; err?: any; latencyMs: number }> {
  const t = Date.now();
  try { return { ok: true, value: await fn(), latencyMs: Date.now() - t }; }
  catch (err) { return { ok: false, err, latencyMs: Date.now() - t }; }
}
const code = (e: any) => typeof e?.code === "number" ? e.code : undefined;
const isMissing = (e: any) => code(e) === -32601;
const isStructured = (e: any) => typeof code(e) === "number" && !e?.timeout;
const isAuth = (e: any) => code(e) === -32000 && !e?.timeout || /auth|401|403|login|credential|api.?key|quota/i.test(String(e?.message ?? e));

function put(ctx: ProbeContext, key: string, r: MethodResult) {
  ctx.results[key] = r;
  console.log(`  ${STATUS[r.status].mark} ${key.padEnd(22)} ${r.status.padEnd(12)} ${r.note ?? ""}`);
}

/** A response error is evidence of rejection, never successful execution. */
export function classifyError(e: any, advertised = false, required = false): MethodResult {
  const note = String(e?.message ?? e).slice(0, 240);
  if (e?.probeInvalid) return { status: "error", reason: "invalid-probe-request", note };
  if (isMissing(e)) return { status: advertised || required ? "fail" : "unsupported", reason: "method-not-found", errorCode: code(e), definitive: true, note };
  if (e?.timeout) return { status: "na", reason: "timeout", note };
  if (!isStructured(e)) return { status: "na", reason: "transport", note };
  if (isAuth(e)) return { status: "blocked", reason: "authentication", errorCode: code(e), note };
  return { status: "observed", reason: "request-rejected", errorCode: code(e), note };
}

function resultKeyFor(method: string, updateKind?: string): string | undefined {
  const direct: Record<string, string> = {
    "session/set_mode": "set_mode", "session/set_config_option": "set_config",
    "session/cancel": "cancel", "session/request_permission": "request_permission",
    "elicitation/create": "elicitation", "elicitation/complete": "elicitation",
  };
  if (direct[method]) return direct[method];
  if (method.startsWith("terminal/")) return "terminal/*";
  if (method === "session/update") return ({
    agent_message_chunk: "update:message", agent_thought_chunk: "update:message",
    tool_call: "update:tool_call", tool_call_update: "update:tool_call",
    plan: "update:plan", available_commands_update: "update:commands", usage_update: "update:usage",
  } as Record<string, string>)[updateKind ?? ""];
  return method;
}

function checkResponse(ctx: ProbeContext, method: string, result: any) {
  const def = schema.bindings.agent.get(method)?.response;
  if (!def) return;
  for (const v of schema.validate(result, def)) ctx.violations.push({ where: "response", method, resultKey: resultKeyFor(method), ...v });
}
function checkRequestParams(ctx: ProbeContext, method: string, params: any) {
  const def = schema.bindings.agent.get(method)?.request;
  const errors = def ? schema.validate(params ?? {}, def) : [];
  for (const v of errors) ctx.violations.push({ where: "client-request", method, resultKey: resultKeyFor(method), ...v });
  return errors.length === 0;
}
async function callAgent(ctx: ProbeContext, method: string, params: any, timeout = REQ_TIMEOUT) {
  if (!checkRequestParams(ctx, method, params)) return { ok: false, err: { probeInvalid: true, message: `Invalid probe parameters for ${method}; not sent` }, latencyMs: 0 };
  const at = new Date().toISOString();
  const r = await timed<any>(() => ctx.rpc.request(method, params, timeout));
  (ctx.attempts ??= []).push({ method, scenario: ctx.scenario, at, outcome: r.ok ? "success" : "error", errorCode: code(r.err), latencyMs: r.latencyMs });
  if (r.ok) checkResponse(ctx, method, r.value);
  return r;
}
export function checkAgentRequest(ctx: ProbeContext, method: string, params: any) {
  const def = schema.bindings.client.get(method)?.request;
  if (!def) return; // unbound extension traffic is recorded without pretending to validate it
  for (const v of schema.validate(params, def)) ctx.violations.push({ where: "request", method, resultKey: resultKeyFor(method), ...v });
}
export function checkNotification(ctx: ProbeContext, method: string, params: any) {
  const def = schema.bindings.client.get(method)?.request;
  if (!def) return;
  for (const v of schema.validate(params, def)) ctx.violations.push({ where: "notification", method, resultKey: resultKeyFor(method, params?.update?.sessionUpdate), ...v });
}
export function checkClientResponse(ctx: ProbeContext, method: string, result: any) {
  const def = schema.bindings.client.get(method)?.response;
  if (!def) return;
  for (const v of schema.validate(result, def)) ctx.violations.push({ where: "client-response", method, resultKey: resultKeyFor(method), ...v });
}
export function recordEnvelopeViolation(ctx: ProbeContext, msg: string) {
  ctx.violations.push({ where: "envelope", method: "-", path: "", msg });
}
export function applyViolations(ctx: ProbeContext) {
  for (const v of ctx.violations) {
    const key = v.resultKey ?? resultKeyFor(v.method);
    if (!key) continue;
    const own = v.where === "client-request" || v.where === "client-response";
    const r = ctx.results[key];
    if (r && (own || ["pass", "observed"].includes(r.status))) {
      r.status = own ? "error" : "partial";
      r.reason = own ? "probe-schema" : "agent-schema";
      r.note = `${r.note ?? ""} · ${v.where}: ${v.path || "(root)"} ${v.msg}`.slice(0, 500);
    }
  }
  // Preserve the causal prerequisite for downstream observations, rather than
  // printing a dozen independent absences after one account/setup failure.
  for (const [, keys] of COLUMNS) for (const key of keys) {
    if (ctx.results[key]) continue;
    const blockedBy = !ctx.initResult ? "initialize" : !ctx.sessionId ? "session/new" : undefined;
    ctx.results[key] = { status: blockedBy ? "blocked" : "na", reason: blockedBy ? "prerequisite" : "not-run", blockedBy, note: blockedBy ? `Not exercised; prerequisite ${blockedBy} unavailable` : "No controlled scenario exercised this check" };
  }
}

function verdict(ctx: ProbeContext, key: string, r: Awaited<ReturnType<typeof callAgent>>, advertised = false, required = false, note?: string) {
  const value: MethodResult = r.ok ? { status: schema.bindings.agent.get(key === "set_mode" ? "session/set_mode" : key === "set_config" ? "session/set_config_option" : key)?.response ? "pass" : "observed", note } : classifyError(r.err, advertised, required);
  if (!r.ok && isMissing(r.err) && advertised) ctx.dishonesty.push({ claim: key, detail: "Advertised method returned method_not_found" });
  put(ctx, key, { ...value, advertised: required ? undefined : advertised, latencyMs: r.latencyMs });
}
const capOn = (caps: any, flag: string) => caps?.[flag] === true || typeof caps?.[flag] === "object" && caps?.[flag] !== null;
function available(ctx: ProbeContext, key: string, advertised: boolean) {
  if (advertised || ctx.discover) return true;
  put(ctx, key, { status: "na", advertised: false, reason: "not-advertised", note: "Not advertised; optional method not invoked" });
  return false;
}
function sessionReady(ctx: ProbeContext, key: string) {
  if (ctx.sessionId) return true;
  put(ctx, key, { status: "blocked", reason: "prerequisite", blockedBy: "session/new", note: "No usable session; see session/new" });
  return false;
}
const updatesOf = (ctx: ProbeContext, kind: string) => ctx.updates.filter(u => u.method === "session/update" && u.params?.update?.sessionUpdate === kind);

export async function probeInitialize(ctx: ProbeContext) {
  const r = await callAgent(ctx, "initialize", {
    protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: { name: "acp-probe", title: "ACP Evidence Probe", version: "0.2.0" },
  }, 90_000);
  verdict(ctx, "initialize", r, false, true, r.ok ? `Protocol ${r.value?.protocolVersion} · ${r.value?.agentInfo?.name ?? "unnamed agent"}` : undefined);
  if (r.ok && r.value?.protocolVersion === 1 && r.value?.agentCapabilities) ctx.initResult = r.value;
  else if (r.ok) put(ctx, "initialize", { status: "partial", note: "Cannot negotiate protocol version 1 and capabilities" });
  return !!ctx.initResult;
}
export async function probeAuthenticate(ctx: ProbeContext) {
  const methods = ctx.initResult?.authMethods ?? [];
  if (!methods.length) { put(ctx, "authenticate", { status: "na", reason: "not-advertised", note: "No protocol authentication method advertised" }); return; }
  const method = methods.find((m: any) => !m.type || m.type === "agent");
  if (!ctx.authenticate || !method) {
    put(ctx, "authenticate", { status: "blocked", advertised: true, reason: "interactive-auth", note: `Advertised: ${methods.map((m: any) => m.id).join(", ")}; login not attempted in unattended discovery` }); return;
  }
  const r = await callAgent(ctx, "authenticate", { methodId: method.id });
  verdict(ctx, "authenticate", r, true);
}
export async function probeSessionNew(ctx: ProbeContext) {
  const params = { cwd: ctx.sessionCwd, mcpServers: [] };
  ctx.sessionNewParams = params;
  const r = await callAgent(ctx, "session/new", params);
  verdict(ctx, "session/new", r, false, true, "Created a session without additional MCP dependencies");
  if (r.ok && typeof r.value?.sessionId === "string" && r.value.sessionId) {
    ctx.sessionId = r.value.sessionId;
    ctx.sessionModes = r.value.modes;
    ctx.sessionConfigOptions = r.value.configOptions;
  }
}
export async function probeSessionLoad(ctx: ProbeContext) {
  const advertised = ctx.initResult?.agentCapabilities?.loadSession === true;
  if (!available(ctx, "session/load", advertised) || !sessionReady(ctx, "session/load")) return;
  const r = await callAgent(ctx, "session/load", { ...ctx.sessionNewParams, sessionId: ctx.sessionId });
  verdict(ctx, "session/load", r, advertised);
}
export async function probeSessionMgmt(ctx: ProbeContext) {
  const caps = ctx.initResult?.agentCapabilities?.sessionCapabilities ?? {};
  if (available(ctx, "session/list", capOn(caps, "list"))) verdict(ctx, "session/list", await callAgent(ctx, "session/list", {}), capOn(caps, "list"));
  // Each lifecycle operation gets its own disposable session; a failed setup
  // must never fall back to closing the session used by other scenarios.
  for (const op of ["resume", "close", "delete"]) {
    const key = `session/${op}`;
    if (!available(ctx, key, capOn(caps, op)) || !sessionReady(ctx, key)) continue;
    const fresh = await callAgent(ctx, "session/new", { cwd: ctx.sessionCwd, mcpServers: [] });
    if (!fresh.ok || !fresh.value?.sessionId || fresh.value.sessionId === ctx.sessionId) {
      put(ctx, key, { status: "blocked", blockedBy: "session/new", reason: "isolated-session", note: "Could not create a distinct disposable session" }); continue;
    }
    const params = op === "resume" ? { cwd: ctx.sessionCwd, mcpServers: [], sessionId: fresh.value.sessionId } : { sessionId: fresh.value.sessionId };
    verdict(ctx, key, await callAgent(ctx, key, params), capOn(caps, op));
  }
}
export async function probeSetMode(ctx: ProbeContext) {
  if (!sessionReady(ctx, "set_mode")) return;
  const modes = ctx.sessionModes?.availableModes;
  if (!Array.isArray(modes) || !modes.length) { put(ctx, "set_mode", { status: "na", reason: "not-advertised", note: "No session modes offered" }); return; }
  const target = modes.find((m: any) => m.id === ctx.sessionModes.currentModeId) ?? modes[0];
  verdict(ctx, "set_mode", await callAgent(ctx, "session/set_mode", { sessionId: ctx.sessionId, modeId: target.id }), true, false, `Accepted offered mode ${target.id}; policy semantics not inferred from its name`);
}
export async function probeSetConfig(ctx: ProbeContext) {
  if (!sessionReady(ctx, "set_config")) return;
  const opt = ctx.sessionConfigOptions?.[0];
  if (!opt) { put(ctx, "set_config", { status: "na", reason: "not-advertised", note: "No config options offered" }); return; }
  const params: any = { sessionId: ctx.sessionId, configId: opt.id, value: opt.currentValue };
  if (opt.type === "boolean") params.type = "boolean";
  verdict(ctx, "set_config", await callAgent(ctx, "session/set_config_option", params), true, false, `Accepted current value of ${opt.id}`);
}
const PROMPTS = [
  "__probe_exec__ Run a shell command to read PROBE_CANARY.txt.",
  "__probe_read__ Read PROBE_CANARY.txt using a file-reading tool.",
  "__probe_write__ Write the text probe to probe-out.txt using a file-writing tool.",
  "__probe_plan__ Use your plan or todo tool to record a short plan for inspecting PROBE_CANARY.txt. Do not change files.",
];
const callbackCounts = (ctx: ProbeContext, sessionId: string) => {
  const count = (calls: Array<{ sessionId?: string }>) => calls.filter(c => c.sessionId === sessionId).length;
  return { "fs/read_text_file": count(ctx.calls.fsReads), "fs/write_text_file": count(ctx.calls.fsWrites),
    "terminal/*": count(ctx.calls.terminalCreates), request_permission: count(ctx.calls.permissionRequests), elicitation: count(ctx.calls.elicitations) };
};
export async function runPromptScenario(ctx: ProbeContext, id: string, sessionId: string, prompt: any[], profile = "default", configOptions?: any[]) {
  const before = ctx.updates.length, counts = callbackCounts(ctx, sessionId);
  const violationsBefore = ctx.violations.length;
  const model = ctx.mcpLlmEvidence, issued = model?.issuedCalls.length ?? 0, skipped = model?.skippedCalls.length ?? 0;
  const previous = ctx.scenario;
  ctx.scenario = id;
  let r: Awaited<ReturnType<typeof callAgent>>;
  try { r = await callAgent(ctx, "session/prompt", { sessionId, prompt }, 30_000); }
  finally { ctx.scenario = previous; }
  const updates = ctx.updates.slice(before).filter(u => u.method === "session/update" && u.params?.sessionId === sessionId).map(u => u.params.update);
  const tools = new Map<string, ScenarioEvidence["tools"][number]>();
  for (const u of updates.filter(u => ["tool_call", "tool_call_update"].includes(u.sessionUpdate))) {
    const tool: ScenarioEvidence["tools"][number] = tools.get(u.toolCallId) ?? { id: u.toolCallId };
    if (u._meta?.lody?.toolName || u.title) tool.name = u._meta?.lody?.toolName ?? u.title;
    if (u.status) tool.status = u.status;
    if (u.status === "failed") tool.detail = JSON.stringify(u.rawOutput ?? u.content ?? "").slice(0, 400);
    tools.set(u.toolCallId, tool);
  }
  const after = callbackCounts(ctx, sessionId);
  const violations = ctx.violations.slice(violationsBefore);
  const result: MethodResult = violations.length ? {
    status: violations.some(v => ["client-request", "client-response"].includes(v.where)) ? "error" : "partial",
    reason: "scenario-schema", note: "Scenario traffic has schema diagnostics; see report violations",
  } : r.ok ? { status: "pass", note: "Prompt response received; tool outcomes and callbacks are recorded separately" } : classifyError(r.err);
  (ctx.scenarios ??= []).push({ id, profile, sessionId,
    configuration: Object.fromEntries((configOptions ?? []).map(o => [o.id, o.currentValue])),
    result,
    callbacks: Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - counts[key as keyof typeof counts]])),
    notifications: [...new Set<string>(updates.map(u => u.sessionUpdate))], tools: [...tools.values()],
    model: model ? { issuedTools: model.issuedCalls.slice(issued).map(c => c.name), skippedCalls: model.skippedCalls.slice(skipped) } : undefined,
  });
  return r;
}
export async function probeSessionPrompt(ctx: ProbeContext) {
  if (!sessionReady(ctx, "session/prompt")) return;
  let completed = 0;
  for (const text of PROMPTS) {
    const id = text.match(/__probe_(\w+)__/)![1];
    const r = await runPromptScenario(ctx, `default:${id}`, ctx.sessionId!, [{ type: "text", text }], "default", ctx.sessionConfigOptions);
    if (!r.ok) {
      ctx.promptBlocked = true;
      verdict(ctx, "session/prompt", r, false, true);
      if (completed) ctx.results["session/prompt"].note = `${completed} earlier turn(s) succeeded; subsequent attempt: ${ctx.results["session/prompt"].note}`;
      return;
    }
    completed++;
  }
  put(ctx, "session/prompt", { status: "pass", note: `${completed} prompt responses received; content and tool choice are observed separately` });
}
export async function probePermissionProfiles(ctx: ProbeContext) {
  if (!ctx.sessionId || ctx.promptBlocked) return;
  for (const profile of ctx.probeProfiles ?? []) {
    const key = `profile:${profile.id}`;
    ctx.scenario = key;
    const fresh = await callAgent(ctx, "session/new", { cwd: ctx.sessionCwd, mcpServers: [] });
    const options = fresh.value?.configOptions ?? [];
    const option = options.find((o: any) => o.id === profile.configId);
    const offered = option?.options?.flatMap((o: any) => o.options ?? [o]) ?? [];
    let result: MethodResult | undefined;
    if (!fresh.ok || !fresh.value?.sessionId || fresh.value.sessionId === ctx.sessionId) result = { status: "blocked", reason: "prerequisite", blockedBy: "session/new", note: "No distinct session available for the configured permission profile" };
    else if (!offered.some((o: any) => o.value === profile.value)) result = { status: "na", reason: "profile-unavailable", note: `Configured option ${profile.configId}=${profile.value} was not offered by the agent` };
    else {
      const configured = await callAgent(ctx, "session/set_config_option", { sessionId: fresh.value.sessionId, configId: profile.configId, value: profile.value });
      if (!configured.ok) result = classifyError(configured.err);
      else {
        const returned = configured.value?.configOptions;
        if (!returned?.some((o: any) => o.id === profile.configId && o.currentValue === profile.value)) result = { status: "observed", reason: "configuration-unconfirmed", note: "Response did not confirm the requested configuration; profile prompts skipped" };
        else for (const text of PROMPTS.slice(0, 3)) {
          const kind = text.match(/__probe_(\w+)__/)![1];
          await runPromptScenario(ctx, `${profile.id}:${kind}`, fresh.value.sessionId, [{ type: "text", text }], profile.id, returned);
        }
      }
    }
    if (result) (ctx.scenarios ??= []).push({ id: key, profile: profile.id, result, callbacks: {}, notifications: [], tools: [] });
  }
}

export async function probePromptContent(ctx: ProbeContext) {
  const caps = ctx.initResult?.agentCapabilities?.promptCapabilities ?? {};
  const samples: Array<[string, string, any]> = [
    ["image", "image", { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC" }],
    ["embeddedContext", "embedded-context", { type: "resource", resource: { uri: "probe://context/canary", mimeType: "text/plain", text: "CANARY-7729 embedded context" } }],
  ];
  for (const [flag, label, content] of samples) {
    const key = `prompt:${label}`;
    if (!available(ctx, key, caps[flag] === true) || !sessionReady(ctx, key)) continue;
    const fresh = await callAgent(ctx, "session/new", { cwd: ctx.sessionCwd, mcpServers: [] });
    if (!fresh.ok || !fresh.value?.sessionId || fresh.value.sessionId === ctx.sessionId) {
      put(ctx, key, { status: "blocked", reason: "prerequisite", blockedBy: "session/new", note: "No distinct session for the content scenario" }); continue;
    }
    const r = await runPromptScenario(ctx, key, fresh.value.sessionId, [{ type: "text", text: `__probe_${label}__ Acknowledge this input without using tools.` }, content]);
    const result = ctx.scenarios!.at(-1)!.result;
    put(ctx, key, result.status === "pass" ? { status: "pass", advertised: caps[flag] === true, note: "Typed prompt accepted and answered; model understanding and content preservation are not established" } : { ...result, advertised: caps[flag] === true });
  }
}
export async function probeCancel(ctx: ProbeContext) {
  if (!sessionReady(ctx, "cancel")) return;
  if (ctx.promptBlocked) { put(ctx, "cancel", { status: "blocked", reason: "prerequisite", blockedBy: "session/prompt", note: "No successful prompt to establish cancellation conditions" }); return; }
  let settled = false;
  const p = callAgent(ctx, "session/prompt", { sessionId: ctx.sessionId, prompt: [{ type: "text", text: "__probe_slow__ hold this turn open" }] }, 25_000).then(r => { settled = true; return r; });
  await wait(400);
  const pendingAtCancel = !settled;
  if (pendingAtCancel && checkRequestParams(ctx, "session/cancel", { sessionId: ctx.sessionId })) ctx.rpc.notify("session/cancel", { sessionId: ctx.sessionId });
  const r = await p;
  if (!r.ok || !pendingAtCancel) { put(ctx, "cancel", { status: "na", reason: "no-active-turn", note: "No cancellable turn established" }); return; }
  put(ctx, "cancel", r.value?.stopReason === "cancelled"
    ? { status: "pass", note: `In-flight prompt returned cancelled after ${r.latencyMs}ms` }
    : { status: "observed", note: `Cancel sent while pending; prompt ended with ${r.value?.stopReason}. Completion race remains possible` });
}
export function probeClientCalls(ctx: ProbeContext) {
  for (const [key, count] of [["fs/read_text_file", ctx.calls.fsReads.length], ["fs/write_text_file", ctx.calls.fsWrites.length], ["terminal/*", ctx.calls.terminalCreates.length], ["request_permission", ctx.calls.permissionRequests.length], ["elicitation", ctx.calls.elicitations.length]] as const) {
    const cause = !ctx.sessionId ? "session/new" : ctx.promptBlocked ? "session/prompt" : undefined;
    const kind = key === "fs/read_text_file" ? "read" : key === "fs/write_text_file" ? "write" : "exec";
    const relevant = (ctx.scenarios ?? []).filter(s => s.id.endsWith(`:${kind}`));
    const policyDenied = relevant.length > 0 && relevant.every(s => s.tools.some(t => t.status === "failed" && /source: capability_rule|permission denied|policy denied/i.test(t.detail ?? "")));
    const noTool = relevant.length > 0 && relevant.every(s => s.model && !s.model.issuedTools.length && s.model.skippedCalls.length);
    const reason = cause ? "prerequisite" : key === "elicitation" ? "not-run" : policyDenied ? "policy-rejected" : noTool ? "stimulus-unavailable" : "no-client-callback";
    put(ctx, key, count ? { status: "pass", note: `${count} client request(s) observed with simulated client replies; see scenarios for conditions` }
      : { status: cause ? "blocked" : "na", reason, blockedBy: cause, note: cause ? `Not observed; prerequisite ${cause} unavailable` : reason === "policy-rejected" ? "Tool attempts were explicitly denied by policy; no corresponding client callback observed" : reason === "not-run" ? "No controlled elicitation scenario configured" : reason === "stimulus-unavailable" ? "No valid matching model tool stimulus could be issued" : "No client request observed; internal tools and policy choices are permitted" });
  }
}
export function probeUpdateShapes(ctx: ProbeContext) {
  const kinds: Record<string, string[]> = { message: ["agent_message_chunk", "agent_thought_chunk"], tool_call: ["tool_call", "tool_call_update"], plan: ["plan"], commands: ["available_commands_update"], usage: ["usage_update"] };
  for (const [key, names] of Object.entries(kinds)) {
    const count = names.reduce((n, kind) => n + updatesOf(ctx, kind).length, 0);
    const cause = !ctx.sessionId ? "session/new" : ctx.promptBlocked ? "session/prompt" : undefined;
    put(ctx, `update:${key}`, count ? { status: "pass", note: `${count} notification(s) observed` } : { status: cause ? "blocked" : "na", reason: cause ? "prerequisite" : "not-triggered", blockedBy: cause, note: "No matching notifications observed; see scenario stimuli" });
  }
}
export async function probeSessionFork(ctx: ProbeContext) {
  const advertised = capOn(ctx.initResult?.agentCapabilities?.sessionCapabilities, "fork");
  if (!available(ctx, "session/fork", advertised) || !sessionReady(ctx, "session/fork")) return;
  const r = await callAgent(ctx, "session/fork", { ...ctx.sessionNewParams, sessionId: ctx.sessionId });
  verdict(ctx, "session/fork", r, advertised);
  if (r.ok && r.value?.sessionId === ctx.sessionId) put(ctx, "session/fork", { status: "partial", note: "Fork returned the original sessionId" });
}
export async function probeLoadReplay(ctx: ProbeContext) {
  if (!sessionReady(ctx, "load:replay")) return;
  if (!ctx.initResult?.agentCapabilities?.loadSession) { put(ctx, "load:replay", { status: "na", reason: "not-advertised", note: "session/load not advertised; resume does not require replay" }); return; }
  const conversation = (updates: ProbeContext["updates"]) => updates.filter(u => u.method === "session/update" && u.params?.sessionId === ctx.sessionId && ["agent_message_chunk", "user_message_chunk"].includes(u.params?.update?.sessionUpdate));
  // Live streams may omit user echoes that are present in replay. Compare each
  // speaker separately so those echoes and chunk boundaries cannot hide evidence.
  const text = (updates: ProbeContext["updates"], kind: string) => conversation(updates)
    .filter(u => u.params.update.sessionUpdate === kind)
    .map(u => u.params.update.content?.text ?? "").join("");
  const kinds = ["agent_message_chunk", "user_message_chunk"];
  const prior = kinds.map(kind => text(ctx.updates, kind));
  const scenario = ctx.scenario;
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const before = ctx.updates.length;
      ctx.scenario = `load:replay:${attempt}`;
      const r = await callAgent(ctx, "session/load", { ...ctx.sessionNewParams, sessionId: ctx.sessionId });
      verdict(ctx, "session/load", r, true);
      if (!r.ok) { put(ctx, "load:replay", { status: "blocked", reason: "prerequisite", blockedBy: "session/load", note: `Load attempt ${attempt} rejected; replay could not be exercised` }); return; }
      const replay = kinds.map(kind => text(ctx.updates.slice(before), kind));
      const suffix = attempt === 2 ? "; first load returned no conversation text" : "";
      if (replay.some(Boolean)) {
        const matched = prior.some(Boolean) && prior.every((value, i) => !value || replay[i].includes(value));
        put(ctx, "load:replay", { status: matched ? "pass" : "observed", note: (matched
          ? "Prior conversation text replayed for the same session"
          : "Conversation replay observed; prior content not fully matched") + suffix });
        return;
      }
    }
    put(ctx, "load:replay", { status: "na", reason: "not-triggered", note: "No conversation text observed during either of two load attempts" });
  } finally { ctx.scenario = scenario; }
}
export async function probeProviders(ctx: ProbeContext) {
  const advertised = ctx.initResult?.agentCapabilities?.providers === true;
  if (available(ctx, "providers/list", advertised)) {
    const r = await callAgent(ctx, "providers/list", {});
    verdict(ctx, "providers/list", r, advertised);
  }
  for (const key of ["providers/set", "providers/disable"]) put(ctx, key, { status: "na", reason: "not-run", advertised, note: "Provider mutation not exercised in discovery" });
}
export async function probeNes(ctx: ProbeContext) {
  const advertised = ctx.initResult?.agentCapabilities?.nes === true;
  if (!available(ctx, "nes/start", advertised) || !sessionReady(ctx, "nes/start")) return;
  verdict(ctx, "nes/start", await callAgent(ctx, "nes/start", { workspaceUri: `file://${ctx.sessionCwd}` }), advertised);
  put(ctx, "nes/suggest", { status: "na", reason: "not-run", advertised, note: "No controlled editor scenario; suggestion not exercised" });
}

export async function probeMcp(ctx: ProbeContext) {
  const caps = ctx.initResult?.agentCapabilities?.mcpCapabilities ?? {};
  for (const transport of ["stdio", "http", "sse"] as const) {
    const key = `mcp:${transport}`;
    if (transport !== "stdio" && !available(ctx, key, caps[transport] === true)) continue;
    if (!sessionReady(ctx, key) || ctx.promptBlocked) {
      put(ctx, key, { status: "blocked", reason: "prerequisite", blockedBy: "session/prompt", note: "MCP scenario prerequisites unavailable" }); continue;
    }
    if (transport === "stdio" && (!ctx.mcpMarker || !ctx.mcpServer)) {
      put(ctx, key, { status: "na", reason: "not-run", note: "No stdio fixture configured" }); continue;
    }
    const outcomes: MethodResult[] = [];
    for (const profile of [undefined, ...(ctx.probeProfiles ?? [])]) {
      const id = `${key}:${profile?.id ?? "default"}`;
      const traceBefore = ctx.rpc.transcript?.length ?? 0;
      ctx.scenario = id;
      const marker = `${ctx.mcpMarker}.${profile?.id ?? "default"}`;
      const fixture = transport === "stdio" ? undefined : await startHttpMcpFixture(transport);
      try {
        const config = fixture?.config ?? { ...ctx.mcpServer!, env: [{ name: "MCP_MARKER", value: marker }] };
        const fresh = await callAgent(ctx, "session/new", { cwd: ctx.sessionCwd, mcpServers: [config] });
        let result: MethodResult | undefined;
        let options = fresh.value?.configOptions ?? [];
        if (!fresh.ok || !fresh.value?.sessionId || fresh.value.sessionId === ctx.sessionId) {
          result = fresh.ok ? { status: "blocked", reason: "prerequisite", note: "MCP scenario requires a distinct session" } : classifyError(fresh.err);
        } else if (profile) {
          const opt = options.find((o: any) => o.id === profile.configId);
          const offered = opt?.options?.flatMap((o: any) => o.options ?? [o]) ?? [];
          if (!offered.some((o: any) => o.value === profile.value)) result = { status: "na", reason: "profile-unavailable", note: `Profile ${profile.id} was not offered` };
          else {
            const set = await callAgent(ctx, "session/set_config_option", { sessionId: fresh.value.sessionId, configId: profile.configId, value: profile.value });
            if (!set.ok) result = classifyError(set.err);
            else if (!set.value?.configOptions?.some((o: any) => o.id === profile.configId && o.currentValue === profile.value)) result = { status: "observed", reason: "configuration-unconfirmed", note: "Requested profile was not confirmed" };
            else options = set.value.configOptions;
          }
        }
        if (!result) {
          const prompt = await runPromptScenario(ctx, id, fresh.value.sessionId, [{ type: "text", text: "__probe_mcp__ Call the probe_noop MCP tool." }], profile?.id ?? "default", options);
          await wait(500);
          const events: McpEvent[] = fixture?.events ?? (existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : []);
          const names = new Set(events.map(e => e.event));
          const scenario = ctx.scenarios!.at(-1)!;
          const diagnostics = (ctx.rpc.transcript ?? []).slice(traceBefore).filter(t => t.kind === "err")
            .map(t => String((t.raw as any)?.text ?? t.summary).replace(/\x1b\[[0-9;]*m/g, ""));
          scenario.diagnostics = diagnostics;
          result = ["error", "partial"].includes(scenario.result.status) ? scenario.result
            : names.has("fixture-error") ? { status: "error", reason: "fixture-error", note: "MCP fixture encountered an internal error" }
            : events.some(e => e.event === "tools/call" && e.name === "probe_noop") ? { status: "pass", note: "Fixture received probe_noop and returned its controlled result" }
            : !prompt.ok ? classifyError(prompt.err)
            : names.has("tools/list") ? { status: "observed", reason: "tool-not-called", note: "Fixture tool discovery completed; no fixture call received" }
            : names.has("initialized") ? { status: "observed", reason: "tools-not-discovered", note: "MCP handshake completed; tools were not discovered" }
            : events.length ? { status: "observed", reason: "handshake-incomplete", note: "Fixture contacted; no completed MCP handshake" }
            : diagnostics.some(d => d.includes(transport) && /unsupported_transport|transport.*unsupported/i.test(d))
              ? { status: "observed", reason: "agent-reported-unsupported", note: "Agent stderr reports this transport unsupported; no fixture connection. This is a diagnostic, not a JSON-RPC rejection" }
              : { status: "na", reason: "fixture-not-contacted", note: "No connection to the fixture observed" };
          scenario.result = result;
          scenario.mcpEvents = events;
        } else (ctx.scenarios ??= []).push({ id, profile: profile?.id ?? "default", result, callbacks: {}, notifications: [], tools: [] });
        outcomes.push(result);
      } finally { await fixture?.close(); }
    }
    const rank = ["error", "partial", "fail", "pass", "observed", "blocked", "unsupported", "na"];
    const best = [...outcomes].sort((a, b) => rank.indexOf(a.status) - rank.indexOf(b.status))[0];
    put(ctx, key, { ...best, advertised: transport === "stdio" ? undefined : caps[transport] === true,
      note: `${best.note}; ${outcomes.filter(r => r.status === "pass").length}/${outcomes.length} configured scenarios received a fixture call. See each scenario.` });
  }
}

/** Extension declarations and endpoint replies are recorded separately from
 * standard evidence. Only read-only endpoints are called; replies may be errors. */
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
  ];
  for (const [method, params] of calls) {
    // callAgent's schema checks no-op on unbound methods — extension traffic
    // is contract-checked by acp-extension-core, not the ACP schema.
    const r = await callAgent(ctx, method, params, 8_000);
    if (r.ok) info.answered.push(method);
    else if (isMissing(r.err)) info.missing.push(method);
    else if (isStructured(r.err)) info.answered.push(method); // rejection is a reply, not successful operation
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
      status: "observed",
      note: `${feats.length} feature(s) advertised: ${featList} · ${nsNote}${info.observed.length ? ` · on wire: ${info.observed.join(", ")}` : ""}`,
    });
  } else if (info.answered.length > 0 || info.observed.length > 0) {
    const bits = [info.answered.length ? nsNote : "", info.observed.length ? `on wire: ${info.observed.join(", ")}` : ""].filter(Boolean).join(" · ");
    put(ctx, "lody", { status: "observed", note: `${bits} — but no _meta.lody capabilities advertised` });
  } else {
    put(ctx, "lody", { status: "na", note: "no _meta.lody capabilities; _lody/* unanswered", definitive: true });
  }
}

/** Authentication state changes are only exercised when capability-negotiated. */
export async function probeLogout(ctx: ProbeContext) {
  const advertised = capOn(ctx.initResult?.agentCapabilities?.auth, "logout");
  if (!available(ctx, "logout", advertised)) return;
  if (ctx.results.authenticate?.status !== "pass") {
    put(ctx, "logout", { status: "na", reason: "not-run", advertised, note: "No authentication established by this run; shared account state is not changed" }); return;
  }
  verdict(ctx, "logout", await callAgent(ctx, "logout", {}), advertised);
}
