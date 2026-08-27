#!/usr/bin/env node
import {
  CANDIDATES_PATH,
  loadExistingQuestionTexts,
  loadPolicy,
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

function normalizedSource(value) {
  const url = new URL(String(value || ''));
  url.hash = '';
  return url.href.replace(/\/$/, '');
}

function normalizedAnswer(value) {
  return String(value || '').normalize('NFKC').replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();
}

const args = options(process.argv.slice(2));
const category = String(args.category || '').trim();
if (!category) throw new Error('يلزم --category.');
const maxPerSource = Number.parseInt(String(args['max-per-source'] || 2), 10);
if (!Number.isSafeInteger(maxPerSource) || maxPerSource < 1) throw new Error('--max-per-source غير صالح.');
const excludedIds = new Set(String(args.exclude || '').split(',').map(value => value.trim()).filter(Boolean));
const candidates = readJson(CANDIDATES_PATH, []);
const pending = candidates.filter(candidate => candidate.category === category && candidate.status === 'pending_review');
if (!pending.length) throw new Error(`لا توجد أسئلة معلّقة في فئة «${category}».`);

const policy = loadPolicy();
const previouslyApproved = candidates.filter(candidate =>
  candidate.category === category && candidate.status === 'approved');
const comparisons = [
  ...loadExistingQuestionTexts(),
  ...previouslyApproved.map(candidate => candidate.question).filter(Boolean),
];
const sourceCounts = new Map();
const answerCounts = new Map();
const approvedIds = new Set();
const reasons = new Map();

for (const candidate of previouslyApproved) {
  try {
    const source = normalizedSource(candidate.source?.url);
    sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
  } catch { /* اعتمدته بوابة أقدم؛ لا نستخدم الرابط المعيب لزيادة الحد. */ }
  const answer = normalizedAnswer(candidate.answer);
  if (answer) answerCounts.set(answer, (answerCounts.get(answer) || 0) + 1);
}

for (const candidate of pending) {
  if (excludedIds.has(candidate.id)) {
    reasons.set(candidate.id, 'استبعاد تحريري: السؤال ملتبس أو أقل فائدة من بديل أو يتناول حقيقة مختلفاً عليها.');
    continue;
  }
  let source;
  try { source = normalizedSource(candidate.source?.url); }
  catch {
    reasons.set(candidate.id, 'رابط المصدر غير صالح.');
    continue;
  }
  if ((sourceCounts.get(source) || 0) >= maxPerSource) {
    reasons.set(candidate.id, `تجاوز حد التنوع: أكثر من ${maxPerSource} أسئلة من صفحة واحدة.`);
    continue;
  }
  const answer = normalizedAnswer(candidate.answer);
  if (!answer || (answerCounts.get(answer) || 0) >= 1) {
    reasons.set(candidate.id, 'إجابة مكررة داخل البايلوت أو إجابة فارغة.');
    continue;
  }
  const validation = validateCandidate(candidate, { policy, existingQuestions: comparisons });
  if (!validation.valid) {
    reasons.set(candidate.id, `فشل بوابة الجودة: ${validation.errors.join(', ')}.`);
    continue;
  }
  approvedIds.add(candidate.id);
  comparisons.push(candidate.question);
  sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
  answerCounts.set(answer, (answerCounts.get(answer) || 0) + 1);
}

const reviewedAt = new Date().toISOString();
for (const candidate of pending) {
  const approved = approvedIds.has(candidate.id);
  candidate.status = approved ? 'approved' : 'rejected_by_reviewer';
  candidate.review = {
    reviewer: 'Codex-assisted general pilot review',
    decision: approved ? 'approve' : 'reject',
    notes: approved
      ? `اجتاز التحقق المستقل، وفحص الصياغة، ومنع تكرار الإجابة، وحد ${maxPerSource} لكل صفحة مصدر.`
      : reasons.get(candidate.id) || 'لم يجتز بوابة جودة البايلوت.',
    religiousSourceAndIsnadConfirmed: false,
    reviewedAt,
  };
}

writeJsonAtomic(CANDIDATES_PATH, candidates);
const levels = Object.fromEntries([1, 2, 3, 4, 5, 6].map(level => [level,
  pending.filter(candidate => candidate.difficultyLevel === level && approvedIds.has(candidate.id)).length,
]));
console.log(JSON.stringify({
  category,
  reviewed: pending.length,
  approved: approvedIds.size,
  rejected: pending.length - approvedIds.size,
  maxPerSource,
  levels,
}, null, 2));
