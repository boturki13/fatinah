#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CANDIDATES_PATH,
  ROOT,
  familyContentViolations,
  isReligiousCategory,
  loadPolicy,
  loadReligiousSourcePackets,
  normalizeArabic,
  readJson,
  structuredRelationKey,
  validateCandidate,
  writeJsonAtomic,
} from './lib.mjs';
import { buildRuntimeAuditManifest } from './runtime-audit-manifest-lib.mjs';

const policy = loadPolicy();
const religiousSourcePackets = loadReligiousSourcePackets();
// بنك الخادم مستقل عن بنك fallback الصغير المضمّن في التطبيق.
const candidates = readJson(CANDIDATES_PATH, []).filter(candidate => candidate.status === 'approved');
const bankPlan = readJson(path.join(ROOT, 'content', 'questions', 'bank-plan-5000.json'), null);
const bank = {};
const rejected = [];

const structuredAnswers = new Map();
for (const candidate of candidates) {
  const key = structuredRelationKey(candidate);
  if (!key) continue;
  if (!structuredAnswers.has(key)) structuredAnswers.set(key, new Set());
  structuredAnswers.get(key).add(normalizeArabic(candidate.answer));
}
const ambiguousStructured = [...structuredAnswers].filter(([, answers]) => answers.size > 1);
if (ambiguousStructured.length) {
  throw new Error(`مرشحون منظمون لهم أكثر من جواب: ${ambiguousStructured.length}.`);
}

if (!bankPlan || bankPlan.schemaVersion !== 1 || !bankPlan.categories) {
  throw new Error('خطة بنك 5000 غير موجودة أو غير صالحة.');
}
const textTargets = Object.fromEntries(Object.entries(bankPlan.categories)
  .filter(([, item]) => item?.kind === 'text')
  .map(([category, item]) => [category, Number(item.target)]));
const targetBankSize = Object.values(textTargets).reduce((sum, target) => sum + target, 0);
if (!Number.isSafeInteger(targetBankSize) || targetBankSize <= 0 || targetBankSize >= bankPlan.targetBankSize) {
  throw new Error('هدف البنك النصي المستخرج من الخطة غير صالح.');
}

for (const candidate of candidates) {
  const religious = isReligiousCategory(candidate.category, policy) || candidate.religious === true;
  const fullyReviewed = candidate.status === 'approved' && (!religious || (
    candidate.review?.religiousSourceAndIsnadConfirmed === true &&
    candidate.review?.religiousCanonicalSourceConfirmed === true &&
    candidate.review?.religiousNoDisputedMatterConfirmed === true
  ));
  const validation = validateCandidate(candidate, {
    policy,
    existingQuestions: [],
    religiousSourcePackets: religious ? religiousSourcePackets : [],
  });
  if (!fullyReviewed || !validation.valid) {
    rejected.push({ id: candidate.id, religious, errors: [
      ...(fullyReviewed ? [] : ['human_review_incomplete']),
      ...validation.errors,
    ] });
    continue;
  }
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
    sourcePacketId: candidate.sourcePacketId || null,
    review: {
      status: 'approved',
      reviewedAt: candidate.review.reviewedAt,
      religiousHumanReviewComplete: religious,
    },
  });
}

// بنك الخادم يضم أيضاً الأسئلة المحلية القديمة التي لها مراجعة فردية مطابقة
// لبصمة السؤال والإجابة والمصدر. لا ننسخ معرّفاتها القديمة غير القياسية؛
// نمنح كل سجل معرّف gq ثابتاً مشتقاً من محتواه مع الاحتفاظ بالمعرّف السابق.
const runtimeManifest = buildRuntimeAuditManifest();
for (const item of runtimeManifest.questions.filter(question => question.origin.component !== 'published')) {
  const religious = isReligiousCategory(item.category, policy);
  const familyViolations = familyContentViolations(item, policy);
  if (familyViolations.length) {
    rejected.push({ id: item.runtimeId, religious, errors: familyViolations });
    continue;
  }
  const eligible = item.review?.status === 'approved'
    && item.citation?.claimSpecific === true
    && item.citation?.effective?.url
    && (!religious || item.review?.religiousSourceAndIsnadConfirmed === true);
  if (!eligible) {
    rejected.push({ id: item.runtimeId, religious, errors: ['legacy_runtime_review_incomplete'] });
    continue;
  }
  const stableId = `gq-${crypto.createHash('sha256').update(JSON.stringify({
    category: item.category,
    difficultyLevel: item.difficultyLevel,
    question: item.question,
    answer: item.answer,
    source: item.citation.effective,
  })).digest('hex').slice(0, 20)}`;
  if (!bank[item.category]) bank[item.category] = [];
  bank[item.category].push({
    id: stableId,
    previousIds: [item.runtimeId, ...(item.previousIds || [])],
    d: item.difficultyLevel,
    q: item.question,
    answer: item.answer,
    source: {
      title: item.citation.effective.title,
      url: item.citation.effective.url,
      publisher: item.citation.effective.publisher || item.citation.effective.title,
    },
    sourcePacketId: null,
    review: {
      status: 'approved',
      reviewedAt: item.review.reviewedAt,
      religiousHumanReviewComplete: false,
      basis: item.review.basis,
    },
  });
}

