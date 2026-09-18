/**
 * Minimal MCP stdio server fixture. The probe passes it to session/new via
 * mcpServers; if the agent actually connects, the handshake lands here and we
 * write a marker file the probe can check — deterministic MCP evidence.
 *
 * Speaks newline-delimited JSON-RPC (MCP stdio transport).
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const MARKER = process.env.MCP_MARKER ?? "/tmp/acp-mcp-marker.json";

function mark(event: string, extra: Record<string, unknown> = {}) {
  appendFileSync(MARKER, JSON.stringify({ event, ts: Date.now(), ...extra }) + "\n");
}

mark("spawned", { pid: process.pid });

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg: any;
  try {
    msg = JSON.parse(t);
  } catch {
    return;
  }
  if (msg.method === "initialize" && msg.id !== undefined) {
    mark("initialize", { params: msg.params });
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "acp-probe-mcp", version: "0.1.0" },
        },
      }) + "\n"
    );
    return;
  }
  if (msg.method === "notifications/initialized") {
    mark("initialized");
    return;
  }
  if (msg.method === "tools/list" && msg.id !== undefined) {
    mark("tools/list");
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [
            {
              name: "probe_noop",
              description: "No-op tool used by acp-probe",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      }) + "\n"
    );
    return;
  }
  if (msg.method === "tools/call" && msg.id !== undefined) {
    mark("tools/call", { name: msg.params?.name });
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: "CANARY-7729 via mcp" }], isError: false },
      }) + "\n"
    );
    return;
  }
  if (msg.method === "ping" && msg.id !== undefined) {
    mark("ping");
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n");
    return;
  }
  if (msg.id !== undefined) {
    mark("other", { method: msg.method });
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\n"
    );
  }
});
