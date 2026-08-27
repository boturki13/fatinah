#!/usr/bin/env node
import crypto from 'node:crypto';
import path from 'node:path';
import { CONTENT_DIR, writeJsonAtomic } from './lib.mjs';

const write = process.argv.includes('--write');
const output = path.join(CONTENT_DIR, 'structured-sources', 'unesco-archaeological-sites.json');
const retrievedAt = new Date().toISOString();
const wikidataEndpoint = 'https://query.wikidata.org/sparql';
const curatedAncientQids = [
  'Q43473','Q39671','Q5788','Q5859','Q5747','Q42798','Q5725','Q129072','Q131013','Q134140',
  'Q5699','Q5715','Q173532','Q200200','Q29317','Q172613','Q168518','Q214944','Q2620036','Q5780',
  'Q522862','Q181427','Q61750','Q192522','Q190048','Q191504','Q230025','Q4523','Q27356','Q277540',
  'Q208379','Q32378','Q219279',
  'Q178835','Q484458','Q156093','Q44112','Q189616','Q47721','Q181007','Q638445','Q43286','Q9278',
  'Q188694','Q459629','Q329967','Q214827','Q217379','Q308807','Q457362','Q223385','Q208177','Q272777',
  'Q272771','Q696193','Q1025825','Q816437','Q385086','Q318422','Q854672','Q505617','Q499019','Q117623',
  'Q27985','Q538061','Q651278','Q732554','Q943327',
  'Q846967','Q214007','Q115253','Q237128','Q331603',
];
const rejectedQids = new Set(['Q464899', 'Q651278', 'Q931434', 'Q683110']);
const query = `
SELECT DISTINCT ?site ?siteLabel ?country ?countryLabel ?whId ?sitelinks ?inscriptionDate ?inception ?culture ?qualification WHERE {
  ?site wdt:P757 ?whId ;
        wdt:P17 ?country ;
        wdt:P31/wdt:P279* wd:Q839954 ;
        rdfs:label ?siteLabel ;
        wikibase:sitelinks ?sitelinks .
  BIND(REPLACE(STR(?whId), "-.*$", "") AS ?whPropertyId)
  ?heritageProperty wdt:P757 ?whPropertyId ;
                    p:P1435 ?heritageDesignationStatement .
  ?heritageDesignationStatement ps:P1435 wd:Q9259 ;
                                pq:P580 ?inscriptionDate .
  ?country wdt:P463 wd:Q1065 ;
           rdfs:label ?countryLabel .
  FILTER(LANG(?siteLabel) = "ar")
  FILTER(LANG(?countryLabel) = "ar")
  {
    ?site wdt:P571 ?inception .
    FILTER(?inception < "+1000-01-01T00:00:00Z"^^xsd:dateTime)
    BIND("dated_before_1000" AS ?qualification)
  } UNION {
    ?site wdt:P2596 ?culture .
    BIND("explicit_culture" AS ?qualification)
  } UNION {
    VALUES ?site { ${curatedAncientQids.map(qid => `wd:${qid}`).join(' ')} }
    BIND("curated_ancient_site" AS ?qualification)
  }
}`;
const sourceDataset = `${wikidataEndpoint}?format=json&query=${encodeURIComponent(query)}`;

async function fetchJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/sparql-results+json',
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

function normalizeArabic(value) {
  return String(value || '').normalize('NFKC').replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[^\u0600-\u06FFA-Za-z0-9]+/g, ' ').trim().toLowerCase();
}

