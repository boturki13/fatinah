#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUTPUT = path.join(ROOT, 'content/questions/structured-sources/chemical-elements.json');
const SNAPSHOT_DATE = '2026-09-05';
const WIKIDATA_ENDPOINT = 'https://query.wikidata.org/sparql';
const IUPAC_PAGE_URL = 'https://iupac.org/what-we-do/periodic-table-of-elements/';
const IUPAC_PDF_URL = 'https://iupac.org/wp-content/uploads/2022/07/IUPAC_Periodic_Table-04May22_CRA.pdf';
const IUPAC_RELEASE_DATE = '2022-05-04';
const USER_AGENT = 'FatinahQuestionImporter/3.0 (chemical-elements provenance verification)';

const WIKIDATA_QUERY = `
SELECT ?item ?itemLabelAr ?itemLabelEn ?atomicNumber ?symbol WHERE {
  ?item wdt:P31 wd:Q11344;
        wdt:P1086 ?atomicNumber;
        wdt:P246 ?symbol.
  FILTER(?atomicNumber >= 1 && ?atomicNumber <= 118)
  OPTIONAL { ?item rdfs:label ?itemLabelAr. FILTER(LANG(?itemLabelAr) = "ar") }
  OPTIONAL { ?item rdfs:label ?itemLabelEn. FILTER(LANG(?itemLabelEn) = "en") }
}
ORDER BY ?atomicNumber
`.trim();

// Exact element names and symbols printed by the pinned official IUPAC table.
// Keeping the expected 118-tuple contract in code makes a source drift, a
// missing row, or a Wikidata disagreement stop the importer instead of silently
// publishing a partial or speculative periodic table.
const IUPAC_ELEMENTS = `
1|H|hydrogen
2|He|helium
3|Li|lithium
4|Be|beryllium
5|B|boron
6|C|carbon
7|N|nitrogen
8|O|oxygen
9|F|fluorine
10|Ne|neon
11|Na|sodium
12|Mg|magnesium
13|Al|aluminium
14|Si|silicon
15|P|phosphorus
16|S|sulfur
17|Cl|chlorine
18|Ar|argon
19|K|potassium
20|Ca|calcium
21|Sc|scandium
22|Ti|titanium
23|V|vanadium
24|Cr|chromium
25|Mn|manganese
26|Fe|iron
27|Co|cobalt
28|Ni|nickel
29|Cu|copper
30|Zn|zinc
31|Ga|gallium
32|Ge|germanium
33|As|arsenic
34|Se|selenium
35|Br|bromine
36|Kr|krypton
37|Rb|rubidium
38|Sr|strontium
39|Y|yttrium
40|Zr|zirconium
41|Nb|niobium
42|Mo|molybdenum
43|Tc|technetium
44|Ru|ruthenium
45|Rh|rhodium
46|Pd|palladium
47|Ag|silver
48|Cd|cadmium
49|In|indium
50|Sn|tin
51|Sb|antimony
52|Te|tellurium
53|I|iodine
54|Xe|xenon
55|Cs|caesium
56|Ba|barium
57|La|lanthanum
58|Ce|cerium
59|Pr|praseodymium
60|Nd|neodymium
61|Pm|promethium
62|Sm|samarium
63|Eu|europium
64|Gd|gadolinium
65|Tb|terbium
66|Dy|dysprosium
67|Ho|holmium
68|Er|erbium
69|Tm|thulium
70|Yb|ytterbium
71|Lu|lutetium
72|Hf|hafnium
73|Ta|tantalum
74|W|tungsten
75|Re|rhenium
76|Os|osmium
77|Ir|iridium
78|Pt|platinum
79|Au|gold
80|Hg|mercury
81|Tl|thallium
82|Pb|lead
83|Bi|bismuth
84|Po|polonium
85|At|astatine
86|Rn|radon
87|Fr|francium
88|Ra|radium
89|Ac|actinium
90|Th|thorium
91|Pa|protactinium
92|U|uranium
93|Np|neptunium
94|Pu|plutonium
95|Am|americium
96|Cm|curium
97|Bk|berkelium
98|Cf|californium
99|Es|einsteinium
100|Fm|fermium
101|Md|mendelevium
102|No|nobelium
103|Lr|lawrencium
104|Rf|rutherfordium
105|Db|dubnium
106|Sg|seaborgium
107|Bh|bohrium
108|Hs|hassium
109|Mt|meitnerium
110|Ds|darmstadtium
111|Rg|roentgenium
112|Cn|copernicium
113|Nh|nihonium
114|Fl|flerovium
115|Mc|moscovium
116|Lv|livermorium
117|Ts|tennessine
118|Og|oganesson
`.trim().split('\n').map(line => {
  const [atomicNumber, symbol, nameEn] = line.split('|');
  return { atomicNumber: Number(atomicNumber), symbol, nameEn };
});

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
  throw new Error('لم يُعثر على pdftotext؛ أوقفنا استيراد العناصر لأن مطابقة جدول IUPAC غير ممكنة.');
}

