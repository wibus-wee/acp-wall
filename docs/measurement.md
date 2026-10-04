# Measurement contract

Methodology version **2.1.0** · report format **2**.

The Wall measures protocol observations under stated conditions. It does not
estimate coding ability, certify complete ACP conformance, or infer absent
capabilities from a run that could not exercise them. The executable vocabulary
is [evidence.js](../probe/src/evidence.js); the probe implementation is
[probes.ts](../probe/src/probes.ts).

## Evidence states

| State | Required evidence | Interpretation |
| --- | --- | --- |
| `pass` | Successful operation or observed interaction, with applicable pinned message checks passing | Verified for this scenario and environment. |
| `observed` | Structured rejection, partial flow or successful unbound endpoint | Evidence exists, but successful schema-checked operation is unproven. |
| `blocked` | Authentication requirement or unavailable scenario prerequisite | Follow `blockedBy` to the originating check. |
| `unsupported` | Explicit `-32601` for an optional, unadvertised method in diagnostic discovery | Optional absence, not a conformance failure. |
| `fail` | Required/advertised method returns `-32601`, or a controlled protocol assertion fails | A specific issue, not a whole-agent grade. |
| `partial` | Observed agent traffic violates a pinned schema or local protocol assertion | Schema/protocol issue with diagnostics. |
| `error` | Invalid probe request/reply or a probe implementation exception | Probe defect; no negative capability inference. |
| `na` | Not invoked, not triggered, timeout or uncertain transport result | Insufficient evidence. |

`mixed` is a display state for grouped methods with differing outcomes. The
underlying method results remain intact. `legacy` identifies older methodology;
old numeric grades are never converted into current evidence.

Counts include the 35 individual checks behind the 25 displayed surfaces. They
are inventory counts, without weights, denominator-based scores or thresholds
for certification. An overall run label describes observed issues, blockers,
probe errors or completed measurements. A `measured` run can have many unobserved
features; it does not mean all capabilities were tested. Schema diagnostics
outside a matrix column remain visible at run level.

Missing evidence also has a `reason`: undeclared methods, omitted scenarios,
unavailable stimuli, policy rejection, missing callbacks, unmet prerequisites,
timeouts and transport uncertainty remain distinct. Reports and the detail view
summarize these causes without adding a new score. Raw status alone cannot tell
whether a scenario was attempted.

## Protocol and environment boundaries

The probe negotiates ACP protocol version 1. Its vendored schema is identified by
SHA-256, and the report includes methodology version, executed probe source
hash, dependency lock hash, MCP SDK version, repository revision/dirty status,
agent version, platform and Node version.
A hash identifies the checked snapshot; it is not a claim that the snapshot is
the latest upstream specification. The local validator implements the schema
constructs described in [schema.ts](../probe/src/schema.ts) and ignores format
annotations. A schema pass is limited to those checks.

Surfaces are separated into core lifecycle, capability-gated optional methods,
observed client interactions and experimental methods. Capability negotiation
controls normal optional calls. `--discover` is an explicit diagnostic mode
that may invoke unadvertised optional methods; results from it must retain that
run configuration. Authentication is never tested with an invented method ID.
Terminal login is not automatically launched. Interactive login needs a separate
authenticated environment and rerun.

A run records whether a mock model endpoint was configured and how many requests
reached it. Model-side evidence lists offered tools, issued tools and scenarios
that could not construct a matching valid tool call. An unused mock is not a
successful mock test. MITM transport interception, when enabled, is disclosed in
the report. Real-provider results require their own provenance and cannot be
inferred from mock behavior.

Client file, terminal, permission and elicitation handlers are simulated.
Observed client interactions establish message exchange with those handlers;
they do not prove real terminal execution or file persistence. Internal agent
tools are allowed and their absence from client callbacks is not an issue.

## Scenario sequence and prerequisites

1. Complete configured preparation in the temporary workspace. On failure,
   publish the failed step and do not launch ACP.
2. Initialize, optionally authenticate when explicitly configured, and create a
   minimal session without extra MCP dependencies.
3. Submit independent exec, read, write and plan scenarios. The scripted model targets
   the current user turn; earlier tool results do not suppress later stimuli.
   Every issued tool call has a unique ID and schema-checked arguments.
4. Observe cancellation while a prompt is pending. A cancellation result proves
   that interaction; other completions remain inconclusive because of races.
5. Probe declared session and configuration operations. Destructive lifecycle
   operations use separate sessions and never fall back to the working session.