const response = await fetchJson(sourceDataset);
const grouped = new Map();
for (const row of response?.results?.bindings || []) {
  const entityUrl = String(row.site?.value || '').trim();
  const qid = entityUrl.match(/\/entity\/(Q\d+)$/)?.[1];
  const siteNameAr = String(row.siteLabel?.value || '').replace(/\s+/g, ' ').trim();
  const countryNameAr = String(row.countryLabel?.value || '').replace(/\s+/g, ' ').trim();
  const countryUrl = String(row.country?.value || '').trim();
  const whComponentId = String(row.whId?.value || '').trim();
  const whPropertyId = whComponentId.split('-')[0];
  const sitelinks = Number(row.sitelinks?.value || 0);
  const qualification = String(row.qualification?.value || '').trim();
  const inscriptionDate = String(row.inscriptionDate?.value || '').trim();
  const inscriptionYear = Number(inscriptionDate.match(/^\+?(\d{4})-/)?.[1] || 0);
  const inception = String(row.inception?.value || '').trim();
  const cultureEntityUrl = String(row.culture?.value || '').trim();
  if (!qid || rejectedQids.has(qid) || countryNameAr === 'إسرائيل' ||
      !/[\u0600-\u06FF]/.test(siteNameAr) || !/[\u0600-\u06FF]/.test(countryNameAr) ||
      !/^[0-9]+(?:bis|ter)?$/i.test(whPropertyId) || !Number.isInteger(sitelinks) ||
      !Number.isInteger(inscriptionYear) || inscriptionYear < 1978 || inscriptionYear > new Date().getUTCFullYear()) continue;
  if (!grouped.has(qid)) grouped.set(qid, {
    qid, entityUrl, siteNameAr, whComponentId, whPropertyId, sitelinks,
    countries: new Map(),
    qualifications: new Set(), inscriptionYears: new Set(), inceptions: new Set(), cultureEntityUrls: new Set(),
  });
  const groupedItem = grouped.get(qid);
  groupedItem.countries.set(countryUrl, countryNameAr);
  if (qualification) groupedItem.qualifications.add(qualification);
  groupedItem.inscriptionYears.add(inscriptionYear);
  if (inception) groupedItem.inceptions.add(inception);
  if (cultureEntityUrl) groupedItem.cultureEntityUrls.add(cultureEntityUrl);
}

const seenNames = new Set();
const records = [];
for (const item of grouped.values()) {
  if (item.countries.size !== 1 || item.inscriptionYears.size !== 1) continue;
  const [countryEntityUrl, countryNameAr] = [...item.countries.entries()][0];
  const inscriptionYear = [...item.inscriptionYears][0];
  const normalizedName = normalizeArabic(item.siteNameAr);
  if (!normalizedName || seenNames.has(normalizedName) || normalizedName.includes(normalizeArabic(countryNameAr))) continue;
  seenNames.add(normalizedName);
  const canonical = {
    siteQid: item.qid,
    siteNameAr: item.siteNameAr,
    countryNameAr,
    countryEntityUrl,
    whComponentId: item.whComponentId,
    whPropertyId: item.whPropertyId,
    sitelinks: item.sitelinks,
    inscriptionYear,
    qualifications: [...item.qualifications].sort(),
    inceptions: [...item.inceptions].sort(),
    cultureEntityUrls: [...item.cultureEntityUrls].sort(),
  };
  records.push({
    sourceRecordId: `unesco-archaeological-site-${item.qid.toLowerCase()}`,
    ...canonical,
    sourceUrl: `https://whc.unesco.org/en/list/${encodeURIComponent(item.whPropertyId)}`,
    sourcePublisher: 'UNESCO World Heritage Centre',
    translationIndexUrl: item.entityUrl,
    retrievedAt,
    sourcePayloadHash: crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
  });
}
records.sort((a, b) => b.sitelinks - a.sitelinks || a.siteNameAr.localeCompare(b.siteNameAr, 'ar'));
if (records.length < 119) throw new Error(`عدد مواقع اليونسكو القديمة الصالحة منخفض: ${records.length}.`);

const document = {
  schemaVersion: 1,
  sourceProfile: 'wikidata_entities_v1',
  sourceDataset,
  finalFactSource: 'Wikidata heritage designation start-time statement, with the UNESCO property page retained as the primary reference link',
  selectionRule: 'Archaeological site with Arabic label, one current UN-member country, UNESCO ID and inscription year, and an ancient-date/culture/curated qualification',
  retrievedAt,
  records,
};
if (write) writeJsonAtomic(output, document);
console.log(JSON.stringify({
  mode: write ? 'write' : 'dry-run', records: records.length,
  output: write ? path.relative(process.cwd(), output) : null,
  aiCalls: 0, estimatedAiCostUsd: 0,
}, null, 2));
