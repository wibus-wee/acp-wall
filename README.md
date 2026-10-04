# The Wall

The Wall is an independent evidence ledger for Agent Client Protocol (ACP)
implementations. It records observed operations, capability declarations,
authentication blockers and test failures with their version and environment.
It does not assign an overall compatibility score or certify agents.

| Area | Location | Responsibility |
| --- | --- | --- |
| Measurement contract | [Methodology](docs/measurement.md) | Defines evidence states, test conditions and interpretation limits. |
| Probe | [probe/src](probe/src) | Runs ACP scenarios over stdio, validates messages and records attempts. |
| Shared vocabulary | [evidence.js](probe/src/evidence.js) | Owns matrix columns, status labels and counts used by reports and the site. |
| Agent catalog | [registry](registry) | Mirrors the official registry; overrides configure controlled test environments. |
| Publication | [aggregate.mjs](tools/aggregate.mjs) | Publishes reports, preserves newer records and labels historical measurements. |
| Website | [index.html](index.html), [assets](assets) | Searchable evidence matrix, comparison, method details and report downloads. |
| Verification | [probe/tests](probe/tests), [CI workflows](.github/workflows) | Regression tests, complete fixtures and daily agent measurements. |

## Read a result

A verified cell means the observed operation succeeded under the recorded
conditions and passed the applicable pinned schema checks. A blocked cell means
a prerequisite was unavailable. Unobserved means the run produced insufficient
evidence; it does not mean unsupported. An unsupported optional method is not a
protocol violation. Grouped cells preserve each method's result.

Open a matrix cell to see its method outcomes, dependencies, schema diagnostics,
agent version, measurement time, source revision and environment. Missing
evidence is grouped by cause. Scenario records retain default and configured
permissions, failed tools, callbacks, MCP events and request attempts. Use the
scenario profile filter to inspect a specific configuration. Filter the matrix by
agent, outcome or surface; select up to four agents to compare. Filters and
record links are shareable through the URL. `Cmd/Ctrl+K` focuses search.

Records from the old scoring method retain their historical notes and timestamps
but display **Needs re-probe**. They are not relabeled as freshly verified.
The assembly timestamp is distinct from each agent's probe timestamp. Records
older than seven days are marked stale. See the [measurement contract](docs/measurement.md)
for the complete interpretation rules.

## Run locally

Use Node.js 24 or later. MCP fixtures use the pinned official TypeScript SDK.
Install the locked dependencies before building or running the probe.

```sh
npm ci --prefix probe
npm test --prefix probe
node probe/dist/src/cli.js --entry registry/agents/dimcode.json \
  --out probe/reports/dimcode.report.json --transcript
node tools/aggregate.mjs
python3 -m http.server 8771 --bind 127.0.0.1
```

Open `http://127.0.0.1:8771`. The site uses ES modules and requires HTTP serving.
To exercise all three synthetic agents:

```sh
npm run selftest --prefix probe
```

The good and minimal fixtures should both produce `measured` runs with no
protocol issues. The declaration-mismatch fixture should produce `issues`,
with `session/load` returning `method_not_found` despite being advertised.
The test suite asserts these outcomes through the actual CLI.

A direct command is also supported:

```sh
node probe/dist/src/cli.js --cmd "opencode acp" --name opencode --llm
```

`--llm` starts a scripted model endpoint; an agent must be configured to use it.
The report records actual mock requests and issued tools, so starting a mock
alone is not evidence that it was used. `--mock-llm URL` uses an external mock.
`--discover` additionally invokes otherwise unadvertised optional methods for
diagnostic exploration. `--authenticate` attempts an advertised non-terminal
login method; unattended runs normally leave interactive login unexercised.

Client file, terminal and permission services are simulated. A terminal callback
proves protocol interaction with that simulated client, not successful execution
of a real shell command. For agents using internal tools, operations run in the
probe's temporary workspace.

## Configure an agent

`tools/sync-registry.mjs` mirrors the
[official ACP registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json).
Human-owned preparation and environment settings live in
`registry/overrides/<id>.json`; generated entries live in `registry/agents`.

| Entry field | Meaning |
| --- | --- |
| `run` | Command that launches ACP over stdio. |
| `setup` | Ordered shell commands completed before ACP starts; any failure prevents launch. |
| `probeProfiles` | Explicit session configuration profiles; each must match an offered option and runs in a distinct session. |
| `env` | Environment passed to preparation and the agent. |
| `sessionFiles` | Configuration files written into the temporary workspace. |
| `install` | Distribution installation performed by CI before probing. |
| `notes` | Human context about configuration and limitations. |

`${WORK_DIR}`, `${REPO_ROOT}` and `${MOCK_LLM_URL}` are substituted in `run`,
`setup`, `env` and `sessionFiles`. Any mock URL reference starts the mock
unless `--mock-llm` supplies one. Keep preparation separate from `run`:
semicolon-separated preparation can hide failures and contaminate ACP stdout.
Setup steps have a two-minute timeout and report the failing step.

DimCode's override demonstrates a custom provider with the `openai` adapter,
mock-only credentials and isolated `DIMCODE_HOME`. It needs no vendor account
for this scenario. Its `probeProfiles` exercise the offered `permission` option
with `workspace-write` and `full-access` values, alongside the unchanged default
profile. Names alone never establish policy behavior. Real-provider runs must identify their environment separately;
passing a mock run does not establish production authentication or availability.

Refresh one entry without rewriting the rest of the catalog:

```sh
node tools/sync-registry.mjs --registry-json data/acp-registry.json --only dimcode
```

Use the same command without `--registry-json` to fetch upstream, or without
`--only` to refresh all entries. Binary distributions are resolved and
checksum-verified by `tools/install-dist.mjs`.

## Reports and publication

A report contains methodology and schema identifiers, individual method
outcomes, uncertainty causes, scenario conditions and tool outcomes, capability
declarations, timestamped attempts, diagnostics and the
wire transcript. `--transcript` also writes a standalone NDJSON file.

The daily workflow installs distributions, runs regression tests, probes the
matrix, uploads reports and transcripts, then updates the static dataset.
Installation failures and unfinished probe processes produce visible failure
records. Public `data/reports/*.json` retain method evidence and provenance;
full wire transcripts remain in the CI artifact. No transcript is silently
advertised as available when only the compact public report exists.

`aggregate.mjs` preserves newer reports and carries forward agents absent from
a partial run, keeping their original timestamps. `--reports`, `--registry`,
`--previous` and `--out` support isolated aggregation and migrations.

Lody and other extension namespaces are recorded separately. Advertised features,
endpoint replies and observed wire keys are different evidence. A catalog
`lodyAdapter` annotation means an adapter is available; the recorded command
identifies the implementation actually tested.

To appeal a result, provide the agent version, report, timestamp and relevant
transcript excerpt in a repository issue. The design rationale and findings from
the measurement redesign are preserved in [the decision record](docs/measurement-v2-decision.md).
