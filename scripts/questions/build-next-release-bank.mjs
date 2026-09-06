#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertNoSimilarOptions, NEXT_RELEASE_REVIEW_DATE, normalizeArabic } from './categories/common.mjs';
import {
  buildPeopleLiteratureCategories, PEOPLE_LITERATURE_CATEGORIES,
  verifyPeopleLiteratureCategories, verifyPeopleLiteratureQuestion,
} from './categories/people-literature.mjs';
import {
  buildMediaTechGlobalCategories, MEDIA_TECH_GLOBAL_CATEGORIES,
  verifyMediaTechGlobalCategories, verifyMediaTechGlobalQuestionFact,
} from './categories/media-tech-global.mjs';
import {
  buildGulfAviationCategories, GULF_AVIATION_CATEGORIES,
  verifyGulfAviationCategories, verifyGulfAviationQuestion,
} from './categories/gulf-aviation.mjs';
import {
  buildWorldScienceCategories, geographicAnswerLeak, verifyWorldScienceCategories, verifyWorldScienceQuestion,
} from './categories/world-science.mjs';
import { buildProverbCategory, verifyProverbCategory, verifyProverbQuestion } from './categories/proverbs.mjs';
import { assertNoLegacyFacts, loadLegacyQuestionRecords } from './legacy-question-policy.mjs';
import { approveVerifiedQuestions, verifyQuestionBankFacts } from './factual-verifier.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT_DIR = path.join(ROOT, 'server-assets/question-bank/v1');
const LEDGER_PATH = path.join(ROOT, 'content/questions/next-release-factual-ledger.json');
const CATEGORY_ORDER = Object.freeze([
  'من أنا؟', 'كرتون وأنمي', 'تقنية وإنترنت', 'اختر العبارة الصحيحة', 'سينما وأفلام عربية',
  'كرة القدم', 'علوم وطبيعة', 'اختراعات واكتشافات', 'الكويت', 'دول الخليج',
  'شخصيات تاريخية', 'مدن وعواصم', 'عملات العالم', 'فيزياء وكيمياء',
  'شعراء وأدباء عرب', 'روايات عالمية', 'مسرحيات خليجية', 'طيران ومطارات',
  'أندية ومنتخبات', 'ألغاز بوليسية', 'اكتشف الكلمة', 'أحداث غيرت العالم',
  'منظمات دولية',
]);
const TARGET_PER_CATEGORY = 90;
const TARGET_BANK_SIZE = CATEGORY_ORDER.length * TARGET_PER_CATEGORY;
const BANNED = /(?:إسرائيل|اسرائيل|إسرائيلي|اسرائيلي|Israel|Israeli|Tel Aviv|تل أبيب|تل ابيب|إباحي|اباحي|إباحية|اباحية|porn|hentai|ecchi|محتوى جنسي|علاقة جنسية|عارٍ|عارية)/iu;
const OPAQUE_WORDING = /(?:حسب السجل|في السجل|المعرّف(?=\s|:)|المعرف(?=\s|:)|Q\d{3,})/iu;

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const readJson = relativePath => JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

function archivedQuestionRecords() {
  const directory = path.join(ROOT, 'server-assets/question-bank/archive');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => /-bank\.json$/u.test(name)).sort().flatMap(name => {
    const document = readJson(`server-assets/question-bank/archive/${name}`);
    return Object.entries(document.categories || {}).flatMap(([category, rows]) =>
      (rows || []).map(question => ({ category, ...question })));
  });
}

function mergeCategoryModules(modules) {
  const merged = {};
  for (const moduleCategories of modules) {
    for (const [category, rows] of Object.entries(moduleCategories)) {
      if (merged[category]) throw new Error(`الفئة مكررة بين وحدات البناء: ${category}`);
      merged[category] = rows;
    }
  }
  const actual = Object.keys(merged);
  if (actual.length !== CATEGORY_ORDER.length
      || CATEGORY_ORDER.some(category => !merged[category])
      || actual.some(category => !CATEGORY_ORDER.includes(category))) {
    throw new Error(`فئات بنك التحديث غير مطابقة للعقد: ${actual.join('، ')}`);
  }
  return Object.fromEntries(CATEGORY_ORDER.map(category => [category, merged[category]]));
}

