#!/usr/bin/env node
import crypto from 'node:crypto';
import path from 'node:path';
import { CONTENT_DIR, familyContentViolations, loadPolicy, writeJsonAtomic } from './lib.mjs';

const write = process.argv.includes('--write');
const output = path.join(CONTENT_DIR, 'structured-sources', 'nci-human-organs.json');
const retrievedAt = new Date().toISOString();
const nciBase = 'https://api-evsrest.nci.nih.gov/api/v1/concept/ncit';
const organRootCode = 'C13018';
const bodyPartRootCode = 'C32221';
const sourceDataset = `${nciBase}/${organRootCode}/descendants`;
const bodyPartDataset = `${nciBase}/${bodyPartRootCode}/descendants`;
const wikidataEndpoint = 'https://query.wikidata.org/sparql';
// هذي مفاهيم تشريحية رئيسية في NCI، لكنها مصنفة تحت فروع أدق من فرع Organ
// ولذلك نضمها بأكوادها الرسمية بدلاً من تخمين الاسم أو إسقاط أسئلة وظائف مهمة.
const supplementalConceptCodes = [
  'C12386', // Small Intestine
  'C12379', // Large Intestine
  'C12382', // Colon
  'C12390', // Rectum
  'C12380', // Appendix
  'C12420', // Larynx
  'C12425', // Pharynx
];
const requiredFunctionNames = [
  'Heart','Brain','Lung','Liver','Kidney','Stomach','Pancreas','Spleen','Skin','Bladder',
  'Gallbladder','Esophagus','Trachea','Spinal Cord','Bone Marrow','Thymus Gland','Tonsil','Ureter','Urethra',
  'Small Intestine','Large Intestine','Colon','Rectum','Appendix','Thyroid Gland','Adrenal Gland','Pituitary Gland',
  'Parathyroid Gland','Lymph Node','Eye','Ear','Nose','Tongue','Larynx','Pharynx','Prostate Gland','Uterus',
  'Ovary','Testis','Fallopian Tube',
];
const policy = loadPolicy();

async function fetchJson(url, headers = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'FatinahQuestionBank/1.3 (https://ata20.com)', ...headers },
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

async function loadArabicLabels(codes) {
  const matches = new Map();
  for (let offset = 0; offset < codes.length; offset += 75) {
    const batch = codes.slice(offset, offset + 75);
    const values = batch.map(code => `"${code}"`).join(' ');
    const query = `SELECT ?item ?label ?ncit ?sitelinks WHERE {
      VALUES ?ncit { ${values} }
      ?item wdt:P1748 ?ncit ; rdfs:label ?label ; wikibase:sitelinks ?sitelinks .
      FILTER(LANG(?label) = "ar")
    }`;
    const url = `${wikidataEndpoint}?format=json&query=${encodeURIComponent(query)}`;
    const response = await fetchJson(url, { Accept: 'application/sparql-results+json' });
    for (const row of response?.results?.bindings || []) {
      const code = String(row.ncit?.value || '').trim();
      const labelAr = String(row.label?.value || '').replace(/\s+/g, ' ').trim();
      const entityUrl = String(row.item?.value || '').trim();
      const sitelinks = Number(row.sitelinks?.value || 0);
      if (/^C\d+$/.test(code) && /[\u0600-\u06FF]/.test(labelAr) && entityUrl &&
          Number.isInteger(sitelinks) && !matches.has(code)) {
        matches.set(code, { labelAr, entityUrl, sitelinks });
      }
    }
  }
  return matches;
}

async function loadDetails(codes) {
  const details = new Map();
  for (let offset = 0; offset < codes.length; offset += 8) {
    const batch = codes.slice(offset, offset + 8);
    const responses = await Promise.all(batch.map(code => fetchJson(`${nciBase}/${code}`)));
    for (const response of responses) details.set(response.code, response);
  }
  return details;
}

