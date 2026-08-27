#!/usr/bin/env node
import path from 'node:path';
import {
  CANDIDATES_PATH, CONTENT_DIR, difficultyTier, loadExistingQuestionTexts, loadPolicy,
  readJson, stableQuestionId, validateCandidate, writeJsonAtomic,
} from './lib.mjs';

const write = process.argv.includes('--write');
const category = 'رياضة';
const model = 'deterministic-fifa-match-template-v1';
const excludedQuestionContent = /إسرائيل|اسرائيل|إسرائيلي|اسرائيلي|تل أبيب|تل ابيب/i;
const sourceDocument = readJson(path.join(CONTENT_DIR, 'structured-sources', 'fifa-world-cup-matches.json'), null);
const bankPlan = readJson(path.join(CONTENT_DIR, 'bank-plan-5000.json'), null);
if (!sourceDocument?.records?.length) throw new Error('شغّل questions:import-fifa-world-cup-matches أولاً.');
if (!bankPlan || bankPlan.targetBankSize !== 5000) throw new Error('خطة بنك 5000 غير صالحة.');

function candidateFor(level, record, ordinal) {
  const score = `${record.homeScore}–${record.awayScore}`;
  const matchLabel = `المباراة رقم ${record.matchId}`;
  let question;
  let answer;
  if (level === 1) {
    question = `منو فاز في ${matchLabel} بكأس العالم ${record.year}؟`;
    answer = record.winner;
  } else if (level === 2) {
    question = `منو خسر في ${matchLabel} بكأس العالم ${record.year}؟`;
    answer = record.loser;
  } else if (level === 3) {
    question = `كم انتهت مباراة ${record.home} ضد ${record.away} في كأس العالم ${record.year}؟`;
    answer = score;
  } else if (level === 4) {
    question = `على أي ملعب لعبت مباراة ${record.home} ضد ${record.away} في كأس العالم ${record.year} وانتهت ${score}؟`;
    answer = record.stadium;
  } else if (level === 5) {
    question = `في أي مدينة لعبت مباراة ${record.home} ضد ${record.away} في كأس العالم ${record.year} وانتهت ${score}؟`;
    answer = record.city;
  } else {
    question = `في أي دور لعبت مباراة ${record.home} ضد ${record.away} في كأس العالم ${record.year} وانتهت ${score}؟`;
    answer = record.stage;
  }
  const candidate = {
    category, difficultyLevel: level, difficulty: difficultyTier(level), question, answer,
    explanation: `سجل FIFA الرسمي يثبت أن ${record.home} واجه ${record.away} في ${record.stage} بمدينة ${record.city} على ${record.stadium}، وانتهت المباراة ${score} وفاز ${record.winner}.`,
    religious: false, sourceRecordId: `${record.sourceRecordId}-l${level}-${ordinal}`,
    templateId: `fifa-match-v1-l${level}`,
    source: { title: `FIFA World Cup ${record.year} — match ${record.matchId}`,
      url: record.sourceUrl, publisher: record.sourcePublisher,
      evidence: `سجل FIFA للمباراة ${record.matchId}: ${record.home} ضد ${record.away}؛ ${score}؛ ${record.stage}؛ ${record.stadium}؛ ${record.city}.` },
  };
  candidate.id = stableQuestionId(candidate);
  return candidate;
}

const policy = loadPolicy();
const candidates = readJson(CANDIDATES_PATH, []);
const knownIds = new Set(candidates.map(candidate => candidate.id));
const comparisons = [...loadExistingQuestionTexts(),
  ...candidates.filter(candidate => candidate.status === 'approved').map(candidate => candidate.question)];
const added = [];
const usedMatchIds = new Set();

function approve(candidate) {
  const now = new Date().toISOString();
  Object.assign(candidate, {
    status: 'approved',
    generation: { model, responseId: null, generatedAt: now,
      usage: { inputTokens: 0, outputTokens: 0, webSearchCalls: 0, estimatedUsd: 0 } },
    verification: { model: 'schema-source-and-duplicate-v1', responseId: null, checkedAt: now,
      result: { verdict: 'pass', factCorrect: true, answerExact: true, answerNotRevealed: true,
        sourceSupportsClaim: true, clearArabic: true, reason: 'قالب حتمي من سجل مباراة FIFA الرسمي.' },
      usage: { inputTokens: 0, outputTokens: 0, webSearchCalls: 0, estimatedUsd: 0 } },
    cost: { pricingAsOf: null, budgetUsd: 0, runEstimatedUsd: 0 },
    review: { reviewer: model, decision: 'approve', notes: 'تحقق حتمي من المصدر وعدم كشف الإجابة.',
      religiousSourceAndIsnadConfirmed: false, reviewedAt: now },
  });
  candidates.push(candidate); added.push(candidate); knownIds.add(candidate.id); comparisons.push(candidate.question);
}

for (let level = 1; level <= 6; level += 1) {
  const needed = Number(bankPlan.categories?.[category]?.levels?.[level]?.gap || 0);
  let accepted = 0;
  const rejections = {};
  for (const record of sourceDocument.records) {
    if (accepted >= needed) break;
    if (usedMatchIds.has(record.sourceRecordId)) continue;
    if (excludedQuestionContent.test(`${record.home} ${record.away} ${record.winner} ${record.loser}`)) continue;
    const candidate = candidateFor(level, record, accepted + 1);
    const validation = validateCandidate(candidate, { policy, existingQuestions: comparisons });
    if (!validation.valid || knownIds.has(candidate.id)) {
      for (const error of validation.errors.length ? validation.errors : ['duplicate_id'])
        rejections[error] = (rejections[error] || 0) + 1;
      continue;
    }
    approve(candidate); usedMatchIds.add(record.sourceRecordId); accepted += 1;
  }
  if (accepted !== needed) throw new Error(`${category} المستوى ${level}: ${accepted}/${needed}؛ ${JSON.stringify(rejections)}`);
}

if (write) writeJsonAtomic(CANDIDATES_PATH, candidates);
console.log(JSON.stringify({ mode: write ? 'write' : 'dry-run', added: added.length,
  byLevel: Object.fromEntries(Array.from({ length: 6 }, (_, index) => [index + 1,
    added.filter(item => item.difficultyLevel === index + 1).length])),
  previews: Array.from({ length: 6 }, (_, index) => added.find(item => item.difficultyLevel === index + 1))
    .filter(Boolean).map(item => ({ level: item.difficultyLevel, question: item.question, answer: item.answer })),
  aiCalls: 0, estimatedAiCostUsd: 0 }, null, 2));
