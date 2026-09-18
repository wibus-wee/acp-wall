/**
 * liar-agent — advertises capabilities it doesn't implement.
 * loadSession: true in initialize, but session/load → method_not_found.
 * session/prompt resolves without ever emitting session/update.
 * This is the wall of shame's raison d'être.
 */
import { RpcPeer } from "../src/rpc.js";

const peer = RpcPeer.stdio();

peer.onRequest = async (method, params: any) => {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true, // ← the lie
          promptCapabilities: { image: true, audio: true, embeddedContext: true },
          mcpCapabilities: { http: true, sse: true },
        },
        agentInfo: { name: "liar-agent", title: "Liar Agent", version: "9.9.9" },
        authMethods: [],
      };
    case "session/new":
      return { sessionId: "sess-liar-1" };
    case "session/load":
      throw { code: -32601, message: "method_not_found" }; // advertised, absent
    case "session/prompt":
      // Returns instantly, no session/update notifications, wrong-ish but
      // well-formed result.
      return { stopReason: "end_turn" };
    default:
      throw { code: -32601, message: "method_not_found" };
  }
};
