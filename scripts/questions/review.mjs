#!/usr/bin/env node
import {
  CANDIDATES_PATH,
  loadExistingQuestionTexts,
  loadPolicy,
  loadReligiousSourcePackets,
  readJson,
  validateCandidate,
  writeJsonAtomic,
} from './lib.mjs';

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

const args = options(process.argv.slice(2));
const id = String(args.id || '').trim();
const decision = String(args.decision || '').trim();
const reviewer = String(args.reviewer || '').trim();
if (!id || !['approve', 'reject'].includes(decision) || !reviewer) {
  throw new Error('يلزم --id و--decision approve|reject و--reviewer.');
}

const candidates = readJson(CANDIDATES_PATH, []);
const candidate = candidates.find(item => item.id === id);
if (!candidate) throw new Error('معرّف السؤال غير موجود.');
if (decision === 'approve') {
  if (!['pending_review', 'pending_religious_review'].includes(candidate.status)) {
    throw new Error('لا يمكن اعتماد سؤال لم ينجح في التحقق الآلي.');
  }
  if (candidate.religious && args['religious-confirmed'] !== true) {
    throw new Error('السؤال الديني يحتاج --religious-confirmed بعد مراجعة المرجع والإسناد يدوياً.');
  }
  if (candidate.religious && args['canonical-source-confirmed'] !== true) {
    throw new Error('السؤال الديني يحتاج --canonical-source-confirmed بعد مطابقته بنص القرآن أو صحيح البخاري.');
  }
  if (candidate.religious && args['no-disputed-matter-confirmed'] !== true) {
    throw new Error('السؤال الديني يحتاج --no-disputed-matter-confirmed بعد التأكد أنه لا يتناول مسألة مختلفاً عليها.');
  }
  const otherQuestions = loadExistingQuestionTexts().filter(question => question !== candidate.question);
  const validation = validateCandidate(candidate, {
    policy: loadPolicy(),
    existingQuestions: otherQuestions,
    religiousSourcePackets: candidate.religious ? loadReligiousSourcePackets() : [],
  });
  if (!validation.valid) throw new Error(`فشل فحص ما قبل الاعتماد: ${validation.errors.join(', ')}`);
}

candidate.status = decision === 'approve' ? 'approved' : 'rejected_by_reviewer';
candidate.review = {
  reviewer,
  decision,
  notes: String(args.notes || '').trim(),
    religiousSourceAndIsnadConfirmed: Boolean(candidate.religious && args['religious-confirmed'] === true),
    religiousCanonicalSourceConfirmed: Boolean(candidate.religious && args['canonical-source-confirmed'] === true),
    religiousNoDisputedMatterConfirmed: Boolean(candidate.religious && args['no-disputed-matter-confirmed'] === true),
  reviewedAt: new Date().toISOString(),
};
writeJsonAtomic(CANDIDATES_PATH, candidates);
console.log(JSON.stringify({ id, status: candidate.status, reviewer }, null, 2));
