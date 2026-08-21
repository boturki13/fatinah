#!/usr/bin/env node
import fs from 'node:fs';
import {
  APPROVED_BANK_PATH,
  CANDIDATES_PATH,
  PUBLISHED_PATH,
  isNearDuplicate,
  loadExistingQuestionTexts,
  loadPolicy,
  readJson,
  validateCandidate,
  writeJsonAtomic,
} from './lib.mjs';

const candidates = readJson(CANDIDATES_PATH, []);
const approved = candidates.filter(candidate => candidate.status === 'approved');
const policy = loadPolicy();
const baseQuestions = loadExistingQuestionTexts();
const accepted = [];

for (const candidate of approved) {
  if (candidate.religious && !candidate.review?.religiousSourceAndIsnadConfirmed) {
    throw new Error(`${candidate.id}: سؤال ديني بلا تأكيد مراجعة المصدر والإسناد.`);
  }
  const comparisons = [
    ...baseQuestions.filter(question => question !== candidate.question),
    ...accepted.map(question => question.question),
  ];
  const validation = validateCandidate(candidate, { policy, existingQuestions: comparisons });
  if (!validation.valid || isNearDuplicate(candidate.question, comparisons)) {
    throw new Error(`${candidate.id}: فشل فحص النشر (${validation.errors.join(', ')}).`);
  }
  accepted.push(candidate);
}

accepted.sort((a, b) => a.category.localeCompare(b.category, 'ar') || a.difficultyLevel - b.difficultyLevel || a.id.localeCompare(b.id));
writeJsonAtomic(PUBLISHED_PATH, accepted);

const bank = {};
for (const candidate of accepted) {
  if (!bank[candidate.category]) bank[candidate.category] = [];
  bank[candidate.category].push({
    id: candidate.id,
    d: candidate.difficultyLevel,
    q: candidate.question,
    answer: candidate.answer,
    explanation: candidate.explanation,
    source: {
      title: candidate.source.title,
      url: candidate.source.url,
      publisher: candidate.source.publisher,
    },
    review: {
      status: 'approved',
      bankVersion: 3,
      reviewedAt: candidate.review.reviewedAt,
      reviewer: candidate.review.reviewer,
      religiousSourceAndIsnadConfirmed: candidate.review.religiousSourceAndIsnadConfirmed,
      generationModel: candidate.generation.model,
      verificationModel: candidate.verification.model,
    },
  });
}

const javascript = `// ملف مولّد؛ لا تعدله يدوياً. المصدر: content/questions/candidates.json\nwindow.__APPROVED_QUESTION_BANK_DATA__ = ${JSON.stringify(bank, null, 2)};\n`;
const temporary = `${APPROVED_BANK_PATH}.${process.pid}.tmp`;
fs.writeFileSync(temporary, javascript, { mode: 0o644 });
fs.renameSync(temporary, APPROVED_BANK_PATH);
console.log(JSON.stringify({ published: accepted.length, categories: Object.keys(bank).length }, null, 2));
