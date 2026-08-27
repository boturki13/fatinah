import assert from 'node:assert/strict';
import fs from 'node:fs';

const records = JSON.parse(fs.readFileSync(
  new URL('../content/questions/structured-sources/world-bank-countries.json', import.meta.url), 'utf8'));
const candidates = JSON.parse(fs.readFileSync(
  new URL('../content/questions/candidates.json', import.meta.url), 'utf8'));

assert.equal(records.schemaVersion, 1);
assert.equal(records.sourceProfile, 'official_dataset_v1');
assert.ok(records.records.length >= 180, 'يلزم عدد كافٍ من دول الأمم المتحدة ذات الأسماء والعواصم العربية.');
assert.equal(new Set(records.records.map(record => record.iso2)).size, records.records.length);
for (const record of records.records) {
  assert.match(record.iso2, /^[A-Z]{2}$/);
  assert.ok(record.countryAr && record.capitalAr);
  assert.match(record.sourceUrl, /^https:\/\/api\.worldbank\.org\/v2\/country\/[A-Z]{2}\?format=json$/);
  assert.match(record.sourcePayloadHash, /^[a-f0-9]{64}$/);
}

const generated = candidates.filter(candidate =>
  candidate.generation?.model === 'deterministic-world-bank-template-v1');
assert.equal(generated.length, 238);
for (const category of ['أعلام الدول', 'جغرافيا']) {
  const rows = generated.filter(candidate => candidate.category === category);
  assert.equal(rows.length, 119, `${category}: يجب ملء الفجوة الحتمية كاملة.`);
  assert.equal(new Set(rows.map(candidate => candidate.sourceRecordId)).size, rows.length);
  assert.ok(rows.every(candidate => candidate.status === 'approved'));
  assert.ok(rows.every(candidate => candidate.cost?.runEstimatedUsd === 0));
  assert.ok(rows.every(candidate => candidate.generation?.usage?.estimatedUsd === 0));
  assert.ok(rows.every(candidate => candidate.verification?.result?.verdict === 'pass'));
}
assert.ok(generated.filter(candidate => candidate.category === 'أعلام الدول')
  .every(candidate => /[\u{1F1E6}-\u{1F1FF}]{2}/u.test(candidate.question) && candidate.question.endsWith('؟')));
assert.ok(generated.filter(candidate => candidate.category === 'جغرافيا')
  .every(candidate => candidate.question.endsWith('؟') && !candidate.question.includes(candidate.answer)));

console.log('✓ 238 سؤال أعلام وجغرافيا حتمي من 191 سجل دولة رسمي، ببصمات وتكلفة AI صفر');
