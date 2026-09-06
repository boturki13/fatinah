#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUTPUT = path.join(ROOT, 'content/questions/structured-sources/bipm-si-units.json');
const SOURCE_URL = 'https://www.bipm.org/documents/d/guest/si-brochure-9-en-pdf';
const SNAPSHOT_DATE = '2026-09-05';
const SOURCE_PUBLISHER = 'Bureau International des Poids et Mesures (BIPM)';

// table is also used to constrain the proof to the authoritative table in the
// brochure. rowLead is needed only where the printed row has a longer or
// wrapped quantity label than the gameplay label.
const UNITS = [
  { table: 'base', quantityEn: 'length', quantityAr: 'الطول', unitEn: 'metre', unitAr: 'المتر', symbol: 'm' },
  { table: 'base', quantityEn: 'mass', quantityAr: 'الكتلة', unitEn: 'kilogram', unitAr: 'الكيلوغرام', symbol: 'kg' },
  { table: 'base', quantityEn: 'time', quantityAr: 'الزمن', unitEn: 'second', unitAr: 'الثانية', symbol: 's' },
  { table: 'base', quantityEn: 'thermodynamic temperature', quantityAr: 'درجة الحرارة الديناميكية الحرارية', unitEn: 'kelvin', unitAr: 'الكلفن', symbol: 'K' },
  { table: 'base', quantityEn: 'electric current', quantityAr: 'شدة التيار الكهربائي', unitEn: 'ampere', unitAr: 'الأمبير', symbol: 'A' },
  { table: 'base', quantityEn: 'amount of substance', quantityAr: 'كمية المادة', unitEn: 'mole', unitAr: 'المول', symbol: 'mol' },
  { table: 'base', quantityEn: 'luminous intensity', quantityAr: 'شدة الإضاءة', unitEn: 'candela', unitAr: 'الكانديلا', symbol: 'cd' },
  { table: 'derived', quantityEn: 'frequency', quantityAr: 'التردد', unitEn: 'hertz', unitAr: 'الهرتز', symbol: 'Hz' },
  { table: 'derived', quantityEn: 'force', quantityAr: 'القوة', unitEn: 'newton', unitAr: 'النيوتن', symbol: 'N' },
  { table: 'derived', quantityEn: 'pressure', quantityAr: 'الضغط', unitEn: 'pascal', unitAr: 'الباسكال', symbol: 'Pa' },
  { table: 'derived', quantityEn: 'energy', quantityAr: 'الطاقة', unitEn: 'joule', unitAr: 'الجول', symbol: 'J' },
  { table: 'derived', quantityEn: 'power', quantityAr: 'القدرة', unitEn: 'watt', unitAr: 'الواط', symbol: 'W' },
  { table: 'derived', quantityEn: 'electric charge', quantityAr: 'الشحنة الكهربائية', unitEn: 'coulomb', unitAr: 'الكولوم', symbol: 'C' },
  { table: 'derived', quantityEn: 'electric potential difference', quantityAr: 'فرق الجهد الكهربائي', unitEn: 'volt', unitAr: 'الفولت', symbol: 'V' },
  { table: 'derived', quantityEn: 'electric resistance', quantityAr: 'المقاومة الكهربائية', unitEn: 'ohm', unitAr: 'الأوم', symbol: 'Ω' },
  { table: 'derived', quantityEn: 'Celsius temperature', quantityAr: 'درجة الحرارة المئوية', unitEn: 'degree Celsius', unitAr: 'الدرجة المئوية', symbol: '°C' },
  { table: 'derived', quantityEn: 'luminous flux', quantityAr: 'التدفق الضوئي', unitEn: 'lumen', unitAr: 'اللومن', symbol: 'lm' },
  { table: 'derived', quantityEn: 'illuminance', quantityAr: 'الاستضاءة', unitEn: 'lux', unitAr: 'اللوكس', symbol: 'lx' },
  { table: 'derived', quantityEn: 'activity referred to a radionuclide', rowLead: 'activity referred to', quantityAr: 'النشاط الإشعاعي', unitEn: 'becquerel', unitAr: 'البيكريل', symbol: 'Bq' },
  { table: 'derived', quantityEn: 'absorbed dose', quantityAr: 'الجرعة الممتصة', unitEn: 'gray', unitAr: 'الغراي', symbol: 'Gy' },
  { table: 'derived', quantityEn: 'dose equivalent', quantityAr: 'الجرعة المكافئة', unitEn: 'sievert', unitAr: 'السيفرت', symbol: 'Sv' },
  { table: 'derived', quantityEn: 'catalytic activity', quantityAr: 'النشاط التحفيزي', unitEn: 'katal', unitAr: 'الكاتال', symbol: 'kat' },
  { table: 'derived', quantityEn: 'capacitance', quantityAr: 'السعة الكهربائية', unitEn: 'farad', unitAr: 'الفاراد', symbol: 'F' },
  { table: 'derived', quantityEn: 'electric conductance', quantityAr: 'الموصلية الكهربائية', unitEn: 'siemens', unitAr: 'السيمنز', symbol: 'S' },
  { table: 'derived', quantityEn: 'magnetic flux', quantityAr: 'التدفق المغناطيسي', unitEn: 'weber', unitAr: 'الويبر', symbol: 'Wb' },
  { table: 'derived', quantityEn: 'magnetic flux density', quantityAr: 'كثافة التدفق المغناطيسي', unitEn: 'tesla', unitAr: 'التسلا', symbol: 'T' },
  { table: 'derived', quantityEn: 'inductance', quantityAr: 'المحاثة الكهربائية', unitEn: 'henry', unitAr: 'الهنري', symbol: 'H' },
  { table: 'derived', quantityEn: 'plane angle', quantityAr: 'الزاوية المستوية', unitEn: 'radian', unitAr: 'الراديان', symbol: 'rad' },
  { table: 'derived', quantityEn: 'solid angle', quantityAr: 'الزاوية المجسمة', unitEn: 'steradian', unitAr: 'الستيراديان', symbol: 'sr' },
];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function normalizeExtractedText(value) {
  return String(value).normalize('NFKC').replace(/\u00ad/gu, '').replace(/\s+/gu, ' ').trim();
}

