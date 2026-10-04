/** Shared report and UI vocabulary. Counts describe evidence, never a quality score. */
export const METHODOLOGY_VERSION = "2.1.0";
export const REASONS = {
  "not-advertised": "Not declared", "not-run": "No scenario run", "not-triggered": "Attempted, not triggered",
  "prerequisite": "Prerequisite unavailable", "policy-rejected": "Policy rejected the stimulus",
  "stimulus-unavailable": "No valid model stimulus", "no-client-callback": "No client callback",
  "profile-unavailable": "Profile not offered", "configuration-unconfirmed": "Configuration not confirmed",
  "agent-reported-unsupported": "Agent reports unsupported transport",
  "fixture-not-contacted": "Fixture not contacted", "handshake-incomplete": "Handshake incomplete",
  "tools-not-discovered": "Tools not discovered", "tool-not-called": "Tool not called",
  "timeout": "Timed out", "transport": "Transport inconclusive", "authentication": "Authentication required",
  "interactive-auth": "Interactive login required", "no-active-turn": "No cancellable turn", "isolated-session": "No isolated session", "fixture-error": "Fixture error",
};
export function reasonLabel(reason) { return REASONS[reason] ?? reason ?? "Reason not recorded"; }
export function uncertaintyReasons(methods = {}) {
  const counts = {};
  for (const key of new Set(COLUMNS.flatMap(([, keys]) => keys))) {
    const r = methods[key];
    if (r && ["na", "blocked"].includes(r.status)) counts[r.reason ?? "unspecified"] = (counts[r.reason ?? "unspecified"] ?? 0) + 1;
  }
  return counts;
}
export const STATUS = {
  pass: { label: "Verified", mark: "+", description: "The operation or interaction was observed successfully under the recorded conditions and passed applicable pinned checks." },
  observed: { label: "Observed", mark: "◐", description: "A response or part of a flow was observed; successful operation is not established." },
  blocked: { label: "Blocked", mark: "▣", description: "Authentication, configuration or another prerequisite prevented this check." },
  unsupported: { label: "Unsupported", mark: "−", description: "The method explicitly returned method_not_found. Optional absence is not a protocol violation." },
  fail: { label: "Issue", mark: "!", description: "A required or advertised method is absent, or a controlled protocol check failed." },
  partial: { label: "Schema issue", mark: "!", description: "Observed agent traffic failed a pinned schema or protocol check." },
  error: { label: "Probe error", mark: "×", description: "A test setup or client-side defect prevents a conclusion about the agent." },
  na: { label: "Unobserved", mark: "·", description: "This run did not produce enough evidence. No claim of absence is made." },
  mixed: { label: "Mixed evidence", mark: "◒", description: "The grouped methods have different outcomes. Open the record for each method." },
  legacy: { label: "Needs re-probe", mark: "?", description: "Historical result from an older measurement method; not revalidated." },
};

export const COLUMNS = [
  ["initialize", ["initialize"], "core"],
  ["authenticate", ["authenticate"], "core"],
  ["session/new", ["session/new"], "core"],
  ["session/load", ["session/load"], "optional"],
  ["session/prompt", ["session/prompt"], "core"],
  ["prompt:content", ["prompt:image", "prompt:embedded-context"], "optional"],
  ["sessions/*", ["session/list", "session/resume", "session/close", "session/delete"], "optional"],
  ["fork", ["session/fork"], "optional"],
  ["load:replay", ["load:replay"], "optional"],
  ["set_mode", ["set_mode"], "optional"],
  ["set_config", ["set_config"], "optional"],
  ["cancel", ["cancel"], "core"],
  ["logout", ["logout"], "optional"],
  ["message*", ["update:message"], "observation"],
  ["tool_call*", ["update:tool_call"], "observation"],
  ["usage", ["update:usage"], "observation"],
  ["permission", ["request_permission"], "observation"],
  ["plan", ["update:plan"], "observation"],
  ["slash_cmds", ["update:commands"], "observation"],
  ["fs/*", ["fs/read_text_file", "fs/write_text_file"], "observation"],
  ["terminal/*", ["terminal/*"], "observation"],
  ["elicitation", ["elicitation"], "observation"],
  ["providers", ["providers/list", "providers/set", "providers/disable"], "experimental"],
  ["nes", ["nes/start", "nes/suggest"], "experimental"],
  ["mcp", ["mcp:stdio", "mcp:http", "mcp:sse"], "observation"],
];

export function summarize(methods = {}) {
  const counts = Object.fromEntries(Object.keys(STATUS).map(s => [s, 0]));
  const keys = [...new Set(COLUMNS.flatMap(([, keys]) => keys))];
  for (const key of keys) counts[methods[key]?.status in counts ? methods[key].status : "na"]++;
  return { ...counts, total: keys.length };
}

export function cellsFromMethods(methods = {}) {
  return COLUMNS.map(([key, keys, scope]) => {
    const items = keys.map(method => ({ method, ...(methods[method] ?? { status: "na", note: "Not exercised in this run" }) }));
    const states = new Set(items.map(r => r.status));
    return { key, scope, status: states.size === 1 ? items[0].status : "mixed", items };
  });
}

export function runState(summary, setup, violations = [], methods = {}) {
  if (setup?.status === "error" || summary.error || Object.values(methods).some(r => r.status === "error") || violations.some(v => ["client-request", "client-response"].includes(v.where))) return "probe-error";
  if (summary.fail || summary.partial || violations.some(v => !["client-request", "client-response"].includes(v.where))) return "issues";
  if (summary.blocked) return "blocked";
  return summary.pass ? "measured" : "inconclusive";
}
