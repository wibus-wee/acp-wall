# Decision: improve probe evidence while preserving the league table

Date: 2026-10-04. Status: implemented in methodology 2.1.0.

## Problem and evidence

The published 2026-10-03 DimCode 0.5.6 report showed 25/100 despite no recorded
schema violations. Its preparation failed with “Custom provider adapter is
required”, then “Provider not found: probe”. Semicolon-separated startup continued,
and session creation later reported missing credentials. That chain measured a
broken test recipe rather than the agent's ability to operate after setup.

The old formula awarded zero credit to both unsupported and unobserved cells.
Authentication therefore reduced every downstream feature's apparent support.
Grouped methods used the worst result, so a successful session/list disappeared
behind an unimplemented session/delete. Conversely, some structured errors,
including method_not_found on core paths, were classified as successful support.

Source investigation found further measurement assumptions: earlier tool results
suppressed later mock stimuli; the MCP fixture preempted exec/read/write probes;
mode names were treated as permission guarantees; state notifications could be
mistaken for conversation replay; and client-side schema defects could downgrade
agent results.

## Decision

Use typed method evidence and causal prerequisites, preserve declarations
separately, and publish run provenance. Keep the existing UI, ranking, score and
tiers; measurement improvements do not authorize redesigning that presentation. Normal
probing respects negotiated capabilities. Diagnostic discovery is explicit.
Retain schema checks on actual traffic and distinguish the responsible side.

Detailed reports retain every grouped method. The original 24-column table uses
partial evidence when a group has both verified and unverified methods, so an
untested sibling cannot erase successful observations. Historical rankings stay
visible with their original timestamps; new probe evidence replaces them after
an actual run.

## Alternatives rejected

- **Remove ranks or redesign the UI:** exceeds the measurement task. The original
  page and ranked tiers are restored; richer evidence belongs in reports and
  existing case-file notes.
- **Exclude unknowns from the ranking denominator:** two successful observations
  could appear as 100% compatibility. The original denominator remains 24.
- **Treat all structured errors as passes:** this proves only rejection and
  can count a missing method as implemented.
- **Require real accounts for every run:** unnecessarily prevents useful
  unauthenticated and custom-provider discovery. Credentialed runs should
  complement these environments with explicit provenance.
- **Relax schema validation globally:** removes valuable evidence of actual
  wire incompatibility without fixing the observational assumptions.

## Experiments and lessons

- DimCode 0.5.6 accepted a custom provider with `--adapter openai` and isolated
  `DIMCODE_HOME`. The real ACP run then created sessions and completed prompt
  scenarios without a vendor login.
- A first revised mock run exposed asynchronous request-state loss. HTTP event
  handlers now bind state explicitly; concurrent mock-server isolation is covered
  by regression tests.
- Reusing the same model tool-call ID across turns produced misleading behavior
  in the real agent. Unique call IDs restored the exec/read/write sequence and
  allowed cancellation to be observed. Regression tests now assert uniqueness.
- Inspecting the first revised run's 15 unobserved checks exposed a replay
  false negative: the first load returned only state, while the second replayed
  conversation. Concatenating all speakers also hid matches when replay included
  user echoes absent from the live stream. The probe now matches by session and
  speaker, permits one additional load after an empty first attempt, and records
  both attempts. Tests cover user echoes, chunk boundaries, wrong sessions and
  wrong speakers. The repeated DimCode run recorded 17 verified observations,
  zero schema issues and 14 unobserved checks; its first load still had no
  conversation replay. Successful replay therefore does not establish reliable
  first-load behavior.
- DimCode's returned permission configuration was `read-only`; exec and write
  tool updates failed with `source: capability_rule`. Missing terminal, write
  and permission callbacks in that profile do not establish absent support.
  Explicit profiles now create distinct sessions and confirm the offered
  `permission` configuration before prompting. `workspace-write` produced a
  permission request, terminal callback and write callback; `full-access`
  produced terminal and write callbacks without a permission request. The
  default denials remain visible alongside those successes.
- A schema-valid `todowrite` stimulus produced the previously missing plan
  notification. Image and embedded-context prompts were accepted; this measures
  typed-input handling, without claiming image understanding or provider fidelity.
- SDK-backed HTTP and SSE fixtures completed tool calls under both configured
  permission profiles. Their default read-only scenarios discovered the tool but
  did not call the fixture. Stdio remained unconnected across all three profiles;
  DimCode stderr explicitly reported `ACP MCP stdio transport is unsupported`.
  The report retains this as an agent diagnostic, separate from a wire-level
  rejection. Independent SDK clients validated all three fixture transports.
- The expanded 35-check run recorded 25 verified observations, one diagnostic
  observation and nine unobserved checks, with zero schema issues. The nine
  unknowns comprise five undeclared interfaces and four checks without controlled
  scenarios. Scenario records preserve 21 separate sets of conditions instead
  of allowing profile successes to erase default-policy failures.

## Follow-up boundaries

The daily matrix can replace historical rows only after running the new probe.
Dedicated credentialed profiles, broader native-tool schema fixtures and a
historical trend view can extend this foundation. None should infer success from
mere endpoint rejection or infer absence from a missing observation.

The next coverage gaps are controlled elicitation, editor suggestion scenarios,
and isolated provider mutations. Image and embedded-context tests can additionally
track preservation through model adapters. Permission profiles for other agents
need documented configuration and real observations before joining the registry;
do not generalize DimCode's option values or policy semantics to other agents.

The current contract is maintained in [measurement.md](measurement.md); this
record owns the reasoning and experiments rather than duplicating that reference.
