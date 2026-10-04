import { createServer, type Server } from "node:http";

import { AsyncLocalStorage } from "node:async_hooks";
import { schema } from "./schema.js";

/** Controlled model stimuli for independent exec, read, write, plan and MCP scenarios.
 * Unrecognized or schema-invalid tool arguments are recorded and not issued. */
/** What the model side of the run actually saw — lets the probe distinguish
 *  "agent never exposed the MCP tool" from "model called it, call vanished". */
export interface MockLlmEvidence {
  /** every tool name ever present in a request's tools array */
  seenTools: Set<string>;
  /** tool calls the mock issued back to the agent */
  issuedCalls: PickedTool[];
  skippedCalls: string[];
  requests: number;
}

export interface MockLlm {
  url: string;
  close: () => void;
  evidence: MockLlmEvidence;
}

const CANARY = "CANARY-7729";
const TOOL_COMMAND = "cat PROBE_CANARY.txt";

interface PickedTool {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

const mockContext = new AsyncLocalStorage<MockLlmEvidence>();
const evidence = () => mockContext.getStore()!;

function messages(body: any): any[] {
  const raw = body?.messages ?? body?.input ?? body?.contents ?? [];
  return Array.isArray(raw) ? raw : [{ role: "user", content: String(raw) }];
}
function messageText(m: any): string {
  if (typeof m?.content === "string") return m.content;
  return (m?.content ?? m?.parts ?? []).map((p: any) => p?.text ?? "").join(" ");
}
function currentUserIndex(list: any[]): number {
  for (let i = list.length - 1; i >= 0; i--) if (list[i]?.role === "user" && messageText(list[i])) return i;
  return -1;
}
function currentText(body: any): string {
  const list = messages(body); return messageText(list[currentUserIndex(list)]);
}

/** Choose a permission-worthy tool and synthesize args from its JSON schema. */
function pickToolCall(tools: any[], body: any): PickedTool | null {
  const norm = (tools ?? [])
    .map((t) => ({
      name: t?.function?.name ?? t?.name,
      params: t?.function?.parameters ?? t?.input_schema ?? t?.parameters ?? {},
    }))
    .filter((t) => typeof t.name === "string");
  for (const t of norm) evidence().seenTools.add(t.name);

  const scenario = currentText(body).match(/__probe_(exec|read|write|plan|mcp)__/i)?.[1]?.toLowerCase();
  const match: Record<string, RegExp> = { exec: /bash|shell|exec|command|terminal/i, read: /read|open|view|cat/i, write: /write|create_file/i, mcp: /probe_noop/i, plan: /^(todowrite|todo_write|update_plan|write_plan|plan_update)$/i };
  if (!scenario) return null;
  const pick = norm.find(t => match[scenario].test(t.name) && (scenario === "mcp" || !/probe_noop/i.test(t.name)));
  if (!pick) { evidence().skippedCalls.push(`${scenario}: no matching tool offered`); return null; }
  const writer = /write|edit|create|patch|apply/i.test(pick.name);

  const args: Record<string, unknown> = {};
  const props = pick.params?.properties ?? {};
  const required = new Set<string>(pick.params?.required ?? []);
  for (const [k, spec] of Object.entries<any>(props)) {
    const worth = required.has(k) || /command|cmd|path|file|content|text|description|prompt|input|query|url/i.test(k);
    if (!worth) continue;
    if (spec?.const !== undefined) { args[k] = spec.const; continue; }
    if (Array.isArray(spec?.enum) && spec.enum.length) { args[k] = spec.enum[0]; continue; }
    const type = spec?.type;
    if (type === "string" || type === undefined) {
      if (/command|cmd|script|code/i.test(k)) args[k] = TOOL_COMMAND;
      else if (/path|file|dir|target/i.test(k)) args[k] = writer ? "./probe-out.txt" : "./PROBE_CANARY.txt";
      else if (/content|new_string|new_str|text|data|body/i.test(k)) args[k] = `${CANARY}\n`;
      else if (/old_string|old_str|find|match|pattern|search|query/i.test(k)) args[k] = "";
      else if (/url|uri/i.test(k)) args[k] = "https://example.com/probe";
      else args[k] = "acp-probe";
    } else if (type === "number" || type === "integer") args[k] = 1;
    else if (type === "boolean") args[k] = true;
    else if (type === "array") args[k] = scenario === "plan" ? [sampleFromSchema(spec.items)] : [];
    else if (type === "object") args[k] = {};
  }
  const errors = schema.validate(args, pick.params);
  if (errors.length) { evidence().skippedCalls.push(`${pick.name}: could not construct valid arguments (${errors[0].path})`); return null; }
  return { id: `call_probe_${evidence().issuedCalls.length + 1}`, name: pick.name, args };
}

/** Flatten provider-specific tool containers (OpenAI tools[], Gemini
 *  tools[].functionDeclarations[], Anthropic tools[]) to one list. */
function toolList(body: any): any[] {
  const raw = Array.isArray(body?.tools) ? body.tools : [];
  return raw.flatMap((t: any) => (Array.isArray(t?.functionDeclarations) ? t.functionDeclarations : [t]));
}

const hasToolResult = (body: any): boolean => {
  const list = messages(body);
  return list.slice(currentUserIndex(list) + 1).some(m =>
    m?.role === "tool" || m?.type === "function_call_output" ||
    (Array.isArray(m?.content) && m.content.some((c: any) => c?.type === "tool_result")) ||
    (Array.isArray(m?.parts) && m.parts.some((p: any) => p?.functionResponse)));
};

/** OpenAI Responses API output items for a completed response. */
function responsesOutput(body: any): { output: any[]; tool: PickedTool | null } {
  const tool = hasToolResult(body) ? null : pickToolCall(toolList(body), body);
  if (tool) { evidence().issuedCalls.push(tool); }
  const sawCanary = JSON.stringify(body).includes(CANARY);
  const output = tool
    ? [
        {
          type: "function_call",
          id: tool.id,
          call_id: tool.id,
          name: tool.name,
          arguments: JSON.stringify(tool.args),
          status: "completed",
        },
      ]
    : [
        {
          type: "message",
          id: "msg_probe",
          status: "completed",
          role: "assistant",
          content: [
            { type: "output_text", text: `PROBE_OK${sawCanary ? " CANARY_ACK" : ""} — exercised by acp-probe mock llm`, annotations: [] },
          ],
        },
      ];
  return { output, tool };
}

function responseObject(output: any[], model: string) {
  return {
    id: "resp_probe",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output,
    usage: { input_tokens: 1, output_tokens: 3, total_tokens: 4 },
  };
}

const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

/** SSE event sequence for a streamed Responses API reply. */
function responsesSse(output: any[], tool: PickedTool | null, model: string): string {
  const final = responseObject(output, model);
  let out = ev("response.created", { type: "response.created", response: { ...final, status: "in_progress", output: [] } });
  const item = output[0];
  out += ev("response.output_item.added", {
    type: "response.output_item.added",
    output_index: 0,
    item: { ...item, status: "in_progress", ...(item.type === "function_call" ? { arguments: "" } : { content: [] }) },
  });
  if (tool) {
    const args = item.arguments;
    out += ev("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: args });
    out += ev("response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: args });
  } else {
    const text = item.content[0].text;
    out += ev("response.content_part.added", {
      type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    out += ev("response.output_text.delta", { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text });
    out += ev("response.output_text.done", { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text });
    out += ev("response.content_part.done", {
      type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0,
      part: { type: "output_text", text, annotations: [] },
    });
  }
  out += ev("response.output_item.done", { type: "response.output_item.done", output_index: 0, item });
  out += ev("response.completed", { type: "response.completed", response: final });
  return out;
}

/** Minimal valid instance of a JSON Schema — emitted when the caller pins
 *  structured output (Gemini responseJsonSchema, OpenAI response_format).
 *  Plain PROBE_OK text makes such callers (e.g. Gemini's auto model router)
 *  retry until the ACP turn times out. */
function sampleFromSchema(schema: any): unknown {
  if (!schema || typeof schema !== "object") return "PROBE_OK";
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.const !== undefined) return schema.const;
  const type = Array.isArray(schema.type) ? schema.type.find((t: any) => t !== "null") : schema.type;
  switch (type) {
    case "array": return [sampleFromSchema(schema.items)];
    case "integer":
    case "number": return 1;
    case "boolean": return true;
    case "null": return null;
    case "string": return "PROBE_OK";
    default: {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(schema.properties ?? {})) out[k] = sampleFromSchema(v);
      return out;
    }
  }
}

/** Forced-JSON reply for a request, or null when the caller didn't pin one. */
function jsonModeText(body: any, gc?: any): string | null {
  const schema = gc?.responseJsonSchema ?? gc?.responseSchema ?? body?.response_format?.json_schema?.schema ?? body?.response_format?.json_schema;
  if (schema) return JSON.stringify(sampleFromSchema(schema));
  if (gc?.responseMimeType === "application/json" || body?.response_format?.type === "json_object") return "{}";
  return null;
}

function openaiResponse(body: any) {
  const tool = hasToolResult(body) ? null : pickToolCall(toolList(body), body);
  if (tool) { evidence().issuedCalls.push(tool); }
  const sawCanary = JSON.stringify(body).includes(CANARY);
  const message: any = tool
    ? {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: tool.id, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } },
        ],
      }
    : { role: "assistant", content: jsonModeText(body) ?? `PROBE_OK${sawCanary ? " CANARY_ACK" : ""} — exercised by acp-probe mock llm` };
  return {
    id: "chatcmpl-probe",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body?.model ?? "probe-model",
    choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
  };
}

