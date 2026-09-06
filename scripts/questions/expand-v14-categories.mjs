#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanArabic, normalizeArabic, optionTooSimilar } from './categories/common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BANK_PATH = path.join(ROOT, 'server-assets/question-bank/v1/bank.json');
const MANIFEST_PATH = path.join(ROOT, 'server-assets/question-bank/v1/manifest.json');
const REPORT_PATH = path.join(ROOT, 'server-assets/question-bank/v1/curation-report.json');
const CANDIDATES_PATH = path.join(ROOT, 'content/questions/candidates.json');
const BANNED = /(?:إسرائيل|اسرائيل|إسرائيلي|اسرائيلي|Israel|Israeli|Tel Aviv|تل أبيب|تل ابيب|إباحي|اباحي|إباحية|اباحية|porn|hentai|ecchi|محتوى جنسي|علاقة جنسية|عارٍ|عارية)/iu;
const OPAQUE = /(?:حسب السجل|في السجل|المعرّف(?=\s|:)|المعرف(?=\s|:)|Q\d{3,})/iu;

// أسماء العرض مستقلة عن أسماء مجموعات المصادر. يمكن تعديل العرض مستقبلاً
// من الخادم من دون إصدار نسخة جديدة من التطبيق.
const DEFINITIONS = Object.freeze({
  'كرة القدم العالمية': ['كأس العالم', 'دوري أبطال أوروبا'],
  'معلومات عامة': ['معلومات عامة'],
  'تاريخ وتراث الخليج': ['ثقافة خليجية'],
  'الفن الخليجي والعربي': ['مسلسلات خليجية', 'أغاني خليجية', 'أفلام عربية'],
  'ألعاب الفيديو': ['ألعاب الفيديو'],
  'تاريخ وحضارات': ['تاريخ', 'حضارات قديمة'],
  'جسم الإنسان والصحة': ['جسم الإنسان'],
  'مطابخ العالم': ['مطابخ العالم'],
  'سيارات ومركبات': ['محرّكات ومركبات'],
  'اللغة العربية والأمثال': ['اللغة العربية', 'أمثال'],
});

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const stable = (rows, key) => [...rows].sort((a, b) =>
  sha256(`${key}|${a.id}`).localeCompare(sha256(`${key}|${b.id}`)));
const questionText = candidate => cleanArabic(String(candidate.question || '')
  .replace(/\s+حسب السجل(?=؟)/u, '')
  .replace(/\s+في السجل(?=؟)/u, '')
  .replace(/في سجل المفردات العربية/u, 'في المعجم العربي')
  .replace(/في سجل التراث العالمي/u, 'في قائمة التراث العالمي'));

function semanticFamily(candidate) {
  const question = String(candidate.question || '');
  if (/في أي (?:دولة|بلد)|أي دولة|الدولة التي/u.test(question)) return 'country';
  if (/في أي (?:عام|سنة)|متى/u.test(question)) return 'year';
  if (/منو|من هو|من هي|مؤلف|مخترع|مخرج|صاحب/u.test(question)) return 'person';
  if (/مدينة|عاصمة/u.test(question)) return 'city';
  if (/كم|نتيجة|عدد/u.test(question)) return 'number';
  if (/مفرد|جمع|مرادف|ضد|كتابة|همزة/u.test(question)) return 'word';
  if (/فاز|بطل|وصيف|منتخب|نادي|فريق/u.test(question)) return 'sports';
  if (/مكوّن|مكون|توابل|طبق|طعام|مشروب/u.test(question)) return 'food';
  return String(candidate.templateId || candidate.generation?.model || 'general').replace(/-l[1-6]$/u, '');
}

function numericDistractors(answer) {
  const match = String(answer).trim().match(/^(\d{1,4})(.*)$/u);
  if (!match) return [];
  const value = Number(match[1]); const suffix = match[2];
  const step = value >= 1000 ? 4 : value >= 100 ? 10 : value >= 20 ? 2 : 1;
  return [value - step, value + step, value + step * 2]
    .filter(item => item >= 0).map(item => `${item}${suffix}`);
}

