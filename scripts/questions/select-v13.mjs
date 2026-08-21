#!/usr/bin/env node
import {
  CANDIDATES_PATH,
  loadExistingQuestionTexts,
  loadPolicy,
  readJson,
  validateCandidate,
  writeJsonAtomic,
} from './lib.mjs';

const categories = [
  'ألعاب الفيديو',
  'اللغة العربية',
  'كتب وروايات',
  'اختراعات واكتشافات',
  'مطابخ العالم',
  'وش الرابط؟',
];

// استبعادات المراجعة الدلالية: تكرار موضوع/إجابة، أو صياغة أقل تنوعاً من البدائل.
const excluded = new Set([
  'gq-e10a6c52dd9dac80ec08',
  'gq-e14e5dc34b4b48d13dbb',
  'gq-4f5decf73eb4b46ff646',
  'gq-cc282dc292a2ba8b1926',
  'gq-26baa25b5de31c72135e',
  'gq-4619b2b1ba9e7bfea123',
  'gq-6b15a77b761a7870c0bf',
  'gq-be442050676b55e5ea0c',
  'gq-39bb9c7220b2d185cda4',
  'gq-409599d1b17b0f05f2f8',
  'gq-880e44cf50c97d5e98da',
  'gq-37334b262f2a3f131827',
  'gq-923e739d0da8356b9a7d',
  'gq-d80a21eecd9b6af1136a',
  'gq-7dab911de410090c3abe',
  'gq-e96156f7b30ceba2027f',
  'gq-b6d14901ce430f5bcf51',
  'gq-e604fbd9f9c6297bdb2c',
  'gq-81c03edb0d845d7bc5d9',
  'gq-a59446d612e0b1407736',
  'gq-7d53e2729180261bad90',
  'gq-c46a7525dac435affec6',
  'gq-68b457bc9a06957cf86c',
  'gq-cd4a753ffdbbf4c83b1a',
]);

const candidates = readJson(CANDIDATES_PATH, []);
const selected = [];
for (const category of categories) {
  for (let level = 1; level <= 6; level += 1) {
    const choices = candidates.filter(candidate =>
      candidate.category === category &&
      candidate.difficultyLevel === level &&
      candidate.status === 'pending_review' &&
      !excluded.has(candidate.id));
    if (choices.length < 4) {
      throw new Error(`${category} — المستوى ${level}: المتاح ${choices.length} فقط بعد الاستبعادات.`);
    }
    selected.push(...choices.slice(0, 4));
  }
}

const selectedIds = new Set(selected.map(candidate => candidate.id));
const policy = loadPolicy();
const comparisons = loadExistingQuestionTexts();
for (const candidate of selected) {
  const check = validateCandidate(candidate, { policy, existingQuestions: comparisons });
  if (!check.valid) throw new Error(`${candidate.id}: ${check.errors.join(', ')}`);
  comparisons.push(candidate.question);
}

const reviewedAt = new Date().toISOString();
for (const candidate of candidates) {
  if (!categories.includes(candidate.category) || candidate.status !== 'pending_review') continue;
  const approved = selectedIds.has(candidate.id);
  candidate.status = approved ? 'approved' : 'rejected_by_reviewer';
  candidate.review = {
    reviewer: 'Codex-assisted source review',
    decision: approved ? 'approve' : 'reject',
    notes: approved
      ? 'اجتاز التحقق المستقل واختير ضمن دفعة 1.3 المتوازنة مع مراجعة التنوع والمصدر.'
      : 'لم يُختر للدفعة: فائض عن أربعة أسئلة للمستوى أو أقل تنوعاً من البدائل.',
    religiousSourceAndIsnadConfirmed: false,
    reviewedAt,
  };
}

writeJsonAtomic(CANDIDATES_PATH, candidates);
console.log(JSON.stringify({ selected: selected.length, categories: categories.length, perLevel: 4 }, null, 2));
