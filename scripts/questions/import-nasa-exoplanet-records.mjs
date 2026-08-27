#!/usr/bin/env node
import crypto from 'node:crypto';
import path from 'node:path';
import { CONTENT_DIR, writeJsonAtomic } from './lib.mjs';

const write = process.argv.includes('--write');
const output = path.join(CONTENT_DIR, 'structured-sources', 'nasa-exoplanets.json');
const retrievedAt = new Date().toISOString();
const tapBaseUrl = 'https://exoplanetarchive.ipac.caltech.edu/TAP/sync';
const query = [
  'select pl_name,hostname,disc_year,discoverymethod,disc_facility',
  'from pscomppars',
  'where disc_year is not null',
  'and discoverymethod is not null',
  'and disc_facility is not null',
].join(' ');
const sourceDataset = `${tapBaseUrl}?query=${encodeURIComponent(query)}&format=json`;

async function fetchJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'FatinahQuestionBank/1.3 (https://ata20.com)',
        },
        signal: AbortSignal.timeout(60_000),
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

function slug(value) {
  const compact = String(value || '').normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72);
  return compact || crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 20);
}

const rows = await fetchJson(sourceDataset);
if (!Array.isArray(rows)) throw new Error('استجابة NASA Exoplanet Archive ليست مصفوفة JSON.');

const seenPlanetNames = new Set();
const records = [];
for (const row of rows) {
  const canonical = {
    planetName: String(row.pl_name || '').trim(),
    hostName: String(row.hostname || '').trim(),
    discoveryYear: Number(row.disc_year),
    discoveryMethod: String(row.discoverymethod || '').trim(),
    discoveryFacility: String(row.disc_facility || '').trim(),
  };
  if (!canonical.planetName || !canonical.hostName || !Number.isInteger(canonical.discoveryYear) ||
      canonical.discoveryYear < 1980 || canonical.discoveryYear > new Date().getUTCFullYear() ||
      !canonical.discoveryMethod || !canonical.discoveryFacility || seenPlanetNames.has(canonical.planetName)) continue;
  seenPlanetNames.add(canonical.planetName);
  const rowQuery = `select pl_name,hostname,disc_year,discoverymethod,disc_facility from pscomppars where pl_name='${canonical.planetName.replaceAll("'", "''")}'`;
  records.push({
    sourceRecordId: `nasa-exoplanet-${slug(canonical.planetName)}`,
    ...canonical,
    sourceUrl: `${tapBaseUrl}?query=${encodeURIComponent(rowQuery)}&format=json`,
    sourcePublisher: 'NASA Exoplanet Archive',
    retrievedAt,
    sourcePayloadHash: crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
  });
}
records.sort((a, b) => a.discoveryYear - b.discoveryYear || a.planetName.localeCompare(b.planetName, 'en'));
if (records.length < 500) throw new Error(`عدد سجلات الكواكب الصالحة منخفض: ${records.length}.`);
if (new Set(records.map(record => record.sourceRecordId)).size !== records.length) {
  throw new Error('تكرار sourceRecordId في سجل الكواكب.');
}

const document = {
  schemaVersion: 1,
  sourceProfile: 'official_dataset_v1',
  sourceDataset,
  sourceDocumentation: 'https://exoplanetarchive.ipac.caltech.edu/docs/TAP/usingTAP.html',
  sourceTable: 'pscomppars',
  retrievedAt,
  records,
};
if (write) writeJsonAtomic(output, document);
console.log(JSON.stringify({
  mode: write ? 'write' : 'dry-run',
  records: records.length,
  output: write ? path.relative(process.cwd(), output) : null,
  aiCalls: 0,
  estimatedAiCostUsd: 0,
}, null, 2));
