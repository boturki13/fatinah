import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  familyContentViolations,
  loadPolicy,
} from '../scripts/questions/lib.mjs';

const policy = loadPolicy();
const config = policy.familyContentPolicy;
assert.equal(config?.schemaVersion, 1, 'سياسة المحتوى العائلي إلزامية قبل بناء بنك التشغيل.');

const requiredBlockedIds = new Set([
  'gq-49031dbfebee1813bbbe',
  'gq-a5f2e33a7bfb6c23a409',
  'gq-a84700354ef2cd82f207',
  'gq-54f7658266c72b8133ee',
  'gq-71ea5ce5a4141257f1cd',
  'gq-17b55cddb25e13081063',
]);
for (const id of requiredBlockedIds) {
  assert.ok(config.blockedQuestionIds.includes(id), `${id}: يجب أن يبقى ضمن الحظر التحريري.`);
}

const bank = JSON.parse(fs.readFileSync(
  new URL('../server-assets/question-bank/v1/bank.json', import.meta.url), 'utf8'));
const runtimeQuestions = Object.entries(bank.categories).flatMap(([category, questions]) =>
  questions.map(question => ({ category, ...question })));
assert.equal(runtimeQuestions.length, bank.questionCount);
for (const question of runtimeQuestions) {
  assert.ok(!requiredBlockedIds.has(question.id), `${question.id}: السؤال المحظور رجع إلى بنك التشغيل.`);
  assert.deepEqual(familyContentViolations(question, policy), [],
    `${question.id}: بنك التشغيل يحتوي مادة غير عائلية.`);
}

const candidates = JSON.parse(fs.readFileSync(
  new URL('../content/questions/candidates.json', import.meta.url), 'utf8'));
for (const candidate of candidates.filter(item => item.status === 'approved')) {
  assert.deepEqual(familyContentViolations(candidate, policy), [],
    `${candidate.id}: مرشح معتمد يخالف سياسة المحتوى العائلي.`);
}

const sourceDocuments = [
  ['جسم الإنسان', '../content/questions/structured-sources/nci-human-organs.json'],
  [null, '../content/questions/structured-sources/wikidata-entity-batch.json'],
  ['أمثال', '../content/questions/structured-sources/wikisource-proverbs.json'],
];
for (const [fallbackCategory, relativePath] of sourceDocuments) {
  const document = JSON.parse(fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8'));
  for (const record of document.records) {
    assert.deepEqual(familyContentViolations({
      category: record.category || fallbackCategory,
      ...record,
    }, policy), [], `${record.sourceRecordId}: أساس توليد غير عائلي.`);
  }
}

assert.ok(familyContentViolations({
  category: 'كتب وروايات',
  question: 'منو مؤلف كتاب إباحي صريح؟',
  answer: 'اسم مؤلف',
}, policy).includes('explicit_adult_content'));
assert.ok(familyContentViolations({
  category: 'أمثال',
  question: 'كمّل هذا المثل؟',
  answer: 'إجابة',
  explanation: 'شرح يتضمن لفظ زنية.',
}, policy).includes('severe_profanity'));
assert.ok(familyContentViolations({
  category: 'جسم الإنسان',
  question: 'شنو المصطلح الإنجليزي للبنية التشريحية «مهبل»؟',
  answer: 'Vagina',
}, policy).includes('direct_sexual_anatomy'));

const breastQuestion = candidates.find(candidate => candidate.id === 'gq-5d478a112b6f74ea353b');
assert.ok(breastQuestion, 'سؤال Breast الطبي الطبيعي مفقود.');
assert.deepEqual(familyContentViolations(breastQuestion, policy), [],
  'سؤال Breast الطبي الطبيعي لا يجوز حجبه.');
for (const medicalQuestion of [
  {
    category: 'جسم الإنسان',
    question: 'شنو العضو العضلي المجوف اللي ينمو داخله الجنين أثناء الحمل؟',
    answer: 'الرحم',
  },
  {
    category: 'جسم الإنسان',
    question: 'شنو الغدة الموجودة أسفل المثانة عند الذكور؟',
    answer: 'البروستاتا',
  },
]) {
  assert.deepEqual(familyContentViolations(medicalQuestion, policy), [],
    'المحتوى الطبي الطبيعي لا يجوز اعتباره محتوى جنسياً صريحاً.');
}
for (const innocentQuestion of [
  { category: 'الشعر العربي', question: 'شنو جنسية الشاعر إسحاق الموصلي؟', answer: 'الدولة العباسية' },
  { category: 'مسلسلات خليجية', question: 'منو أخرج مسلسل الخراز؟', answer: 'عارف الطويل' },
  { category: 'جغرافيا', question: 'شنو عاصمة المكسيك؟', answer: 'مدينة مكسيكو' },
]) {
  assert.deepEqual(familyContentViolations(innocentQuestion, policy), [],
    'المطابقة العائلية لا يجوز أن تعتمد مقاطع قصيرة داخل كلمات بريئة.');
}

console.log(`✓ بوابة المحتوى العائلي اجتازت ${runtimeQuestions.length} سؤالاً بلا false positives طبية`);
