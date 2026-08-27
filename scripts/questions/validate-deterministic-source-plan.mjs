#!/usr/bin/env node
import path from 'node:path';
import { CONTENT_DIR, isReligiousCategory, loadBaseCategories, loadPolicy, readJson } from './lib.mjs';

const policy = loadPolicy();
const plan = readJson(path.join(CONTENT_DIR, 'deterministic-source-plan.json'), null);
if (!plan || plan.schemaVersion !== 1 || plan.mode !== 'deterministic_structured_source') {
  throw new Error('خطة المصادر الحتمية غير صالحة.');
}
if (plan.estimatedAiCostUsd !== 0 || plan.rules?.aiGenerationForbidden !== true ||
    plan.rules?.finalFactSourceRequired !== true) {
  throw new Error('خطة المصادر يجب أن تكون بلا تكلفة AI وبمرجع حقيقة نهائي إلزامي.');
}

const expected = loadBaseCategories().filter(category => !isReligiousCategory(category, policy));
const assignments = new Map();
for (const profile of plan.profiles || []) {
  if (!(policy.generationStrategy?.allowedSourceProfiles || []).includes(profile.id)) {
    throw new Error(`ملف مصدر غير مسموح: ${profile.id}.`);
  }
  for (const category of profile.categories || []) {
    if (assignments.has(category)) throw new Error(`الفئة مكررة في خطة المصادر: ${category}.`);
    assignments.set(category, profile.id);
  }
}
const missing = expected.filter(category => !assignments.has(category));
const unknown = [...assignments].map(([category]) => category).filter(category => !expected.includes(category));
if (missing.length || unknown.length) {
  throw new Error(`تغطية الفئات غير كاملة. ناقص: ${missing.join('، ') || 'لا يوجد'}؛ زائد: ${unknown.join('، ') || 'لا يوجد'}.`);
}

console.log(JSON.stringify({
  mode: plan.mode,
  estimatedAiCostUsd: plan.estimatedAiCostUsd,
  profiles: plan.profiles.length,
  categoriesCovered: assignments.size,
  paidAiGenerationEnabled: policy.generationStrategy.paidAiGenerationEnabled,
}, null, 2));
