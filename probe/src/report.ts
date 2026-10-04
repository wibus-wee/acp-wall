import type { Attempt, ExtSurface, LodyProbeInfo, MethodResult, ViolationRec, ScenarioEvidence } from "./probes.js";
import type { TranscriptEntry } from "./rpc.js";

import { COLUMNS, METHODOLOGY_VERSION, cellsFromMethods, summarize, runState, uncertaintyReasons } from "./evidence.js";
import { schema } from "./schema.js";

export const CELL_ORDER = COLUMNS.map(([key]) => key);
export interface SetupResult { status: "pass" | "error" | "not-configured"; step?: number; note?: string; phase?: "preparation" | "installation" | "execution" }
export interface RunEnvironment {
  profile: "mock" | "external-provider" | "not-started";
  discovery?: boolean;
  authenticationAttempted?: boolean;
  recipeSha256?: string;
  platform: string;
  node: string;
  revision?: string;
  sourceDirty?: boolean;
  sourceHash?: string;
  dependencySha256?: string;
  mcpSdkVersion?: string;
  ciUrl?: string;
  command?: string;
  mockRequests?: number;
  client: "simulated";
  modelEvidence?: { seenTools: string[]; issuedTools: string[]; skippedCalls: string[] };
}

export interface Report {
  harness: string;
  agentName?: string;
  agentVersion?: string;
  specVersion: number;
  probedAt: string;
  reportVersion: 2;
  methodologyVersion: string;
  schemaSha256: string;
  state: string;
  summary: Record<string, number>;
  cells: ReturnType<typeof cellsFromMethods>;
  setup: SetupResult;
  environment?: RunEnvironment;
  advertised: any;
  notes: Record<string, string>;
  methods: Record<string, MethodResult>;
  claimMismatches: Array<{ claim: string; detail: string }>;
  violations: ViolationRec[];
  transcript: TranscriptEntry[];
  attempts?: Attempt[];
  scenarios?: ScenarioEvidence[];
  uncertaintyReasons: Record<string, number>;
  /** Lody extension evidence (acp-extension-core) — `_meta.lody` capabilities
   * advertised, `_lody/*` endpoints that answered, `_meta.lody.*` keys seen on
   * wire traffic. Kept separate from standard protocol evidence. */
  lody?: LodyProbeInfo;
  /** Generic extension surface — every `_meta` namespace advertised (caps,
   * top-level, authMethods) and every `_meta.<ns>.<key>` pair seen on wire.
   * Vendor-agnostic; lody is just one namespace here. */
  ext?: ExtSurface;
  /** Disclosed when the probe impersonated model endpoints at the transport
   * layer (transparent SNI proxy) rather than via documented config. */
  transport?: {
    mitm?: {
      port: number;
      impersonated: string[];
      impersonations: number;
      relayed: number;
      drops: number;
    };
  };
}

export function buildReport(opts: {
  harness: string;
  initResult: any;
  results: Record<string, MethodResult>;
  dishonesty: Array<{ claim: string; detail: string }>;
  violations: ViolationRec[];
  transcript: TranscriptEntry[];
  attempts?: Attempt[];
  scenarios?: ScenarioEvidence[];
  setup?: SetupResult;
  environment?: RunEnvironment;
  lody?: LodyProbeInfo;
  ext?: ExtSurface;
  transport?: Report["transport"];
}): Report {
  const cells = cellsFromMethods(opts.results);
  const summary = summarize(opts.results);
  const setup = opts.setup ?? { status: "not-configured" as const };
  return {
    reportVersion: 2,
    methodologyVersion: METHODOLOGY_VERSION,
    schemaSha256: schema.sha256,
    harness: opts.harness,
    agentName: opts.initResult?.agentInfo?.name,
    agentVersion: opts.initResult?.agentInfo?.version,
    specVersion: opts.initResult?.protocolVersion ?? 1,
    advertised: { capabilities: opts.initResult?.agentCapabilities ?? {}, authMethods: opts.initResult?.authMethods ?? [] },
    probedAt: new Date().toISOString(),
    state: runState(summary, setup, opts.violations, opts.results),
    summary,
    setup,
    environment: opts.environment,
    cells,
    notes: Object.fromEntries(cells.map(c => [c.key, c.items.map(i => `${i.method}: ${i.note ?? i.status}`).join(" · ")])),
    methods: opts.results,
    claimMismatches: opts.dishonesty,
    violations: opts.violations,
    transcript: opts.transcript,
    attempts: opts.attempts ?? [],
    scenarios: opts.scenarios ?? [],
    uncertaintyReasons: uncertaintyReasons(opts.results),
    lody: opts.lody,
    ext: opts.ext,
    transport: opts.transport,
  };
}
