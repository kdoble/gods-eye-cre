#!/usr/bin/env node
// Privacy kill-gate for the public release of this fork: scans every
// git-tracked file for terms that would identify the owner, his real
// property, his business names, or his local machine, and lists every
// binary file so a human can eyeball it before the repo goes public.
//
// This script carries NO private terms of its own. It is public source and
// must stay that way: the previous version kept the terms list as string
// literals in this file and excluded this file from scanning, so publishing
// the repo published the very terms it existed to guard. That defect is
// fixed structurally, not just patched: the terms live in a file outside
// this repo, and this script is scanned like every other tracked file (see
// EXCLUDED_TEXT_FILES below for the one narrow, non-term-related exception).
//
// Terms file: PRIVACY_TERMS_FILE env var, else `.privacy-terms.local` at the
// repo root (gitignored -- never committed). One term per line:
//   - blank lines and lines starting with `#` are ignored
//   - `re:<pattern>` -- a case-insensitive regular expression
//   - `word:<term>` -- a case-SENSITIVE whole-word match (\b<term>\b)
//   - anything else -- a plain case-insensitive substring match
//
// No terms file present: this is an INCONCLUSIVE check, not a clean one.
// Per the negative-test rule, a scanner that found nothing because it never
// looked is not a pass. Exit code 2, distinct from the exit 1 failure code,
// so CI (or a human) can tell "found problems" apart from "checked nothing."
//
// Exit codes: 0 = ran and found zero hits. 1 = ran and found hits. 2 = did
// not run (no terms file). This is the gate: a scanner that has never been
// proven to fail on a known-bad tree is not a gate (see the negative-test
// rule) -- run this once against a tree with a known leak and confirm it
// fails, before trusting a green run.
//
// Usage:
//   node scripts/privacy-gate.mjs
//   PRIVACY_TERMS_FILE=/path/to/terms.txt node scripts/privacy-gate.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TERMS_FILE = path.join(ROOT, '.privacy-terms.local');

// The only tolerated hit: the repository's own public GitHub URL form, and
// only inside package.json or README.md. This is not a private term -- it is
// the project's sanctioned public identity -- so a rule for it belongs in
// this script rather than in a private terms file. It is derived from
// package.json's own `repository`/`homepage` fields at run time (never
// spelled out as a literal owner name in this script's source), so this
// file itself never contains the public org/user string either -- a
// hardcoded literal here would itself be a hit once this script scans
// itself (see header).
const ALLOWLIST_FILES = new Set(['package.json', 'README.md']);

function buildAllowlistPattern() {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const candidates = [pkg.homepage, pkg.repository?.url, pkg.bugs?.url].filter(
    Boolean,
  );
  for (const url of candidates) {
    const match = /github\.com\/([^/#]+)\//i.exec(String(url));
    if (match) {
      const owner = match[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`github\\.com/${owner}/`, 'i');
    }
  }
  return null;
}

// package-lock.json is machine-generated: a short term can coincidentally
// appear inside a random base64 integrity hash on essentially any dependency
// tree (verified 2026-09-24 against two unrelated npm packages' sha512
// hashes). There is no human-authored prose in this file to leak, so it is
// excluded from term scanning (still listed if it were binary, which it is
// not). This script itself carries NO term literals (see header) and is not
// excluded -- it is scanned like anything else.
const EXCLUDED_TEXT_FILES = new Set(['package-lock.json']);

// Extensions treated as binary: not scanned for terms, just listed by size
// so a human can review what's shipping (images, PDFs, video, fonts, models,
// audio). Anything not in this list is read and scanned as text.
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.pdf',
  '.mp4',
  '.mov',
  '.webm',
  '.avi',
  '.mp3',
  '.wav',
  '.ogg',
  '.glb',
  '.gltf',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.zip',
  '.pbf',
]);

function resolveTermsFilePath() {
  return process.env.PRIVACY_TERMS_FILE
    ? path.resolve(process.env.PRIVACY_TERMS_FILE)
    : DEFAULT_TERMS_FILE;
}

// S-3: a crude, deliberately conservative catastrophic-backtracking guard.
// Real protection against every pathological pattern needs a timeout (not
// available synchronously without a worker thread), but the common failure
// shape -- a quantified group nested inside another quantifier, e.g.
// `(a+)+` or `(a*)*` -- is cheap to catch by inspection before the pattern
// ever runs. Exported so a maintainer running `npm run test:privacy` sees a
// clear rejection rather than a hang.
export const CATASTROPHIC_REGEX_PATTERN = /\([^()]*[+*][^()]*\)[+*?]/;

/** @param {string} pattern @returns {boolean} */
export function looksCatastrophic(pattern) {
  return CATASTROPHIC_REGEX_PATTERN.test(pattern);
}

/**
 * Parse the terms file into matcher objects. Each line becomes one matcher:
 * a plain substring (case-insensitive), a `word:` whole-word match
 * (case-sensitive), or a `re:` regular expression (case-insensitive).
 *
 * A malformed or catastrophic `re:` term is reported as a parse error
 * (line number included) rather than thrown -- this script never ran a
 * partial scan, so it is the INCONCLUSIVE case (exit 2, "did not run"),
 * never the exit-1 "found hits" case a crash would otherwise look like.
 * @param {string} text
 * @returns {{matchers:{label:string, test:(line:string)=>boolean}[]}|{error:{lineNumber:number, message:string}}}
 */
