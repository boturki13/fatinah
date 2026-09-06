#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertNoSimilarOptions, normalizeArabic } from './categories/common.mjs';
import {
  PEOPLE_LITERATURE_CATEGORIES, verifyPeopleLiteratureCategories, verifyPeopleLiteratureQuestion,
} from './categories/people-literature.mjs';
import {
  MEDIA_TECH_GLOBAL_CATEGORIES, verifyMediaTechGlobalCategories, verifyMediaTechGlobalQuestionFact,
} from './categories/media-tech-global.mjs';
import {
  GULF_AVIATION_CATEGORIES, verifyGulfAviationCategories, verifyGulfAviationQuestion,
} from './categories/gulf-aviation.mjs';
import {
  geographicAnswerLeak, verifyWorldScienceCategories, verifyWorldScienceQuestion,
} from './categories/world-science.mjs';
import { verifyProverbCategory, verifyProverbQuestion } from './categories/proverbs.mjs';
import { assertNoLegacyFacts, loadLegacyQuestionRecords } from './legacy-question-policy.mjs';
import { verifyQuestionBankFacts } from './factual-verifier.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CATEGORY_ORDER = Object.freeze([
  'من أنا؟', 'كرتون وأنمي', 'تقنية وإنترنت', 'اختر العبارة الصحيحة', 'سينما وأفلام عربية',
  'كرة القدم', 'علوم وطبيعة', 'اختراعات واكتشافات', 'الكويت', 'دول الخليج',
  'شخصيات تاريخية', 'مدن وعواصم', 'عملات العالم', 'فيزياء وكيمياء',
  'شعراء وأدباء عرب', 'روايات عالمية', 'مسرحيات خليجية', 'طيران ومطارات',
  'أندية ومنتخبات', 'ألغاز بوليسية', 'اكتشف الكلمة', 'أحداث غيرت العالم',
  'منظمات دولية',
]);
const BANNED = /(?:إسرائيل|اسرائيل|إسرائيلي|اسرائيلي|Israel|Israeli|Tel Aviv|تل أبيب|تل ابيب|إباحي|اباحي|إباحية|اباحية|porn|hentai|ecchi|محتوى جنسي|علاقة جنسية|عارٍ|عارية)/iu;
const OPAQUE = /(?:حسب السجل|في السجل|المعرّف(?=\s|:)|المعرف(?=\s|:)|Q\d{3,})/iu;
const AMBIGUOUS_BROAD_PERSON_CLUE=/(?:نلت|نال|نالت).*«(?:جوائز الغولدن غلوب|جائزة الأوسكار|جائزة غرامي)»|(?:تولت|توليت) منصب «(?:رئيس الوزراء|إمبراطور|عاهل|ملك)»/u;
const read = relativePath => JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
function answerRevealedByStem(question){
  if(['animal-group-choice-v1','detective-unique-solution-v3'].includes(question.templateId)
    || /final-score-v1$/u.test(String(question.templateId||''))) return false;
  const answer=normalizeArabic(question.answer);
  return answer.length>=3&&normalizeArabic(question.q).includes(answer);
}

function archivedRecords() {
  const directory = path.join(ROOT, 'server-assets/question-bank/archive');
  return fs.readdirSync(directory).filter(name => /-bank\.json$/u.test(name)).sort().flatMap(name => {
    const document = read(`server-assets/question-bank/archive/${name}`);
    return Object.entries(document.categories || {}).flatMap(([category, rows]) =>
      (rows || []).map(question => ({ category, ...question })));
  });
}

const bank = read('server-assets/question-bank/v1/bank.json');
const manifest = read('server-assets/question-bank/v1/manifest.json');
const ledger = read('content/questions/next-release-factual-ledger.json');
const legacyRecords = loadLegacyQuestionRecords();
const oldQuestions = new Set(legacyRecords.map(record => record.q));
const oldRecords = archivedRecords();
const issues = [];
const issue = (code, category = '', question = null, details = '') => issues.push({
  code, category, id: question?.id || '', question: question?.q || '', details,
});
const categories = bank.categories || {};
const all = Object.entries(categories).flatMap(([category, rows]) =>
  (rows || []).map(question => ({ category, ...question })));

if (bank.schemaVersion !== 1 || bank.questionCount !== 2070 || bank.targetBankSize !== 2070
    || bank.ready !== true || bank.releaseReady !== true || bank.factuallyVerifiedCount !== 2070
    || !Array.isArray(bank.releaseBlockers) || bank.releaseBlockers.length) issue('invalid_release_envelope');
if (Object.keys(categories).length !== CATEGORY_ORDER.length
    || CATEGORY_ORDER.some((category, index) => Object.keys(categories)[index] !== category)) issue('invalid_category_contract');
