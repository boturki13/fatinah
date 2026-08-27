#!/usr/bin/env node
import fs from 'node:fs';
import {
  LEGACY_REVIEWS_PATH,
  buildRuntimeAuditManifest,
  legacyReviewFingerprint,
} from './runtime-audit-manifest-lib.mjs';

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

function writeAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

const args = options(process.argv.slice(2));
const auditId = String(args['audit-id'] || '').trim();
const decision = String(args.decision || '').trim();
const reviewer = String(args.reviewer || '').trim();
if (!auditId || !['approve', 'reject'].includes(decision) || !reviewer) {
  throw new Error('يلزم --audit-id و--decision approve|reject و--reviewer.');
}

const manifest = buildRuntimeAuditManifest();
const question = manifest.questions.find(item => item.auditId === auditId);
if (!question) throw new Error('معرّف التدقيق غير موجود في بنك التشغيل.');
if (question.origin.component === 'published') throw new Error('السؤال منشور أصلاً عبر سجل published.json.');
if (decision === 'approve') {
  if (!question.citation.claimSpecific || question.flags.categoryFallbackSource) {
    throw new Error('لا يمكن الاعتماد قبل استبدال رابط الفئة بدليل خاص بادعاء السؤال.');
  }
  if (args['source-confirmed'] !== true) {
    throw new Error('يلزم --source-confirmed بعد فتح المرجع والتأكد أنه يدعم السؤال والإجابة.');
  }
  const religious = ['دين وسيرة','السيرة النبوية','القرآن الكريم','فتوحات المسلمين','الصحابة','الخلفاء الراشدون','الأنبياء والرسل']
    .includes(question.category);
  if (religious && args['religious-confirmed'] !== true) {
    throw new Error('السؤال الديني يحتاج --religious-confirmed بعد مراجعة المصدر والإسناد.');
  }
}

const reviews = fs.existsSync(LEGACY_REVIEWS_PATH)
  ? JSON.parse(fs.readFileSync(LEGACY_REVIEWS_PATH, 'utf8'))
  : [];
const religious = ['دين وسيرة','السيرة النبوية','القرآن الكريم','فتوحات المسلمين','الصحابة','الخلفاء الراشدون','الأنبياء والرسل']
  .includes(question.category);
const record = {
  auditId,
  questionFingerprintSha256: legacyReviewFingerprint(question),
  decision: decision === 'approve' ? 'approved' : 'rejected',
  reviewer,
  reviewedAt: new Date().toISOString(),
  sourceClaimConfirmed: decision === 'approve' && args['source-confirmed'] === true,
  religious,
  religiousSourceAndIsnadConfirmed: religious && decision === 'approve' && args['religious-confirmed'] === true,
  notes: String(args.notes || '').trim(),
};
const existingIndex = reviews.findIndex(review => review.auditId === auditId);
if (existingIndex >= 0) reviews[existingIndex] = record;
else reviews.push(record);
reviews.sort((left, right) => left.auditId.localeCompare(right.auditId, 'ar'));
writeAtomic(LEGACY_REVIEWS_PATH, reviews);
console.log(JSON.stringify({ auditId, decision: record.decision, reviewer }, null, 2));
