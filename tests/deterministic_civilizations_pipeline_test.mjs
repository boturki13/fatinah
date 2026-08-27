import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

const records = JSON.parse(fs.readFileSync(
  new URL('../content/questions/structured-sources/unesco-archaeological-sites.json', import.meta.url), 'utf8'));
const candidates = JSON.parse(fs.readFileSync(
  new URL('../content/questions/candidates.json', import.meta.url), 'utf8'));

assert.equal(records.schemaVersion, 1);
assert.equal(records.sourceProfile, 'wikidata_entities_v1');
assert.ok(records.records.length >= 119);
assert.equal(new Set(records.records.map(record => record.sourceRecordId)).size, records.records.length);
assert.equal(new Set(records.records.map(record => record.siteNameAr)).size, records.records.length);
for (const record of records.records) {
  assert.match(record.siteNameAr, /[\u0600-\u06FF]/);
  assert.match(record.countryNameAr, /[\u0600-\u06FF]/);
  assert.notEqual(record.countryNameAr, 'إسرائيل');
  assert.match(record.sourceUrl, /^https:\/\/whc\.unesco\.org\/en\/list\/[0-9]+(?:bis|ter)?$/i);
  assert.match(record.translationIndexUrl, /^http:\/\/www\.wikidata\.org\/entity\/Q\d+$/);
  assert.ok(record.qualifications.some(value =>
    ['dated_before_1000', 'explicit_culture', 'curated_ancient_site'].includes(value)));
  const canonical = {
    siteQid: record.siteQid, siteNameAr: record.siteNameAr, countryNameAr: record.countryNameAr,
    countryEntityUrl: record.countryEntityUrl, whComponentId: record.whComponentId,
    whPropertyId: record.whPropertyId, sitelinks: record.sitelinks,
    inscriptionYear: record.inscriptionYear,
    qualifications: record.qualifications, inceptions: record.inceptions,
    cultureEntityUrls: record.cultureEntityUrls,
  };
  assert.equal(record.sourcePayloadHash,
    crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'));
}

const generated = candidates.filter(candidate =>
  candidate.generation?.model === 'deterministic-unesco-archaeological-site-template-v1');
assert.equal(generated.length, 119);
assert.equal(new Set(generated.map(candidate => candidate.sourceRecordId)).size, generated.length);
assert.deepEqual(
  Object.fromEntries(Array.from({ length: 6 }, (_, index) => [String(index + 1),
    generated.filter(candidate => candidate.difficultyLevel === index + 1).length])),
  { 1: 20, 2: 20, 3: 20, 4: 20, 5: 20, 6: 19 },
);
const sourceCounts = generated.reduce((counts, candidate) => {
  counts[candidate.source.url] = (counts[candidate.source.url] || 0) + 1;
  return counts;
}, {});
assert.ok(Object.values(sourceCounts).every(count => count <= 2));
assert.ok(generated.every(candidate => candidate.status === 'approved'));
assert.ok(generated.every(candidate => candidate.question.endsWith('؟')));
assert.ok(generated.every(candidate => !candidate.question.includes(candidate.answer)));
assert.ok(generated.every(candidate => candidate.cost?.runEstimatedUsd === 0));
assert.ok(!generated.some(candidate => /مونه ايه|قطع صخرة دازو|مقبرة بنتارغه|هيد سماشد/.test(
  `${candidate.question} ${candidate.answer}`)));

console.log('✓ 119 سؤال حضارات ومواقع أثرية حتمي من صفحات اليونسكو، ببصمات وتكلفة AI صفر');