/** SSE chunk sequence for `stream:true` chat completions — same tool
 *  decision as openaiResponse, emitted as deltas + [DONE]. */
function openaiSse(body: any): string {
  const tool = hasToolResult(body) ? null : pickToolCall(toolList(body), body);
  if (tool) { evidence().issuedCalls.push(tool); }
  const sawCanary = JSON.stringify(body).includes(CANARY);
  const base = {
    id: "chatcmpl-probe",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: body?.model ?? "probe-model",
  };
  const chunk = (delta: any, finish: string | null = null) =>
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  let out = chunk({ role: "assistant", content: tool ? null : "" });
  if (tool) {
    out += chunk({ tool_calls: [{ index: 0, id: tool.id, type: "function", function: { name: tool.name, arguments: "" } }] });
    out += chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(tool.args) } }] });
    out += chunk({}, "tool_calls");
  } else {
    out += chunk({ content: jsonModeText(body) ?? `PROBE_OK${sawCanary ? " CANARY_ACK" : ""} — exercised by acp-probe mock llm` });
    out += chunk({}, "stop");
  }
  return out + "data: [DONE]\n\n";
}

/** Gemini generateContent — parts carry functionCall or text. */
function geminiResponse(body: any) {
  const tool = hasToolResult(body) ? null : pickToolCall(toolList(body), body);
  if (tool) { evidence().issuedCalls.push(tool); }
  const sawCanary = JSON.stringify(body).includes(CANARY);
  const parts = tool
    ? [{ functionCall: { name: tool.name, args: tool.args } }]
    : [{ text: jsonModeText(body, body?.generationConfig) ?? `PROBE_OK${sawCanary ? " CANARY_ACK" : ""} — exercised by acp-probe mock llm` }];
  return {
    candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 3, totalTokenCount: 4 },
    modelVersion: "probe-model",
    responseId: "probe-gemini",
  };
}

