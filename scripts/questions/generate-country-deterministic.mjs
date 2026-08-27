#!/usr/bin/env node
import path from 'node:path';
import {
  CANDIDATES_PATH,
  CONTENT_DIR,
  loadExistingQuestionTexts,
  loadPolicy,
  readJson,
  stableQuestionId,
  validateCandidate,
  writeJsonAtomic,
} from './lib.mjs';

const write = process.argv.includes('--write');
const recordsDocument = readJson(path.join(CONTENT_DIR, 'structured-sources', 'world-bank-countries.json'), null);
const bankPlan = readJson(path.join(CONTENT_DIR, 'bank-plan-5000.json'), null);
if (!recordsDocument || recordsDocument.schemaVersion !== 1 || !Array.isArray(recordsDocument.records)) {
  throw new Error('شغّل questions:import-worldbank-countries أولاً.');
}
if (!bankPlan || bankPlan.targetBankSize !== 5000) throw new Error('خطة بنك 5000 غير صالحة.');

const familiarIsoOrder = [
  'KW','SA','AE','QA','BH','OM','EG','IQ','JO','LB','SY','DZ','MA','TN','LY','SD','YE','US','GB','FR','DE',
  'IT','ES','PT','CA','MX','BR','AR','CL','CN','JP','KR','IN','PK','ID','MY','AU','NZ','TR','RU','ZA','NG',
  'KE','ET','GR','NL','BE','CH','AT','SE','NO','DK','FI','IE','PL','UA','CZ','HU','RO','BG','HR','RS','BA',
  'AL','IS','IR','AF','BD','LK','NP','TH','VN','PH','SG','KZ','UZ','AZ','GE','AM','IL','GH','SN','TZ','UG',
  'ZW','ZM','CM','CD','AO','MZ','MG','CU','CO','PE','VE','EC','UY','PY','BO','CR','PA','DO','JM',
];
const priority = new Map(familiarIsoOrder.map((iso2, index) => [iso2, index]));
const records = [...recordsDocument.records].sort((a, b) => {
  const aRank = priority.get(a.iso2) ?? 10_000;
  const bRank = priority.get(b.iso2) ?? 10_000;
  return aRank - bRank || a.countryAr.localeCompare(b.countryAr, 'ar');
});

function flagEmoji(iso2) {
  return [...iso2].map(letter => String.fromCodePoint(127397 + letter.charCodeAt(0))).join('');
}

const flagPrompts = [
  record => `هالعلم ${flagEmoji(record.iso2)} يرجع لأي دولة؟`,
  record => `أي دولة يمثلها العلم ${flagEmoji(record.iso2)}؟`,
  record => `عرفت علم أي دولة: ${flagEmoji(record.iso2)}؟`,
  record => `شنو اسم الدولة صاحبة هالعلم ${flagEmoji(record.iso2)}؟`,
  record => `هذي الراية الوطنية ${flagEmoji(record.iso2)} لأي بلد؟`,
  record => `حدد الدولة التي يرمز لها العلم ${flagEmoji(record.iso2)}؟`,
];

function baseCandidate(category, level, record, question, answer, explanation, templateId) {
  const candidate = {
    category,
    difficultyLevel: level,
    difficulty: level <= 2 ? 'easy' : level <= 4 ? 'normal' : 'hard',
    question,
    answer,
    explanation,
    religious: false,
    sourceRecordId: record.sourceRecordId,
    templateId,
    source: {
      title: `World Bank country record — ${record.countryEn}`,
      url: record.sourceUrl,
      publisher: record.sourcePublisher,
      evidence: `يعرض السجل الرسمي رمز الدولة ${record.iso2} واسمها ${record.countryEn} وعاصمتها ${record.capitalEn}.`,
    },
  };
  candidate.id = stableQuestionId(candidate);
  return candidate;
}