if (hash(Buffer.from(JSON.stringify(categories))) !== bank.sha256) issue('invalid_bank_digest');
if (manifest.sha256 !== bank.sha256 || manifest.bankVersion !== bank.bankVersion
    || manifest.questionCount !== bank.questionCount || manifest.releaseReady !== true
    || manifest.factuallyVerifiedCount !== 2070) issue('manifest_bank_mismatch');

const ids = new Set(); const questionTexts = new Set(); const factKeys = new Set(); const claimKeys = new Set();
for (const category of CATEGORY_ORDER) {
  const rows = categories[category] || [];
  if (rows.length !== 90) issue('category_count', category, null, String(rows.length));
  for (let position = 0; position < rows.length; position += 1) {
    const question = rows[position];
    const bandIndex = Math.floor(position / 30);
    const expectedBand = ['easy', 'medium', 'hard'][bandIndex];
    const expectedDifficulty = bandIndex * 2 + 1 + (position % 2);
    if (!/^gq-[a-f0-9]{20}$/u.test(String(question.id || '')) || ids.has(question.id)) issue('duplicate_or_invalid_id', category, question);
    ids.add(question.id);
    const normalizedQuestion = normalizeArabic(question.q);
    if (!normalizedQuestion || questionTexts.has(normalizedQuestion)) issue('duplicate_question', category, question);
    questionTexts.add(normalizedQuestion);
    if (!question.factKey || factKeys.has(question.factKey)) issue('duplicate_fact', category, question);
    factKeys.add(question.factKey);
    if (question.band !== expectedBand || question.d !== expectedDifficulty) issue('difficulty_order', category, question);
    if (typeof question.q !== 'string' || question.q.trim().length < 12 || question.q.trim().length > 220 || OPAQUE.test(question.q)) issue('wording', category, question);
    if (geographicAnswerLeak(question)) issue('answer_leaked_in_geographic_question', category, question);
    if (answerRevealedByStem(question)) issue('answer_revealed_by_question_stem', category, question);
    if(AMBIGUOUS_BROAD_PERSON_CLUE.test(question.q)) issue('ambiguous_broad_person_clue',category,question);
    if (BANNED.test(JSON.stringify({ q: question.q, o: question.o, answer: question.answer }))) issue('banned_content', category, question);
    if (!Array.isArray(question.o) || question.o.length !== 4
        || new Set((question.o || []).map(normalizeArabic)).size !== 4
        || !Number.isInteger(question.a) || question.a < 0 || question.a > 3
        || question.o?.[question.a] !== question.answer
        || question.o?.filter(option => normalizeArabic(option) === normalizeArabic(question.answer)).length !== 1) {
      issue('invalid_options', category, question);
    } else {
      try { assertNoSimilarOptions(question); } catch (error) { issue('similar_options', category, question, error.message); }
    }
    if (!String(question.sourceRecordId || '').trim() || !String(question.source?.url || '').startsWith('https://')) issue('invalid_provenance', category, question);
    if (question.review?.status !== 'approved' || question.review?.factualVerificationRequired !== false) issue('unapproved_question', category, question);
    if (question.verification?.claim) {
      const key = `${question.verification.artifact || question.verification.profile}|${canonical(question.verification.claim)}`;
      if (claimKeys.has(key)) issue('duplicate_source_claim', category, question);
      claimKeys.add(key);
    }
  }
  for (const band of ['easy', 'medium', 'hard']) {
    const bandRows = rows.filter(question => question.band === band);
    const slots = Array.from({ length: 4 }, (_, slot) => bandRows.filter(question => question.a === slot).length);
    if (bandRows.length !== 30) issue('band_count', category, null, `${band}:${bandRows.length}`);
    if (slots.length && Math.max(...slots) - Math.min(...slots) > 1) issue('answer_position_bias', category, null, `${band}:${slots.join(',')}`);
  }
  for (let difficulty = 1; difficulty <= 6; difficulty += 1) {
    const count = rows.filter(question => question.d === difficulty).length;
    if (count !== 15) issue('level_count', category, null, `${difficulty}:${count}`);
  }
}

