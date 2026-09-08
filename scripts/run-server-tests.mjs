import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

// Some suites cold-load Firebase/Google SDKs from disk before executing their
// deterministic checks. Give that initialization enough room on a clean CI
// runner while retaining a hard, configurable upper bound for genuine hangs.
export const DEFAULT_SUITE_TIMEOUT_MS = 180_000;
export const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DEFAULT_FORCE_KILL_WAIT_MS = 5_000;
const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

// Unit tests must never inherit managed-hosting production mode. Otherwise
// REPLIT_DEPLOYMENT/FATINAH_ENVIRONMENT activates the real distributed limiter
// inside isolated HTTP fixtures (for example the RevenueCat webhook suite),
// turning deterministic tests into live Firestore calls. Production behavior
// remains covered explicitly by test_production_release_gate.py and the
// distributed limiter suite.
const applicationEnvironmentName = /^(?:FATINAH_|FIREBASE_|FIRESTORE_|APPLE_|REVENUECAT_|SMTP_|GOOGLE_API_KEY$|GOOGLE_APPLICATION_CREDENTIALS$|GOOGLE_CLOUD_PROJECT$|ADMIN_SECRET$|REPORT_EMAIL_TO$|INVENTORY_ALERT_EMAIL_TO$|SESSION_SECRET$|REPLIT_DEPLOYMENT$|PORT$|OPENAI_API_KEY$|ANTHROPIC_API_KEY$)/;

export function createTestEnvironment(environment = process.env) {
  const testEnvironment = Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !applicationEnvironmentName.test(name),
    ),
  );
  testEnvironment.FATINAH_ENVIRONMENT = 'test';
  testEnvironment.REPLIT_DEPLOYMENT = '0';
  // تشغيل ملف Python داخل tests/ يجعل Python يضع مجلد tests فقط في sys.path.
  // أضف جذر المشروع صراحةً حتى تستورد جميع الاختبارات server بالطريقة نفسها
  // محليًا وفي CI، من دون اعتماد خفي على إعداد PYTHONPATH في جهاز المطوّر.
  testEnvironment.PYTHONPATH = [repositoryRoot, testEnvironment.PYTHONPATH]
    .filter(Boolean).join(path.delimiter);
  return testEnvironment;
}

export function parseDurationSetting(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer number of milliseconds.`);
  }

  const duration = Number(value);
  if (!Number.isSafeInteger(duration) || duration < 1 || duration > MAX_TIMER_DELAY_MS) {
    throw new Error(`${name} must be between 1 and ${MAX_TIMER_DELAY_MS} milliseconds.`);
  }
  return duration;
}

export function formatDuration(durationMs) {
  if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(2)}s`;

  const minutes = Math.floor(durationMs / 60_000);
  const seconds = ((durationMs % 60_000) / 1_000).toFixed(1);
  return `${minutes}m ${seconds}s`;
}

