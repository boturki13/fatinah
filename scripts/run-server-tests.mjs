import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const pythonCandidates = process.platform === 'win32'
  ? [path.join(root, '.venv', 'Scripts', 'python.exe')]
  : [path.join(root, '.venv', 'bin', 'python3'), path.join(root, '.venv', 'bin', 'python')];

const python = pythonCandidates.find(candidate => {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
});

if (!python) {
  console.error('Python environment missing. Run `uv sync --locked` before `npm test`.');
  process.exit(1);
}

const commands = [
  [python, 'tests/test_api_version_contract.py'],
  [process.execPath, 'tests/test_function_version_contract.mjs'],
  [python, 'tests/test_revenuecat_webhook.py'],
  [python, 'tests/test_question_history.py'],
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

// Unit tests must never inherit managed-hosting production mode. Otherwise
// REPLIT_DEPLOYMENT/FATINAH_ENVIRONMENT activates the real distributed limiter
// inside isolated HTTP fixtures (for example the RevenueCat webhook suite),
// turning deterministic tests into live Firestore calls. Production behavior
// remains covered explicitly by test_production_release_gate.py and the
// distributed limiter suite.
const applicationEnvironmentName = /^(?:FATINAH_|FIREBASE_|FIRESTORE_|APPLE_|REVENUECAT_|SMTP_|GOOGLE_API_KEY$|GOOGLE_APPLICATION_CREDENTIALS$|GOOGLE_CLOUD_PROJECT$|ADMIN_SECRET$|REPORT_EMAIL_TO$|SESSION_SECRET$|REPLIT_DEPLOYMENT$|PORT$|OPENAI_API_KEY$|ANTHROPIC_API_KEY$)/;
const testEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !applicationEnvironmentName.test(name),
  ),
);
testEnvironment.FATINAH_ENVIRONMENT = 'test';
testEnvironment.REPLIT_DEPLOYMENT = '0';

for (const [executable, script] of commands) {
  const result = spawnSync(executable, [script], {
    cwd: root,
    env: testEnvironment,
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(`Unable to run ${script}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