function assertModuleReport(name, report) {
  if (report === true || report?.valid === true) return;
  const details = Array.isArray(report?.errors) ? report.errors.slice(0, 12).join('\n- ') : String(report);
  throw new Error(`فشل مدقق وحدة ${name}:\n- ${details}`);
}

function validateBankShape(categories, sourcePolicy) {
  const ids = new Set();
  const questions = new Set();
  const facts = new Set();
  const claims = new Set();
  const blockedIds = new Set([
    ...(sourcePolicy.familyContentPolicy?.blockedSourceRecordIds || []),
    ...(sourcePolicy.factualQualityPolicy?.blockedSourceRecordIds || []),
  ].map(String));
  const blockedPrefixes = (sourcePolicy.factualQualityPolicy?.blockedSourceRecordPrefixes || []).map(String);

  for (const category of CATEGORY_ORDER) {
    const rows = categories[category];
    if (!Array.isArray(rows) || rows.length !== TARGET_PER_CATEGORY) {
      throw new Error(`${category}: المطلوب ${TARGET_PER_CATEGORY} سؤالًا`);
    }
    for (let position = 0; position < rows.length; position += 1) {
      const question = rows[position];
      const expectedBandIndex = Math.floor(position / 30);
      const expectedBand = ['easy', 'medium', 'hard'][expectedBandIndex];
      const expectedDifficulty = expectedBandIndex * 2 + 1 + (position % 2);
      const visible = JSON.stringify({ q: question.q, o: question.o, answer: question.answer });
      if (!/^gq-[a-f0-9]{20}$/u.test(String(question.id || '')) || ids.has(question.id)) {
        throw new Error(`${category}: معرّف سؤال مفقود أو مكرر ${question.id || ''}`);
      }
      if (typeof question.q !== 'string' || question.q.trim().length < 12 || question.q.trim().length > 220
          || OPAQUE_WORDING.test(question.q)) throw new Error(`${question.id}: صياغة غير مفهومة أو غير صالحة`);
      if (geographicAnswerLeak(question)) throw new Error(`${question.id}: نص سؤال الموقع يكشف الإجابة`);
      const normalizedAnswer=normalizeArabic(question.answer);
      const answerMayAppearInChoices=['animal-group-choice-v1','detective-unique-solution-v3'].includes(question.templateId)
        || /final-score-v1$/u.test(String(question.templateId||''));
      if(!answerMayAppearInChoices&&normalizedAnswer.length>=3
        &&normalizeArabic(question.q).includes(normalizedAnswer)){
        throw new Error(`${question.id}: نص السؤال يكشف الإجابة`);
      }
      if(/(?:نلت|نال|نالت).*«(?:جوائز الغولدن غلوب|جائزة الأوسكار|جائزة غرامي)»|(?:تولت|توليت) منصب «(?:رئيس الوزراء|إمبراطور|عاهل|ملك)»/u.test(question.q)){
        throw new Error(`${question.id}: وصف جائزة أو منصب عام يجعل أكثر من خيار صحيحًا`);
      }
      if (BANNED.test(visible)) throw new Error(`${question.id}: محتوى محظور`);
      if (!Array.isArray(question.o) || question.o.length !== 4
          || new Set(question.o.map(normalizeArabic)).size !== 4
          || !Number.isInteger(question.a) || question.a < 0 || question.a > 3
          || question.o[question.a] !== question.answer
          || question.o.filter(option => normalizeArabic(option) === normalizeArabic(question.answer)).length !== 1) {
        throw new Error(`${question.id}: الخيارات أو الإجابة الصحيحة غير صالحة`);
      }
      assertNoSimilarOptions(question);
      if (question.band !== expectedBand || question.d !== expectedDifficulty) {
        throw new Error(`${question.id}: ترتيب الصعوبة لا يطابق موقع السؤال`);
      }
      if (!String(question.sourceRecordId || '').trim() || !String(question.factKey || '').trim()) {
        throw new Error(`${question.id}: هوية الحقيقة أو سجل المصدر مفقودة`);
      }
      if (blockedIds.has(String(question.sourceRecordId))
          || blockedPrefixes.some(prefix => String(question.sourceRecordId).startsWith(prefix))) {
        throw new Error(`${question.id}: سجل مصدر محظور`);
      }
      if (!String(question.source?.url || '').startsWith('https://')) {
        throw new Error(`${question.id}: رابط مصدر غير آمن`);
      }
      const questionKey = normalizeArabic(question.q);
      if (questions.has(questionKey)) throw new Error(`${question.id}: سؤال مكرر نصيًا`);
      if (facts.has(question.factKey)) throw new Error(`${question.id}: حقيقة مكررة`);
      ids.add(question.id); questions.add(questionKey); facts.add(question.factKey);
      const claim = question.verification?.claim;
      if (claim && typeof claim === 'object') {
        const claimKey = `${question.verification?.artifact || question.verification?.profile}|${canonical(claim)}`;
        if (claims.has(claimKey)) throw new Error(`${question.id}: ادعاء مصدري مكرر`);
        claims.add(claimKey);
      }
    }
    for (const band of ['easy', 'medium', 'hard']) {
      const bandRows = rows.filter(question => question.band === band);
      const slots = Array.from({ length: 4 }, (_, answerIndex) =>
        bandRows.filter(question => question.a === answerIndex).length);
      if (bandRows.length !== 30 || Math.max(...slots) - Math.min(...slots) > 1) {
        throw new Error(`${category}: توزيع ${band} أو مواقع الإجابة غير متوازن`);
      }
    }
    for (let difficulty = 1; difficulty <= 6; difficulty += 1) {
      if (rows.filter(question => question.d === difficulty).length !== 15) {
        throw new Error(`${category}: المستوى ${difficulty} لا يحتوي 15 سؤالًا`);
      }
    }
    const allSlots = Array.from({ length: 4 }, (_, answerIndex) =>
      rows.filter(question => question.a === answerIndex).length);
    if (Math.max(...allSlots) - Math.min(...allSlots) > 1) {
      throw new Error(`${category}: مواقع الإجابة الصحيحة غير متوازنة`);
    }
  }
  if (ids.size !== TARGET_BANK_SIZE || questions.size !== TARGET_BANK_SIZE || facts.size !== TARGET_BANK_SIZE) {
    throw new Error('تفرد البنك الكامل لا يطابق العدد المستهدف');
  }
}