function anthropicResponse(body: any) {
  const tool = hasToolResult(body) ? null : pickToolCall(toolList(body), body);
  if (tool) { evidence().issuedCalls.push(tool); }
  const sawCanary = JSON.stringify(body).includes(CANARY);
  const content = tool
    ? [{ type: "tool_use", id: tool.id, name: tool.name, input: tool.args }]
    : [{ type: "text", text: `PROBE_OK${sawCanary ? " CANARY_ACK" : ""} — exercised by acp-probe mock llm` }];
  return {
    id: "msg_probe",
    type: "message",
    role: "assistant",
    // echo the client's model — real clients reject a response whose model
    // differs from what they requested ("model may not exist")
    model: body?.model ?? "probe-model",
    content,
    stop_reason: tool ? "tool_use" : "end_turn",
    usage: { input_tokens: 1, output_tokens: 3 },
  };
}

/** Anthropic SSE sequence for stream:true requests. */
function anthropicSse(body: any): string {
  const tool = hasToolResult(body) ? null : pickToolCall(toolList(body), body);
  if (tool) { evidence().issuedCalls.push(tool); }
  const sawCanary = JSON.stringify(body).includes(CANARY);
  const model = body?.model ?? "probe-model";
  let out = ev("message_start", {
    type: "message_start",
    message: {
      id: "msg_probe", type: "message", role: "assistant", model,
      content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  if (tool) {
    out += ev("content_block_start", {
      type: "content_block_start", index: 0,
      content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} },
    });
    out += ev("content_block_delta", {
      type: "content_block_delta", index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.args) },
    });
    out += ev("content_block_stop", { type: "content_block_stop", index: 0 });
    out += ev("message_delta", {
      type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 },
    });
  } else {
    const text = `PROBE_OK${sawCanary ? " CANARY_ACK" : ""} — exercised by acp-probe mock llm`;
    out += ev("content_block_start", {
      type: "content_block_start", index: 0, content_block: { type: "text", text: "" },
    });
    out += ev("content_block_delta", {
      type: "content_block_delta", index: 0, delta: { type: "text_delta", text },
    });
    out += ev("content_block_stop", { type: "content_block_stop", index: 0 });
    out += ev("message_delta", {
      type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 },
    });
  }
  out += ev("message_stop", { type: "message_stop" });
  return out;
}

