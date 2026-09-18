import type { MethodResult, Status, ViolationRec } from "./probes.js";
import type { TranscriptEntry } from "./rpc.js";

/** Cell order matches the wall's CAPS columns (19 methods/features). */
export const CELL_ORDER = [
  "initialize", "authenticate", "session/new", "session/load", "session/prompt",
  "sessions/*", "set_mode", "set_config", "cancel", "logout",
  "message*", "tool_call*", "permission", "plan", "slash_cmds",
  "fs/*", "terminal/*", "elicitation", "mcp",
] as const;

/** Map probe-result keys onto the wall's columns. */
const CELL_MAP: Record<string, string[]> = {
  "initialize": ["initialize"],
  "authenticate": ["authenticate"],
  "session/new": ["session/new"],
  "session/load": ["session/load"],
  "session/prompt": ["session/prompt"],
  "sessions/*": ["session/list", "session/resume", "session/close", "session/delete"],
  "set_mode": ["set_mode"],
  "set_config": ["set_config"],
  "cancel": ["cancel"],
  "logout": ["logout"],
  "message*": ["update:message"],
  "tool_call*": ["update:tool_call"],
  "permission": ["request_permission"],
  "plan": ["update:plan"],
  "slash_cmds": ["update:commands"],
  "fs/*": ["fs/read_text_file", "fs/write_text_file"],
  "terminal/*": ["terminal/*"],
  "elicitation": ["elicitation"],
  "mcp": ["mcp"],
};

const RANK: Record<Status, number> = { pass: 3, partial: 2, na: 1, fail: 0 };

function worst(results: Record<string, MethodResult>, keys: string[]): MethodResult | null {
  let w: MethodResult | null = null;
  for (const k of keys) {
    const r = results[k];
    if (!r) continue;
    if (w === null || RANK[r.status] < RANK[w.status]) w = r;
  }
  return w;
}

export interface Report {
  harness: string;
  agentName?: string;
  agentVersion?: string;
  specVersion: number;
  probedAt: string;
  score: number;
  tier: "honor" | "partial" | "shame";
  cells: number[]; // 1 pass · 2 partial · 0 fail · -1 n/a
  notes: Record<string, string>; // column → detail of the worst probe behind it
  methods: Record<string, MethodResult>;
  dishonesty: Array<{ claim: string; detail: string }>;
  violations: ViolationRec[];
  transcript: TranscriptEntry[];
}

export function buildReport(opts: {
  harness: string;
  initResult: any;
  results: Record<string, MethodResult>;
  dishonesty: Array<{ claim: string; detail: string }>;
  violations: ViolationRec[];
  transcript: TranscriptEntry[];
}): Report {
  const notes: Record<string, string> = {};
  const cells = CELL_ORDER.map((col) => {
    const keys = CELL_MAP[col] ?? [];
    const w = worst(opts.results, keys);
    if (w === null) return -1;
    if (w.note) notes[col] = w.note;
    return w.status === "pass" ? 1 : w.status === "partial" ? 2 : w.status === "fail" ? 0 : -1;
  });
  const counted = cells.filter((c) => c !== -1);
  const score = counted.length
    ? Math.round((counted.reduce((a: number, c) => a + (c === 1 ? 1 : c === 2 ? 0.5 : 0), 0) / counted.length) * 100)
    : 0;
  // Honor is for *demonstrated* coverage, not just a clean average:
  // ≥90 score AND ≥60% of columns actually verified (not ?/na).
  const verified = counted.length;
  let tier: Report["tier"] =
    score >= 90 && verified >= Math.ceil(CELL_ORDER.length * 0.6)
      ? "honor"
      : score >= 50
        ? "partial"
        : "shame";
  // Claimed-but-absent is worse than absent: liars can't sit on the honor wall.
  if (opts.dishonesty.length > 0 && tier === "honor") tier = "partial";
  if (opts.dishonesty.length > 0 && score < 70) tier = "shame";
  return {
    harness: opts.harness,
    agentName: opts.initResult?.agentInfo?.name,
    agentVersion: opts.initResult?.agentInfo?.version,
    specVersion: opts.initResult?.protocolVersion ?? 1,
    probedAt: new Date().toISOString(),
    score,
    tier,
    cells,
    notes,
    methods: opts.results,
    dishonesty: opts.dishonesty,
    violations: opts.violations,
    transcript: opts.transcript,
  };
}
