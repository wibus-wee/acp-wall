import { spawn } from "node:child_process";
import type { SetupResult } from "./report.js";

/** Setup stdout is kept off the ACP channel. A failed step prevents launch. */
export async function runSetup(commands: string[], env: NodeJS.ProcessEnv, cwd: string, timeout = 120_000): Promise<SetupResult> {
  for (let i = 0; i < commands.length; i++) {
    const result = await new Promise<{ code: number | null; diagnostic: string }>(resolve => {
      let diagnostic = "";
      let finished = false;
      const child = spawn(commands[i], { shell: true, cwd, env: { ...process.env, ...env }, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      const done = (code: number | null, detail?: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({ code, diagnostic: detail ?? diagnostic.trim().slice(-400) });
      };
      child.stdout?.resume();
      child.stderr?.on("data", b => { diagnostic = (diagnostic + b).slice(-2000); });
      const timer = setTimeout(() => {
        try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* process already exited */ }
        done(null, `Setup timed out after ${timeout}ms`);
      }, timeout);
      child.once("error", e => done(null, e.message));
      child.once("close", code => done(code));
    });
    if (result.code !== 0) return { status: "error", phase: "preparation", step: i + 1, note: `Setup step ${i + 1} exited ${result.code ?? "without status"}: ${result.diagnostic}` };
  }
  return { status: commands.length ? "pass" : "not-configured" };
}
