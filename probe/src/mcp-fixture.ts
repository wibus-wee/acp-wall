import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

export interface McpEvent { event: string; ts: number; name?: string }
export type McpMark = (event: string, extra?: { name?: string }) => void;

/** Shared fixture behavior across transports; SDK owns negotiation and framing. */
export function createMcpFixture(mark: McpMark) {
  const server = new Server({ name: "acp-probe-mcp", version: "0.2.0" }, { capabilities: { tools: {} } });
  server.oninitialized = () => mark("initialized");
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    mark("tools/list");
    return { tools: [{ name: "probe_noop", description: "Read-only no-op fixture for ACP measurement", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }] };
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    if (request.params.name !== "probe_noop") throw new McpError(ErrorCode.InvalidParams, "Unknown fixture tool");
    mark("tools/call", { name: request.params.name });
    return { content: [{ type: "text", text: "CANARY-7729 via mcp" }], isError: false };
  });
  return server;
}

export async function startHttpMcpFixture(kind: "http" | "sse") {
  const events: McpEvent[] = [];
  const mark: McpMark = (event, extra) => events.push({ event, ts: Date.now(), ...extra });
  const path = `/${randomUUID()}`;
  const connections = new Map<string, StreamableHTTPServerTransport | SSEServerTransport>();
  const peers = new Set<Server>();
  let origin = "";
  const http = createHttpServer((req, res) => {
    void (async () => {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) { res.writeHead(403).end(); return; }
      const url = new URL(req.url ?? "/", origin);
      if (kind === "sse") {
        if (req.method === "GET" && url.pathname === `${path}/sse`) {
          const transport = new SSEServerTransport(`${path}/messages`, res);
          const peer = createMcpFixture(mark); peers.add(peer);
          connections.set(transport.sessionId, transport);
          await peer.connect(transport); mark("connected");
          res.on("close", () => { connections.delete(transport.sessionId); peers.delete(peer); });
        } else if (req.method === "POST" && url.pathname === `${path}/messages`) {
          const transport = connections.get(url.searchParams.get("sessionId") ?? "");
          if (transport instanceof SSEServerTransport) await transport.handlePostMessage(req, res);
          else res.writeHead(404).end();
        } else res.writeHead(404).end();
        return;
      }
      if (url.pathname !== `${path}/mcp`) { res.writeHead(404).end(); return; }
      const id = req.headers["mcp-session-id"];
      let transport = typeof id === "string" ? connections.get(id) : undefined;
      if (!transport && !id && req.method === "POST") {
        const created = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true,
          onsessioninitialized: sessionId => { connections.set(sessionId, created); mark("connected"); } });
        const peer = createMcpFixture(mark); peers.add(peer);
        await peer.connect(created); transport = created;
      }
      if (transport instanceof StreamableHTTPServerTransport) await transport.handleRequest(req, res);
      else res.writeHead(typeof id === "string" ? 404 : 405).end();
    })().catch(() => { mark("fixture-error"); if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", () => { http.off("error", reject); resolve(); }); });
  const address = http.address();
  if (!address || typeof address === "string") throw Error("Missing MCP fixture address");
  origin = `http://127.0.0.1:${address.port}`;
  return { config: { type: kind, name: `acp-probe-${kind}`, url: `${origin}${path}/${kind === "http" ? "mcp" : "sse"}`, headers: [] }, events,
    close: async () => { await Promise.allSettled([...peers].map(p => p.close())); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); },
  };
}
