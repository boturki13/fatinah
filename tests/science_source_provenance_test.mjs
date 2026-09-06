import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = relativePath => JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const verifyEnvelopeHash = document => {
  const { contentSha256, ...payload } = document;
  assert.match(contentSha256, /^[a-f0-9]{64}$/u);
  assert.equal(contentSha256, sha256(canonical(payload)));
};
const verifyRecordHash = record => {
  const { recordPayloadSha256, ...payload } = record;
  assert.match(recordPayloadSha256, /^[a-f0-9]{64}$/u);
  assert.equal(recordPayloadSha256, sha256(canonical(payload)));
};

const bipm = readJson('content/questions/structured-sources/bipm-si-units.json');
assert.equal(bipm.schemaVersion, 2);
assert.equal(bipm.sourceProfile, 'bipm_si_brochure_pdf_snapshot_v2');
assert.equal(bipm.sourceUrl, 'https://www.bipm.org/documents/d/guest/si-brochure-9-en-pdf');
assert.match(bipm.sourcePayloadSha256, /^[a-f0-9]{64}$/u);
assert.match(bipm.sourceTextSha256, /^[a-f0-9]{64}$/u);
assert.equal(bipm.validation.profile, 'bipm_pdf_table_tuple_proof_v1');
assert.equal(bipm.validation.verifiedRecordCount, 29);
assert.equal(bipm.validation.verifiedBaseUnitCount, 7);
assert.equal(bipm.validation.verifiedDerivedSpecialNameCount, 22);
assert.equal(bipm.records.length, 29);
assert.deepEqual(bipm.records.map(record => record.familiarityRank), Array.from({ length: 29 }, (_, index) => index + 1));
assert.equal(new Set(bipm.records.map(record => record.sourceRecordId)).size, 29);
assert.equal(new Set(bipm.records.map(record => record.unitEn)).size, 29);
assert.equal(new Set(bipm.records.map(record => record.symbol)).size, 29);
assert.equal(bipm.records.filter(record => record.sourceTable === 'SI Brochure Table 2').length, 7);
assert.equal(bipm.records.filter(record => record.sourceTable === 'SI Brochure Table 4').length, 22);
for (const record of bipm.records) {
  assert.ok(record.quantityEn && record.quantityAr && record.unitEn && record.unitAr && record.symbol);
  assert.equal(record.sourceUrl, bipm.sourceUrl);
  assert.equal(record.sourcePayloadHash, bipm.sourcePayloadSha256);
  verifyRecordHash(record);
}
verifyEnvelopeHash(bipm);

const elements = readJson('content/questions/structured-sources/chemical-elements.json');
assert.equal(elements.schemaVersion, 2);
assert.equal(elements.sourceProfile, 'wikidata_iupac_chemical_elements_snapshot_v1');
assert.equal(elements.validation.profile, 'wikidata_iupac_exact_118_tuple_proof_v1');
assert.equal(elements.validation.expectedRecordCount, 118);
assert.equal(elements.validation.verifiedRecordCount, 118);
assert.equal(elements.validation.verifiedIupacTupleCount, 118);
assert.equal(elements.records.length, 118);
assert.match(elements.sources.wikidata.sourcePayloadSha256, /^[a-f0-9]{64}$/u);
assert.match(elements.sources.iupac.sourcePayloadSha256, /^[a-f0-9]{64}$/u);
assert.match(elements.sources.iupac.sourceTextSha256, /^[a-f0-9]{64}$/u);
assert.ok(elements.sources.wikidata.url.startsWith('https://query.wikidata.org/'));
assert.ok(elements.sources.iupac.url.startsWith('https://iupac.org/'));
assert.deepEqual(elements.records.map(record => Number(record.atomicNumber)), Array.from({ length: 118 }, (_, index) => index + 1));
for (const field of ['sourceRecordId', 'item', 'itemLabel', 'itemLabelEn', 'symbol']) {
  assert.equal(new Set(elements.records.map(record => record[field])).size, 118, `${field} must be unique`);
}
for (const record of elements.records) {
  assert.match(record.sourceRecordId, /^iupac-element-(?:[1-9]|[1-9]\d|1[01]\d|118)$/u);
  assert.match(record.item, /^http:\/\/www\.wikidata\.org\/entity\/Q\d+$/u);
  assert.match(record.sourceUrl, /^https:\/\/www\.wikidata\.org\/wiki\/Q\d+$/u);
  assert.match(record.itemLabel, /\p{Script=Arabic}/u);
  assert.match(record.itemLabelEn, /^[a-z]+$/u);
  assert.match(record.symbol, /^[A-Z][a-z]?$/u);
  assert.equal(record.iupacSourceUrl, elements.sources.iupac.url);
  const atomicNumber = Number(record.atomicNumber);
  const sourceFacts = {
    wikidata: {
      item: record.item,
      itemLabel: record.itemLabel,
      itemLabelEn: record.itemLabelEn,
      symbol: record.symbol,
      atomicNumber,
    },
    iupac: { atomicNumber, symbol: record.symbol, nameEn: record.itemLabelEn },
  };
  assert.equal(record.sourcePayloadHash, sha256(canonical(sourceFacts)));
  verifyRecordHash(record);
}
assert.deepEqual(
  elements.records.filter(record => ['1', '118'].includes(record.atomicNumber))
    .map(record => [record.atomicNumber, record.symbol, record.itemLabelEn]),
  [['1', 'H', 'hydrogen'], ['118', 'Og', 'oganesson']],
);
verifyEnvelopeHash(elements);

const currencies = readJson('content/questions/structured-sources/currency-names-ar.json');
const cldrMajor = currencies.cldrVersion.split('.')[0];
assert.equal(currencies.records.length, 90);
for (const record of currencies.records) {
  assert.equal(record.sourceUrl,
    `https://www.unicode.org/cldr/charts/${cldrMajor}/summary/ar.html`);
  assert.ok(!record.sourceUrl.includes('currencies.names.html'),
    'رابط CLDR القديم الذي يرجع 404 ممنوع من العودة.');
}

console.log('science source provenance: BIPM 29/29, Wikidata/IUPAC 118/118, and CLDR currencies 90/90 verified');
