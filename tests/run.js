#!/usr/bin/env node
/* PIXEL HOLD'EM — test harness.
 * Usage: node tests/run.js [filter]
 *   - Creates a vm context, loads logic modules in contract order (skipping missing files),
 *     then every tests/*.test.js (optionally only files whose name contains `filter`).
 *   - Tests register via TESTS.push({ name, fn }); fn may be async.
 *   - `assert` (node:assert/strict) is exposed on the context.
 *   - Exits non-zero if any module/test file fails to load or any test fails.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const ROOT = path.resolve(__dirname, '..');
const JS_DIR = path.join(ROOT, 'js');
const TEST_DIR = __dirname;
const LOGIC_MODULES = ['cards.js', 'evaluator.js', 'equity.js', 'engine.js', 'bots.js', 'coach.js',
  'tournament.js', 'net.js', 'remote-engine.js', 'room.js'];
const TEST_SUFFIX = '.test.js';

const COLORS = process.stdout.isTTY
  ? { green: '\x1b[32m', red: '\x1b[31m', dim: '\x1b[2m', reset: '\x1b[0m' }
  : { green: '', red: '', dim: '', reset: '' };

function createContext() {
  const sandbox = {
    console,
    assert,
    TESTS: [],
    performance,
    crypto: webcrypto,
    setTimeout,
    clearTimeout,
    setImmediate,
    queueMicrotask,
  };
  sandbox.globalThis = sandbox;
  return vm.createContext(sandbox);
}

function runFile(ctx, file) {
  const code = fs.readFileSync(file, 'utf8');
  vm.runInContext(code, ctx, { filename: path.relative(ROOT, file) });
}

function loadModules(ctx, failures) {
  for (const name of LOGIC_MODULES) {
    const file = path.join(JS_DIR, name);
    if (!fs.existsSync(file)) {
      process.stdout.write(COLORS.dim + '  (skip missing js/' + name + ')' + COLORS.reset + '\n');
      continue;
    }
    try {
      runFile(ctx, file);
    } catch (err) {
      failures.push({ name: 'load js/' + name, err });
    }
  }
}

function listTestFiles(filter) {
  return fs.readdirSync(TEST_DIR)
    .filter((f) => f.endsWith(TEST_SUFFIX))
    .filter((f) => !filter || f.includes(filter))
    .sort()
    .map((f) => path.join(TEST_DIR, f));
}

let current = null;   // label of the running test (for the stall guard below)
let finished = false;

async function runTestFile(ctx, file, failures) {
  const fileName = path.basename(file);
  const start = ctx.TESTS.length;
  try {
    runFile(ctx, file);
  } catch (err) {
    failures.push({ name: 'load ' + fileName, err });
    return { passed: 0, failed: 1 };
  }
  const tests = ctx.TESTS.slice(start);
  let passed = 0;
  let failed = 0;
  process.stdout.write('\n' + fileName + '\n');
  for (const t of tests) {
    const label = (t && t.name) || '(unnamed test)';
    try {
      if (!t || typeof t.fn !== 'function') throw new Error('test entry has no fn');
      current = fileName + ' > ' + label;
      await t.fn();
      passed++;
      process.stdout.write('  ' + COLORS.green + 'PASS' + COLORS.reset + ' ' + label + '\n');
    } catch (err) {
      failed++;
      failures.push({ name: fileName + ' > ' + label, err });
      process.stdout.write('  ' + COLORS.red + 'FAIL' + COLORS.reset + ' ' + label + '\n');
    }
  }
  return { passed, failed };
}

function reportFailures(failures) {
  if (!failures.length) return;
  process.stdout.write('\n' + COLORS.red + 'Failures:' + COLORS.reset + '\n');
  for (const f of failures) {
    const detail = f.err && f.err.stack ? f.err.stack : String(f.err);
    process.stdout.write('\n- ' + f.name + '\n' + detail.split('\n').map((l) => '    ' + l).join('\n') + '\n');
  }
}

async function main() {
  const filter = process.argv[2] || '';
  const failures = [];
  const ctx = createContext();
  loadModules(ctx, failures);
  const loadFailures = failures.length;

  let passed = 0;
  let failed = 0;
  for (const file of listTestFiles(filter)) {
    const r = await runTestFile(ctx, file, failures);
    passed += r.passed;
    failed += r.failed;
  }

  reportFailures(failures);
  const summary = '\n' + passed + ' passed, ' + failed + ' failed' +
    (loadFailures ? ', ' + loadFailures + ' module load error(s)' : '') + '\n';
  const ok = failed === 0 && loadFailures === 0;
  process.stdout.write((ok ? COLORS.green : COLORS.red) + summary + COLORS.reset);
  process.exitCode = ok ? 0 : 1;
  finished = true;
}

// A test awaiting a promise that can never settle (deadlock) empties the event loop and Node would
// exit 0 with the remaining tests silently skipped. Fail loudly instead.
process.on('beforeExit', () => {
  if (finished) return;
  finished = true;
  process.stdout.write(COLORS.red + '\nSTALLED (never settled): ' + (current || 'harness') + COLORS.reset + '\n');
  process.exitCode = 1;
});

process.on('unhandledRejection', (err) => {
  process.stdout.write(COLORS.red + 'Unhandled rejection: ' + (err && err.stack ? err.stack : err) + COLORS.reset + '\n');
  process.exitCode = 1;
});

main().catch((err) => {
  process.stdout.write(COLORS.red + 'Harness error: ' + (err && err.stack ? err.stack : err) + COLORS.reset + '\n');
  process.exitCode = 1;
});