function parseTerms(text) {
  const matchers = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const lineNumber = i + 1;
    if (line.startsWith('re:')) {
      const pattern = line.slice('re:'.length);
      if (looksCatastrophic(pattern)) {
        return {
          error: {
            lineNumber,
            message: `privacy-gate: catastrophic regex term on line ${lineNumber} (a quantified group nested inside another quantifier can run away; rewrite it, e.g. drop the outer repetition or the inner one)`,
          },
        };
      }
      let re;
      try {
        re = new RegExp(pattern, 'i');
      } catch {
        return {
          error: {
            lineNumber,
            message: `privacy-gate: invalid regex term on line ${lineNumber}`,
          },
        };
      }
      matchers.push({ label: line, test: (text) => re.test(text) });
    } else if (line.startsWith('word:')) {
      const term = line.slice('word:'.length);
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b${escaped}\\b`);
      matchers.push({ label: line, test: (text) => re.test(text) });
    } else {
      const needle = line.toLowerCase();
      matchers.push({
        label: line,
        test: (text) => text.toLowerCase().includes(needle),
      });
    }
  }
  return { matchers };
}

function trackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

function isBinaryPath(relPath) {
  return BINARY_EXTENSIONS.has(path.extname(relPath).toLowerCase());
}

function findTermHits(relPath, text, matchers) {
  const hits = [];
  const lines = text.split('\n');
  for (const matcher of matchers) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!matcher.test(line)) continue;
      hits.push({
        path: relPath,
        line: i + 1,
        term: matcher.label,
        fullLine: line,
        text: line.trim().slice(0, 200),
      });
    }
  }
  return hits;
}

function findAllowlistedGithubUrl(relPath, text, allowlistPattern) {
  const hits = [];
  if (!allowlistPattern) return hits;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (allowlistPattern.test(lines[i])) {
      hits.push({ path: relPath, line: i + 1, text: lines[i].trim().slice(0, 200) });
    }
  }
  return hits;
}

function main() {
  const allowlistPattern = buildAllowlistPattern();
  const termsPath = resolveTermsFilePath();
  if (!existsSync(termsPath)) {
    console.log(
      `privacy-gate: no terms file; nothing was checked (looked for ${termsPath}; set PRIVACY_TERMS_FILE or create .privacy-terms.local at the repo root)`,
    );
    process.exitCode = 2;
    return;
  }
  const termsText = readFileSync(termsPath, 'utf8');
  const parsed = parseTerms(termsText);
  if (parsed.error) {
    console.log(parsed.error.message);
    process.exitCode = 2;
    return;
  }
  const { matchers } = parsed;
  if (matchers.length === 0) {
    console.log(
      `privacy-gate: no terms file; nothing was checked (${termsPath} exists but has no active term lines)`,
    );
    process.exitCode = 2;
    return;
  }

  const files = trackedFiles();
  const failingHits = [];
  const allowlistedHits = [];
  const binaryFiles = [];

  for (const relPath of files) {
    const abs = path.join(ROOT, relPath);
    let stats;
    try {
      stats = statSync(abs);
    } catch {
      continue; // deleted-but-still-listed edge case; nothing to scan
    }
    if (!stats.isFile()) continue;

    if (isBinaryPath(relPath)) {
      binaryFiles.push({ path: relPath, size: stats.size });
      continue;
    }
    if (EXCLUDED_TEXT_FILES.has(relPath)) continue;

    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      // Unreadable as UTF-8 text (e.g. an undeclared binary format): list it
      // like a binary file rather than silently skipping it.
      binaryFiles.push({ path: relPath, size: stats.size, note: 'undeclared binary (not valid UTF-8)' });
      continue;
    }

    const termHits = findTermHits(relPath, text, matchers);
    const isAllowlistFile = ALLOWLIST_FILES.has(relPath);
    for (const hit of termHits) {
      if (isAllowlistFile && allowlistPattern?.test(hit.fullLine)) continue;
      failingHits.push(hit);
    }
    if (isAllowlistFile) {
      allowlistedHits.push(
        ...findAllowlistedGithubUrl(relPath, text, allowlistPattern),
      );
    }
  }

  console.log(`Terms file: ${termsPath} (${matchers.length} active term${matchers.length === 1 ? '' : 's'})`);
  console.log(`Scanned ${files.length} tracked files.`);
  console.log('');

  console.log(`=== Binary files (${binaryFiles.length}) ===`);
  for (const b of binaryFiles.sort((a, b) => b.size - a.size)) {
    const note = b.note ? `  [${b.note}]` : '';
    console.log(`${b.size.toString().padStart(10)}  ${b.path}${note}`);
  }
  console.log('');

  if (allowlistedHits.length) {
    console.log(`=== Allow-listed hits (the repo's own public GitHub URL, per package.json, in package.json or README.md; reported, not failing) (${allowlistedHits.length}) ===`);
    for (const h of allowlistedHits) {
      console.log(`${h.path}:${h.line}: ${h.text}`);
    }
    console.log('');
  }

  if (failingHits.length) {
    console.log(`=== FAILING privacy hits (${failingHits.length}) ===`);
    for (const h of failingHits) {
      console.log(`${h.path}:${h.line}: [${h.term}] ${h.text}`);
    }
    console.log('');
    console.log(`privacy-gate: FAIL (${failingHits.length} hit${failingHits.length === 1 ? '' : 's'})`);
    process.exitCode = 1;
    return;
  }

  console.log('privacy-gate: PASS (0 hits)');
  process.exitCode = 0;
}

main();
