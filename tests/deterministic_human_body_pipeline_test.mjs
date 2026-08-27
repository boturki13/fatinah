import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

const records = JSON.parse(fs.readFileSync(
  new URL('../content/questions/structured-sources/nci-human-organs.json', import.meta.url), 'utf8'));
const candidates = JSON.parse(fs.readFileSync(
  new URL('../content/questions/candidates.json', import.meta.url), 'utf8'));

assert.equal(records.schemaVersion, 1);
assert.equal(records.sourceProfile, 'wikidata_entities_v1');
assert.equal(records.sourceRootCode, 'C13018');
assert.ok(records.records.length >= 150);
assert.equal(new Set(records.records.map(record => record.sourceRecordId)).size, records.records.length);
assert.equal(new Set(records.records.map(record => record.nameAr)).size, records.records.length);
for (const record of records.records) {
  assert.match(record.code, /^C\d+$/);
  assert.match(record.nameAr, /[\u0600-\u06FF]/);
  assert.match(record.sourceUrl, /^https:\/\/api-evsrest\.nci\.nih\.gov\/api\/v1\/concept\/ncit\/C\d+$/);
  assert.match(record.translationIndexUrl, /^http:\/\/www\.wikidata\.org\/entity\/Q\d+$/);
  const canonical = {
    code: record.code, officialNameEn: record.officialNameEn, nameAr: record.nameAr,
    hierarchyLevel: record.hierarchyLevel, sitelinks: record.sitelinks, definition: record.definition,
  };
  assert.equal(record.sourcePayloadHash,
    crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'));
}

const generated = candidates.filter(candidate =>
  candidate.generation?.model === 'deterministic-nci-human-organ-template-v1');
assert.equal(generated.length, 119);
assert.equal(new Set(generated.map(candidate => candidate.sourceRecordId)).size, generated.length);
assert.deepEqual(
  Object.fromEntries(Array.from({ length: 6 }, (_, index) => [String(index + 1),
    generated.filter(candidate => candidate.difficultyLevel === index + 1).length])),
  { 1: 20, 2: 20, 3: 20, 4: 20, 5: 20, 6: 19 },
);
assert.equal(generated.filter(candidate => candidate.templateId.startsWith('human-organ-function')).length, 40);
assert.ok(generated.every(candidate => candidate.status === 'approved'));
assert.ok(generated.every(candidate => candidate.question.endsWith('؟')));
assert.ok(generated.every(candidate => !candidate.question.includes(candidate.answer)));
assert.ok(generated.every(candidate => candidate.cost?.runEstimatedUsd === 0));

console.log('✓ 119 سؤال جسم الإنسان حتمي من NCI، منها 40 سؤال وظيفة، ببصمات وتكلفة AI صفر');