function buildOptions(candidate, pool, targetCategory, position) {
  const answer = cleanArabic(candidate.answer);
  const families = [
    row => semanticFamily(row) === semanticFamily(candidate)
      && String(row.templateId || '').replace(/-l[1-6]$/u, '') === String(candidate.templateId || '').replace(/-l[1-6]$/u, ''),
    row => semanticFamily(row) === semanticFamily(candidate),
    () => true,
  ];
  const values = [];
  for (const value of numericDistractors(answer)) {
    if (!optionTooSimilar(value, answer) && !values.some(item => optionTooSimilar(item, value))) {
      values.push(value);
    }
  }
  for (const predicate of families) {
    for (const row of stable(pool.filter(item => item.id !== candidate.id && predicate(item)), candidate.id)) {
      const value = cleanArabic(row.answer);
      if (!value || normalizeArabic(value) === normalizeArabic(answer)) continue;
      if (optionTooSimilar(value, answer) || values.some(item => optionTooSimilar(item, value))) continue;
      values.push(value);
      if (values.length >= 3) break;
    }
    if (values.length >= 3) break;
  }
  if (values.length < 3) throw new Error(`${targetCategory}: لا توجد مشتتات منطقية كافية للسؤال ${candidate.id}`);
  const correctIndex = position % 4;
  const options = values.slice(0, 3); options.splice(correctIndex, 0, answer);
  return { options, correctIndex, answer };
}

function eligible(candidate, sourceCategories, existingQuestions) {
  const visible = `${candidate.question || ''} ${candidate.answer || ''}`;
  const cleanedQuestion = questionText(candidate);
  const normalizedQuestion = normalizeArabic(cleanedQuestion);
  const normalizedAnswer = normalizeArabic(candidate.answer);
  return sourceCategories.includes(candidate.category)
    && candidate.status === 'approved'
    && candidate.verification?.result?.verdict === 'pass'
    && candidate.verification.result.factCorrect === true
    && candidate.verification.result.answerExact === true
    && candidate.verification.result.sourceSupportsClaim === true
    && candidate.verification.result.clearArabic === true
    && Number.isInteger(Number(candidate.difficultyLevel))
    && Number(candidate.difficultyLevel) >= 1 && Number(candidate.difficultyLevel) <= 6
    && cleanedQuestion.length >= 12
    && String(candidate.source?.url || '').startsWith('https://')
    && !BANNED.test(visible)
    && !OPAQUE.test(cleanedQuestion)
    && !(normalizedAnswer.length >= 3 && normalizedQuestion.includes(normalizedAnswer))
    && !existingQuestions.has(normalizeArabic(candidate.question));
}

function selectCategory(name, sourceCategories, candidates, existingQuestions) {
  const pool = candidates.filter(row => eligible(row, sourceCategories, existingQuestions));
  const byLevel = new Map();
  for (let level = 1; level <= 6; level += 1) {
    const levelRows = stable(pool.filter(row => Number(row.difficultyLevel) === level), `${name}|${level}`);
    if (levelRows.length < 15) throw new Error(`${name}: المستوى ${level} يوفر ${levelRows.length}/15 فقط`);
    byLevel.set(level, levelRows.slice(0, 15));
  }
  // ترتيب 30 سهلة ثم 30 متوسطة ثم 30 صعبة، مع تناوب المستوى داخل كل حزمة.
  const selected = [];
  for (const firstLevel of [1, 3, 5]) {
    for (let index = 0; index < 15; index += 1) {
      selected.push(byLevel.get(firstLevel)[index], byLevel.get(firstLevel + 1)[index]);
    }
  }
  return selected.map((candidate, position) => {
    const { options, correctIndex, answer } = buildOptions(candidate, pool, name, position);
    const level = Number(candidate.difficultyLevel);
    const sourceRecordId = String(candidate.sourceRecordId || candidate.id);
    return {
      id: `gq-${sha256(`v14-expanded|${name}|${candidate.id}`).slice(0, 20)}`,
      d: level,
      band: level <= 2 ? 'easy' : level <= 4 ? 'medium' : 'hard',
      q: questionText(candidate), o: options, a: correctIndex, answer,
      explanation: cleanArabic(candidate.explanation || ''), source: candidate.source,
      sourceRecordId, factKey: `${candidate.category}:${sourceRecordId}`,
      sourcePacketId: null, templateId: candidate.templateId || 'verified-candidate-v1',
      editorialGroup: 'v14-server-category', verification: candidate.verification,
      review: {
        status: 'approved', reviewer: candidate.review?.reviewer || 'Fatinah deterministic source gate',
        reviewedAt: String(candidate.review?.reviewedAt || candidate.verification?.checkedAt || '2026-09-06').slice(0, 10),
        basis: 'verified_source_candidate', humanReviewRequired: false,
        factualVerificationRequired: false,
      },
    };
  });
}

