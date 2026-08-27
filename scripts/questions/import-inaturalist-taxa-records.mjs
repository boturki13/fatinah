#!/usr/bin/env node
import crypto from 'node:crypto';
import path from 'node:path';
import { CONTENT_DIR, writeJsonAtomic } from './lib.mjs';

const write = process.argv.includes('--write');
const output = path.join(CONTENT_DIR, 'structured-sources', 'inaturalist-animal-taxa.json');
const retrievedAt = new Date().toISOString();
const apiBase = 'https://api.inaturalist.org/v1/taxa';
const iconicTaxonIds = new Map([
  ['Mammalia', 40151], ['Aves', 3], ['Reptilia', 26036], ['Amphibia', 20978],
  ['Actinopterygii', 47178], ['Insecta', 47158], ['Arachnida', 47119], ['Mollusca', 47115],
]);
const pagesPerGroup = 2;
const wikidataEndpoint = 'https://query.wikidata.org/sparql';
// استبعادات مراجعة لغوية يدوية لأسماء متطابقة تقنياً بين المصدرين لكنها ركيكة أو مضللة بالعربية.
const rejectedTaxonIds = new Set([3454, 6915, 6921, 6933, 10070]);

function listUrl(taxonId, page) {
  const params = new URLSearchParams({
    is_active: 'true', taxon_id: String(taxonId), rank: 'species', locale: 'ar',
    per_page: '200', page: String(page), order_by: 'observations_count', order: 'desc',
  });
  return `${apiBase}?${params}`;
}
const sourceRequests = [...iconicTaxonIds.values()].flatMap(taxonId =>
  Array.from({ length: pagesPerGroup }, (_, index) => listUrl(taxonId, index + 1)));

async function fetchJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'FatinahQuestionBank/1.3 (https://ata20.com)' },
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) throw new Error(`${new URL(url).hostname}: HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, attempt * 750));
    }
  }
  throw lastError;
}

function normalizeArabicName(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[^\u0600-\u06FFA-Za-z0-9]+/g, ' ').trim();
}

async function loadWikidataArabicLabels(taxonIds) {
  const matches = new Map();
  for (let offset = 0; offset < taxonIds.length; offset += 100) {
    const batch = taxonIds.slice(offset, offset + 100);
    const values = batch.map(id => `"${id}"`).join(' ');
    const query = `SELECT ?item ?taxonId ?label WHERE {
      VALUES ?taxonId { ${values} }
      ?item wdt:P3151 ?taxonId ; rdfs:label ?label .
      FILTER(LANG(?label) = "ar")
    }`;
    const url = `${wikidataEndpoint}?format=json&query=${encodeURIComponent(query)}`;
    const response = await fetchJson(url);
    for (const row of response?.results?.bindings || []) {
      const taxonId = Number(row.taxonId?.value);
      const label = String(row.label?.value || '').trim();
      const entityUrl = String(row.item?.value || '').trim();
      if (Number.isInteger(taxonId) && label && entityUrl && !matches.has(taxonId)) {
        matches.set(taxonId, { label, entityUrl });
      }
    }
  }
  return matches;
}

const responses = await Promise.all(sourceRequests.map(fetchJson));
const seenIds = new Set();
const seenArabicNames = new Set();
const provisionalRecords = [];
for (const response of responses) {
  for (const row of response?.results || []) {
    const canonical = {
      taxonId: Number(row.id),
      scientificName: String(row.name || '').trim(),
      commonNameAr: String(row.preferred_common_name || '').replace(/\s+/g, ' ').trim(),
      iconicTaxon: String(row.iconic_taxon_name || '').trim(),
      rank: String(row.rank || '').trim(),
      observationsCountAtRetrieval: Number(row.observations_count || 0),
    };
    const normalizedArabicName = normalizeArabicName(canonical.commonNameAr);
    if (!Number.isInteger(canonical.taxonId) || canonical.taxonId < 1 || rejectedTaxonIds.has(canonical.taxonId) ||
        seenIds.has(canonical.taxonId) ||
        canonical.rank !== 'species' || !/^[A-Z][A-Za-z.-]+\s[a-z][A-Za-z.-]+(?:\s[a-z][A-Za-z.-]+)?$/.test(canonical.scientificName) ||
        !/[\u0600-\u06FF]/.test(canonical.commonNameAr) || canonical.commonNameAr.length < 3 ||
        canonical.commonNameAr.length > 80 || canonical.commonNameAr === 'بركة' ||
        seenArabicNames.has(normalizedArabicName) || canonical.observationsCountAtRetrieval < 1_000) continue;
    seenIds.add(canonical.taxonId);
    seenArabicNames.add(normalizedArabicName);
    provisionalRecords.push({
      sourceRecordId: `inaturalist-taxon-${canonical.taxonId}`,
      ...canonical,
      sourceUrl: `${apiBase}/${canonical.taxonId}?locale=ar`,
      sourcePublisher: 'iNaturalist',
      retrievedAt,
      sourcePayloadHash: crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
    });
  }
}
const wikidataLabels = await loadWikidataArabicLabels(provisionalRecords.map(record => record.taxonId));
const records = provisionalRecords.flatMap(record => {
  const crossCheck = wikidataLabels.get(record.taxonId);
  if (!crossCheck || normalizeArabicName(crossCheck.label) !== normalizeArabicName(record.commonNameAr)) return [];
  return [{
    ...record,
    translationCrossCheck: {
      publisher: 'Wikidata',
      labelAr: crossCheck.label,
      entityUrl: crossCheck.entityUrl,
      taxonProperty: 'P3151',
    },
  }];
});
records.sort((a, b) => b.observationsCountAtRetrieval - a.observationsCountAtRetrieval ||
  a.commonNameAr.localeCompare(b.commonNameAr, 'ar'));
if (records.length < 120) throw new Error(`عدد سجلات الحيوانات العربية المتطابقة بين المصدرين منخفض: ${records.length}.`);

const document = {
  schemaVersion: 1,
  sourceProfile: 'official_dataset_v1',
  sourceDataset: sourceRequests,
  sourceDocumentation: 'https://api.inaturalist.org/v1/docs/',
  translationCrossCheck: 'Wikidata Arabic label matched by iNaturalist taxon ID (P3151)',
  locale: 'ar',
  imageDataUsed: false,
  retrievedAt,
  records,
};
if (write) writeJsonAtomic(output, document);
console.log(JSON.stringify({
  mode: write ? 'write' : 'dry-run', records: records.length,
  output: write ? path.relative(process.cwd(), output) : null,
  aiCalls: 0, estimatedAiCostUsd: 0,
}, null, 2));
