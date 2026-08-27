#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTENT_DIR, readJson } from './lib.mjs';
import { PRICING_AS_OF } from './cost.mjs';

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    result[key] = argv[index + 1]?.startsWith('--') || argv[index + 1] === undefined ? true : argv[++index];
  }
  return result;
}

function safeLimit(value, maximum) {
  if (value === undefined) return maximum;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('--limit يجب أن يكون عدداً صحيحاً موجباً.');
  return Math.min(parsed, maximum);
}

const args = options(process.argv.slice(2));
const target = Number.parseInt(String(args.target || 5000), 10);
if (!Number.isSafeInteger(target) || target < 1) throw new Error('--target يجب أن يكون عدداً صحيحاً موجباً.');

const plan = readJson(path.join(CONTENT_DIR, `bank-plan-${target}.json`), null);
const queue = readJson(path.join(CONTENT_DIR, `generation-queue-${target}.json`), null);
if (!plan || !queue || plan.targetBankSize !== target || queue.targetBankSize !== target) {
  throw new Error('خطة البنك أو طابور التوليد غير صالح. أعد بناء الملفين أولاً.');
}

const readyJobs = (queue.jobs || []).filter(job => job.status === 'ready');
const selectedJobs = readyJobs.slice(0, safeLimit(args.limit, readyJobs.length));
const generatorPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'generate.mjs');
const categoryTotals = {};
let conservativeUpperBoundUsd = 0;
let questionCount = 0;

for (const job of selectedJobs) {
  const levelTarget = plan.categories?.[job.category]?.levels?.[job.difficultyLevel]?.target;
  if (!Number.isSafeInteger(levelTarget)) throw new Error(`لا يوجد هدف صالح للدفعة ${job.id}.`);
  const result = spawnSync(process.execPath, [
    generatorPath,
    '--category', job.category,
    '--level', String(job.difficultyLevel),
    '--count', String(job.count),
    '--target-per-level', String(levelTarget),
    '--dry-run',
  ], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`فشلت محاكاة الدفعة ${job.id}: ${String(result.stderr || result.stdout).trim()}`);
  }
  let report;
  try { report = JSON.parse(result.stdout); }
  catch { throw new Error(`خرجت الدفعة ${job.id} بنتيجة محاكاة غير صالحة.`); }
  if (report.mode !== 'dry-run' || report.runtimePreflight?.exceedsRuntimeGap !== false) {
    throw new Error(`لم تجتز الدفعة ${job.id} حارس فجوة بنك التشغيل.`);
  }
  const estimate = Number(report.costPreflight?.totalEstimatedUsd);
  if (!Number.isFinite(estimate) || estimate < 0) throw new Error(`تعذر حساب تكلفة الدفعة ${job.id}.`);
  conservativeUpperBoundUsd += estimate;
  questionCount += job.count;
  categoryTotals[job.category] ||= { jobs: 0, questions: 0, conservativeUpperBoundUsd: 0 };
  categoryTotals[job.category].jobs += 1;
  categoryTotals[job.category].questions += job.count;
  categoryTotals[job.category].conservativeUpperBoundUsd += estimate;
}

for (const summary of Object.values(categoryTotals)) {
  summary.conservativeUpperBoundUsd = Number(summary.conservativeUpperBoundUsd.toFixed(6));
}

console.log(JSON.stringify({
  mode: 'dry-run-only',
  targetBankSize: target,
  readyJobsAvailable: readyJobs.length,
  jobsValidated: selectedJobs.length,
  questionsValidated: questionCount,
  pricingAsOf: PRICING_AS_OF,
  conservativeUpperBoundUsd: Number(conservativeUpperBoundUsd.toFixed(6)),
  writesPerformed: false,
  apiCallsPerformed: false,
  categoryTotals,
}, null, 2));
