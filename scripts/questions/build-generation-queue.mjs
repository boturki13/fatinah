#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTENT_DIR,
  isReligiousCategory,
  loadPolicy,
  readJson,
  writeJsonAtomic,
} from './lib.mjs';

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

export function buildGenerationQueue(plan, policy = loadPolicy()) {
  if (!plan || plan.schemaVersion !== 1 || !Number.isSafeInteger(plan.targetBankSize)) {
    throw new Error('خطة البنك غير صالحة. شغّل questions:plan-bank --write أولاً.');
  }
  const jobs = [];
  if (policy.generationStrategy?.defaultMode !== 'deterministic_structured_source' ||
      policy.generationStrategy?.paidAiGenerationEnabled !== false) {
    throw new Error('سياسة بنك 1.3 يجب أن توقف AI المدفوع وتعتمد المصادر المنظمة الحتمية.');
  }
  for (const [category, categoryPlan] of Object.entries(plan.categories || {})) {
    const religious = isReligiousCategory(category, policy);
    const image = categoryPlan.kind === 'image';
    for (const [levelText, levelPlan] of Object.entries(categoryPlan.levels || {})) {
      const level = Number(levelText);
      let remaining = Number(levelPlan.gap || 0);
      let part = 1;
      while (remaining > 0) {
        const count = Math.min(25, remaining);
        jobs.push({
          id: `bank-${plan.targetBankSize}-${category}-${level}-p${part}`,
          category,
          difficultyLevel: level,
          count,
          generationModel: image ? 'deterministic-curated-image-v1'
            : religious ? 'deterministic-religious-template-v1' : 'deterministic-structured-template-v1',
          verificationModel: image ? 'image-rights-and-asset-v1'
            : religious ? 'canonical-source-double-verification-v1' : 'schema-source-and-duplicate-v1',
          sourceMode: image ? 'curated_image_with_rights'
            : religious ? 'double_verified_deterministic_packet' : 'structured_dataset_template',
          status: image ? 'blocked_until_curated_image_assets'
            : religious ? 'blocked_until_double_verified_source_packets'
            : 'blocked_until_structured_source_records',
        });
        remaining -= count;
        part += 1;
      }
    }
  }
  const questionCount = jobs.reduce((sum, job) => sum + job.count, 0);
  if (questionCount !== plan.gapTotal) {
    throw new Error(`مجموع طابور التوليد ${questionCount} لا يطابق فجوة الخطة ${plan.gapTotal}.`);
  }
  return {
    schemaVersion: 1,
    targetBankSize: plan.targetBankSize,
    currentQuestionCount: plan.currentTotal,
    questionsToGenerate: questionCount,
    generationModel: 'deterministic-structured-template-v1',
    generalVerificationModel: 'schema-source-and-duplicate-v1',
    religiousVerificationModel: 'tanzil-1.1+quran-foundation-v4',
    paidAiGenerationEnabled: false,
    jobs,
  };
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const args = options(process.argv.slice(2));
  const target = Number(args.target || 5000);
  const planPath = path.join(CONTENT_DIR, `bank-plan-${target}.json`);
  const queue = buildGenerationQueue(readJson(planPath, null));
  if (args.write === true) {
    const output = path.join(CONTENT_DIR, `generation-queue-${target}.json`);
    writeJsonAtomic(output, queue);
    console.log(JSON.stringify({
      targetBankSize: queue.targetBankSize,
      currentQuestionCount: queue.currentQuestionCount,
      questionsToGenerate: queue.questionsToGenerate,
      jobs: queue.jobs.length,
      readyJobs: queue.jobs.filter(job => job.status === 'ready').length,
      blockedReligiousJobs: queue.jobs.filter(job =>
        job.status === 'blocked_until_double_verified_source_packets').length,
      blockedImageJobs: queue.jobs.filter(job =>
        job.status === 'blocked_until_curated_image_assets').length,
      blockedStructuredSourceJobs: queue.jobs.filter(job =>
        job.status === 'blocked_until_structured_source_records').length,
      output: path.relative(process.cwd(), output),
    }, null, 2));
  } else {
    console.log(JSON.stringify(queue, null, 2));
  }
}