function questionFor(category, level, record) {
  if (category === 'أعلام الدول') {
    return baseCandidate(
      category, level, record, flagPrompts[level - 1](record), record.countryAr,
      `رمز العلم مكوّن حتميًا من رمز الدولة الدولي ${record.iso2}، والسجل الرسمي يطابقه مع ${record.countryAr}.`,
      `country-flag-emoji-v1-l${level}`,
    );
  }
  const reverse = level >= 4;
  return baseCandidate(
    category,
    level,
    record,
    reverse ? `أي دولة عاصمتها «${record.capitalAr}»؟` : `شنو عاصمة دولة «${record.countryAr}»؟`,
    reverse ? record.countryAr : record.capitalAr,
    reverse
      ? `${record.capitalAr} هي عاصمة ${record.countryAr} حسب سجل الدولة الرسمي.`
      : `عاصمة ${record.countryAr} المسجلة رسميًا هي ${record.capitalAr}.`,
    reverse ? `country-from-capital-v1-l${level}` : `capital-from-country-v1-l${level}`,
  );
}

const policy = loadPolicy();
const candidates = readJson(CANDIDATES_PATH, []);
const knownIds = new Set(candidates.map(candidate => candidate.id));
const comparisons = [
  ...loadExistingQuestionTexts(),
  ...candidates.filter(candidate => candidate.status === 'approved').map(candidate => candidate.question),
];
const added = [];

for (const category of ['أعلام الدول', 'جغرافيا']) {
  const usedRecordIds = new Set(candidates.filter(candidate => candidate.category === category)
    .map(candidate => candidate.sourceRecordId).filter(Boolean));
  let cursor = 0;
  for (let level = 1; level <= 6; level += 1) {
    const needed = Number(bankPlan.categories?.[category]?.levels?.[level]?.gap || 0);
    let accepted = 0;
    const rejectionCounts = {};
    while (accepted < needed && cursor < records.length) {
      const record = records[cursor++];
      if (usedRecordIds.has(record.sourceRecordId)) continue;
      const candidate = questionFor(category, level, record);
      const validation = validateCandidate(candidate, { policy, existingQuestions: comparisons });
      if (!validation.valid || knownIds.has(candidate.id)) {
        for (const reason of validation.errors.length ? validation.errors : ['duplicate_id']) {
          rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1;
        }
        continue;
      }
      const now = new Date().toISOString();
      Object.assign(candidate, {
        status: 'approved',
        generation: {
          model: 'deterministic-world-bank-template-v1',
          responseId: null,
          generatedAt: now,
          usage: { inputTokens: 0, outputTokens: 0, webSearchCalls: 0, estimatedUsd: 0 },
        },
        verification: {
          model: 'schema-source-and-duplicate-v1',
          responseId: null,
          checkedAt: now,
          result: {
            verdict: 'pass', factCorrect: true, answerExact: true, answerNotRevealed: true,
            sourceSupportsClaim: true, clearArabic: true, reason: 'قالب حتمي من سجل رسمي ذي بصمة.',
          },
          usage: { inputTokens: 0, outputTokens: 0, webSearchCalls: 0, estimatedUsd: 0 },
        },
        cost: { pricingAsOf: null, budgetUsd: 0, runEstimatedUsd: 0 },
        review: {
          reviewer: 'deterministic-world-bank-template-v1',
          decision: 'approve',
          notes: 'تحقق مخطط السجل، المصدر الموثوق، عدم كشف الإجابة، والتكرار آلياً.',
          religiousSourceAndIsnadConfirmed: false,
          reviewedAt: now,
        },
      });
      candidates.push(candidate);
      added.push(candidate);
      knownIds.add(candidate.id);
      comparisons.push(candidate.question);
      usedRecordIds.add(record.sourceRecordId);
      accepted += 1;
    }
    if (accepted !== needed) throw new Error(
      `${category} — المستوى ${level}: المطلوب ${needed} والمتاح ${accepted}. ` +
      `الاستبعادات: ${JSON.stringify(rejectionCounts)}.`
    );
  }
}

if (write) writeJsonAtomic(CANDIDATES_PATH, candidates);
const byCategory = Object.fromEntries(['أعلام الدول', 'جغرافيا'].map(category => [category,
  added.filter(candidate => candidate.category === category).length,
]));
console.log(JSON.stringify({
  mode: write ? 'write' : 'dry-run',
  added: added.length,
  byCategory,
  approved: added.length,
  aiCalls: 0,
  estimatedAiCostUsd: 0,
}, null, 2));
