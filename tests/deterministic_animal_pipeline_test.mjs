import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

const records = JSON.parse(fs.readFileSync(
  new URL('../content/questions/structured-sources/inaturalist-animal-taxa.json', import.meta.url), 'utf8'));
const candidates = JSON.parse(fs.readFileSync(
  new URL('../content/questions/candidates.json', import.meta.url), 'utf8'));

assert.equal(records.schemaVersion, 1);
assert.equal(records.sourceProfile, 'official_dataset_v1');
assert.equal(records.locale, 'ar');
assert.equal(records.imageDataUsed, false);
assert.ok(records.records.length >= 120);
assert.equal(new Set(records.records.map(record => record.sourceRecordId)).size, records.records.length);
assert.equal(new Set(records.records.map(record => record.commonNameAr)).size, records.records.length);
for (const record of records.records) {
  assert.match(record.sourceUrl, /^https:\/\/api\.inaturalist\.org\/v1\/taxa\/\d+\?locale=ar$/);
  assert.match(record.commonNameAr, /[\u0600-\u06FF]/);
  assert.equal(record.rank, 'species');
  assert.equal(record.translationCrossCheck?.publisher, 'Wikidata');
  assert.equal(record.translationCrossCheck?.taxonProperty, 'P3151');
  assert.ok(record.translationCrossCheck?.entityUrl.startsWith('http://www.wikidata.org/entity/Q'));
  const canonical = {
    taxonId: record.taxonId, scientificName: record.scientificName, commonNameAr: record.commonNameAr,
    iconicTaxon: record.iconicTaxon, rank: record.rank,
    observationsCountAtRetrieval: record.observationsCountAtRetrieval,
  };
  assert.equal(record.sourcePayloadHash,
    crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'));
}

const generated = candidates.filter(candidate =>
  candidate.generation?.model === 'deterministic-inaturalist-taxon-template-v1');
assert.equal(generated.length, 119);
assert.equal(new Set(generated.map(candidate => candidate.sourceRecordId)).size, generated.length);
assert.deepEqual(
  Object.fromEntries(Array.from({ length: 6 }, (_, index) => [String(index + 1),
    generated.filter(candidate => candidate.difficultyLevel === index + 1).length])),
  { 1: 20, 2: 20, 3: 20, 4: 20, 5: 20, 6: 19 },
);
assert.ok(generated.every(candidate => candidate.status === 'approved'));
assert.ok(generated.every(candidate => candidate.question.endsWith('؟')));
assert.ok(generated.every(candidate => !candidate.question.includes(candidate.answer)));
assert.ok(generated.every(candidate => candidate.cost?.runEstimatedUsd === 0));
assert.ok(generated.every(candidate => candidate.generation?.usage?.estimatedUsd === 0));
const generatedGroups = new Set(generated.map(candidate => {
  const record = records.records.find(item => item.sourceRecordId === candidate.sourceRecordId);
  return record?.iconicTaxon;
}));
assert.deepEqual(generatedGroups, new Set([
  'Mammalia', 'Aves', 'Reptilia', 'Amphibia', 'Actinopterygii', 'Insecta', 'Arachnida', 'Mollusca',
]));
assert.ok(!generated.some(candidate => /تم أخرس|تم بواق|حسون الظالم|حمامة الحداد|بلبول شمالي/.test(
  `${candidate.question} ${candidate.answer}`)));

console.log('✓ 119 سؤال حيوانات حتمي من سجلات iNaturalist العربية، ببصمات وتكلفة AI صفر');