const legacyRecords = loadLegacyQuestionRecords();
const oldQuestions = new Set(legacyRecords.map(record => record.q));
const oldRecords = archivedQuestionRecords();
const people = buildPeopleLiteratureCategories({ legacyRecords, oldQuestions });
const media = buildMediaTechGlobalCategories({ oldRecords, oldQuestions });
const gulf = buildGulfAviationCategories();
const world = buildWorldScienceCategories({ legacyRecords, oldQuestions });
const proverbs = { 'اكتشف الكلمة': buildProverbCategory({ legacyRecords }) };

assertModuleReport('الأشخاص والأدب', verifyPeopleLiteratureCategories(people, { legacyRecords, oldQuestions }));
assertModuleReport('الإعلام والتقنية والعالم', verifyMediaTechGlobalCategories(media, { oldRecords, oldQuestions }));
assertModuleReport('الخليج والطيران', verifyGulfAviationCategories(gulf));
assertModuleReport('العالم والعلوم', verifyWorldScienceCategories(world));
assertModuleReport('اكتشف الكلمة', verifyProverbCategory(proverbs['اكتشف الكلمة']));

assertNoLegacyFacts({ ...people, ...world, ...proverbs }, legacyRecords);
const bank = mergeCategoryModules([people, media, gulf, world, proverbs]);
const sourcePolicy = readJson('content/questions/source-policy.json');
validateBankShape(bank, sourcePolicy);

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
const factualLedger = verifyQuestionBankFacts(bank, { customVerifier, verifierFiles });
if (factualLedger.questionCount !== TARGET_BANK_SIZE
    || factualLedger.verifiedQuestionCount !== TARGET_BANK_SIZE) {
  throw new Error('سجل التحقق الواقعي لم يعتمد جميع أسئلة البنك');
}
approveVerifiedQuestions(bank, factualLedger, { verifierFiles });