function findPython(root) {
  const candidates = process.platform === 'win32'
    ? [path.join(root, '.venv', 'Scripts', 'python.exe')]
    : [path.join(root, '.venv', 'bin', 'python3'), path.join(root, '.venv', 'bin', 'python')];

  return candidates.find(candidate => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function createSuites(python) {
  return [
    [python, 'tests/test_api_version_contract.py'],
    [process.execPath, 'tests/test_function_version_contract.mjs'],
    [process.execPath, 'tests/legacy_generation_content_policy_test.mjs'],
    [python, 'tests/test_legacy_generation_content_policy.py'],
    [python, 'tests/test_revenuecat_webhook.py'],
    [python, 'tests/test_revenuecat_status_refresh.py'],
    [python, 'tests/test_question_history.py'],
    [python, 'tests/test_question_inventory_alerts.py'],
    [python, 'tests/test_remote_question_bank.py'],
    [python, 'tests/test_account_delete.py'],
    [python, 'tests/test_free_round_reports_metrics.py'],
    [python, 'tests/test_devicecheck_free_round.py'],
    [python, 'tests/test_app_attest.py'],
    [python, 'tests/test_app_attest_api.py'],
    [python, 'tests/test_firebase_admin_and_durable_firestore.py'],
    [python, 'tests/test_http_server_limits.py'],
    [python, 'tests/test_distributed_rate_limit.py'],
    [python, 'tests/test_production_release_gate.py'],
  ];
}

function delay(durationMs) {
  return new Promise(resolve => setTimeout(resolve, durationMs));
}

function sendSignal(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function runWindowsTaskkill(pid) {
  return new Promise((resolve, reject) => {
    let killer;
    try {
      killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      killer.kill('SIGKILL');
      killer.unref();
      finish(new Error(`taskkill did not finish within ${WINDOWS_TASKKILL_TIMEOUT_MS}ms`));
    }, WINDOWS_TASKKILL_TIMEOUT_MS);

    killer.once('error', finish);
    killer.once('close', code => {
      if (code === 0) finish();
      else finish(new Error(`taskkill exited with code ${code ?? 'unknown'}`));
    });
  });
}

async function terminateProcessTree(child, { platform, terminationGraceMs }) {
  const pid = child.pid;
  if (!Number.isInteger(pid) || pid < 1) return;

  if (platform === 'win32') {
    try {
      await runWindowsTaskkill(pid);
    } catch (taskkillError) {
      // Preserve a best-effort direct-process fallback, but surface that the
      // Windows tree operation itself failed to the caller.
      try {
        child.kill('SIGKILL');
      } catch {
        // The process may already have exited between taskkill and this call.
      }
      throw taskkillError;
    }
    return;
  }

  const processGroupId = -pid;
  const groupWasRunning = sendSignal(processGroupId, 'SIGTERM');
  if (!groupWasRunning && child.exitCode === null) child.kill('SIGTERM');

  await delay(terminationGraceMs);

  const groupIsStillRunning = sendSignal(processGroupId, 0);
  if (groupIsStillRunning) sendSignal(processGroupId, 'SIGKILL');
  else if (child.exitCode === null) child.kill('SIGKILL');
}

function observeChild(child) {
  return new Promise(resolve => {
    let settled = false;
    const finish = outcome => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    child.once('error', error => finish({ status: null, signal: null, error }));
    child.once('close', (status, signal) => finish({ status, signal, error: null }));
  });
}

function waitForSuiteTrigger(childOutcome, timeoutMs, abortSignal) {
  return new Promise(resolve => {
    let settled = false;
    const finish = trigger => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      resolve(trigger);
    };
    const onAbort = () => finish({ kind: 'aborted', reason: abortSignal.reason });
    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);

    if (abortSignal?.aborted) onAbort();
    else abortSignal?.addEventListener('abort', onAbort, { once: true });

    childOutcome.then(outcome => finish({ kind: 'closed', outcome }));
  });
}

