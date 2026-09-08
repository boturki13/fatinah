import assert from 'node:assert/strict';
import fs from 'node:fs';

import { assertNoSimilarOptions, normalizeArabic } from '../scripts/questions/categories/common.mjs';
import {
  CATEGORY_ORDER, CATEGORY_QUESTION_COUNTS, EXPECTED_QUESTION_COUNT,
  expectedBandCount, expectedLevelCount, expectedQuestionPlacement,
} from '../scripts/questions/release-contract.mjs';
import { verifyWorldScienceCategories } from '../scripts/questions/categories/world-science.mjs';
import { verifyProverbCategory } from '../scripts/questions/categories/proverbs.mjs';
import { assertNoLegacyFacts, loadLegacyQuestionRecords } from '../scripts/questions/legacy-question-policy.mjs';

const read = relative => JSON.parse(fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8'));
const bank = read('server-assets/question-bank/v1/bank.json');
const expectedCategories = [...CATEGORY_ORDER];
const worldScienceCategories = [
  'اختر العبارة الصحيحة', 'كرة القدم', 'علوم وطبيعة', 'مدن وعواصم',
  'عملات العالم', 'فيزياء وكيمياء',
];
const MEDIA_EASY_CURATION_CATEGORIES = new Set([
  'كرتون وأنمي', 'تقنية وإنترنت', 'سينما وأفلام عربية',
  'اختراعات واكتشافات', 'أحداث غيرت العالم', 'منظمات دولية',
]);
const banned = /(?:إسرائيل|اسرائيل|Israel|Israeli|Tel Aviv|تل أبيب|تل ابيب|إباح|اباح|porn|hentai|ecchi)/iu;
const ambiguousBroadPersonClue=/(?:نلت|نال|نالت).*«(?:جوائز الغولدن غلوب|جائزة الأوسكار|جائزة غرامي)»|(?:تولت|توليت) منصب «(?:رئيس الوزراء|إمبراطور|عاهل|ملك)»/u;
const previouslyAmbiguousIds=new Set([
  'gq-7ad3afdfb8eb0afd8323','gq-4a8827ce1b7dbcf2c3e5','gq-8b82cd9e8d02c574e5c7',
  'gq-caf1f4ddfae371921e62','gq-cd8b6973583d57137928','gq-18a80c34389ddf28b87a',
  'gq-ff6eb1c530bd5b61b3ff','gq-773560367b7fac5fab67','gq-29e6c62dd579c404807d',
]);
const repeatedLegacyFactIds=new Set(['gq-fd6d751d599a64fca7e7']);

assert.equal(bank.releaseReady, true, 'بنك الإصدار يجب أن يكون معتمدًا.');
assert.equal(bank.questionCount, EXPECTED_QUESTION_COUNT);
assert.equal(bank.categoryCount, CATEGORY_ORDER.length);
assert.deepEqual(Object.keys(bank.categories), expectedCategories, 'ترتيب فئات الإصدار غير مطابق.');
assert.equal(Object.hasOwn(bank.categories, 'رتّبها صح'), false, 'فئة رتّبها صح محذوفة.');
assert.equal(Object.hasOwn(bank.categories, 'رياضيات وحساب'), false, 'فئة رياضيات وحساب محذوفة نهائيًا.');
assert.equal(Object.hasOwn(bank.categories, 'ألغاز بوليسية'), false, 'فئة ألغاز بوليسية محذوفة نهائيًا.');

const seenIds = new Set();
const seenQuestions = new Set();
const seenFacts = new Set();
for (const category of expectedCategories) {
  const rows = bank.categories[category];
  const expectedCount = CATEGORY_QUESTION_COUNTS[category];
  assert.equal(rows.length, expectedCount, `${category}: عدد الأسئلة غير مطابق.`);
  for (const [position, question] of rows.entries()) {
    const placement = expectedQuestionPlacement(category, position);
    assert.equal(question.band, placement.band, `${question.id}: ترتيب الصعوبة غير صحيح.`);
    assert.equal(question.d, placement.level);
    assert.equal(question.review?.status, 'approved', `${question.id}: سؤال غير معتمد.`);
    assert.ok(String(question.review?.reviewer || '').trim(), `${question.id}: اسم مدقق الاعتماد مفقود.`);
    assert.match(String(question.review?.reviewedAt || ''), /^\d{4}-\d{2}-\d{2}/u,
      `${question.id}: تاريخ اعتماد السؤال مفقود.`);
    assert.equal(question.review?.humanReviewRequired, false,
      `${question.id}: يجب ألا يعتمد الإصدار على مراجعة بشرية معلقة.`);
    if (MEDIA_EASY_CURATION_CATEGORIES.has(category) && position < 30) {
      assert.equal(question.popularity?.curatedTier, 'widely-known-arabic-or-global',
        `${question.id}: السؤال السهل غير مصنف وفق شهرة الجمهور العربي والخليجي.`);
    }
    assert.equal(question.o.length, 4, `${question.id}: يجب أن تظهر أربعة خيارات.`);
    assert.equal(new Set(question.o.map(normalizeArabic)).size, 4, `${question.id}: خيارات مكررة.`);
    assert.equal(question.o[question.a], question.answer, `${question.id}: موضع الجواب لا يطابق الإجابة.`);
    assertNoSimilarOptions(question);
    assert.doesNotMatch(JSON.stringify({ q: question.q, o: question.o, answer: question.answer }), banned,
      `${question.id}: محتوى محظور.`);
    assert.doesNotMatch(question.q,ambiguousBroadPersonClue,
      `${question.id}: وصف عام يجعل أكثر من خيار صحيحًا.`);
    assert.equal(previouslyAmbiguousIds.has(question.id),false,
      `${question.id}: سؤال متعدد الإجابات معروف لا يجوز أن يعود.`);
    assert.equal(repeatedLegacyFactIds.has(question.id), false,
      `${question.id}: حقيقة منشورة في البنك القديم لا يجوز أن تعود بصياغة أخرى.`);
    assert.ok(!seenIds.has(question.id), `${question.id}: معرف مكرر.`);
    assert.ok(!seenQuestions.has(normalizeArabic(question.q)), `${question.id}: صياغة مكررة.`);
    assert.ok(!seenFacts.has(question.factKey), `${question.id}: حقيقة مكررة.`);
    seenIds.add(question.id); seenQuestions.add(normalizeArabic(question.q)); seenFacts.add(question.factKey);
  }
  for (const band of ['easy', 'medium', 'hard']) {
    const subset = rows.filter(question => question.band === band);
    assert.equal(subset.length, expectedBandCount(category),
      `${category}/${band}: عدد الأسئلة غير مطابق.`);
    const slots = [0, 1, 2, 3].map(index => subset.filter(question => question.a === index).length);
    assert.ok(Math.max(...slots) - Math.min(...slots) <= 1,
      `${category}/${band}: مواضع الإجابة منحازة (${slots.join('/')}).`);
  }
  for (let level = 1; level <= 6; level += 1) {
    assert.equal(rows.filter(question => question.d === level).length,
      expectedLevelCount(category),
      `${category}: عدد أسئلة المستوى ${level} غير مطابق.`);
  }
}
assert.equal(seenIds.size, EXPECTED_QUESTION_COUNT);
assert.equal(seenQuestions.size, EXPECTED_QUESTION_COUNT);
assert.equal(seenFacts.size, EXPECTED_QUESTION_COUNT);

for (const question of bank.categories['القرآن الكريم']) {
  assert.equal(question.templateId, 'quran-foundation-verse-to-surah-v1');
  assert.equal(question.verification?.provider, 'Quran.Foundation Content API v4');
  assert.equal(question.verification?.result?.verdict, 'pass');
  assert.equal(question.review?.religiousHumanReviewComplete, true);
  assert.match(question.sourceRecordId, /^quran-pilot-/u);
}

const trueFalse = bank.categories['اختر العبارة الصحيحة'];
assert.deepEqual([...new Set(trueFalse.map(question => question.templateId))].sort(), [
  'one-true-animal-group-v1', 'one-true-country-iso3-v1', 'one-true-element-v1',
]);
for (const question of trueFalse) {
  assert.match(question.q, /^أي العبارات التالية صحيحة؟/u);
  assert.equal(question.truthClaims.length, 4);
  const trueClaims = question.truthClaims.filter(claim => String(claim.actualValue) === String(claim.presentedValue));
  assert.equal(trueClaims.length, 1, `${question.id}: يجب أن يكون هناك زوج صحيح واحد.`);
  assert.equal(question.answer, trueClaims[0].text);
}

const football = bank.categories['كرة القدم'];
assert.deepEqual(football.map(question => question.templateId).reduce((counts, template) => {
  counts[template] = (counts[template] || 0) + 1; return counts;
}, {}), { 'fifa-match-stage-v3': 30, 'fifa-match-score-v3': 30, 'fifa-match-city-v3': 30 });
for (const question of football.filter(row => row.templateId === 'fifa-match-score-v3')) {
  assert.match(question.q, /ثم[\u0600-\u06ff\s]+، بالترتيب/u, `${question.id}: ترتيب نتيجة الفريقين غير واضح.`);
  assert.ok(question.o.every(option => /^\d+–\d+$/u.test(option)), `${question.id}: خيار نتيجة غير منطقي.`);
}

const nature = bank.categories['علوم وطبيعة'];
const natureTemplates = ['animal-group-v2', 'animal-group-choice-v1', 'animal-scientific-name-v2'];
for (const template of natureTemplates) {
  assert.equal(nature.filter(question => question.templateId === template).length, 30, `${template}: المطلوب 30.`);
}
const natureSourceSets = natureTemplates.map(template => new Set(
  nature.filter(question => question.templateId === template).map(question => question.sourceRecordId),
));
for (let left = 0; left < natureSourceSets.length; left += 1) {
  for (let right = left + 1; right < natureSourceSets.length; right += 1) {
    assert.equal([...natureSourceSets[left]].some(id => natureSourceSets[right].has(id)), false,
      'مستويات علوم وطبيعة يجب ألا تعيد الحيوان نفسه بصياغة أخرى.');
  }
}

const cities = bank.categories['مدن وعواصم'];
const familiarCities = [
  'إسطنبول', 'نيويورك', 'لوس أنجلوس', 'مكة المكرمة', 'المدينة المنورة', 'برشلونة',
  'ميلانو', 'مانشستر', 'ليفربول', 'سيدني', 'تورونتو', 'شيكاغو', 'الإسكندرية', 'الدار البيضاء',
];
assert.ok(cities.slice(0, 30).filter(question =>
  familiarCities.some(city => question.q.includes(`«${city}»`))).length >= 8,
  'مستوى المدن السهل يجب أن يبدأ بمدن معروفة.');
for (const question of cities) {
  assert.equal(normalizeArabic(question.q).includes(normalizeArabic(question.answer)), false,
    `${question.id}: نص سؤال المدينة يكشف الإجابة.`);
}

assert.equal(verifyWorldScienceCategories(Object.fromEntries(
  worldScienceCategories.map(category => [category, bank.categories[category]]),
)), true, 'مدقق وحدة العالم والعلوم رفض البنك.');
assert.equal(verifyProverbCategory(bank.categories['اكتشف الكلمة']), true, 'مدقق الأمثال رفض البنك.');

const legacyCategories = Object.fromEntries([
  'من أنا؟', 'شخصيات تاريخية', 'شعراء وأدباء عرب', 'روايات عالمية',
  ...worldScienceCategories, 'اكتشف الكلمة',
].map(category => [category, bank.categories[category]]));
assertNoLegacyFacts(legacyCategories, loadLegacyQuestionRecords());

console.log(`✅ ${EXPECTED_QUESTION_COUNT} سؤالًا: خيارات منطقية، ومنها فئة قرآن موثقة عبر Quran.Foundation`);