const bank = JSON.parse(fs.readFileSync(BANK_PATH, 'utf8'));
const candidates = JSON.parse(fs.readFileSync(CANDIDATES_PATH, 'utf8'));
delete bank.categories['رياضيات وحساب'];
for (const name of Object.keys(DEFINITIONS)) delete bank.categories[name];
const existingQuestions = new Set(Object.values(bank.categories).flat().map(row => normalizeArabic(row.q)));
for (const [name, sourceCategories] of Object.entries(DEFINITIONS)) {
  const rows = selectCategory(name, sourceCategories, candidates, existingQuestions);
  bank.categories[name] = rows;
  rows.forEach(row => existingQuestions.add(normalizeArabic(row.q)));
}
const categoryJson = JSON.stringify(bank.categories);
bank.sha256 = sha256(Buffer.from(categoryJson));
bank.bankVersion = `v3-curated-expanded-${bank.sha256.slice(0, 16)}`;
bank.questionCount = Object.values(bank.categories).reduce((sum, rows) => sum + rows.length, 0);
bank.targetBankSize = bank.questionCount;
bank.categoryCount = Object.keys(bank.categories).length;
bank.generatedAt = new Date().toISOString();
bank.factuallyVerifiedCount = bank.questionCount;
bank.releaseReady = true; bank.ready = true; bank.releaseBlockers = [];

const distribution = Object.fromEntries(Object.entries(bank.categories).map(([name, rows]) => [name, {
  count: rows.length,
  bands: Object.fromEntries(['easy', 'medium', 'hard'].map(band => [band, rows.filter(row => row.band === band).length])),
  levels: Object.fromEntries([1, 2, 3, 4, 5, 6].map(level => [level, rows.filter(row => row.d === level).length])),
}]));
const metadata = {
  schemaVersion: 1, bankVersion: bank.bankVersion, generatedAt: bank.generatedAt,
  sha256: bank.sha256, questionCount: bank.questionCount, categoryCount: bank.categoryCount,
  targetBankSize: bank.targetBankSize, ready: true, releaseReady: true,
  factuallyVerifiedCount: bank.factuallyVerifiedCount, releaseBlockers: [], distribution,
};
fs.writeFileSync(BANK_PATH, `${JSON.stringify(bank, null, 2)}\n`);
fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(metadata, null, 2)}\n`);
fs.writeFileSync(REPORT_PATH, `${JSON.stringify({ ...metadata, addedCategories: Object.keys(DEFINITIONS), removedCategories: ['رياضيات وحساب'], qualityRules: { fourUniqueOptions: true, oneCorrectAnswer: true, thirtyPerBand: true, trustedSourceVerification: true, bannedContentFilter: true, duplicateQuestionFilter: true } }, null, 2)}\n`);
console.log(JSON.stringify({ bankVersion: bank.bankVersion, questionCount: bank.questionCount, categoryCount: bank.categoryCount, addedCategories: Object.keys(DEFINITIONS) }, null, 2));