function extractPdfText(sourceBytes) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fatinah-iupac-'));
  const pdfPath = path.join(temporaryDirectory, 'periodic-table.pdf');
  const textPath = path.join(temporaryDirectory, 'periodic-table.txt');
  try {
    fs.writeFileSync(pdfPath, sourceBytes);
    const result = spawnSync(resolvePdfToText(), ['-raw', pdfPath, textPath], {
      encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`pdftotext فشل: ${result.error?.message || result.stderr || `exit ${result.status}`}`);
    }
    const text = fs.readFileSync(textPath, 'utf8');
    if (text.length < 3_000) throw new Error(`نص جدول IUPAC غير مكتمل (${text.length} محرفاً).`);
    return text;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function fetchWithRetry(url, init, label) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(45_000) });
      if (response.ok) return response;
      if (![429, 502, 503, 504].includes(response.status)) {
        throw new Error(`${label} HTTP ${response.status}`);
      }
      lastError = new Error(`${label} HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
  }
  throw lastError || new Error(`${label}: exhausted retries`);
}

async function fetchWikidataBindings() {
  const queryUrl = new URL(WIKIDATA_ENDPOINT);
  queryUrl.searchParams.set('query', WIKIDATA_QUERY);
  queryUrl.searchParams.set('format', 'json');
  const response = await fetchWithRetry(queryUrl, {
    headers: { accept: 'application/sparql-results+json', 'user-agent': USER_AGENT },
  }, 'Wikidata Query Service');
  const payload = await response.json();
  if (!Array.isArray(payload?.results?.bindings)) throw new Error('Wikidata SPARQL payload has no bindings.');
  return payload.results.bindings;
}

async function fetchIupacPdf() {
  const response = await fetchWithRetry(IUPAC_PDF_URL, {
    headers: { accept: 'application/pdf', 'user-agent': USER_AGENT },
  }, 'IUPAC');
  const contentType = response.headers.get('content-type') || '';
  const sourceBytes = Buffer.from(await response.arrayBuffer());
  if (!/application\/pdf/iu.test(contentType)
    || sourceBytes.length < 40_000
    || sourceBytes.subarray(0, 5).toString() !== '%PDF-') {
    throw new Error('IUPAC لم يُرجع ملف PDF الرسمي الكامل المتوقع.');
  }
  return sourceBytes;
}

function proveIupacElements(extractedText) {
  const normalizedText = normalizeExtractedText(extractedText);
  if (!normalizedText.includes('IUPAC Periodic Table of the Elements')
    || !normalizedText.includes('This version is dated 4 May 2022')) {
    throw new Error('هوية أو إصدار جدول IUPAC غير مطابق للمصدر المثبّت.');
  }
  const missing = [];
  for (const element of IUPAC_ELEMENTS) {
    const tuplePattern = new RegExp(
      `(?:^|\\s)${element.atomicNumber}\\s+${escapeRegExp(element.symbol)}\\s+${escapeRegExp(element.nameEn)}(?=\\s|$)`,
      'u',
    );
    if (!tuplePattern.test(normalizedText)) missing.push(`${element.atomicNumber}:${element.symbol}:${element.nameEn}`);
  }
  if (missing.length) throw new Error(`صفوف IUPAC غير المثبتة (${missing.length}): ${missing.join(', ')}`);
  return normalizedText;
}

function parseWikidata(bindings) {
  const records = bindings.map((binding, index) => {
    const item = binding.item?.value;
    const itemLabel = binding.itemLabelAr?.value?.trim();
    const itemLabelEn = binding.itemLabelEn?.value?.trim().toLowerCase();
    const symbol = binding.symbol?.value?.trim();
    const atomicNumber = Number(binding.atomicNumber?.value);
    if (!/^http:\/\/www\.wikidata\.org\/entity\/Q\d+$/u.test(item || '')) {
      throw new Error(`Wikidata item URI غير صالح في الصف ${index + 1}.`);
    }
    if (!Number.isInteger(atomicNumber) || atomicNumber < 1 || atomicNumber > 118) {
      throw new Error(`Wikidata atomic number غير صالح: ${binding.atomicNumber?.value}`);
    }
    if (!itemLabel || !/[\p{Script=Arabic}]/u.test(itemLabel) || /[<>]/u.test(itemLabel)) {
      throw new Error(`Wikidata Arabic label مفقود/غير صالح للعنصر ${atomicNumber}.`);
    }
    if (!/^[A-Z][a-z]?$/u.test(symbol || '') || !/^[a-z]+$/u.test(itemLabelEn || '')) {
      throw new Error(`Wikidata English name/symbol غير صالح للعنصر ${atomicNumber}.`);
    }
    return { item, itemLabel, itemLabelEn, symbol, atomicNumber };
  }).sort((left, right) => left.atomicNumber - right.atomicNumber);

  const unique = field => new Set(records.map(record => String(record[field]))).size;
  if (records.length !== 118
    || unique('atomicNumber') !== 118
    || unique('symbol') !== 118
    || unique('item') !== 118
    || unique('itemLabel') !== 118) {
    throw new Error(`Wikidata يجب أن ينتج 118 عنصراً فريداً؛ records=${records.length}, atomic=${unique('atomicNumber')}, symbols=${unique('symbol')}, items=${unique('item')}, labels=${unique('itemLabel')}`);
  }
  for (const expected of IUPAC_ELEMENTS) {
    const actual = records[expected.atomicNumber - 1];
    if (actual.atomicNumber !== expected.atomicNumber
      || actual.symbol !== expected.symbol
      || actual.itemLabelEn !== expected.nameEn) {
      throw new Error(`تعارض Wikidata/IUPAC في العنصر ${expected.atomicNumber}: ${actual.symbol}/${actual.itemLabelEn} ≠ ${expected.symbol}/${expected.nameEn}`);
    }
  }
  return records;
}

function writeJsonAtomic(filePath, document) {
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`);
  fs.renameSync(temporaryPath, filePath);
}

