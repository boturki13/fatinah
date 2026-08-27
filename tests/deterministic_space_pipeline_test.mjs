import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

const records = JSON.parse(fs.readFileSync(
  new URL('../content/questions/structured-sources/nasa-exoplanets.json', import.meta.url), 'utf8'));
const candidates = JSON.parse(fs.readFileSync(
  new URL('../content/questions/candidates.json', import.meta.url), 'utf8'));

assert.equal(records.schemaVersion, 1);
assert.equal(records.sourceProfile, 'official_dataset_v1');
assert.equal(records.sourceTable, 'pscomppars');
assert.ok(records.records.length >= 500, 'يلزم عدد كافٍ من سجلات NASA الموثقة.');
assert.equal(new Set(records.records.map(record => record.sourceRecordId)).size, records.records.length);
for (const record of records.records) {
  assert.ok(record.planetName && record.hostName && record.discoveryMethod && record.discoveryFacility);
  assert.ok(Number.isInteger(record.discoveryYear));
  assert.match(record.sourceUrl, /^https:\/\/exoplanetarchive\.ipac\.caltech\.edu\/TAP\/sync\?/);
  const canonical = {
    planetName: record.planetName,
    hostName: record.hostName,
    discoveryYear: record.discoveryYear,
    discoveryMethod: record.discoveryMethod,
    discoveryFacility: record.discoveryFacility,
  };
  assert.equal(record.sourcePayloadHash,
    crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'));
}

const generated = candidates.filter(candidate =>
  candidate.generation?.model === 'deterministic-nasa-exoplanet-template-v1');
assert.equal(generated.length, 119);
assert.equal(new Set(generated.map(candidate => candidate.sourceRecordId)).size, generated.length);
assert.deepEqual(
  Object.fromEntries(Array.from({ length: 6 }, (_, index) => [String(index + 1),
    generated.filter(candidate => candidate.difficultyLevel === index + 1).length])),
  { 1: 20, 2: 20, 3: 20, 4: 20, 5: 20, 6: 19 },
);
assert.ok(generated.every(candidate => candidate.category === 'الفضاء والكون'));
assert.ok(generated.every(candidate => candidate.status === 'approved'));
assert.ok(generated.every(candidate => candidate.question.endsWith('؟')));
assert.ok(generated.every(candidate => !candidate.question.includes(candidate.answer)));
assert.ok(generated.filter(candidate => candidate.difficultyLevel >= 5)
  .every(candidate => /[\u0600-\u06FF]/.test(candidate.answer)), 'أسماء مرافق الرصد تُعرض بالعربية.');
assert.ok(generated.every(candidate => candidate.cost?.runEstimatedUsd === 0));
assert.ok(generated.every(candidate => candidate.generation?.usage?.estimatedUsd === 0));
assert.ok(generated.every(candidate => candidate.verification?.result?.verdict === 'pass'));

console.log('✓ 119 سؤال فضاء حتمي من سجل NASA الرسمي، ببصمات وتكلفة AI صفر');
