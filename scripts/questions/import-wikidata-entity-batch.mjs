#!/usr/bin/env node
import crypto from 'node:crypto';
import path from 'node:path';
import { CONTENT_DIR, familyContentViolations, loadPolicy, writeJsonAtomic } from './lib.mjs';

const write = process.argv.includes('--write');
const endpoint = 'https://query.wikidata.org/sparql';
const retrievedAt = new Date().toISOString();
const output = path.join(CONTENT_DIR, 'structured-sources', 'wikidata-entity-batch.json');
const specs = [
  { category: 'كتب وروايات', property: 'P50', relation: 'author',
    where: '?item wdt:P50 ?answer.' },
  { category: 'ألعاب الفيديو', property: 'P178', relation: 'developer',
    where: '?item wdt:P31 wd:Q7889; wdt:P178 ?answer.' },
  { category: 'محرّكات ومركبات', property: 'P176', relation: 'manufacturer',
    where: '?item wdt:P31 wd:Q3231690; wdt:P176 ?answer.' },
];
const policy = loadPolicy();

async function fetchQuery(query) {
  const url = new URL(endpoint);
  url.searchParams.set('format', 'json');
  url.searchParams.set('query', query);
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/sparql-results+json',
        'User-Agent': 'FatinahQuestionBank/1.3 (https://ata20.com)' }, signal: AbortSignal.timeout(90_000) });
      if (!response.ok) throw new Error(`Wikidata HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 5) await new Promise(resolve => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw lastError;
}

const records = [];
for (const spec of specs) {
  const query = `SELECT DISTINCT ?item ?itemLabel ?answer ?answerLabel WHERE {
    ${spec.where}
    SERVICE wikibase:label { bd:serviceParam wikibase:language "ar".
      ?item rdfs:label ?itemLabel. ?answer rdfs:label ?answerLabel. }
    FILTER(LANG(?itemLabel)="ar" && LANG(?answerLabel)="ar")
  } LIMIT 240`;
  const payload = await fetchQuery(query);
  const categoryRecords = [];
  for (const binding of payload?.results?.bindings || []) {
    const itemUrl = String(binding.item?.value || '').replace('http://', 'https://');
    const answerUrl = String(binding.answer?.value || '').replace('http://', 'https://');
    const itemId = itemUrl.split('/').pop();
    const answerId = answerUrl.split('/').pop();
    const itemLabel = String(binding.itemLabel?.value || '').trim();
    const answerLabel = String(binding.answerLabel?.value || '').trim();
    if (!/^Q\d+$/.test(itemId) || !/^Q\d+$/.test(answerId) || !itemLabel || !answerLabel) continue;
    const canonical = { category: spec.category, relation: spec.relation, property: spec.property,
      itemId, itemLabel, answerId, answerLabel };
    const sourceRecord = { sourceRecordId: `wikidata-${itemId}-${spec.property}-${answerId}`,
      ...canonical, sourceUrl: `https://www.wikidata.org/wiki/${itemId}`,
      sourcePublisher: 'Wikidata', retrievedAt,
      sourcePayloadHash: crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex') };
    if (familyContentViolations(sourceRecord, policy).length) continue;
    categoryRecords.push(sourceRecord);
  }
  const unique = [...new Map(categoryRecords.map(record => [record.sourceRecordId, record])).values()];
  if (unique.length < 150) throw new Error(`${spec.category}: سجلات Wikidata العربية غير كافية (${unique.length}).`);
  records.push(...unique);
}

const document = { schemaVersion: 1, sourceProfile: 'wikidata_entities_v1', endpoint,
  retrievedAt, records };
if (write) writeJsonAtomic(output, document);
console.log(JSON.stringify({ mode: write ? 'write' : 'dry-run', total: records.length,
  byCategory: Object.fromEntries(specs.map(spec => [spec.category,
    records.filter(record => record.category === spec.category).length])),
  output: write ? path.relative(process.cwd(), output) : null, aiCalls: 0, estimatedAiCostUsd: 0 }, null, 2));