async function main() {
  const write = process.argv.includes('--write');
  if (IUPAC_ELEMENTS.length !== 118
    || new Set(IUPAC_ELEMENTS.map(element => element.atomicNumber)).size !== 118
    || new Set(IUPAC_ELEMENTS.map(element => element.symbol)).size !== 118) {
    throw new Error('عقد IUPAC المحلي يجب أن يحتوي 118 صفاً فريداً.');
  }

  const [bindings, iupacBytes] = await Promise.all([fetchWikidataBindings(), fetchIupacPdf()]);
  const wikidataRecords = parseWikidata(bindings);
  const iupacText = proveIupacElements(extractPdfText(iupacBytes));
  const wikidataFactsSha256 = sha256(canonical(wikidataRecords));
  const iupacPayloadSha256 = sha256(iupacBytes);
  const iupacTextSha256 = sha256(iupacText);

  const records = wikidataRecords.map((wikidataRecord, index) => {
    const expected = IUPAC_ELEMENTS[index];
    const qid = wikidataRecord.item.match(/Q\d+$/u)[0];
    const sourceFacts = {
      wikidata: wikidataRecord,
      iupac: { atomicNumber: expected.atomicNumber, symbol: expected.symbol, nameEn: expected.nameEn },
    };
    const payload = {
      sourceRecordId: `iupac-element-${expected.atomicNumber}`,
      item: wikidataRecord.item,
      itemLabel: wikidataRecord.itemLabel,
      itemLabelEn: expected.nameEn,
      symbol: expected.symbol,
      atomicNumber: String(expected.atomicNumber),
      sourceUrl: `https://www.wikidata.org/wiki/${qid}`,
      sourcePublisher: 'Wikidata',
      sourceLicense: 'CC0 1.0',
      iupacSourceUrl: IUPAC_PDF_URL,
      iupacSourcePublisher: 'International Union of Pure and Applied Chemistry (IUPAC)',
      sourcePayloadHash: sha256(canonical(sourceFacts)),
    };
    return { ...payload, recordPayloadSha256: sha256(canonical(payload)) };
  });

  const document = {
    schemaVersion: 2,
    sourceProfile: 'wikidata_iupac_chemical_elements_snapshot_v1',
    sourceArtifactId: `chemical-elements-wikidata-iupac-${SNAPSHOT_DATE}`,
    retrievedAt: SNAPSHOT_DATE,
    selectionPolicy: 'Exactly the 118 IUPAC-recognized elements. Atomic number, English name, and symbol must agree between Wikidata and the official IUPAC 4 May 2022 table; Arabic labels come directly from Wikidata.',
    sources: {
      wikidata: {
        title: 'Wikidata chemical elements (P31=Q11344, P1086, P246)',
        url: WIKIDATA_ENDPOINT,
        publisher: 'Wikimedia Foundation — Wikidata',
        license: 'CC0 1.0',
        querySha256: sha256(WIKIDATA_QUERY),
        sourcePayloadSha256: wikidataFactsSha256,
      },
      iupac: {
        title: 'IUPAC Periodic Table of the Elements',
        pageUrl: IUPAC_PAGE_URL,
        url: IUPAC_PDF_URL,
        publisher: 'International Union of Pure and Applied Chemistry (IUPAC)',
        releaseDate: IUPAC_RELEASE_DATE,
        sourcePayloadSha256: iupacPayloadSha256,
        sourceTextSha256: iupacTextSha256,
      },
    },
    validation: {
      profile: 'wikidata_iupac_exact_118_tuple_proof_v1',
      expectedRecordCount: 118,
      verifiedRecordCount: records.length,
      verifiedIupacTupleCount: IUPAC_ELEMENTS.length,
      uniqueAtomicNumberCount: new Set(records.map(record => record.atomicNumber)).size,
      uniqueSymbolCount: new Set(records.map(record => record.symbol)).size,
      uniqueWikidataItemCount: new Set(records.map(record => record.item)).size,
      extractor: 'pdftotext -raw',
    },
    records,
  };
  document.contentSha256 = sha256(canonical(document));

  if (write) {
    writeJsonAtomic(OUTPUT, document);
    console.log(`Wrote ${records.length} Wikidata/IUPAC-proven elements to ${path.relative(ROOT, OUTPUT)}`);
  } else {
    console.log(`Verified ${records.length} Wikidata elements against 118 official IUPAC tuples; use --write to replace the snapshot.`);
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
