import assert from 'node:assert/strict';
import {
  buildWorldScienceCategories,
  geographicAnswerLeak,
  verifyWorldScienceCategories,
} from '../scripts/questions/categories/world-science.mjs';
import { assertNoSimilarOptions, normalizeArabic } from '../scripts/questions/categories/common.mjs';

const categories = buildWorldScienceCategories();
const all = Object.values(categories).flat();

assert.equal(all.length, 630);
assert.equal(verifyWorldScienceCategories(categories), true);
assert.equal(new Set(all.map(question => normalizeArabic(question.q))).size, 630);
assert.equal(new Set(all.map(question => question.factKey)).size, 630);
assert.equal(all.filter(geographicAnswerLeak).length, 0);
for (const question of all) assert.doesNotThrow(() => assertNoSimilarOptions(question));

const nature = categories['علوم وطبيعة'];
assert.deepEqual(['easy', 'medium', 'hard'].map(band =>
  [...new Set(nature.filter(question => question.band === band).map(question => question.templateId))]), [
  ['animal-group-v2'], ['animal-group-choice-v1'], ['animal-scientific-name-v2'],
]);
for (const question of nature.filter(item => item.band === 'medium')) {
  assert.equal(question.animalChoiceClaims.length, 4);
  assert.equal(new Set(question.animalChoiceClaims.map(claim => claim.name)).size, 4);
  assert.equal(new Set(question.animalChoiceClaims.map(claim => claim.iconicTaxon)).size, 4);
  assert.equal(question.animalChoiceClaims.filter(claim =>
    claim.iconicTaxon === question.targetAnimalGroup).length, 1);
}
assert.doesNotMatch(JSON.stringify(nature), /ببر|حمار الزرد السهلي|ذعرة بيضاء/u);

const natureTargets = new Set(nature.map(question => question.sourceRecordId));
const trueFalseAnimalTargets = categories['اختر العبارة الصحيحة']
  .filter(question => question.templateId === 'one-true-animal-group-v1')
  .map(question => question.sourceRecordId);
assert.equal(natureTargets.size, 90);
assert.equal(new Set(trueFalseAnimalTargets).size, 30);
assert.equal(trueFalseAnimalTargets.some(id => natureTargets.has(id)), false);
assert.ok(categories['اختر العبارة الصحيحة'].every(question => question.q.startsWith('أي العبارات التالية صحيحة؟')));

const logic = categories['ألغاز بوليسية'];
const expectedKindCounts = {
  easy: { guilty: 60, innocent: 60, oneOf: 0, neither: 0 },
  medium: { guilty: 30, innocent: 30, oneOf: 30, neither: 30 },
  hard: { guilty: 0, innocent: 0, oneOf: 60, neither: 60 },
};
for (const band of ['easy', 'medium', 'hard']) {
  const rows = logic.filter(question => question.band === band);
  const requiredCounts = Object.fromEntries([1, 2, 3]
    .map(required => [required, rows.filter(question => question.requiredTrueStatements === required).length]));
  const kindCounts = Object.fromEntries(['guilty', 'innocent', 'oneOf', 'neither'].map(kind =>
    [kind, rows.flatMap(question => question.logicStatements).filter(statement => statement.kind === kind).length]));
  assert.deepEqual(kindCounts, expectedKindCounts[band]);
  assert.deepEqual(requiredCounts, band === 'easy'
    ? { 1: 15, 2: 0, 3: 15 } : { 1: 10, 2: 10, 3: 10 });
}

assert.doesNotMatch(JSON.stringify(categories['كرة القدم'].map(question => ({
  q: question.q, o: question.o, answer: question.answer,
}))), /تالوكا|كوبه/u);

const tampered = structuredClone(categories);
const mediumQuestion = tampered['علوم وطبيعة'][30];
mediumQuestion.o[mediumQuestion.a === 0 ? 1 : 0] = 'حيوان غير موثق';
assert.equal(verifyWorldScienceCategories(tampered), false);

const logicTamper = structuredClone(categories);
logicTamper['ألغاز بوليسية'][30].logicComplexity.compoundStatementCount = 4;
assert.equal(verifyWorldScienceCategories(logicTamper), false);

const wordingTamper = structuredClone(categories);
wordingTamper['اختر العبارة الصحيحة'][0].q = wordingTamper['اختر العبارة الصحيحة'][0].q
  .replace('أي العبارات التالية صحيحة؟', 'أي زوج صحيح؟');
assert.equal(verifyWorldScienceCategories(wordingTamper), false);

console.log('✓ وحدة العالم والعلوم: 630 سؤالًا متدرجًا، متباين السجلات، ومقاومًا للعبث');