for (const questions of Object.values(bank)) {
  questions.sort((left, right) => left.d - right.d || left.id.localeCompare(right.id));
}

const generatedAt = new Date().toISOString();
const canonical = JSON.stringify(bank);
const digest = crypto.createHash('sha256').update(canonical).digest('hex');
const questionCount = Object.values(bank).reduce((sum, rows) => sum + rows.length, 0);
const ids = Object.values(bank).flat().map(question => question.id);
if (new Set(ids).size !== ids.length) throw new Error('بنك الخادم يحتوي معرّفات مكررة.');
const unsafeRuntime = Object.entries(bank).flatMap(([category, questions]) =>
  questions.flatMap(question => {
    const violations = familyContentViolations({ category, ...question }, policy);
    return violations.length ? [{ id: question.id, violations }] : [];
  }));
if (unsafeRuntime.length) {
  throw new Error(`بوابة المحتوى العائلي رفضت بنك التشغيل: ${JSON.stringify(unsafeRuntime)}.`);
}
const answersByQuestion = new Map();
for (const question of Object.values(bank).flat()) {
  const key = normalizeArabic(question.q);
  if (!answersByQuestion.has(key)) answersByQuestion.set(key, new Set());
  answersByQuestion.get(key).add(normalizeArabic(question.answer));
}
if ([...answersByQuestion.values()].some(answers => answers.size > 1)) {
  throw new Error('بنك الخادم يحتوي سؤالاً واحداً بأكثر من إجابة.');
}
for (const [category, target] of Object.entries(textTargets)) {
  const actual = bank[category]?.length || 0;
  if (actual !== target) throw new Error(`${category}: البنك النصي ${actual}/${target}.`);
}
const unexpectedCategories = Object.keys(bank).filter(category => !(category in textTargets));
if (unexpectedCategories.length) {
  throw new Error(`فئات نصية غير موجودة في الخطة: ${unexpectedCategories.join('، ')}.`);
}
if (questionCount !== targetBankSize) {
  throw new Error(`بنك الخادم النصي ${questionCount}/${targetBankSize}.`);
}
const outputDirectory = path.join(ROOT, 'server-assets', 'question-bank', 'v1');
writeJsonAtomic(path.join(outputDirectory, 'bank.json'), {
  schemaVersion: 1,
  bankVersion: `v1-${digest.slice(0, 16)}`,
  generatedAt,
  sha256: digest,
  questionCount,
  targetBankSize,
  ready: questionCount === targetBankSize,
  categories: bank,
});
writeJsonAtomic(path.join(outputDirectory, 'manifest.json'), {
  schemaVersion: 1,
  bankVersion: `v1-${digest.slice(0, 16)}`,
  generatedAt,
  sha256: digest,
  questionCount,
  categoryCount: Object.keys(bank).length,
  excludedCount: rejected.length,
  religiousExcludedPendingFullReview: rejected.filter(item => item.religious).length,
  targetBankSize,
  ready: questionCount === targetBankSize,
});

if (rejected.some(item => !item.religious)) {
  fs.writeFileSync(path.join(outputDirectory, 'rejected.json'), `${JSON.stringify(rejected, null, 2)}\n`, { mode: 0o600 });
} else {
  try { fs.unlinkSync(path.join(outputDirectory, 'rejected.json')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

console.log(JSON.stringify({ questionCount, categories: Object.keys(bank).length, excluded: rejected.length,
  bankVersion: `v1-${digest.slice(0, 16)}` }, null, 2));
