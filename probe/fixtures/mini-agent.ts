/**
 * mini-agent — honest but minimal: initialize + session/new + a bare
 * session/prompt that echoes with one update chunk. No load, no cancel
 * handling, never touches fs/terminal/permission. Spawns configured MCP
 * servers and completes the handshake — but never discovers or calls tools,
 * exercising the probe's handshake-only partial rung.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { RpcPeer } from "../src/rpc.js";

const peer = RpcPeer.stdio();

peer.onRequest = async (method, params: any) => {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
        agentInfo: { name: "mini-agent", title: "Mini Agent", version: "0.0.1" },
        authMethods: [],
      };
    case "session/new": {
      // handshake only: spawn + initialize + initialized, then stop there
      for (const s of params?.mcpServers ?? []) {
        if (!s?.command) continue;
        const child = spawn(s.command, s.args ?? [], {
          env: { ...process.env, ...Object.fromEntries((s.env ?? []).map((e: any) => [e.name, e.value])) },
          stdio: ["pipe", "pipe", "inherit"],
        });
        const rl = createInterface({ input: child.stdout! });
        rl.on("line", (line) => {
          let msg: any;
          try { msg = JSON.parse(line); } catch { return; }
          if (msg.id === 1) {
            child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
            rl.close();
          }
        });
        child.stdin!.write(JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "mini-agent", version: "0.0.1" } },
        }) + "\n");
      }
      return { sessionId: "sess-mini-1" };
    }
    case "session/prompt": {
      const sid = params.sessionId;
      peer.notify("session/update", {
        sessionId: sid,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "echo" } },
      });
      // Slow prompts just finish — cancel can't be proven here.
      return { stopReason: "end_turn" };
    }
    default:
      throw { code: -32601, message: "method_not_found" };
  }
};
