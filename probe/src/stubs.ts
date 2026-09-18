/**
 * The probe plays the CLIENT side of ACP: it must answer the agent's
 * reverse-direction calls (fs/*, terminal/*, session/request_permission).
 * These stubs return canned data and record every call so probes can assert
 * on what the agent asked for.
 */

export interface ClientCalls {
  fsReads: Array<{ path: string; sessionId?: string }>;
  fsWrites: Array<{ path: string; content: string; sessionId?: string }>;
  terminalCreates: Array<{ command: string; sessionId?: string }>;
  terminalCalls: Array<{ method: string; terminalId?: string }>;
  permissionRequests: Array<{ options: unknown[]; toolCall?: unknown }>;
  elicitations: Array<{ message?: string }>;
}

export const STUB_FILE_CONTENT = "PROBE_CANNED_FILE_CONTENT\nline two\n";

export function makeClientStubs(calls: ClientCalls) {
  const terminals = new Map<string, { command: string }>();
  let termSeq = 0;

  return async (method: string, params: any): Promise<unknown> => {
    switch (method) {
      case "fs/read_text_file": {
        calls.fsReads.push({ path: params?.path, sessionId: params?.sessionId });
        if (typeof params?.path !== "string" || !params.path.startsWith("/"))
          throw { code: -32602, message: "path must be absolute" };
        return { content: STUB_FILE_CONTENT };
      }
      case "fs/write_text_file": {
        calls.fsWrites.push({ path: params?.path, content: params?.content, sessionId: params?.sessionId });
        if (typeof params?.path !== "string" || !params.path.startsWith("/"))
          throw { code: -32602, message: "path must be absolute" };
        return {};
      }
      case "terminal/create": {
        const terminalId = `probe-term-${++termSeq}`;
        terminals.set(terminalId, { command: params?.command });
        calls.terminalCreates.push({ command: params?.command, sessionId: params?.sessionId });
        return { terminalId };
      }
      case "terminal/output": {
        calls.terminalCalls.push({ method, terminalId: params?.terminalId });
        const t = terminals.get(params?.terminalId);
        if (!t) throw { code: -32602, message: "unknown terminalId" };
        return {
          output: `stubbed output for: ${t.command}\n`,
          truncated: false,
          exitStatus: { exitCode: 0, signal: null },
        };
      }
      case "terminal/wait_for_exit": {
        calls.terminalCalls.push({ method, terminalId: params?.terminalId });
        return { exitCode: 0 };
      }
      case "terminal/kill":
      case "terminal/release": {
        calls.terminalCalls.push({ method, terminalId: params?.terminalId });
        return {};
      }
      case "session/request_permission": {
        const options = params?.options ?? [];
        calls.permissionRequests.push({ options, toolCall: params?.toolCall });
        const pick = options.find((o: any) => o?.kind === "allow_once") ?? options[0];
        return { outcome: { outcome: "selected", optionId: pick?.optionId } };
      }
      case "elicitation/create": {
        calls.elicitations.push({ message: params?.message });
        return { action: "accept", content: { probe: "accepted" } };
      }
      default:
        throw { code: -32601, message: `probe client does not implement ${method}` };
    }
  };
}