6. Exercise explicit registry permission profiles in distinct sessions, requiring
   the exact configured option to be offered and confirmed in the response.
   Run typed image and embedded-resource prompts when declared.
7. Exercise stdio MCP and declared HTTP/SSE transports in separate sessions for
   the default and configured profiles. Inspect fixture connection, handshake,
   discovery and call evidence. A handshake alone is observed, not full tool use.
8. Collect notifications, reverse calls, extension observations and diagnostics.
   End authentication-state tests only when applicable.

Each outgoing request is checked before sending. Invalid probe input is recorded
as a client defect, not sent and not charged to the agent. Notification violations
retain their actual feature key; a malformed tool notification does not downgrade
an unrelated text stream. Client response violations are also probe defects.

Structured errors prove only that a request was rejected. `method_not_found` is
classified before broader structured-error handling. Authentication errors block
the dependent scenario. Unknown sessions, invalid parameters and internal errors
are not successful operations.

Scenario records contain IDs, session IDs, returned configuration, model stimuli,
tool outcomes, notifications and client callback counts. Counts exclude callbacks
from other sessions. A successful prompt response does not imply successful tool
execution. The default scenario remains in the report when another profile
succeeds. Registry `probeProfiles` entries contain `id`, `configId`, `value` and
`description`; unavailable or unconfirmed options prevent those prompts.

Mode names do not establish permission policy. A failed tool call is not proof
of execution or permission bypass. No requirement to call a particular client
API, emit a plan or return particular prose is inferred from a prompt.

Image and embedded-context checks establish acceptance of typed input and a valid
prompt response. They do not establish image understanding, input preservation
through the provider adapter or real-model behavior.

MCP fixtures share an implementation built on the official SDK, tested through
SDK clients for all three transports. HTTP listeners bind to loopback and reject
unrelated origins/hosts. The fixture offers only a read-only no-op. The pinned
[ACP setup schema](../probe/schema/acp-schema.json) gates HTTP/SSE; see the
[MCP transport specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)
for wire framing. Each transport has a separate method result and per-profile
scenario records. A verified transport means at least one recorded profile
received the fixture call; it does not erase failed or absent calls in others.
An agent's stderr statement of unsupported transport is diagnostic evidence
(`observed`), separate from a structured JSON-RPC rejection or a conformance
assertion. Bounded stderr excerpts are retained with the corresponding scenario.

Replay is checked before forking, against conversation text captured for the same
session and speaker. User echoes in replay and different chunk boundaries are
permitted; command lists and usage updates cannot prove replay. If the first load
returns no conversation text, one further load is attempted. Both attempts are
recorded, and a successful second attempt retains the empty first attempt in its
note. Only notifications received before each load response count for that
attempt. Unmatched replay is retained as observed or unobserved rather than a
guessed loss of conversation. This check establishes an observed replay; it does
not prove first-load reliability or arbitrary history fidelity.

## Publication and reproduction

The [aggregator](../tools/aggregate.mjs) uses the same vocabulary as the probe and
website. It never overwrites a newer run with an older report. Partial matrix
runs preserve prior timestamps; the dataset assembly time is not a measurement
time. A newer failed attempt remains visible rather than silently preserving a
previous successful appearance.

Current public reports preserve method outcomes, capability declarations,
model-side scenario evidence, attempts, diagnostics and provenance. Full wire
transcripts are stored in the CI artifact. Reports from local runs explicitly
record local source modifications. The schema/source hashes make differences
visible but do not replace committing and archiving the corresponding source.

Use the recorded agent version and registry recipe, then run:

```sh
npm test --prefix probe
node probe/dist/src/cli.js --entry registry/agents/dimcode.json \
  --out probe/reports/dimcode.report.json --transcript
```

Freshness is an operational hint: the page marks records older than seven days
stale. It cannot infer whether an untested newer release behaves identically.

## Remaining limits

- Elicitation, provider mutations and editor suggestions still lack controlled
  scenarios; their absence is recorded as `not-run`.
- Native tool schemas and provider APIs vary. Skipped stimuli remain visible;
  they need provider-specific fixtures before stronger claims are possible.
- Simulated client services do not verify real filesystem or process effects.
- Stream observation is not a complete state-machine or event-order proof.
- Experimental methods follow the vendored snapshot and may drift upstream.
- CI currently records the latest run per agent. Long-term regression history
  remains in Git and CI artifacts; a dedicated history store is future work.
- Credentialed testing needs dedicated accounts and explicit environment
  provenance. Unauthenticated discovery cannot answer credential-dependent questions.
