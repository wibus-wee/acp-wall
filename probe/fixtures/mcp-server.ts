/** MCP stdio fixture; marker events are separate from the protocol stream. */
import { appendFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpFixture, type McpMark } from "../src/mcp-fixture.js";

const marker = process.env.MCP_MARKER;
if (!marker) throw Error("MCP_MARKER is required");
const mark: McpMark = (event, extra) => appendFileSync(marker, JSON.stringify({ event, ts: Date.now(), ...extra }) + "\n");
mark("spawned");
await createMcpFixture(mark).connect(new StdioServerTransport());
