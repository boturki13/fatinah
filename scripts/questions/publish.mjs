#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  APPROVED_BANK_PATH,
  CANDIDATES_PATH,
  PUBLISHED_PATH,
  createNearDuplicateIndex,
  loadExistingQuestionTexts,
  loadPolicy,
  loadReligiousSourcePackets,
  readJson,
  validateCandidate,
  writeJsonAtomic,
  ROOT,
} from './lib.mjs';

const candidates = readJson(CANDIDATES_PATH, []);
const runtimeSelection = readJson(path.join(ROOT, 'content', 'questions', 'runtime-published-ids.json'), null);
if (!runtimeSelection || runtimeSelection.schemaVersion !== 1 || !Array.isArray(runtimeSelection.ids)) {
  throw new Error('قائمة بنك fallback المحلي غير صالحة.');
}
const selectedIds = new Set(runtimeSelection.ids);
if (selectedIds.size !== runtimeSelection.ids.length) throw new Error('قائمة بنك fallback المحلي مكررة.');
const approved = candidates.filter(candidate => candidate.status === 'approved' && selectedIds.has(candidate.id));
if (approved.length !== selectedIds.size) throw new Error(`بنك fallback المحلي ${approved.length}/${selectedIds.size}.`);
const policy = loadPolicy();
const religiousSourcePackets = loadReligiousSourcePackets();
const baseQuestions = loadExistingQuestionTexts();
const accepted = [];
// approved-question-bank.js جزء من بنك التشغيل الحالي؛ استبعد المطابقة الحرفية
// للسجل نفسه مثلما كان يفعل المسار السابق، ثم افحص التكرار بين المرشحين بالترتيب.
const approvedQuestionTexts = new Set(approved.map(candidate => candidate.question));
const duplicateIndex = createNearDuplicateIndex(
  baseQuestions.filter(question => !approvedQuestionTexts.has(question)),
);

for (const candidate of approved) {
  if (candidate.religious && !candidate.review?.religiousSourceAndIsnadConfirmed) {
    throw new Error(`${candidate.id}: سؤال ديني بلا تأكيد مراجعة المصدر والإسناد.`);
  }
  if (candidate.religious && (!candidate.review?.religiousCanonicalSourceConfirmed ||
      !candidate.review?.religiousNoDisputedMatterConfirmed)) {
    throw new Error(`${candidate.id}: سؤال ديني بلا تأكيد المصدر الثابت أو خلوه من المسائل المختلف عليها.`);
  }
  const duplicate = duplicateIndex.has(candidate.question);
  const validation = validateCandidate(candidate, {
    policy,
    // فحص التكرار يتم بمؤشر مكافئ أدناه كي لا نعيد تطبيع ملايين الأزواج.
    existingQuestions: [],
    religiousSourcePackets: candidate.religious ? religiousSourcePackets : [],
  });
  if (!validation.valid || duplicate) {
    const errors = [...validation.errors, ...(duplicate ? ['duplicate_or_near_duplicate'] : [])];
    throw new Error(`${candidate.id}: فشل فحص النشر (${errors.join(', ')}).`);
  }
  accepted.push(candidate);
  duplicateIndex.add(candidate.question);
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
    sourcePacketId: candidate.sourcePacketId || null,
    review: {
      status: 'approved',
      bankVersion: 3,
      reviewedAt: candidate.review.reviewedAt,
      reviewer: candidate.review.reviewer,
      religiousSourceAndIsnadConfirmed: candidate.review.religiousSourceAndIsnadConfirmed,
      religiousCanonicalSourceConfirmed: candidate.review.religiousCanonicalSourceConfirmed,
      religiousNoDisputedMatterConfirmed: candidate.review.religiousNoDisputedMatterConfirmed,
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
