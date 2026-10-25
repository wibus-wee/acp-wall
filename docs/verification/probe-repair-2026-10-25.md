# Probe environment and evidence repair

Baseline: `8654ddce3c297803c3a96f81785416723731767f`.

## Independently reproduced

- Existing 44 unit/CLI fixture checks passed before changes.
- Added schema regressions failed before repair: overlapping oneOf branches, unresolved reference, string length constraints. Ajv repair passes them.
- Original CI transcripts show fast-agent and Minion failing PyPI TLS (`UnknownIssuer`), before initialize. Replacement CA variables used a test-only CA, discarding public roots.
- Local non-MITM reruns now launch fast-agent and Minion. Fast-agent completes session/prompt and controlled exec/read/write/MCP stimuli (13 verified checks in that run). Minion reaches initialize but returns the genuine authentication requirement at session/new.
- MiniMax preparation now uses supported CLI arguments and succeeds. Its ACP session/new still requests mcode login; no vendor login is fabricated.
- Autohand's nonexistent extra package was replaced with official `autohand-cli@0.9.8`, retaining registry adapter `@autohandai/autohand-acp@0.2.1`. Local launch passes initialize and then exposes an authentication prerequisite.
- Mimi alpha resolves to 0.1.0-alpha.3. Initially it exited with sandbox_unavailable / socat missing. After explicit approval, socat 1.8.0.3 and libwrap0 were obtained from the configured signed Debian repository and unpacked locally (no sudo available). With the sandbox unchanged and an isolated custom mock provider, the final run has 20 verified checks, zero blocked/errors/schema violations, and completed client read/write/terminal-create tool outcomes. MCP discovery succeeds but no controlled MCP call was issued; terminal create is only observed, not a complete lifecycle.
- Cline uses provider ID openai-compatible (the CLI auth alias openai is not the stored provider ID). With explicit approval for vendor telemetry, the final controlled run has 11 verified checks, no schema violations, and completed run_commands/read_files/apply_patch outcomes. Interactive OAuth remains untested; it is not needed for this mock-key profile.
- Explicit tool mappings now use nonempty commands/files and absolute client paths, fixing valid-but-useless empty-array stimuli and client path rejections.

## Verification limits

Local checks do not claim full vendor-account coverage, actual terminal side effects, all-platform conformance or production deployment. Environment and auth barriers remain visible. No real user credentials or project data were used. Historical public reports are not overwritten by these local runs.

Headless Chromium verification was blocked by this executor's IPC/filesystem setup. The actual page has a DOM integration regression covering unranked rows, expansion, extension markers, command-palette filter and extension toggle; this is not pixel/real-browser acceptance.

Final local validation: 61 tests pass after a clean locked dependency install, including the actual-page DOM integration test. The three canonical CLI fixtures run through the real probe. No full-matrix or credentialed-provider claim is made.
