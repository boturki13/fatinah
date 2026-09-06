#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const releaseMode = process.argv.includes('--release');
const generatedArtifacts = [
  'content/questions/next-release-factual-ledger.json',
  'server-assets/question-bank/v1/bank.json',
  'server-assets/question-bank/v1/manifest.json',
  'server-assets/question-bank/v1/curation-report.json',
  'server-assets/question-bank/v1/quality-report.json',
];

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

function snapshot() {
  return Object.fromEntries(generatedArtifacts.map(relativePath => [
    relativePath, fs.readFileSync(path.join(ROOT, relativePath)),
  ]));
}

run(process.execPath, ['scripts/questions/build-next-release-bank.mjs']);
run(process.execPath, ['scripts/questions/audit-next-release-bank.mjs']);
const first = snapshot();
const firstManifest = JSON.parse(first['server-assets/question-bank/v1/manifest.json'].toString('utf8'));

run(process.execPath, ['scripts/questions/build-next-release-bank.mjs']);
run(process.execPath, ['scripts/questions/audit-next-release-bank.mjs']);
for (const [relativePath, firstBytes] of Object.entries(first)) {
  const secondBytes = fs.readFileSync(path.join(ROOT, relativePath));
  if (!firstBytes.equals(secondBytes)) throw new Error(`ملف إصدار غير ثابت بين بناءين: ${relativePath}`);
}

const audit = JSON.parse(fs.readFileSync(
  path.join(ROOT, 'server-assets/question-bank/v1/quality-report.json'), 'utf8',
));
if (firstManifest.sha256 !== audit.bankSha256 || firstManifest.bankVersion !== audit.bankVersion) {
  throw new Error('تقرير الجودة لا يخص نسخة البنك الحالية');
}
if (releaseMode && audit.releaseReady !== true) {
  console.error(JSON.stringify({
    error: 'بنك الأسئلة لم يجتز بوابة الإصدار',
    releaseReady: false,
    issueCount: audit.issueCount,
    byCode: audit.byCode,
  }, null, 2));
  process.exit(1);
}

run('python3', ['tests/test_remote_question_bank.py']);
run(process.execPath, ['tests/next_release_semantic_options_test.mjs']);
run(process.execPath, ['tests/question_bank_factual_tamper_test.mjs']);
run(process.execPath, ['tests/playable_content_curation_test.mjs']);
run(process.execPath, ['tests/content_release_visibility_test.mjs']);
run(process.execPath, ['tests/game_flow_test.mjs']);
run(process.execPath, ['tests/game_turn_order_test.mjs']);

console.log(`بوابة البنك الجديد ناجحة: ${firstManifest.questionCount} سؤالًا، ${firstManifest.categoryCount} فئة، الإصدار ${firstManifest.bankVersion}`);