async function waitForChildAfterTermination(childOutcome, forceKillWaitMs) {
  let timer;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => resolve(null), forceKillWaitMs);
  });
  try {
    return await Promise.race([childOutcome, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function exitDescription(outcome) {
  if (outcome?.error) return `launch error: ${outcome.error.message}`;
  if (outcome?.signal) return `signal ${outcome.signal}`;
  return `exit code ${outcome?.status ?? 'unknown'}`;
}

export async function runSuite({
  executable,
  args,
  label = args.join(' '),
  cwd = repositoryRoot,
  env = createTestEnvironment(),
  timeoutMs = DEFAULT_SUITE_TIMEOUT_MS,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
  forceKillWaitMs = DEFAULT_FORCE_KILL_WAIT_MS,
  platform = process.platform,
  stdio = 'inherit',
  abortSignal,
  logger = console,
}) {
  const startedAt = performance.now();
  logger.log(`[server-tests] START ${label} (timeout ${formatDuration(timeoutMs)})`);

  let child;
  try {
    child = spawn(executable, args, {
      cwd,
      env,
      stdio,
      detached: platform !== 'win32',
      windowsHide: true,
    });
  } catch (error) {
    const durationMs = performance.now() - startedAt;
    logger.error(`[server-tests] FAIL  ${label} (${formatDuration(durationMs)}; launch error: ${error.message})`);
    return { status: null, signal: null, error, durationMs, timedOut: false, aborted: false };
  }

  const childOutcome = observeChild(child);
  const trigger = await waitForSuiteTrigger(childOutcome, timeoutMs, abortSignal);
  if (trigger.kind === 'closed') {
    const durationMs = performance.now() - startedAt;
    const outcome = trigger.outcome;
    if (!outcome.error && outcome.status === 0) {
      logger.log(`[server-tests] PASS  ${label} (${formatDuration(durationMs)})`);
    } else {
      logger.error(`[server-tests] FAIL  ${label} (${formatDuration(durationMs)}; ${exitDescription(outcome)})`);
    }
    return { ...outcome, durationMs, timedOut: false, aborted: false };
  }

  if (trigger.kind === 'timeout') {
    logger.error(
      `[server-tests] TIMEOUT ${label}: exceeded ${formatDuration(timeoutMs)}; terminating process tree...`,
    );
  } else {
    logger.error(`[server-tests] INTERRUPT ${label}: terminating process tree...`);
  }

  let cleanupError = null;
  try {
    await terminateProcessTree(child, { platform, terminationGraceMs });
  } catch (error) {
    cleanupError = error;
  }

  const outcome = await waitForChildAfterTermination(childOutcome, forceKillWaitMs);
  if (!outcome) {
    child.unref();
    cleanupError ??= new Error(`child did not exit within ${forceKillWaitMs}ms after forced termination`);
  }

  const durationMs = performance.now() - startedAt;
  const cleanupDescription = cleanupError
    ? `process-tree cleanup error: ${cleanupError.message}`
    : 'process tree terminated';

  if (trigger.kind === 'timeout') {
    logger.error(
      `[server-tests] TIMEOUT ${label} (${formatDuration(durationMs)}; limit ${formatDuration(timeoutMs)}; ${cleanupDescription})`,
    );
  } else {
    logger.error(`[server-tests] INTERRUPTED ${label} (${formatDuration(durationMs)}; ${cleanupDescription})`);
  }

  return {
    status: outcome?.status ?? null,
    signal: outcome?.signal ?? null,
    error: outcome?.error ?? null,
    durationMs,
    timedOut: trigger.kind === 'timeout',
    aborted: trigger.kind === 'aborted',
    abortReason: trigger.reason,
    cleanupError,
  };
}

function interruptionExitCode(abortSignal) {
  return Number.isInteger(abortSignal?.reason?.exitCode)
    ? abortSignal.reason.exitCode
    : 1;
}

export async function runServerTests({
  root = repositoryRoot,
  environment = process.env,
  abortSignal,
  logger = console,
} = {}) {
  const python = findPython(root);
  if (!python) {
    logger.error('Python environment missing. Run `uv sync --locked` before `npm test`.');
    return 1;
  }

  let timeoutMs;
  try {
    timeoutMs = parseDurationSetting(
      environment.FATINAH_SERVER_TEST_TIMEOUT_MS,
      DEFAULT_SUITE_TIMEOUT_MS,
      'FATINAH_SERVER_TEST_TIMEOUT_MS',
    );
  } catch (error) {
    logger.error(`[server-tests] Invalid configuration: ${error.message}`);
    return 1;
  }

  const testEnvironment = createTestEnvironment(environment);
  for (const [executable, script] of createSuites(python)) {
    if (abortSignal?.aborted) return interruptionExitCode(abortSignal);

    const result = await runSuite({
      executable,
      args: [script],
      label: script,
      cwd: root,
      env: testEnvironment,
      timeoutMs,
      abortSignal,
      logger,
    });

    if (result.aborted) return interruptionExitCode(abortSignal);
    if (result.timedOut || result.error || result.status !== 0) return result.status ?? 1;
  }

  return 0;
}

async function main() {
  const controller = new AbortController();
  const signalHandlers = new Map([
    ['SIGINT', () => {
      const reason = new Error('Received SIGINT');
      reason.exitCode = 130;
      controller.abort(reason);
    }],
    ['SIGTERM', () => {
      const reason = new Error('Received SIGTERM');
      reason.exitCode = 143;
      controller.abort(reason);
    }],
  ]);

  // Keep both handlers installed until cleanup completes. A second terminal
  // signal must not bypass process-tree termination while the grace period is
  // still in progress.
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);
  try {
    return await runServerTests({ abortSignal: controller.signal });
  } finally {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  }
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main()
    .then(exitCode => {
      process.exitCode = exitCode;
    })
    .catch(error => {
      console.error(`[server-tests] Runner failure: ${error.stack ?? error.message}`);
      process.exitCode = 1;
    });
}
