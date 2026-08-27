#!/usr/bin/env node
import crypto from 'node:crypto';
import path from 'node:path';
import { CONTENT_DIR, writeJsonAtomic } from './lib.mjs';

const write = process.argv.includes('--write');
const endpoint = 'https://query.wikidata.org/sparql';
const output = path.join(CONTENT_DIR, 'structured-sources', 'wikidata-cultural-batch.json');
const retrievedAt = new Date().toISOString();
const excludedQuestionContent = /إسرائيل|اسرائيل|إسرائيلي|اسرائيلي|تل أبيب|تل ابيب/i;
const arabCountries = 'wd:Q79 wd:Q817 wd:Q851 wd:Q878 wd:Q822 wd:Q858 wd:Q796 wd:Q810 wd:Q1028 wd:Q948 wd:Q262 wd:Q846 wd:Q398 wd:Q842 wd:Q805 wd:Q219060 wd:Q1049 wd:Q1016 wd:Q1025';
const specs = [
  { category: 'أنمي', property: 'P57', relation: 'director', min: 119,
    where: '?item wdt:P31 wd:Q63952888; wdt:P57 ?answer.' },
  { category: 'أفلام عربية', property: 'P57', relation: 'director', min: 150,
    where: `VALUES ?country { ${arabCountries} } ?item wdt:P31 wd:Q11424; wdt:P495 ?country; wdt:P57 ?answer.` },
  { category: 'مطابخ العالم', property: 'P495', relation: 'country-of-origin', min: 150,
    where: '?item wdt:P31 wd:Q746549; wdt:P495 ?answer.' },
  { category: 'اختراعات واكتشافات', property: 'P61', relation: 'discoverer-or-inventor', min: 150,
    where: '?item wdt:P61 ?answer.' },
  { category: 'الشعر العربي', property: 'P27', relation: 'citizenship', min: 150,
    where: '?item wdt:P106 wd:Q49757; wdt:P1412 wd:Q13955; wdt:P27 ?answer.' },
];

async function fetchQuery(query) {
  const url = new URL(endpoint); url.searchParams.set('format', 'json'); url.searchParams.set('query', query);
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/sparql-results+json',
        'User-Agent': 'FatinahQuestionBank/1.3 (https://ata20.com)' }, signal: AbortSignal.timeout(90_000) });
      if (!response.ok) throw new Error(`Wikidata HTTP ${response.status}`);
      return await response.json();
    } catch (error) { lastError = error; if (attempt < 5) await new Promise(resolve => setTimeout(resolve, attempt * 1_000)); }
  }
  throw lastError;
}

const records = [];
for (const spec of specs) {
  const query = `SELECT DISTINCT ?item ?itemLabel ?answer ?answerLabel WHERE { ${spec.where}
    SERVICE wikibase:label { bd:serviceParam wikibase:language "ar".
      ?item rdfs:label ?itemLabel. ?answer rdfs:label ?answerLabel. }
    FILTER(LANG(?itemLabel)="ar" && LANG(?answerLabel)="ar") } LIMIT 240`;
  const payload = await fetchQuery(query);
  const batch = [];
  for (const binding of payload?.results?.bindings || []) {
    const itemId = String(binding.item?.value || '').split('/').pop();
    const answerId = String(binding.answer?.value || '').split('/').pop();
    const itemLabel = String(binding.itemLabel?.value || '').trim();
    const answerLabel = String(binding.answerLabel?.value || '').trim();
    if (!/^Q\d+$/.test(itemId) || !/^Q\d+$/.test(answerId) || !itemLabel || !answerLabel ||
        excludedQuestionContent.test(`${itemLabel} ${answerLabel}`)) continue;
    const canonical = { category: spec.category, relation: spec.relation, property: spec.property,
      itemId, itemLabel, answerId, answerLabel };
    batch.push({ sourceRecordId: `wikidata-${itemId}-${spec.property}-${answerId}`, ...canonical,
      sourceUrl: `https://www.wikidata.org/wiki/${itemId}`, sourcePublisher: 'Wikidata', retrievedAt,
      sourcePayloadHash: crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex') });
  }
  const unique = [...new Map(batch.map(record => [record.sourceRecordId, record])).values()];
  if (unique.length < spec.min) throw new Error(`${spec.category}: سجلات غير كافية (${unique.length}/${spec.min}).`);
  records.push(...unique);
}
const document = { schemaVersion: 1, sourceProfile: 'wikidata_entities_v1', endpoint, retrievedAt, records };
if (write) writeJsonAtomic(output, document);
console.log(JSON.stringify({ mode: write ? 'write' : 'dry-run', total: records.length,
  byCategory: Object.fromEntries(specs.map(spec => [spec.category, records.filter(r => r.category === spec.category).length])),
  output: write ? path.relative(process.cwd(), output) : null, aiCalls: 0, estimatedAiCostUsd: 0 }, null, 2));
