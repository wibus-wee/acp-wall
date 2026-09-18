/**
 * good-agent — a fully conformant stub ACP agent.
 * Exercises: initialize, session/new, session/load, session/prompt
 * (with message/tool_call/plan updates + fs/permission reverse calls),
 * and cancellable prompts via session/cancel.
 */
import { RpcPeer } from "../src/rpc.js";

const peer = RpcPeer.stdio();
let releaseSlow: (() => void) | null = null;

peer.onRequest = async (method, params: any) => {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          mcpCapabilities: { http: true, sse: false },
        },
        agentInfo: { name: "good-agent", title: "Good Agent", version: "0.1.0" },
        authMethods: [],
      };
    case "session/new":
      return { sessionId: "sess-good-1" };
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
      const file = (await peer.request("fs/read_text_file", { sessionId: sid, path: "/etc/hostname" })) as any;
      peer.notify("session/update", {
        sessionId: sid,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          title: "Run tests",
          kind: "execute",
          status: "in_progress",
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
