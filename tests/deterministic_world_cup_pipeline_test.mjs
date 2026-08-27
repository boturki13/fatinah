import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

const records = JSON.parse(fs.readFileSync(
  new URL('../content/questions/structured-sources/fifa-world-cup-finals.json', import.meta.url), 'utf8'));
const candidates = JSON.parse(fs.readFileSync(
  new URL('../content/questions/candidates.json', import.meta.url), 'utf8'));

assert.equal(records.schemaVersion, 1);
assert.equal(records.sourceProfile, 'official_dataset_v1');
assert.equal(records.competitionId, '17');
assert.equal(records.finals.length, 20);
assert.equal(records.records.length, 120);
assert.equal(new Set(records.records.map(record => record.sourceRecordId)).size, 120);
assert.deepEqual([...new Set(records.records.map(record => record.factType))].sort(),
  ['champion', 'city', 'date', 'runner-up', 'score', 'stadium']);
for (const record of records.records) {
  assert.ok(record.year >= 1930 && record.year <= 2018 && record.year !== 1950);
  assert.match(record.sourceUrl, /^https:\/\/api\.fifa\.com\/api\/v3\/calendar\/matches\?/);
  const canonical = {
    competitionId: record.competitionId, seasonId: record.seasonId, year: record.year,
    matchId: record.matchId, factType: record.factType, answer: record.answer,
    homeTeam: record.homeTeam, awayTeam: record.awayTeam, homeScore: record.homeScore,
    awayScore: record.awayScore, homePenaltyScore: record.homePenaltyScore,
    awayPenaltyScore: record.awayPenaltyScore, stage: record.stage, date: record.date,
  };
  assert.equal(record.sourcePayloadHash,
    crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'));
}

const generated = candidates.filter(candidate =>
  candidate.generation?.model === 'deterministic-fifa-world-cup-finals-template-v1');
assert.equal(generated.length, 119);
assert.equal(new Set(generated.map(candidate => candidate.sourceRecordId)).size, 119);
assert.deepEqual(Object.fromEntries(Array.from({ length: 6 }, (_, index) => [String(index + 1),
  generated.filter(candidate => candidate.difficultyLevel === index + 1).length])),
{ 1: 20, 2: 20, 3: 20, 4: 20, 5: 20, 6: 19 });
assert.ok(generated.every(candidate => candidate.status === 'approved'));
assert.ok(generated.every(candidate => candidate.question.endsWith('؟')));
assert.ok(generated.every(candidate => !candidate.question.includes(candidate.answer)));
assert.ok(generated.every(candidate => candidate.cost?.runEstimatedUsd === 0));

console.log('✓ 119 سؤال كأس عالم حتمي من نهائيات FIFA الرسمية، ببصمات وتكلفة AI صفر');