const [descendants, bodyPartDescendants] = await Promise.all([
  fetchJson(sourceDataset),
  fetchJson(bodyPartDataset),
]);
if (!Array.isArray(descendants) || descendants.length < 300) throw new Error('فرع أعضاء NCI غير صالح أو ناقص.');
if (!Array.isArray(bodyPartDescendants) || bodyPartDescendants.length < 4_000) {
  throw new Error('فرع أجزاء الجسم في NCI غير صالح أو ناقص.');
}
const supplementalConcepts = await loadDetails(supplementalConceptCodes);
// المستويات الثلاثة الأولى تعطي أجزاء تشريحية عامة ومناسبة للعبة، وتستبعد
// التفاصيل المجهرية شديدة التخصص الموجودة في المستويات الأعمق.
const sourceConcepts = [
  ...descendants,
  ...bodyPartDescendants.filter(row => Number(row.level) <= 3),
].filter((row, index, all) => all.findIndex(item => item.code === row.code) === index);
for (const code of supplementalConceptCodes) {
  const concept = supplementalConcepts.get(code);
  if (!concept?.name) throw new Error(`مفهوم NCI المكمل مفقود: ${code}`);
  if (!sourceConcepts.some(row => row.code === code)) {
    sourceConcepts.push({ code, name: concept.name, level: 1 });
  }
}
const filtered = sourceConcepts.filter(row => /^C\d+$/.test(String(row.code || '')) &&
  String(row.name || '').trim() && !/\b(?:Mouse|Rat|Fetal|Embryonic|Neoplasm|Tumor)\b/i.test(row.name));
const arabicByCode = await loadArabicLabels(filtered.map(row => row.code));

const provisional = filtered.flatMap(row => {
  const arabic = arabicByCode.get(row.code);
  if (!arabic) return [];
  return [{
    code: row.code,
    officialNameEn: String(row.name).trim(),
    hierarchyLevel: Number(row.level),
    nameAr: arabic.labelAr,
    translationIndexUrl: arabic.entityUrl,
    sitelinks: arabic.sitelinks,
  }];
});
const required = provisional.filter(record => requiredFunctionNames.includes(record.officialNameEn));
const missingRequired = requiredFunctionNames.filter(name => !required.some(record => record.officialNameEn === name));
if (missingRequired.length) throw new Error(`مصطلحات الوظائف غير مرتبطة عربياً: ${missingRequired.join(', ')}`);
const details = await loadDetails(required.map(record => record.code));

const seenArabic = new Set();
const records = [];
for (const record of provisional) {
  const normalizedArabic = record.nameAr.normalize('NFKC').replace(/[\u064B-\u065F\u0670]/g, '').trim();
  if (!normalizedArabic || seenArabic.has(normalizedArabic)) continue;
  seenArabic.add(normalizedArabic);
  const detail = details.get(record.code);
  const definition = String(detail?.definitions?.find(item => item.type === 'DEFINITION' && item.source === 'NCI')?.definition ||
    detail?.definitions?.find(item => item.definition)?.definition || '').trim();
  const canonical = {
    code: record.code,
    officialNameEn: record.officialNameEn,
    nameAr: record.nameAr,
    hierarchyLevel: record.hierarchyLevel,
    sitelinks: record.sitelinks,
    definition: requiredFunctionNames.includes(record.officialNameEn) ? definition : '',
  };
  const sourceRecord = {
    sourceRecordId: `nci-human-organ-${record.code.toLowerCase()}`,
    ...canonical,
    sourceUrl: `${nciBase}/${record.code}`,
    sourcePublisher: 'National Cancer Institute — NCI Thesaurus',
    translationIndexUrl: record.translationIndexUrl,
    retrievedAt,
    sourcePayloadHash: crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
  };
  if (familyContentViolations({ category: 'جسم الإنسان', ...sourceRecord }, policy).length) continue;
  records.push(sourceRecord);
}
records.sort((a, b) => b.sitelinks - a.sitelinks || a.hierarchyLevel - b.hierarchyLevel ||
  a.nameAr.localeCompare(b.nameAr, 'ar'));
if (records.length < 150) throw new Error(`عدد سجلات أعضاء الجسم العربية الصالحة منخفض: ${records.length}.`);
if (required.some(record => !records.find(item => item.code === record.code)?.definition)) {
  throw new Error('تعريف NCI مفقود لواحد أو أكثر من أسئلة الوظائف.');
}

const document = {
  schemaVersion: 1,
  sourceProfile: 'wikidata_entities_v1',
  sourceDataset,
  sourceRootCode: organRootCode,
  sourceDatasets: [sourceDataset, bodyPartDataset],
  sourceRootCodes: [organRootCode, bodyPartRootCode],
  supplementalConceptCodes,
  finalFactSource: 'NCI Thesaurus concept record',
  translationIndex: 'Wikidata Arabic label matched by NCI Thesaurus ID (P1748)',
  requiredFunctionNames,
  retrievedAt,
  records,
};
if (write) writeJsonAtomic(output, document);
console.log(JSON.stringify({
  mode: write ? 'write' : 'dry-run', records: records.length,
  functionRecords: requiredFunctionNames.length,
  output: write ? path.relative(process.cwd(), output) : null,
  aiCalls: 0, estimatedAiCostUsd: 0,
}, null, 2));
