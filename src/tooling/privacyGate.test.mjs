// Tests for scripts/privacy-gate.mjs's error handling (S-3): an invalid or
// catastrophic `re:` term must be reported as an INCONCLUSIVE parse error
// (exit 2), never crash with an uncaught SyntaxError (which looks exactly
// like exit 1, "found hits", to a caller reading only the exit code) and
// never hang the tree scan. Uses made-up terms only, never a real private
// one, per the rule that the term file format is documented and testable
// without private data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'privacy-gate.mjs');

function runGate(termsContent) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'privacy-gate-test-'));
  const termsFile = path.join(dir, 'terms.txt');
  writeFileSync(termsFile, termsContent, 'utf8');
  try {
    return spawnSync(process.execPath, [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, PRIVACY_TERMS_FILE: termsFile },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('S-3: an invalid re: regex term exits 2 (inconclusive), not 1, and never a raw stack trace', () => {
  const result = runGate('re:(\n');
  assert.equal(
    result.status,
    2,
    'a malformed term must be "did not run" (2), never "found hits" (1) -- a crash before scanning is not a clean pass either',
  );
  assert.match(result.stdout, /privacy-gate: invalid regex term on line 1/);
  assert.doesNotMatch(
    result.stderr,
    /SyntaxError/,
    'the gate must catch the RegExp construction failure itself, not let it surface as an uncaught exception',
  );
});

test('S-3: an invalid re: term reports the correct 1-based line number among other lines', () => {
  const result = runGate('# a comment\nplain-term-not-real\nre:(unterminated\n');
  assert.equal(result.status, 2);
  assert.match(result.stdout, /privacy-gate: invalid regex term on line 3/);
});

test('S-3: a catastrophic nested-quantifier re: term is rejected before it ever runs, not left to hang or backtrack', () => {
  const result = runGate('re:(a+)+$\n');
  assert.equal(result.status, 2);
  assert.match(result.stdout, /privacy-gate: catastrophic regex term on line 1/);
});

// Built from parts at runtime, never spelled out whole in this file's own
// source -- the gate scans every tracked file including this one, so a
// made-up term written literally here would match itself and turn a
// "should be a clean PASS" test into a false FAIL.
const madeUpNeedle = ['zzqx', 'nonexistent', 'termfixture', '7719'].join('-');

test('a valid re: term still runs the scan normally (no false rejection)', () => {
  const result = runGate(`re:${madeUpNeedle}\n`);
  assert.equal(result.status, 0, 'a well-formed pattern that matches nothing is a clean PASS');
  assert.match(result.stdout, /privacy-gate: PASS \(0 hits\)/);
});

test('a word: term is still escaped correctly (regression: word: path untouched by the re: fix)', () => {
  const result = runGate(`word:${madeUpNeedle.replace(/-/g, '')}\n`);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /privacy-gate: PASS \(0 hits\)/);
});