const subset = names => Object.fromEntries(names.map(name => [name, categories[name]]));
const moduleReports = {
  peopleLiterature: verifyPeopleLiteratureCategories(subset(PEOPLE_LITERATURE_CATEGORIES), { legacyRecords, oldQuestions }),
  mediaTechGlobal: verifyMediaTechGlobalCategories(subset(MEDIA_TECH_GLOBAL_CATEGORIES), { oldRecords, oldQuestions }),
  gulfAviation: verifyGulfAviationCategories(subset(GULF_AVIATION_CATEGORIES)),
  worldScience: { valid: verifyWorldScienceCategories(subset(['اختر العبارة الصحيحة','كرة القدم','علوم وطبيعة','مدن وعواصم','عملات العالم','فيزياء وكيمياء','ألغاز بوليسية'])) },
  proverbs: { valid: verifyProverbCategory(categories['اكتشف الكلمة']) },
};
for (const [name, report] of Object.entries(moduleReports)) {
  if (report?.valid !== true) issue('module_verification', name, null, (report?.errors || []).slice(0, 8).join(' | '));
}
try {
  assertNoLegacyFacts({
    ...subset(PEOPLE_LITERATURE_CATEGORIES),
    ...subset(['اختر العبارة الصحيحة','كرة القدم','علوم وطبيعة','مدن وعواصم','عملات العالم','فيزياء وكيمياء','ألغاز بوليسية']),
    'اكتشف الكلمة': categories['اكتشف الكلمة'],
  }, legacyRecords);
} catch (error) { issue('legacy_fact_reuse', '', null, error.message); }

const customVerifier = (question, record) => {
  if (PEOPLE_LITERATURE_CATEGORIES.includes(question.category)) return verifyPeopleLiteratureQuestion(question, record);
  if (MEDIA_TECH_GLOBAL_CATEGORIES.includes(question.category)) return verifyMediaTechGlobalQuestionFact(question, record);
  if (GULF_AVIATION_CATEGORIES.includes(question.category)) return verifyGulfAviationQuestion(question, record);
  if (question.category === 'اكتشف الكلمة') return verifyProverbQuestion(question, record);
  return verifyWorldScienceQuestion(question, record);
};
const verifierFiles = [
  'scripts/questions/categories/common.mjs',
  'scripts/questions/categories/people-literature.mjs',
  'scripts/questions/categories/media-tech-global.mjs',
  'scripts/questions/categories/gulf-aviation.mjs',
  'scripts/questions/categories/world-science.mjs',
  'scripts/questions/categories/proverbs.mjs',
];
try {
  const recomputed = verifyQuestionBankFacts(categories, { customVerifier, verifierFiles });
  if (canonical(recomputed) !== canonical(ledger)) {
    const topLevel = [...new Set([...Object.keys(recomputed), ...Object.keys(ledger)])]
      .filter(key => key !== 'questions' && canonical(recomputed[key]) !== canonical(ledger[key]));
    const questionIds = [...new Set([
      ...Object.keys(recomputed.questions || {}), ...Object.keys(ledger.questions || {}),
    ])].filter(id => canonical(recomputed.questions?.[id]) !== canonical(ledger.questions?.[id]));
    issue('factual_ledger_mismatch', '', null,
      `fields=${topLevel.join(',') || 'questions'}; questionIds=${questionIds.slice(0, 5).join(',')}; count=${questionIds.length}`);
  }
  if (recomputed.questionCount !== 2070 || recomputed.verifiedQuestionCount !== 2070) issue('factual_verification_incomplete');
} catch (error) { issue('factual_verification_failed', '', null, error.message); }

const byCode = Object.fromEntries([...new Set(issues.map(item => item.code))].sort().map(code =>
  [code, issues.filter(item => item.code === code).length]));
const auditedAt = process.env.FATINAH_BANK_AUDIT_DATE || bank.generatedAt;
const report = {
  schemaVersion: 2,
  bankVersion: bank.bankVersion,
  bankSha256: bank.sha256,
  auditedAt,
  questionCount: all.length,
  categoryCount: Object.keys(categories).length,
  passed: issues.length === 0,
  releaseReady: issues.length === 0 && bank.releaseReady === true,
  factualVerification: { verified: ledger.verifiedQuestionCount || 0, required: 2070 },
  legacyQuestionRecordsChecked: legacyRecords.length,
  moduleReports,
  automatedChecks: [
    'four_unique_options', 'one_correct_answer', 'balanced_answer_positions',
    'difficulty_distribution', 'duplicate_question_and_claim_filters',
    'published_legacy_fact_exclusion', 'family_content_policy', 'trusted_source_binding',
    'deterministic_factual_ledger', 'tamper_resistant_category_verifiers',
  ],
  issueCount: issues.length,
  byCode,
  issues: issues.slice(0, 500),
};
fs.writeFileSync(path.join(ROOT, 'server-assets/question-bank/v1/quality-report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, issues: undefined, moduleReports: Object.fromEntries(
  Object.entries(moduleReports).map(([name, value]) => [name, { valid: value.valid, questionCount: value.questionCount }]),
) }, null, 2));
if (issues.length) process.exitCode = 1;
