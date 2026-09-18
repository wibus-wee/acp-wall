/**
 * good-agent — a fully conformant stub ACP agent.
 * Exercises: initialize, session/new, session/load, session/prompt
 * (with message/tool_call/plan updates + fs/permission reverse calls),
 * cancellable prompts via session/cancel, and the full MCP stdio chain
 * (spawn → initialize → tools/list → tools/call on the probe fixture).
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { RpcPeer } from "../src/rpc.js";

const peer = RpcPeer.stdio();
let releaseSlow: (() => void) | null = null;

/** Minimal MCP stdio client — enough to prove the full tool chain. */
function mcpConnect(server: any) {
  const child = spawn(server.command, server.args ?? [], {
    env: { ...process.env, ...Object.fromEntries((server.env ?? []).map((e: any) => [e.name, e.value])) },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const pending = new Map<number, (v: any) => void>();
  let nextId = 1;
  createInterface({ input: child.stdout! }).on("line", (line) => {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    }
  });
  const send = (m: any) => child.stdin!.write(JSON.stringify(m) + "\n");
  const request = (method: string, params: any) =>
    Promise.race([
      new Promise<any>((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        send({ jsonrpc: "2.0", id, method, params });
      }),
      new Promise<any>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
  const notify = (method: string) => send({ jsonrpc: "2.0", method });
  return { request, notify };
}

const mcpClients: Array<ReturnType<typeof mcpConnect>> = [];

peer.onRequest = async (method, params: any) => {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          mcpCapabilities: { http: true, sse: false },
          // acp-extension-core: Lody contracts ride _meta.lody on the standard
          // capability map, each feature independently versioned.
          _meta: {
            lody: {
              rateLimits: { version: 1 },
              goal: {
                version: 1,
                actions: ["set", "pause", "resume", "clear"],
                controlActions: ["pause", "clear"],
                promptActions: ["set", "resume", "pause", "clear"],
              },
              worktreeProject: { version: 1 },
              task: { version: 1 },
            },
          },
        },
        agentInfo: { name: "good-agent", title: "Good Agent", version: "0.1.0" },
        authMethods: [],
      };
    case "session/new": {
      // connect every configured stdio MCP server: handshake + discovery
      for (const s of params?.mcpServers ?? []) {
        if (!s?.command) continue;
        const c = mcpConnect(s);
        await c.request("initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "good-agent", version: "0.1.0" },
        });
        c.notify("notifications/initialized");
        await c.request("tools/list", {});
        mcpClients.push(c);
      }
      return { sessionId: "sess-good-1" };
    }
    case "session/load": {
      const sid = params?.sessionId;
      peer.notify("session/update", {
        sessionId: sid,
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "earlier question" } },
      });
      peer.notify("session/update", {
        sessionId: sid,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "earlier answer" } },
      });
      return {};
    }
    case "session/prompt": {
      const text = params?.prompt?.[0]?.text ?? "";
      if (text.includes("__probe_slow__")) {
        // Hold the turn until session/cancel arrives.
        return await new Promise((resolve) => {
          releaseSlow = () => resolve({ stopReason: "cancelled" });
        });
      }
      // A normal turn: stream chunks, read a file, emit tool_call + plan,
      // ask permission, then finish.
      const sid = params.sessionId;
      peer.notify("session/update", {
        sessionId: sid,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reading your file…" } },
      });
      // exercise connected MCP servers end to end
      for (const c of mcpClients) {
        await c.request("tools/call", { name: "probe_noop", arguments: {} });
      }
      const file = (await peer.request("fs/read_text_file", { sessionId: sid, path: "/etc/hostname" })) as any;
      peer.notify("session/update", {
        sessionId: sid,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          title: "Run tests",
          kind: "execute",
          status: "in_progress",
          // lody ext: canonical tool identity rides the standard envelope
          _meta: { lody: { toolName: "Bash" } },
        },
      });
      const term = (await peer.request("terminal/create", { sessionId: sid, command: "npm test" })) as any;
      await peer.request("terminal/output", { sessionId: sid, terminalId: term.terminalId });
      await peer.request("terminal/wait_for_exit", { sessionId: sid, terminalId: term.terminalId });
      await peer.request("terminal/release", { sessionId: sid, terminalId: term.terminalId });
      peer.notify("session/update", {
        sessionId: sid,
        update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" },
      });
      peer.notify("session/update", {
        sessionId: sid,
        update: { sessionUpdate: "plan", entries: [{ content: "verify protocol", priority: "high", status: "completed" }] },
      });
      peer.notify("session/update", {
        sessionId: sid,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "probe", description: "probe cmd" }],
        },
      });
      await peer.request("session/request_permission", {
        sessionId: sid,
        toolCall: { toolCallId: "tc-2", title: "write file" },
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      });
      await peer.request("fs/write_text_file", {
        sessionId: sid,
        path: "/tmp/probe-out.txt",
        content: "agent wrote this\n",
      });
      peer.notify("session/update", {
        sessionId: sid,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `done — file said: ${file.content?.split("\n")[0]}` } },
      });
      return { stopReason: "end_turn" };
    }
    // _lody/* extension namespace (acp-extension-core) — read-only surface.
    case "_lody/rate_limits/get":
      return { rateLimits: [], fetchedAtEpochSeconds: Math.floor(Date.now() / 1000) };
    case "_lody/subagents/list":
      return { tasks: [] };
    case "_lody/session/history/read":
      return {};
    case "_lody/session/goal":
      return { goal: null };
    default:
      throw { code: -32601, message: "method_not_found" };
  }
};

peer.onNotify = (method, params: any) => {
  if (method === "session/cancel" && releaseSlow) {
    releaseSlow();
    releaseSlow = null;
  }
};
