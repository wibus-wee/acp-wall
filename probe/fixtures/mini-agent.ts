/**
 * mini-agent — honest but minimal: initialize + session/new + a bare
 * session/prompt that echoes with one update chunk. No load, no cancel
 * handling, never touches fs/terminal/permission.
 */
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
    case "session/new":
      return { sessionId: "sess-mini-1" };
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
