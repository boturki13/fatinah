#!/usr/bin/env node
import crypto from 'node:crypto';
import path from 'node:path';
import { CONTENT_DIR, writeJsonAtomic } from './lib.mjs';

const write = process.argv.includes('--write');
const output = path.join(CONTENT_DIR, 'structured-sources', 'world-bank-countries.json');
const retrievedAt = new Date().toISOString();
const worldBankUrl = 'https://api.worldbank.org/v2/country?format=json&per_page=400';
const wikidataQuery = `
SELECT ?country ?iso2 ?countryLabel ?capitalLabel WHERE {
  ?country wdt:P463 wd:Q1065 ;
           wdt:P297 ?iso2 .
  OPTIONAL { ?country wdt:P36 ?capital . }
  FILTER(STRLEN(?iso2) = 2)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "ar,en". }
}`;

async function fetchJson(url, headers = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'FatinahQuestionBank/1.3 (https://ata20.com)', ...headers },
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

const [worldBank, wikidata] = await Promise.all([
  fetchJson(worldBankUrl),
  fetchJson(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(wikidataQuery)}`, {
    Accept: 'application/sparql-results+json',
  }),
]);

const arabicByIso = new Map();
for (const row of wikidata?.results?.bindings || []) {
  const iso2 = String(row.iso2?.value || '').toUpperCase();
  const countryAr = String(row.countryLabel?.['xml:lang'] === 'ar' ? row.countryLabel.value : '').trim();
  const capitalAr = String(row.capitalLabel?.['xml:lang'] === 'ar' ? row.capitalLabel.value : '').trim();
  if (/^[A-Z]{2}$/.test(iso2) && countryAr && capitalAr && !arabicByIso.has(iso2)) {
    arabicByIso.set(iso2, {
      countryAr,
      capitalAr,
      wikidataEntity: row.country?.value || null,
    });
  }
}

const rows = Array.isArray(worldBank?.[1]) ? worldBank[1] : [];
const records = [];
for (const country of rows) {
  const iso2 = String(country.iso2Code || '').toUpperCase();
  const arabic = arabicByIso.get(iso2);
  if (!/^[A-Z]{2}$/.test(iso2) || !country.region?.id || !country.capitalCity || !arabic) continue;
  const canonical = {
    iso2,
    iso3: String(country.id || ''),
    countryAr: arabic.countryAr,
    countryEn: String(country.name || ''),
    capitalAr: arabic.capitalAr,
    capitalEn: String(country.capitalCity || ''),
    regionEn: String(country.region.value || ''),
    longitude: String(country.longitude || ''),
    latitude: String(country.latitude || ''),
  };
  records.push({
    sourceRecordId: `worldbank-country-${iso2.toLowerCase()}`,
    ...canonical,
    sourceUrl: `https://api.worldbank.org/v2/country/${encodeURIComponent(iso2)}?format=json`,
    sourcePublisher: 'World Bank',
    translationIndexUrl: arabic.wikidataEntity,
    retrievedAt,
    sourcePayloadHash: crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
  });
}
records.sort((a, b) => a.iso2.localeCompare(b.iso2, 'en'));
if (records.length < 150) throw new Error(`عدد الدول الصالحة منخفض: ${records.length}.`);
if (new Set(records.map(record => record.iso2)).size !== records.length) throw new Error('تكرار ISO2 في سجل الدول.');

const document = {
  schemaVersion: 1,
  sourceProfile: 'official_dataset_v1',
  sourceDataset: worldBankUrl,
  translationIndex: 'Wikidata SPARQL Arabic labels (index only)',
  retrievedAt,
  records,
};
if (write) writeJsonAtomic(output, document);
console.log(JSON.stringify({
  mode: write ? 'write' : 'dry-run',
  records: records.length,
  withArabicCountryAndCapital: records.length,
  output: write ? path.relative(process.cwd(), output) : null,
  aiCalls: 0,
  estimatedAiCostUsd: 0,
}, null, 2));