const categoryJson = JSON.stringify(bank);
const bankSha256 = sha256(Buffer.from(categoryJson));
const bankVersion = `v3-curated-${bankSha256.slice(0, 16)}`;
let previousManifest = null;
try { previousManifest = readJson('server-assets/question-bank/v1/manifest.json'); } catch { /* first build */ }
const reviewedTimestamp = `${NEXT_RELEASE_REVIEW_DATE}T00:00:00.000Z`;
const generatedAt = process.env.FATINAH_BANK_GENERATED_AT
  || (previousManifest?.sha256 === bankSha256 ? previousManifest.generatedAt : '')
  || reviewedTimestamp;
if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(generatedAt)) {
  throw new Error('FATINAH_BANK_GENERATED_AT يجب أن يكون توقيت ISO UTC صالحًا');
}

const distribution = Object.fromEntries(CATEGORY_ORDER.map(category => [category, {
  count: bank[category].length,
  bands: Object.fromEntries(['easy', 'medium', 'hard'].map(band =>
    [band, bank[category].filter(question => question.band === band).length])),
  levels: Object.fromEntries(Array.from({ length: 6 }, (_, index) => index + 1).map(level =>
    [level, bank[category].filter(question => question.d === level).length])),
}]));
const releaseMetadata = {
  schemaVersion: 1,
  bankVersion,
  generatedAt,
  sha256: bankSha256,
  questionCount: TARGET_BANK_SIZE,
  categoryCount: CATEGORY_ORDER.length,
  targetBankSize: TARGET_BANK_SIZE,
  ready: true,
  releaseReady: true,
  factualInputSha256: factualLedger.contentSha256,
  factuallyVerifiedCount: factualLedger.verifiedQuestionCount,
  releaseBlockers: [],
};
const bankDocument = { ...releaseMetadata, categories: bank };
const manifest = {
  ...releaseMetadata,
  oldBankQuestionsReused: 0,
  legacyQuestionRecordsChecked: legacyRecords.length,
  distribution,
};
const curationReport = {
  ...manifest,
  moduleVerification: {
    peopleLiterature: verifyPeopleLiteratureCategories(people, { legacyRecords, oldQuestions }),
    mediaTechGlobal: verifyMediaTechGlobalCategories(media, { oldRecords, oldQuestions }),
    gulfAviation: verifyGulfAviationCategories(gulf),
    worldScience: { valid: verifyWorldScienceCategories(world), questionCount: Object.values(world).flat().length },
    proverbs: { valid: verifyProverbCategory(proverbs['اكتشف الكلمة']), questionCount: proverbs['اكتشف الكلمة'].length },
  },
  qualityRules: {
    fourUniqueOptions: true,
    oneCorrectAnswer: true,
    threeDifficultyBands: true,
    thirtyPerBand: true,
    fifteenPerNumericLevel: true,
    balancedCorrectAnswerPositions: true,
    oldPublishedFactsExcluded: true,
    exactDuplicatesBlocked: true,
    semanticClaimDuplicatesBlocked: true,
    bannedSexualContent: true,
    bannedIsraelContent: true,
    httpsTrustedSources: true,
    deterministicSourceVerification: true,
    verifierTamperResistance: true,
    humanReviewRequired: false,
  },
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(LEDGER_PATH, `${JSON.stringify(factualLedger, null, 2)}\n`);
fs.writeFileSync(path.join(OUT_DIR, 'bank.json'), `${JSON.stringify(bankDocument, null, 2)}\n`);
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(path.join(OUT_DIR, 'curation-report.json'), `${JSON.stringify(curationReport, null, 2)}\n`);

console.log(JSON.stringify({
  bankVersion,
  questionCount: TARGET_BANK_SIZE,
  categoryCount: CATEGORY_ORDER.length,
  releaseReady: true,
  factuallyVerifiedCount: factualLedger.verifiedQuestionCount,
  legacyQuestionRecordsChecked: legacyRecords.length,
}, null, 2));
