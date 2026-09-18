import { createServer, type Server } from "node:http";

/**
 * Minimal OpenAI/Anthropic-compatible endpoint so harnesses can be probed
 * without a real model. Deterministic, stateful script:
 *
 *   turn 1: if the agent offers tools → call the most permission-worthy one
 *           (bash/exec > write/edit > read), args synthesized from the tool's
 *           own declared JSON schema — a `rm -rf`-style command that an
 *           ask-policy harness must gate behind session/request_permission.
 *   turn 2: (request now carries the tool result) → final text. If the tool
 *           result contains the seeded CANARY-7729, the reply carries
 *           CANARY_ACK so the probe can verify end-to-end content flow.
 *
 *   no tools offered → plain text completion (PROBE_OK).
 */

export interface MockLlm {
  url: string;
  close: () => void;
}

const CANARY = "CANARY-7729";
const TOOL_COMMAND = "rm -rf ./probe-scratch && cat PROBE_CANARY.txt";

interface PickedTool {
  name: string;
  args: Record<string, unknown>;
}

/** counts tool_calls issued — rotates preference so sequential turns cover
 *  exec → write → read paths instead of always the same tool kind. */
let toolRound = 0;

/** Choose a permission-worthy tool and synthesize args from its JSON schema. */
function pickToolCall(tools: any[]): PickedTool | null {
  const norm = (tools ?? [])
    .map((t) => ({
      name: t?.function?.name ?? t?.name,
      params: t?.function?.parameters ?? t?.input_schema ?? t?.parameters ?? {},
    }))
    .filter((t) => typeof t.name === "string");
  if (norm.length === 0) return null;

  // our own MCP fixture tool wins outright — invoking it proves the full
  // client→agent→MCP→tool→result chain end to end
  const fixture = norm.find((t) => t.name === "probe_noop");
  if (fixture) return { name: fixture.name, args: {} };

  const base = [/bash|shell|exec|command|terminal|run|process/i, /write|edit|create|patch|apply/i, /read|open|view|cat|grep|search/i];
  const prefs = base.slice(toolRound % base.length).concat(base.slice(0, toolRound % base.length));
  let pick = norm[0];
  for (const re of prefs) {
    const hit = norm.find((t) => re.test(t.name));
    if (hit) { pick = hit; break; }
  }
  const writer = /write|edit|create|patch|apply/i.test(pick.name);

  const args: Record<string, unknown> = {};
  const props = pick.params?.properties ?? {};
  const required = new Set<string>(pick.params?.required ?? []);
  for (const [k, spec] of Object.entries<any>(props)) {
    const worth = required.has(k) || /command|cmd|path|file|content|text|description|prompt|input|query|url/i.test(k);
    if (!worth) continue;
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
    else if (type === "array") args[k] = [];
    else if (type === "object") args[k] = {};
  }
  if (Object.keys(args).length === 0) args.command = TOOL_COMMAND;
  return { name: pick.name, args };
}

const hasToolResult = (body: any): boolean => {
  const msgs = body?.messages ?? body?.input ?? [];
  if (!Array.isArray(msgs)) return false;
  return msgs.some(
    (m: any) =>
      m?.role === "tool" ||
      m?.type === "function_call_output" ||
      (Array.isArray(m?.content) && m.content.some((c: any) => c?.type === "tool_result"))
  );
};

/** OpenAI Responses API output items for a completed response. */
function responsesOutput(body: any): { output: any[]; tool: PickedTool | null } {
  const tool = hasToolResult(body) ? null : pickToolCall(body?.tools);
  if (tool) toolRound++;
  const sawCanary = JSON.stringify(body).includes(CANARY);
  const output = tool
    ? [
        {
          type: "function_call",
          id: "fc_probe_1",
          call_id: "call_probe_1",
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

function responseObject(output: any[]) {
  return {
    id: "resp_probe",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: "probe-model",
    output,
    usage: { input_tokens: 1, output_tokens: 3, total_tokens: 4 },
  };
}

/** SSE event sequence for a streamed Responses API reply. */
function responsesSse(output: any[], tool: PickedTool | null): string {
  const ev = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const final = responseObject(output);
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

function openaiResponse(body: any) {
  const tool = hasToolResult(body) ? null : pickToolCall(body?.tools);
  if (tool) toolRound++;
  const sawCanary = JSON.stringify(body).includes(CANARY);
  const message: any = tool
    ? {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_probe_1", type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } },
        ],
      }
    : { role: "assistant", content: `PROBE_OK${sawCanary ? " CANARY_ACK" : ""} — exercised by acp-probe mock llm` };
  return {
    id: "chatcmpl-probe",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "probe-model",
    choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
  };
}

function anthropicResponse(body: any) {
  const tool = hasToolResult(body) ? null : pickToolCall(body?.tools);
  if (tool) toolRound++;
  const sawCanary = JSON.stringify(body).includes(CANARY);
  const content = tool
    ? [{ type: "tool_use", id: "toolu_probe_1", name: tool.name, input: tool.args }]
    : [{ type: "text", text: `PROBE_OK${sawCanary ? " CANARY_ACK" : ""} — exercised by acp-probe mock llm` }];
  return {
    id: "msg_probe",
    type: "message",
    role: "assistant",
    model: "probe-model",
    content,
    stop_reason: tool ? "tool_use" : "end_turn",
    usage: { input_tokens: 1, output_tokens: 3 },
  };
}

export function startMockLlm(port = 0): Promise<MockLlm> {
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = req.url ?? "";
      let body: any = {};
      try { body = JSON.parse(raw || "{}"); } catch { /* leave {} */ }
      const json = (payload: unknown, code = 200) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const tools = Array.isArray(body?.tools) ? body.tools.length : 0;
      console.error(`  [mock] ${req.method} ${url} tools=${tools} stream=${!!body?.stream} msgs=${body?.messages?.length ?? body?.input?.length ?? "-"}`);
      // script word: the probe's cancel test sends __probe_slow__ and needs
      // the turn to still be open when session/cancel lands
      if (raw.includes("__probe_slow__")) {
        setTimeout(() => {
          if (url.endsWith("/responses")) {
            const { output, tool } = responsesOutput(body);
            if (body?.stream) {
              res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
              res.end(responsesSse(output, tool));
            } else json(responseObject(output));
          } else if (url.endsWith("/chat/completions") || url.endsWith("/completions")) json(openaiResponse(body));
          else if (url.endsWith("/messages")) json(anthropicResponse(body));
          else res.writeHead(404).end("not found");
        }, 8000);
        return;
      }
      if (url.endsWith("/responses")) {
        const { output, tool } = responsesOutput(body);
        if (body?.stream) {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          res.end(responsesSse(output, tool));
          return;
        }
        return json(responseObject(output));
      }
      if (url.endsWith("/chat/completions") || url.endsWith("/completions")) return json(openaiResponse(body));
      if (url.endsWith("/messages")) return json(anthropicResponse(body));
      if (url.endsWith("/models")) {
        return json({ object: "list", data: [{ id: "probe-model", object: "model" }] });
      }
      res.writeHead(404).end("not found");
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : port;
      resolve({ url: `http://127.0.0.1:${p}/v1`, close: () => server.close() });
    });
  });
}