function sectionBetween(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    throw new Error(`تعذر إثبات قسم BIPM: ${start} → ${end}`);
  }
  return text.slice(startIndex, endIndex);
}

function resolvePdfToText() {
  const candidates = [];
  if (process.env.FATINAH_PDFTOTEXT_BIN) candidates.push(process.env.FATINAH_PDFTOTEXT_BIN);
  candidates.push('pdftotext');
  const whichPdfInfo = spawnSync('which', ['pdfinfo'], { encoding: 'utf8' });
  if (whichPdfInfo.status === 0 && whichPdfInfo.stdout.trim()) {
    candidates.push(path.resolve(
      path.dirname(whichPdfInfo.stdout.trim()),
      '../../native/poppler/poppler/bin/pdftotext',
    ));
  }
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-v'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return candidate;
  }
  throw new Error('لم يُعثر على pdftotext؛ أوقفنا الاستيراد لأن إثات سجلات BIPM غير ممكن.');
}

function extractPdfText(sourceBytes) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fatinah-bipm-'));
  const pdfPath = path.join(temporaryDirectory, 'si-brochure.pdf');
  const textPath = path.join(temporaryDirectory, 'si-brochure.txt');
  try {
    fs.writeFileSync(pdfPath, sourceBytes);
    const result = spawnSync(resolvePdfToText(), ['-raw', pdfPath, textPath], {
      encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`pdftotext فشل: ${result.error?.message || result.stderr || `exit ${result.status}`}`);
    }
    const text = fs.readFileSync(textPath, 'utf8');
    if (text.length < 100_000) throw new Error(`نص BIPM المستخرج غير مكتمل (${text.length} محرفاً).`);
    return text;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function proveUnitRecords(extractedText) {
  const documentText = normalizeExtractedText(extractedText);
  const tables = {
    base: sectionBetween(documentText, 'Table 2. SI base units', 'Starting from the definition of the SI'),
    derived: sectionBetween(documentText, 'Table 4. The 22 SI units with special names and symbols', '(a) The order of symbols for base units'),
  };
  const proofKeys = new Set();
  for (const unit of UNITS) {
    const proofKey = `${unit.quantityEn}|${unit.unitEn}|${unit.symbol}`;
    if (proofKeys.has(proofKey)) throw new Error(`إثات BIPM مكرر: ${proofKey}`);
    proofKeys.add(proofKey);
    if (!documentText.includes(unit.quantityEn)) {
      throw new Error(`BIPM لا يحتوي اسم الكمية حرفياً: ${unit.quantityEn}`);
    }
    const rowLead = unit.rowLead || unit.quantityEn;
    const rowPattern = new RegExp(
      `${escapeRegExp(rowLead)}.{0,90}?${escapeRegExp(unit.unitEn)}(?:\\s*\\([^)]+\\))?\\s+${escapeRegExp(unit.symbol)}(?=\\s|$)`,
      'u',
    );
    if (!rowPattern.test(tables[unit.table])) {
      throw new Error(`لم يُثبت صف BIPM الرسمي: ${proofKey}`);
    }
  }
  if (UNITS.filter(unit => unit.table === 'base').length !== 7
    || UNITS.filter(unit => unit.table === 'derived').length !== 22) {
    throw new Error('يجب إثات 7 وحدات أساسية و22 وحدة ذات اسم خاص.');
  }
  return { normalizedText: documentText, tableHashes: {
    base: sha256(tables.base), derived: sha256(tables.derived),
  } };
}

async function fetchOfficialPdf() {
  const response = await fetch(SOURCE_URL, {
    headers: { 'user-agent': 'FatinahQuestionImporter/3.0 (BIPM provenance verification)' },
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`BIPM HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') || '';
  const sourceBytes = Buffer.from(await response.arrayBuffer());
  if (!/application\/pdf/iu.test(contentType)
    || sourceBytes.length < 1_000_000
    || sourceBytes.subarray(0, 5).toString() !== '%PDF-') {
    throw new Error('BIPM لم يُرجع نسخة PDF الكاملة المتوقعة.');
  }
  return sourceBytes;
}

function writeJsonAtomic(filePath, document) {
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`);
  fs.renameSync(temporaryPath, filePath);
}

async function main() {
  const write = process.argv.includes('--write');
  const sourceBytes = await fetchOfficialPdf();
  const sourcePayloadSha256 = sha256(sourceBytes);
  const extractedText = extractPdfText(sourceBytes);
  const proof = proveUnitRecords(extractedText);
  const sourceTextSha256 = sha256(proof.normalizedText);
  const sourceVersion = proof.normalizedText.match(/\bV\d+\.\d+\b/u)?.[0];
  const records = UNITS.map((unit, index) => {
    const payload = {
      sourceRecordId: `bipm-si-${unit.unitEn.toLowerCase().replace(/[^a-z]+/gu, '-')}`,
      quantityEn: unit.quantityEn,
      quantityAr: unit.quantityAr,
      unitEn: unit.unitEn,
      unitAr: unit.unitAr,
      symbol: unit.symbol,
      familiarityRank: index + 1,
      sourceTable: unit.table === 'base' ? 'SI Brochure Table 2' : 'SI Brochure Table 4',
      sourceUrl: SOURCE_URL,
      sourcePublisher: SOURCE_PUBLISHER,
      sourcePayloadHash: sourcePayloadSha256,
    };
    return { ...payload, recordPayloadSha256: sha256(canonical(payload)) };
  });
  const document = {
    schemaVersion: 2,
    sourceProfile: 'bipm_si_brochure_pdf_snapshot_v2',
    sourceTitle: 'The International System of Units (SI Brochure), 9th edition',
    sourceVersion,
    sourceUrl: SOURCE_URL,
    sourcePublisher: SOURCE_PUBLISHER,
    sourceLicense: 'Creative Commons Attribution 4.0 International',
    retrievedAt: SNAPSHOT_DATE,
    sourcePayloadSha256,
    sourceTextSha256,
    selectionPolicy: 'All seven SI base units and all 22 SI units with special names; every English quantity, unit name, and unit symbol is fail-closed against the official PDF tables before output.',
    validation: {
      profile: 'bipm_pdf_table_tuple_proof_v1',
      extractor: 'pdftotext -raw',
      verifiedRecordCount: records.length,
      verifiedBaseUnitCount: 7,
      verifiedDerivedSpecialNameCount: 22,
      tableTextSha256: proof.tableHashes,
    },
    records,
  };
  document.contentSha256 = sha256(canonical(document));
  if (write) {
    writeJsonAtomic(OUTPUT, document);
    console.log(`Wrote ${records.length} BIPM-proven SI records to ${path.relative(ROOT, OUTPUT)} (${sourceVersion || 'unknown version'})`);
  } else {
    console.log(`Verified ${records.length} BIPM SI records against the official PDF; use --write to replace the snapshot.`);
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
