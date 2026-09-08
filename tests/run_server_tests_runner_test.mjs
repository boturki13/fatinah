import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  createTestEnvironment,
  parseDurationSetting,
  repositoryRoot,
  runSuite,
} from '../scripts/run-server-tests.mjs';

const sanitizedEnvironment = createTestEnvironment({
  PATH: '/safe/bin',
  CI: 'true',
  SAFE_TEST_FLAG: 'preserved',
  FATINAH_ENVIRONMENT: 'production',
  FATINAH_SERVER_TEST_TIMEOUT_MS: '999999',
  FIREBASE_CONFIG: 'secret',
  FIRESTORE_EMULATOR_HOST: 'production.example',
  APPLE_APP_ATTEST_KEY: 'secret',
  REVENUECAT_WEBHOOK_SECRET: 'secret',
  SMTP_PASSWORD: 'secret',
  GOOGLE_API_KEY: 'secret',
  GOOGLE_APPLICATION_CREDENTIALS: '/secret/credentials.json',
  GOOGLE_CLOUD_PROJECT: 'production-project',
  ADMIN_SECRET: 'secret',
  REPORT_EMAIL_TO: 'production@example.com',
  SESSION_SECRET: 'secret',
  REPLIT_DEPLOYMENT: '1',
  PORT: '443',
  OPENAI_API_KEY: 'secret',
  ANTHROPIC_API_KEY: 'secret',
});

assert.deepEqual(sanitizedEnvironment, {
  PATH: '/safe/bin',
  CI: 'true',
  SAFE_TEST_FLAG: 'preserved',
  FATINAH_ENVIRONMENT: 'test',
  REPLIT_DEPLOYMENT: '0',
  PYTHONPATH: repositoryRoot,
});
assert.equal(parseDurationSetting(undefined, 123, 'TEST_TIMEOUT'), 123);
assert.equal(parseDurationSetting('456', 123, 'TEST_TIMEOUT'), 456);
assert.throws(
  () => parseDurationSetting('not-a-duration', 123, 'TEST_TIMEOUT'),
  /TEST_TIMEOUT must be a positive integer/,
);

const messages = [];
const logger = {
  log(message) {
    messages.push(message);
  },
  error(message) {
    messages.push(message);
  },
};

const successful = await runSuite({
  executable: process.execPath,
  args: ['-e', 'process.exit(0)'],
  label: 'runner-success-probe',
  timeoutMs: 2_000,
  stdio: 'ignore',
  logger,
});
assert.equal(successful.status, 0);
assert.equal(successful.timedOut, false);
assert.equal(successful.aborted, false);
assert.ok(successful.durationMs >= 0);
assert.ok(messages.some(message => /START runner-success-probe/.test(message)));
assert.ok(messages.some(message => /PASS  runner-success-probe \(.+\)/.test(message)));

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitUntilProcessExits(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return !processIsAlive(pid);
}

const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'fatinah-server-runner-'));
const grandchildPidPath = path.join(temporaryDirectory, 'grandchild.pid');
let grandchildPid = null;

try {
  const grandchildSource = [
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1_000);',
  ].join('\n');
  const parentSource = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const source = ${JSON.stringify(grandchildSource)};`,
    "const grandchild = spawn(process.execPath, ['-e', source], { stdio: 'ignore' });",
    `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));`,
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1_000);',
  ].join('\n');

  const timedOut = await runSuite({
    executable: process.execPath,
    args: ['-e', parentSource],
    label: 'runner-timeout-tree-probe',
    timeoutMs: 1_000,
    terminationGraceMs: 75,
    forceKillWaitMs: 2_000,
    stdio: 'ignore',
    logger,
  });

  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.aborted, false);
  assert.equal(timedOut.cleanupError, null);
  assert.ok(timedOut.durationMs >= 1_000);
  assert.ok(messages.some(message => (
    /TIMEOUT runner-timeout-tree-probe: exceeded 1\.00s/.test(message)
    && /terminating process tree/.test(message)
  )));
  assert.ok(messages.some(message => (
    /TIMEOUT runner-timeout-tree-probe/.test(message)
    && /limit 1\.00s/.test(message)
    && /process tree terminated/.test(message)
  )));

  grandchildPid = Number(readFileSync(grandchildPidPath, 'utf8'));
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
  assert.equal(
    await waitUntilProcessExits(grandchildPid, 2_000),
    true,
    `grandchild process ${grandchildPid} survived the suite timeout`,
  );
} finally {
  if (grandchildPid && processIsAlive(grandchildPid)) {
    try {
      process.kill(grandchildPid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

console.log('✓ runner isolates test environment, reports durations, times out, and kills process trees');
