# The Wall

A public ledger of ACP (Agent Client Protocol) compatibility. Every harness
claims "ACP support" — this repo asks a ruder question: *which methods, exactly?*

- **已验证 Verified** — probed methods exercise cleanly against the schema.
- **部分兼容 Partially compatible** — real support, with gaps.
- **兼容性有限 Limited** — most exercised methods missing or failing.

Compatibility is separate from honesty: a harness that advertises a method and
then answers `method_not_found` carries a `dishonesty` flag whatever its tier.

The site is a static page (`index.html` at the repo root — serve the repo or
open it directly). The data behind it is real: produced by `acp-probe`, a
schema-driven conformance probe that launches each harness as a child process,
exercises the protocol over stdio, and validates every message against the
official ACP JSON Schema.

## Layout

```
probe/              acp-probe — TypeScript, zero runtime deps
  schema/acp-schema.json   vendored official ACP JSON Schema (170 defs)
  src/schema.ts     JSON-Schema validator + x-method binding index
  src/rpc.ts        NDJSON JSON-RPC peer over child-process stdio
  src/stubs.ts      client-side handlers (fs/*, terminal/*, permission, elicitation)
  src/probes.ts     the probe suite — every call schema-checked both ways
  src/report.ts     cells → score → tier, dishonesty + violation detection
  src/mock-llm.ts   OpenAI-compatible scripted LLM endpoint
  src/cli.ts        `node dist/src/cli.js --cmd "..." | --entry registry/x.json`
  fixtures/         good / liar / mini agents used to self-test the probe
registry/
  agents/           GENERATED — synced from the official ACP registry
  overrides/        per-agent probe config (env wiring, run overrides, notes)
  fixture-*.json    selftest entries (probed in CI, never published)
tools/
  sync-registry.mjs official registry → registry/agents/*.json
  install-dist.mjs  fetch binary dists (per-platform, sha256-verified)
  aggregate.mjs     reports → data/conformance.js (consumed by the site)
data/conformance.js generated wall data — do not edit by hand
.github/workflows/  probe.yml (PR gate) + wall.yml (daily full matrix → aggregate → commit)
index.html          THE WALL — the production page
```

## Where the catalog comes from

The harness list is **not hand-maintained** — `tools/sync-registry.mjs` pulls the
official ACP registry (`cdn.agentclientprotocol.com/registry/v1/latest/registry.json`,
currently 41 agents) and turns each agent's `distribution` field into a launch
recipe: `npx` packages run as-is, `binary` dists are downloaded per-platform and
sha256-verified, `uvx` via uv. To get on the wall, a harness registers upstream
at agentclientprotocol.com — the wall mirrors and measures.

`registry/overrides/<id>.json` holds only *probe* config (e.g. which env var
points the agent at the mock LLM) — it never changes what the harness is.

## How the probe works

The probe is **schema-driven**, not vibes: every agent response is validated
against its bound `*Response` def, every `session/update` against
`SessionNotification`, every agent→client request against its `*Request` def —
and the probe validates *its own* outbound params too, so probe bugs surface as
`client-request` violations rather than false negatives.

Per-method probes cover the full protocol surface (18 columns): lifecycle
(`initialize`, `authenticate` — actually invoked, `session/new`, `session/load`,
`session/prompt`), session management (`session/list`, `resume`, `close`,
`delete` — gated by `sessionCapabilities`, destructive ops on disposable
sessions), config (`set_mode`, `set_config`), `cancel`, streaming
(`message*`, `tool_call*`, `plan`, `slash_cmds`), reverse calls
(`fs/*`, `terminal/*`, `permission`, `elicitation`), and `mcp`.

## Cell semantics

| cell | meaning |
|---|---|
| `✓` pass | method works and response validates against the schema |
| `~` partial | works but schema violations, or works-but-not-advertised, or the endpoint exists but rejected the call |
| `✗` fail | missing, errors, or claims support but fails when exercised |
| `·` n/a | reverse-direction capability the agent never exercised — client-side methods are only testable when the agent calls them |

No unverifiable cells: every agent-side method is always invoked (capability
flags only drive dishonesty checks, never skip calls). An endpoint that
answers `method_not_found` is absent; an endpoint that answers anything else —
including an auth error — exists. Client-side methods (`fs/*`, `terminal/*`,
`request_permission`, `elicitation`) can only be proven when the agent calls
them, so "never called" is a factual `·`, never a silent `✗`.

Three distinct failure flavors, kept separate on purpose:

- **absent** — `method_not_found` → `✗` (core methods) or `·` (optional ones)
- **claimed-but-absent** — advertised in `initialize` but `method_not_found`
  when exercised → `report.dishonesty`; dishonest harnesses cannot be marked
  verified
- **auth-blocked** — the endpoint exists but demands proprietary credentials
  (e.g. `kimi acp` requires Moonshot OAuth — issue #1330) → `✗`/`~` cells with
  the auth error as note. Requiring a vendor account is itself a wall-worthy
  fact: the probe is CI-driven and holds no accounts

Score = average over exercised cells (pass=1, partial=0.5); `·` cells don't
count. Tier: `≥90` **and** ≥60% cells exercised → verified · `≥50` → partial ·
else limited — then dishonesty adjustments.

## Running locally

```sh
cd probe && npm run build        # vendored typescript, zero other deps
# probe any command that speaks ACP on stdio (run from repo root):
node probe/dist/src/cli.js --cmd "opencode acp" --name opencode --llm
# or via a registry entry (paths are repo-root relative):
node tools/sync-registry.mjs      # refresh registry/agents/ from upstream
node probe/dist/src/cli.js --entry registry/agents/opencode.json --llm
# self-test against the three fixtures:
for e in good liar mini; do
  node probe/dist/src/cli.js --entry registry/fixture-$e.json --out probe/reports/fixture-$e.report.json
done
# regenerate wall data:
node tools/aggregate.mjs
# then open index.html — it loads data/conformance.js live
```

Expected self-test results: `fixture-good` → 100/verified · `fixture-mini` →
partial · `fixture-liar` → limited with `dishonesty: loadSession`.

## Appealing a result

Reports ship with the full NDJSON transcript (`--transcript`) plus the exact
schema violations (`report.violations`). If a harness thinks a cell is wrong:
open an issue referencing the report + transcript, or PR a probe fix.
`workflow_dispatch` on `wall.yml` re-runs a single agent.
