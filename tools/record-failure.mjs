#!/usr/bin/env node
// Write a visible run failure when installation or the probe process did not finish.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildReport } from '../probe/dist/src/report.js';
const [entryFile, out, reason, exitCode, diagnosticFile] = process.argv.slice(2);
if (!entryFile || !out || !reason) throw new Error('usage: record-failure.mjs ENTRY OUT REASON [EXIT_CODE]');
if (existsSync(out)) process.exit(0); // preserve a report produced before a nonzero exit
const diagnostic = diagnosticFile && existsSync(diagnosticFile) ? readFileSync(diagnosticFile, "utf8").replace(/\x1b\[[0-9;]*m/g, "").slice(-2000) : "";
const entry = JSON.parse(readFileSync(entryFile, 'utf8'));
const report = buildReport({
  harness: entry.name, initResult: null, results: {}, dishonesty: [], violations: [], transcript: [],
  setup: { status: 'error', phase: reason.startsWith('Distribution') ? 'installation' : 'execution', note: `${reason}${exitCode ? ` (exit ${exitCode})` : ''}; no completed measurement${diagnostic ? `; ${diagnostic}` : ""}` },
  environment: {
    profile: 'not-started', client: 'simulated', platform: `${process.platform}-${process.arch}`, node: process.version,
    revision: process.env.GITHUB_SHA,
    ciUrl: process.env.GITHUB_RUN_ID ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined,
  },
});
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
