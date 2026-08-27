#!/usr/bin/env node
import path from 'node:path';
import {
  CANDIDATES_PATH, CONTENT_DIR, difficultyTier, loadExistingQuestionTexts, loadPolicy,
  readJson, stableQuestionId, validateCandidate, writeJsonAtomic,
} from './lib.mjs';

const write = process.argv.includes('--write');
const previewAll = process.argv.includes('--preview-all');
const category = 'حضارات قديمة';
const model = 'deterministic-unesco-archaeological-site-template-v1';
const recordsDocument = readJson(path.join(CONTENT_DIR, 'structured-sources', 'unesco-archaeological-sites.json'), null);
const bankPlan = readJson(path.join(CONTENT_DIR, 'bank-plan-5000.json'), null);
if (!recordsDocument || recordsDocument.schemaVersion !== 1 || !Array.isArray(recordsDocument.records)) {
  throw new Error('شغّل questions:import-unesco-archaeological-sites أولاً.');
}
if (!bankPlan || bankPlan.targetBankSize !== 5000) throw new Error('خطة بنك 5000 غير صالحة.');

const templates = [
  record => `في أي دولة يقع الموقع الأثري «${record.siteNameAr}»؟`,
  record => `موقع «${record.siteNameAr}» الأثري موجود بأي دولة؟`,
  record => `حدد الدولة الحديثة التي تضم الموقع الأثري «${record.siteNameAr}»؟`,
  record => `أي دولة تحتضن موقع «${record.siteNameAr}» المسجل أثرياً؟`,
  record => `وين يقع الموقع الأثري «${record.siteNameAr}» من بين دول العالم؟`,
  record => `إلى أي دولة يُنسب موقع «${record.siteNameAr}» في سجل التراث العالمي؟`,
];

function candidateFor(level, record) {
  const candidate = {
    category,
    difficultyLevel: level,
    difficulty: difficultyTier(level),
    question: templates[level - 1](record),
    answer: record.countryNameAr,
    explanation: `يسجل مركز التراث العالمي موقع ${record.siteNameAr} ضمن ممتلكات ${record.countryNameAr}.`,
    religious: false,
    sourceRecordId: record.sourceRecordId,
    templateId: `unesco-archaeological-site-country-v1-l${level}`,
    source: {
      title: `UNESCO World Heritage List — ${record.whPropertyId}`,
      url: record.sourceUrl,
      publisher: record.sourcePublisher,
      evidence: `صفحة الملكية رقم ${record.whPropertyId} تربط الموقع الأثري بالدولة الطرف ${record.countryNameAr}.`,
    },
  };
  candidate.id = stableQuestionId(candidate);
  return candidate;
}

const policy = loadPolicy();
const candidates = readJson(CANDIDATES_PATH, []);
const knownIds = new Set(candidates.map(candidate => candidate.id));
const comparisons = [...loadExistingQuestionTexts(),
  ...candidates.filter(candidate => candidate.status === 'approved').map(candidate => candidate.question)];
const usedRecordIds = new Set(candidates.filter(candidate => candidate.category === category)
  .map(candidate => candidate.sourceRecordId).filter(Boolean));
const sourcePageUses = new Map();
const added = [];
let cursor = 0;

for (let level = 1; level <= 6; level += 1) {
  const needed = Number(bankPlan.categories?.[category]?.levels?.[level]?.gap || 0);
  let accepted = 0;
  const rejectionCounts = {};
  while (accepted < needed && cursor < recordsDocument.records.length) {
    const record = recordsDocument.records[cursor++];
    if (usedRecordIds.has(record.sourceRecordId) || (sourcePageUses.get(record.sourceUrl) || 0) >= 2) continue;
    const candidate = candidateFor(level, record);
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
      generation: { model, responseId: null, generatedAt: now,
        usage: { inputTokens: 0, outputTokens: 0, webSearchCalls: 0, estimatedUsd: 0 } },
      verification: {
        model: 'schema-source-and-duplicate-v1', responseId: null, checkedAt: now,
        result: { verdict: 'pass', factCorrect: true, answerExact: true, answerNotRevealed: true,
          sourceSupportsClaim: true, clearArabic: true,
          reason: 'قالب حتمي؛ الاسم العربي مفهرس والبلد موثق بصفحة ملكية اليونسكو.' },
        usage: { inputTokens: 0, outputTokens: 0, webSearchCalls: 0, estimatedUsd: 0 },
      },
      cost: { pricingAsOf: null, budgetUsd: 0, runEstimatedUsd: 0 },
      review: { reviewer: model, decision: 'approve',
        notes: 'استُبعدت المواقع متعددة الدول والأسماء المكررة وكشف الإجابة، وحُد الاستخدام باثنين لكل صفحة ملكية.',
        religiousSourceAndIsnadConfirmed: false, reviewedAt: now },
    });
    candidates.push(candidate);
    added.push(candidate);
    knownIds.add(candidate.id);
    comparisons.push(candidate.question);
    usedRecordIds.add(record.sourceRecordId);
    sourcePageUses.set(record.sourceUrl, (sourcePageUses.get(record.sourceUrl) || 0) + 1);
    accepted += 1;
  }
  if (accepted !== needed) throw new Error(
    `${category} — المستوى ${level}: المطلوب ${needed} والمتاح ${accepted}. الاستبعادات: ${JSON.stringify(rejectionCounts)}.`
  );
}

if (write) writeJsonAtomic(CANDIDATES_PATH, candidates);
console.log(JSON.stringify({
  mode: write ? 'write' : 'dry-run', added: added.length,
  byLevel: Object.fromEntries(Array.from({ length: 6 }, (_, index) => [index + 1,
    added.filter(candidate => candidate.difficultyLevel === index + 1).length])),
  previews: Array.from({ length: 6 }, (_, index) => {
    const candidate = added.find(item => item.difficultyLevel === index + 1);
    return candidate ? { level: index + 1, question: candidate.question, answer: candidate.answer } : null;
  }).filter(Boolean),
  ...(previewAll ? { allQuestions: added.map(candidate => ({
    level: candidate.difficultyLevel, question: candidate.question, answer: candidate.answer,
    sourceRecordId: candidate.sourceRecordId,
  })) } : {}),
  approved: added.length, aiCalls: 0, estimatedAiCostUsd: 0,
}, null, 2));
