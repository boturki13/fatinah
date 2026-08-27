#!/usr/bin/env node
import path from 'node:path';
import {
  CANDIDATES_PATH,
  CONTENT_DIR,
  familyContentViolations,
  loadPolicy,
  readJson,
  writeJsonAtomic,
} from './lib.mjs';

const write = process.argv.includes('--write');
const policy = loadPolicy();
const sources = [
  { category: 'جسم الإنسان', file: 'nci-human-organs.json' },
  { category: null, file: 'wikidata-entity-batch.json' },
  { category: 'أمثال', file: 'wikisource-proverbs.json' },
];

const candidates = readJson(CANDIDATES_PATH, []);
const safeCandidates = candidates.filter(candidate =>
  familyContentViolations(candidate, policy).length === 0);
const removedCandidates = candidates.filter(candidate =>
  familyContentViolations(candidate, policy).length > 0)
  .map(candidate => ({
    id: candidate.id,
    sourceRecordId: candidate.sourceRecordId || null,
    violations: familyContentViolations(candidate, policy),
  }));

const sourceResults = [];
for (const source of sources) {
  const file = path.join(CONTENT_DIR, 'structured-sources', source.file);
  const document = readJson(file, null);
  if (!document || document.schemaVersion !== 1 || !Array.isArray(document.records)) {
    throw new Error(`${source.file}: ملف المصدر المنظم غير صالح.`);
  }
  const safeRecords = document.records.filter(record =>
    familyContentViolations({ category: record.category || source.category, ...record }, policy).length === 0);
  const removed = document.records.filter(record =>
    familyContentViolations({ category: record.category || source.category, ...record }, policy).length > 0)
    .map(record => ({
      sourceRecordId: record.sourceRecordId,
      violations: familyContentViolations({ category: record.category || source.category, ...record }, policy),
    }));
  sourceResults.push({ file, document: { ...document, records: safeRecords }, removed });
}

if (write) {
  writeJsonAtomic(CANDIDATES_PATH, safeCandidates);
  for (const result of sourceResults) writeJsonAtomic(result.file, result.document);
}

console.log(JSON.stringify({
  mode: write ? 'write' : 'dry-run',
  candidates: {
    before: candidates.length,
    after: safeCandidates.length,
    removed: removedCandidates,
  },
  sources: sourceResults.map(result => ({
    file: path.relative(process.cwd(), result.file),
    after: result.document.records.length,
    removed: result.removed,
  })),
}, null, 2));
