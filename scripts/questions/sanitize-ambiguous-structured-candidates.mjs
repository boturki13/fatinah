#!/usr/bin/env node
import {
  CANDIDATES_PATH,
  normalizeArabic,
  readJson,
  structuredRelationKey,
  writeJsonAtomic,
} from './lib.mjs';

const write = process.argv.includes('--write');
const candidates = readJson(CANDIDATES_PATH, []);
const answersByRelation = new Map();

for (const candidate of candidates.filter(item => item.status === 'approved')) {
  const key = structuredRelationKey(candidate);
  if (!key) continue;
  if (!answersByRelation.has(key)) answersByRelation.set(key, new Set());
  answersByRelation.get(key).add(normalizeArabic(candidate.answer));
}

const ambiguousRelations = new Set([...answersByRelation]
  .filter(([, answers]) => answers.size > 1)
  .map(([key]) => key));
const removed = candidates.filter(candidate => ambiguousRelations.has(structuredRelationKey(candidate)));
const clean = candidates.filter(candidate => !ambiguousRelations.has(structuredRelationKey(candidate)));

if (write) writeJsonAtomic(CANDIDATES_PATH, clean);
console.log(JSON.stringify({
  mode: write ? 'write' : 'dry-run',
  ambiguousRelationCount: ambiguousRelations.size,
  removedCount: removed.length,
  removedIds: removed.map(candidate => candidate.id),
}, null, 2));
