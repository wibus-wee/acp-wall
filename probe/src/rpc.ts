import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export type Dir = "out" | "in";
export interface TranscriptEntry {
  dir: Dir;
  kind: "req" | "res" | "notif" | "err";
  method?: string;
  summary: string;
  raw?: unknown;
  ts: number;
}
export type RequestHandler = (method: string, params: unknown) => Promise<unknown>;

const sum = (v: unknown, n = 140): string => {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > n ? s.slice(0, n) + "…" : s;
  } catch {
    return String(v);
  }
};

/** JSON-RPC 2.0 peer over newline-delimited JSON. */
export class RpcPeer {
  readonly proc?: ChildProcess;
  readonly transcript: TranscriptEntry[] = [];
  onRequest: RequestHandler = async (method) => {
    throw { code: -32601, message: `peer does not implement ${method}` };
  };
  onNotify: (method: string, params: unknown) => void = () => {};
  onExit: (code: number | null) => void = () => {};
  /** JSON-RPC envelope violations from the agent (non-JSON lines, result+error
   *  in one object, orphan response ids, missing jsonrpc:"2.0"). */
  onEnvelopeViolation: (msg: string) => void = () => {};
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }>();
  private closed = false;
  private out: Writable;

  private constructor(input: Readable, output: Writable, proc?: ChildProcess) {
    this.out = output;
    this.proc = proc;
    const rl = createInterface({ input });
    rl.on("line", (line) => this.handleLine(line));
    if (proc) {
      proc.stderr?.on("data", (d) => {
        const s = String(d).trim();
        if (s) this.log("in", "err", undefined, `[stderr] ${s.slice(0, 200)}`);
      });
      proc.on("exit", (code) => {
        this.closed = true;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error(`agent exited (code ${code})`));
        }
        this.pending.clear();
        this.onExit(code);
      });
      // A dead agent's stdin emits EPIPE asynchronously; without a handler it
      // crashes the probe before the exit event can report the real cause.
      this.out.on("error", (err) => {
        this.closed = true;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error(`agent stdin closed: ${(err as Error).message}`));
        }
        this.pending.clear();
      });
    }
  }

  /** Probe side: spawn a harness subprocess and talk ACP over its stdio. */
  static launch(cmdline: string, env: NodeJS.ProcessEnv = {}, cwd?: string): RpcPeer {
    const proc = spawn(cmdline, {
      shell: true,
      env: { ...process.env, ...env },
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (!proc.stdout || !proc.stdin) throw new Error("failed to spawn agent stdio");
    return new RpcPeer(proc.stdout, proc.stdin, proc);
  }

  /** Agent side: speak ACP over our own stdio (used by fixtures/tests). */
  static stdio(): RpcPeer {
    return new RpcPeer(process.stdin, process.stdout);
  }

  private log(dir: Dir, kind: TranscriptEntry["kind"], method: string | undefined, summary: string, raw?: unknown) {
    this.transcript.push({ dir, kind, method, summary, raw, ts: Date.now() });
  }

  private write(obj: unknown) {
    if (this.closed) return;
    this.out.write(JSON.stringify(obj) + "\n");
  }

  private handleLine(line: string) {
    const t = line.trim();
    if (!t) return;
    let msg: any;
    try {
      msg = JSON.parse(t);
    } catch {
      this.log("in", "err", undefined, `[non-json] ${t.slice(0, 200)}`);
      this.onEnvelopeViolation(`non-JSON line: ${t.slice(0, 80)}`);
      return;
    }
    if (msg?.jsonrpc !== "2.0") {
      this.onEnvelopeViolation(`missing/invalid jsonrpc field: ${t.slice(0, 80)}`);
    }
    if (msg.id !== undefined && msg.result !== undefined && msg.error !== undefined) {
      this.onEnvelopeViolation("response carries both result and error");
    }
    // error object shape is part of the envelope too: integer code + string message
    if (msg.error !== undefined) {
      const e = msg.error;
      if (e === null || typeof e !== "object" || typeof e.code !== "number" || !Number.isInteger(e.code) || typeof e.message !== "string") {
        this.onEnvelopeViolation(`malformed error object: ${sum(e, 80)}`);
      }
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) this.onEnvelopeViolation(`response for unknown id ${msg.id}`);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) {
          const detail = msg.error.data !== undefined ? ` — ${sum(msg.error.data?.details ?? msg.error.data, 120)}` : "";
          this.log("in", "res", undefined, `error ${msg.error.code}: ${sum(msg.error.message)}${detail}`, msg);
          p.reject(Object.assign(new Error((msg.error.message ?? "rpc error") + detail), { code: msg.error.code, data: msg.error.data }));
        } else {
          this.log("in", "res", undefined, `result ${sum(msg.result, 90)}`, msg);
          p.resolve(msg.result);
        }
      }
      return;
    }
    if (msg.id !== undefined && msg.method) {
      this.log("in", "req", msg.method, `← ${msg.method} ${sum(msg.params, 80)}`, msg);
      Promise.resolve()
        .then(() => this.onRequest(msg.method, msg.params))
        .then((result) => {
          this.log("out", "res", msg.method, `→ result ${sum(result, 90)}`);
          this.write({ jsonrpc: "2.0", id: msg.id, result: result ?? null });
        })
        .catch((e: any) => {
          const code = typeof e?.code === "number" ? e.code : -32603;
          const message = e?.message ?? String(e);
          this.log("out", "res", msg.method, `→ error ${code}: ${message}`);
          this.write({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
        });
      return;
    }
    if (msg.method) {
      this.log("in", "notif", msg.method, `← ${msg.method} ${sum(msg.params, 80)}`, msg);
      this.onNotify(msg.method, msg.params);
      return;
    }
  }

  request<T = any>(method: string, params?: unknown, timeoutMs = 15_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("peer is closed"));
    const id = this.nextId++;
    this.log("out", "req", method, `→ ${method} ${sum(params, 80)}`);
    this.write({ jsonrpc: "2.0", id, method, params: params ?? {} });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`${method} timed out after ${timeoutMs}ms`), { code: -32000, timeout: true }));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as any, reject, timer });
    });
  }

  notify(method: string, params?: unknown) {
    this.log("out", "notif", method, `→ ${method} ${sum(params, 80)}`);
    this.write({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  close() {
    this.closed = true;
    const proc = this.proc;
    if (proc) {
      try {
        proc.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {}
      }, 1500).unref();
    }
  }
}
