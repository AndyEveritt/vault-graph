#!/usr/bin/env node
// github#147

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = ".githooks/pre-push";
const WORKFLOW = ".github/workflows/quality.yml";

// github#147 -- the required-status context is the job's name
const JOB_NAME = "quality gates";

// github#147 -- the two markers that bound the hook's static block
const BLOCK_START = '-z "$gated_push"';
const BLOCK_END = '-n "$SKIP_SMOKE"';

// github#147 -- a hook gate CI genuinely cannot run, by normalised key
const LOCAL_ONLY = [];

const read = (p) => readFileSync(join(ROOT, p), "utf8");

/**
 * github#147
 * @param {string} cmd
 * @returns {string | null}
 */
function key(cmd) {
  if (/\bnpm\s+run\s+lint\b/.test(cmd)) return "npm run lint";
  const script = /(?:\$root\/|[\s"'])?(scripts\/[\w.-]+\.mjs)/.exec(cmd);
  if (!script) return null;
  const flags = (cmd.slice(script.index + script[0].length).match(/--[\w-]+/g) || []).sort();
  return [script[1], ...flags].join(" ");
}

/**
 * github#147
 * @param {string} hook
 * @returns {string[]}
 */
function hookGates(hook) {
  const lines = hook.split("\n");
  const from = lines.findIndex((l) => l.includes(BLOCK_START));
  const to = lines.findIndex((l) => l.includes(BLOCK_END));
  if (from < 0 || to < 0 || to <= from) {
    console.error("check-ci-parity: FAIL");
    console.error(`  FAIL could not find the static block in ${HOOK}`);
    console.error(`  FAIL expected a line with ${BLOCK_START} before one with ${BLOCK_END}`);
    console.error("  FAIL the markers moved or were renamed -- fix them here, do not delete this check");
    process.exit(1);
  }
  const found = [];
  // github#147 -- the refusal messages name scripts in prose
  let heredoc = null;
  for (const line of lines.slice(from, to)) {
    if (heredoc !== null) {
      if (line.trim() === heredoc) heredoc = null;
      continue;
    }
    const opens = /<<-?\s*'?([A-Za-z_][\w]*)'?/.exec(line);
    if (opens) { heredoc = opens[1]; continue; }
    if (/^\s*#/.test(line)) continue;
    const k = key(line);
    if (k && !found.includes(k)) found.push(k);
  }
  if (heredoc !== null) {
    console.error("check-ci-parity: FAIL");
    console.error(`  FAIL an unterminated <<${heredoc} heredoc in ${HOOK}'s static block`);
    process.exit(1);
  }
  return found;
}

/**
 * github#147
 * @param {string} workflow
 * @returns {string[]}
 */
function workflowRuns(workflow) {
  const found = [];
  for (const line of workflow.split("\n")) {
    const run = /^\s*run:\s*(.+?)\s*$/.exec(line);
    if (!run) continue;
    const k = key(run[1]);
    if (k && !found.includes(k)) found.push(k);
  }
  return found;
}

const hook = read(HOOK);
const workflow = read(WORKFLOW);
const gates = hookGates(hook);
const runs = workflowRuns(workflow);
const problems = [];

if (!gates.length) problems.push(`no gates found in ${HOOK}'s static block -- the parser or the hook changed shape`);

for (const gate of gates) {
  if (LOCAL_ONLY.includes(gate)) continue;
  if (!runs.includes(gate)) problems.push(`${HOOK} runs \`${gate}\` and ${WORKFLOW} does not`);
}

if (!new RegExp(`^\\s*name:\\s*${JOB_NAME}\\s*$`, "m").test(workflow)) {
  problems.push(`${WORKFLOW} has no job named \`${JOB_NAME}\` -- that string is the required-status context`);
}

if (problems.length) {
  console.error("check-ci-parity: FAIL");
  for (const p of problems) console.error("  FAIL " + p);
  console.error("");
  console.error(`Add the missing step to ${WORKFLOW}, in the same order the hook runs it. A gate`);
  console.error("that runs only in the hook is a gate no merge boundary can see, which is the whole");
  console.error("of github#147. If it genuinely cannot run on a runner, put its key in LOCAL_ONLY");
  console.error("in this file with the reason in .ai-context/invariants.md -- do not drop it silently.");
  process.exit(1);
}

console.log(`check-ci-parity: ok -- ${gates.length} static gates in ${HOOK}, all ${gates.length} run by \`${JOB_NAME}\``);