export function startMockLlm(port = 0): Promise<MockLlm> {
  const state: MockLlmEvidence = { seenTools: new Set(), issuedCalls: [], skippedCalls: [], requests: 0 };
  const server: Server = createServer((req, res) => mockContext.run(state, () => {
    state.requests++;
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => mockContext.run(state, () => {
      const url = req.url ?? "";
      const path = url.split("?")[0];
      let body: any = {};
      try { body = JSON.parse(raw || "{}"); } catch { /* leave {} */ }
      const json = (payload: unknown, code = 200) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const tools = Array.isArray(body?.tools) ? body.tools.length : 0;
      console.error(`  [mock] ${req.method} ${url} tools=${tools} stream=${!!body?.stream} msgs=${body?.messages?.length ?? body?.input?.length ?? "-"}`);
      // Claude Code pings {base}/api/hello as a connectivity check before any
      // real request; a 404 makes it declare the backend unreachable.
      if (path.endsWith("/api/hello")) return json({ message: "Hello" });
      // script word: the probe's cancel test sends __probe_slow__ and needs
      // the turn to still be open when session/cancel lands
      if (currentText(body).includes("__probe_slow__")) {
        setTimeout(() => {
          if (path.endsWith("/responses")) {
            const { output, tool } = responsesOutput(body);
            if (body?.stream) {
              res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
              res.end(responsesSse(output, tool, body?.model ?? "probe-model"));
            } else json(responseObject(output, body?.model ?? "probe-model"));
          } else if (url.includes(":streamGenerateContent")) {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.end(`data: ${JSON.stringify(geminiResponse(body))}\n\n`);
          } else if (url.includes(":generateContent")) json(geminiResponse(body));
          else if (path.endsWith("/chat/completions") || path.endsWith("/completions")) {
            if (body?.stream) {
              res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
              res.end(openaiSse(body));
            } else json(openaiResponse(body));
          }
          else if (path.endsWith("/messages")) {
            if (body?.stream) {
              res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
              res.end(anthropicSse(body));
            } else json(anthropicResponse(body));
          }
          else res.writeHead(404).end("not found");
        }, 8000).unref();
        return;
      }
      if (path.endsWith("/responses")) {
        const { output, tool } = responsesOutput(body);
        if (body?.stream) {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          res.end(responsesSse(output, tool, body?.model ?? "probe-model"));
          return;
        }
        return json(responseObject(output, body?.model ?? "probe-model"));
      }
      if (url.includes(":streamGenerateContent")) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end(`data: ${JSON.stringify(geminiResponse(body))}\n\n`);
        return;
      }
      if (url.includes(":generateContent")) return json(geminiResponse(body));
      if (url.includes(":countTokens")) return json({ totalTokens: 1 });
      if (path.endsWith("/chat/completions") || path.endsWith("/completions")) {
        if (body?.stream) {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          res.end(openaiSse(body));
          return;
        }
        return json(openaiResponse(body));
      }
      if (path.endsWith("/messages")) {
        if (body?.stream) {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          res.end(anthropicSse(body));
          return;
        }
        return json(anthropicResponse(body));
      }
      // includes() not endsWith(): kimchi fetches {base}/v1/models/metadata
      // (doubling /v1 when the configured endpoint already carries it) and
      // wants its own metadata shape — provider "ai-enabler" routes through
      // kimchi's openai-completions implementation at the same endpoint.
      if (path.includes("/models/metadata")) {
        return json({ models: [{ slug: "probe-model", display_name: "probe-model", provider: "ai-enabler", reasoning: false, input_modalities: ["text"], limits: { context_window: 128000, max_output_tokens: 16384 } }] });
      }
      if (path.includes("/models")) {
        if (url.includes("beta")) {
          return json({ models: [{ name: "models/probe-model", displayName: "probe-model", supportedGenerationMethods: ["generateContent", "streamGenerateContent"] }] });
        }
        return json({ object: "list", data: [{ id: "probe-model", object: "model" }] });
      }
      res.writeHead(404).end("not found");
    }));
  }));
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : port;
      resolve({ url: `http://127.0.0.1:${p}/v1`, close: () => { server.closeAllConnections(); server.close(); }, evidence: state });
    });
  });
}
