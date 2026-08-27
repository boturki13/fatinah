#!/usr/bin/env node
import path from 'node:path';
import {
  CANDIDATES_PATH, CONTENT_DIR, difficultyTier, loadExistingQuestionTexts, loadPolicy,
  readJson, stableQuestionId, validateCandidate, writeJsonAtomic,
} from './lib.mjs';

const write = process.argv.includes('--write');
const category = 'كأس العالم';
const model = 'deterministic-fifa-world-cup-finals-template-v1';
const recordsDocument = readJson(path.join(CONTENT_DIR, 'structured-sources', 'fifa-world-cup-finals.json'), null);
const bankPlan = readJson(path.join(CONTENT_DIR, 'bank-plan-5000.json'), null);
if (!recordsDocument || recordsDocument.schemaVersion !== 1 || !Array.isArray(recordsDocument.records)) {
  throw new Error('شغّل questions:import-fifa-world-cup-finals أولاً.');
}
if (!bankPlan || bankPlan.targetBankSize !== 5000) throw new Error('خطة بنك 5000 غير صالحة.');

const factTypeByLevel = new Map([[1, 'champion'], [2, 'runner-up'], [3, 'score'], [4, 'stadium'], [5, 'city'], [6, 'date']]);
const summaryByMatch = new Map(recordsDocument.finals.map(item => [String(item.matchId), item]));

function candidateFor(level, record) {
  const summary = summaryByMatch.get(record.matchId);
  let question;
  let answer = record.answer;
  let templateId;
  if (level === 1) {
    question = `منو فاز بكأس العالم سنة ${record.year}؟`;
    templateId = 'world-cup-final-champion-v1-l1';
  } else if (level === 2) {
    question = `منو كان وصيف كأس العالم سنة ${record.year}؟`;
    templateId = 'world-cup-final-runner-up-v1-l2';
  } else if (level === 3) {
    question = `كم انتهى نهائي ${record.year} بين ${summary.home} و${summary.away} على ${summary.stadium}، قبل ركلات الترجيح إن وُجدت؟`;
    templateId = 'world-cup-final-score-v1-l3';
  } else if (level === 4) {
    question = `على أي ملعب انلعب نهائي ${record.year} بين ${summary.home} و${summary.away} وانتهى ${summary.score}؟`;
    templateId = 'world-cup-final-stadium-v1-l4';
  } else if (level === 5) {
    question = `في أي مدينة انلعب نهائي ${record.year} بين ${summary.home} و${summary.away} وانتهى ${summary.score}؟`;
    templateId = 'world-cup-final-city-v1-l5';
  } else {
    question = `شنو التاريخ الكامل لنهائي ${record.year} بين ${summary.home} و${summary.away} وانتهى ${summary.score}؟`;
    templateId = 'world-cup-final-date-v1-l6';
  }
  const penalties = summary.homePenaltyScore != null && summary.awayPenaltyScore != null
    ? ` وانتهت ركلات الترجيح ${summary.homePenaltyScore}–${summary.awayPenaltyScore}` : '';
  const candidate = {
    category, difficultyLevel: level, difficulty: difficultyTier(level), question, answer,
    explanation: `يسجل FIFA نهائي ${record.year} بين ${summary.home} و${summary.away} بنتيجة ${summary.score}، والبطل ${summary.champion}${penalties}.`,
    religious: false, sourceRecordId: record.sourceRecordId, templateId,
    source: {
      title: `FIFA World Cup ${record.year} — Final (match ${record.matchId})`,
      url: record.sourceUrl,
      publisher: record.sourcePublisher,
      evidence: `سجل مباراة FIFA الرسمي رقم ${record.matchId}: ${summary.home} ضد ${summary.away}؛ النتيجة ${summary.score}؛ البطل ${summary.champion}؛ الملعب ${summary.stadium}؛ المدينة ${summary.city}؛ التاريخ ${summary.finalDate}.`,
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
const added = [];

function approveCandidate(candidate) {
  const now = new Date().toISOString();
  Object.assign(candidate, {
    status: 'approved',
    generation: { model, responseId: null, generatedAt: now,
      usage: { inputTokens: 0, outputTokens: 0, webSearchCalls: 0, estimatedUsd: 0 } },
    verification: {
      model: 'schema-source-and-duplicate-v1', responseId: null, checkedAt: now,
      result: { verdict: 'pass', factCorrect: true, answerExact: true, answerNotRevealed: true,
        sourceSupportsClaim: true, clearArabic: true,
        reason: 'قالب حتمي من سجل المباراة الرسمي في FIFA وبصمة حقيقة مستقلة.' },
      usage: { inputTokens: 0, outputTokens: 0, webSearchCalls: 0, estimatedUsd: 0 },
    },
    cost: { pricingAsOf: null, budgetUsd: 0, runEstimatedUsd: 0 },
    review: { reviewer: model, decision: 'approve',
      notes: 'تحقق آلي من المباراة والنسخة والمصدر وعدم كشف الإجابة والتكرار.',
      religiousSourceAndIsnadConfirmed: false, reviewedAt: now },
  });
  candidates.push(candidate); added.push(candidate); knownIds.add(candidate.id);
  comparisons.push(candidate.question); usedRecordIds.add(candidate.sourceRecordId);
}

for (let level = 1; level <= 6; level += 1) {
  const needed = Number(bankPlan.categories?.[category]?.levels?.[level]?.gap || 0);
  const factType = factTypeByLevel.get(level);
  const pool = recordsDocument.records.filter(record => record.factType === factType)
    .sort((a, b) => a.year - b.year);
  let accepted = 0;
  const rejectionCounts = {};
  const rejectionExamples = [];
  for (const record of pool) {
    if (accepted >= needed) break;
    if (usedRecordIds.has(record.sourceRecordId)) continue;
    const candidate = candidateFor(level, record);
    const validation = validateCandidate(candidate, { policy, existingQuestions: comparisons });
    if (!validation.valid || knownIds.has(candidate.id)) {
      if (rejectionExamples.length < 3) rejectionExamples.push({ question: candidate.question, errors: validation.errors });
      for (const reason of validation.errors.length ? validation.errors : ['duplicate_id']) {
        rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1;
      }
      continue;
    }
    approveCandidate(candidate);
    accepted += 1;
  }
  if (accepted !== needed) throw new Error(
    `${category} — المستوى ${level}: المطلوب ${needed} والمتاح ${accepted}. ` +
    `الاستبعادات: ${JSON.stringify(rejectionCounts)}. أمثلة: ${JSON.stringify(rejectionExamples)}.`
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
  approved: added.length, aiCalls: 0, estimatedAiCostUsd: 0,
}, null, 2));
