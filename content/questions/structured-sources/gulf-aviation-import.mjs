#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const OUTPUT = path.join(import.meta.dirname, 'gulf-aviation.json');
const LEGACY_PLAY_SEED = path.join(import.meta.dirname, 'gulf-plays.json');
const LEGACY_AIRPORT_SEED = path.join(import.meta.dirname, 'next-release-wikidata.json');
const ARCHIVE_BANK_ARTIFACTS = [
  ...fs.readdirSync(path.join(ROOT, 'server-assets/question-bank/archive'))
    .filter(file => /-bank\.json$/u.test(file))
    .sort()
    .map(file => `server-assets/question-bank/archive/${file}`),
  'server-assets/question-bank/archive/gulf-pre-release-baseline-v3-next-f4c15f7a680882df-0726a0986da63b32-2070.json',
];
const WRITE = process.argv.includes('--write');
const CAPTURED_AT = process.env.FATINAH_SOURCE_RETRIEVED_AT || new Date().toISOString();

const CSB_ADMIN_URL = 'https://gis.csb.gov.kw/media/pdf/1_Chapter1_Administrative_Division_of_Kuwait.pdf';
const OUR_AIRPORTS_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const ARWIKI_API = 'https://ar.wikipedia.org/w/api.php';
const USER_AGENT = 'FatinahQuestionBank/2.1 (https://ata20.com; offline source snapshot)';
const BANNED = /(?:إسرائيل|اسرائيل|إسرائيلي|اسرائيلي|Israel|Israeli|Tel Aviv|تل أبيب|تل ابيب|إباحي|اباحي|جنسي)/iu;
const UNSAFE_PLAY_TITLE = /(?:عالم نساء ورجل|الشرطية الحسناء)/u;
let ourAirportsSourceHash = '';
let airportArchiveStats = null;

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const normalize = value => String(value || '')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[\u064b-\u065f\u0670]/gu, '')
  .replace(/[إأآٱ]/gu, 'ا')
  .replace(/ى/gu, 'ي')
  .replace(/ة/gu, 'ه')
  .replace(/[\s\p{P}\p{S}]+/gu, '');

function canonicalHash(record) {
  return sha256(JSON.stringify({
    sourceRecordId: record.sourceRecordId,
    category: record.category,
    subject: record.subject,
    predicate: record.predicate,
    object: record.object,
    evidence: record.evidence,
  }));
}

function finishRecord(record) {
  return { ...record, sourcePayloadHash: canonicalHash(record) };
}

// The Arabic labels and page references below were transcribed from the legends
// on the Central Statistical Bureau's official 2011 administrative-division maps.
// The tiers are an editorial familiarity ordering; they never use a hash.
const KUWAIT_AREAS = [
  // easy (30)
  ['الدسمة', 'محافظة العاصمة', 16], ['كيفان', 'محافظة العاصمة', 16], ['الشامية', 'محافظة العاصمة', 16],
  ['الروضة', 'محافظة العاصمة', 16], ['العديلية', 'محافظة العاصمة', 16], ['القادسية', 'محافظة العاصمة', 16],
  ['حولي', 'محافظة حولي', 17], ['السالمية', 'محافظة حولي', 17], ['الجابرية', 'محافظة حولي', 17],
  ['مشرف', 'محافظة حولي', 17], ['بيان', 'محافظة حولي', 17],
  ['الأحمدي', 'محافظة الأحمدي', 18], ['الفحيحيل', 'محافظة الأحمدي', 18], ['المنقف', 'محافظة الأحمدي', 18],
  ['أبو حليفة', 'محافظة الأحمدي', 18], ['الصباحية', 'محافظة الأحمدي', 18], ['العقيلة', 'محافظة الأحمدي', 18],
  ['الفروانية', 'محافظة الفروانية', 20], ['خيطان', 'محافظة الفروانية', 20], ['جليب الشيوخ', 'محافظة الفروانية', 20],
  ['الأندلس', 'محافظة الفروانية', 20], ['العارضية', 'محافظة الفروانية', 20],
  ['الجهراء', 'محافظة الجهراء', 19], ['سعد العبدالله', 'محافظة الجهراء', 19], ['الصليبية', 'محافظة الجهراء', 19], ['القيروان', 'محافظة الجهراء', 19],
  ['صباح السالم', 'محافظة مبارك الكبير', 21], ['العدان', 'محافظة مبارك الكبير', 21], ['القصور', 'محافظة مبارك الكبير', 21], ['القرين', 'محافظة مبارك الكبير', 21],

  // medium (30)
  ['المنصورية', 'محافظة العاصمة', 16], ['الفيحاء', 'محافظة العاصمة', 16], ['النزهة', 'محافظة العاصمة', 16],
  ['الخالدية', 'محافظة العاصمة', 16], ['الدعية', 'محافظة العاصمة', 16], ['قرطبة', 'محافظة العاصمة', 16],
  ['الرميثية', 'محافظة حولي', 17], ['سلوى', 'محافظة حولي', 17], ['أنجفة', 'محافظة حولي', 17], ['الشعب', 'محافظة حولي', 17], ['الزهراء', 'محافظة حولي', 17],
  ['الرقة', 'محافظة الأحمدي', 18], ['هدية', 'محافظة الأحمدي', 18], ['الظهر', 'محافظة الأحمدي', 18], ['جابر العلي', 'محافظة الأحمدي', 18], ['المهبولة', 'محافظة الأحمدي', 18], ['الفنطاس', 'محافظة الأحمدي', 18],
  ['إشبيلية', 'محافظة الفروانية', 20], ['الرحاب', 'محافظة الفروانية', 20], ['الرابية', 'محافظة الفروانية', 20], ['العمرية', 'محافظة الفروانية', 20], ['الفردوس', 'محافظة الفروانية', 20],
  ['تيماء', 'محافظة الجهراء', 19], ['الواحة', 'محافظة الجهراء', 19], ['العيون', 'محافظة الجهراء', 19], ['النعيم', 'محافظة الجهراء', 19], ['أمغرة', 'محافظة الجهراء', 19],
  ['مبارك الكبير', 'محافظة مبارك الكبير', 21], ['الفنيطيس', 'محافظة مبارك الكبير', 21], ['أبو فطيرة', 'محافظة مبارك الكبير', 21],

  // hard (30)
  ['بنيد القار', 'محافظة العاصمة', 16], ['اليرموك', 'محافظة العاصمة', 16], ['السرة', 'محافظة العاصمة', 16], ['الدوحة', 'محافظة العاصمة', 16], ['غرناطة', 'محافظة العاصمة', 16], ['الصليبيخات', 'محافظة العاصمة', 16],
  ['مبارك العبدالله', 'محافظة حولي', 17], ['الشهداء', 'محافظة حولي', 17], ['الصديق', 'محافظة حولي', 17], ['حطين', 'محافظة حولي', 17], ['السلام', 'محافظة حولي', 17],
  ['شمال الشعيبة', 'محافظة الأحمدي', 18], ['جنوب الشعيبة', 'محافظة الأحمدي', 18], ['ميناء عبدالله', 'محافظة الأحمدي', 18], ['الزور', 'محافظة الأحمدي', 18], ['النويصيب', 'محافظة الأحمدي', 18], ['الوفرة', 'محافظة الأحمدي', 18],
  ['الضجيج', 'محافظة الفروانية', 20], ['العارضية الحرفية', 'محافظة الفروانية', 20], ['مخازن العارضية', 'محافظة الفروانية', 20], ['العارضية الحكومية', 'محافظة الفروانية', 20], ['ضاحية عبدالله المبارك', 'محافظة الفروانية', 20], ['صباح الناصر', 'محافظة الفروانية', 20],
  ['جنوب شرق الجهراء', 'محافظة الجهراء', 19], ['الجهراء الصناعية', 'محافظة الجهراء', 19], ['الصليبية الصناعية 1', 'محافظة الجهراء', 19], ['كبد', 'محافظة الجهراء', 19], ['العبدلي', 'محافظة الجهراء', 19],
  ['صبحان الصناعية', 'محافظة مبارك الكبير', 21], ['المسيلة', 'محافظة مبارك الكبير', 21],
];

const GCC_IDS = {
  'الكويت': 'Q817',
  'المملكة العربية السعودية': 'Q851',
  'الإمارات العربية المتحدة': 'Q878',
  'قطر': 'Q846',
  'البحرين': 'Q398',
  'سلطنة عمان': 'Q842',
};

const SA = 'المملكة العربية السعودية';
const AE = 'الإمارات العربية المتحدة';
const KW = 'الكويت';
const QA = 'قطر';
const BH = 'البحرين';
const OM = 'سلطنة عمان';

// The legacy Wikidata seed predates several prominent Gulf hubs. These extra
// CC0 rows are fixed identifiers whose IATA claims are rechecked live below.
const AIRPORT_EXTRA_SEEDS = [
  ['Q527157', 'KWI', 'مطار الكويت الدولي', KW],
  ['Q1198791', 'DOH', 'مطار حمد الدولي', QA],
  ['Q1133357', 'MCT', 'مطار مسقط الدولي', OM],
  ['Q47157', 'RUH', 'مطار الملك خالد الدولي', SA],
  ['Q911155', 'DMM', 'مطار الملك فهد الدولي', SA],
  ['Q1205940', 'MED', 'مطار الأمير محمد بن عبد العزيز الدولي', SA],
  ['Q1065223', 'DWC', 'مطار آل مكتوم الدولي', AE],
  ['Q1391995', 'AAN', 'مطار العين الدولي', AE],
  ['Q1432681', 'SLL', 'مطار صلالة', OM],
  ['Q2743319', 'AHB', 'مطار أبها الدولي', SA],
  ['Q2876136', 'TIF', 'مطار الطائف الدولي', SA],
].map(([qid, iata, itemLabel, countryLabel]) => ({
  item: `http://www.wikidata.org/entity/${qid}`,
  iata,
  itemLabel,
  countryLabel,
}));

// Difficulty is a Gulf-audience familiarity order, then a global-hub order;
// Wikidata sitelinks only break ties in the remaining long tail. No hash is used.
const AIRPORT_FAMILIARITY_ORDER = [
  'KWI', 'DXB', 'DOH', 'AUH', 'MCT', 'RUH', 'DMM', 'MED', 'DWC', 'SLL', 'AAN', 'AHB', 'TIF',
  'SIN', 'HND', 'PEK', 'NRT', 'HKG', 'ICN', 'ATL', 'ORD', 'DFW', 'MAD', 'FCO', 'BKK', 'KUL', 'SYD', 'CAI', 'BOM', 'PVG',
  'CAN', 'VIE', 'ZRH', 'CPH', 'ATH', 'HEL', 'WAW', 'OSL', 'DUB', 'EWR', 'TPE', 'BUD', 'HAM', 'RIX', 'TIA', 'BRU', 'KIX', 'DME', 'SVO', 'CGK', 'SGN', 'DAD', 'CXR', 'BLR', 'NBO', 'ADD', 'BOS', 'IAD', 'NGO', 'GIB',
];

function wiki(label) {
  return `https://ar.wikipedia.org/wiki/${encodeURIComponent(label.replace(/ /gu, '_'))}`;
}

// Exactly five stable place/country claims per GCC state in every band.
// A Q-id is included where the claim came from the existing CC0 Wikidata import;
// otherwise the cited Arabic Wikipedia page is the human-verifiable upstream.
const GCC_PLACES = [
  // easy (30)
  ['الرياض', SA], ['جدة', SA], ['مكة المكرمة', SA], ['المدينة المنورة', SA], ['العلا', SA],
  ['دبي', AE], ['أبوظبي', AE], ['الشارقة', AE, 'Q289693'], ['العين', AE, null, 'العين (أبوظبي)'], ['رأس الخيمة', AE],
  ['سوق المباركية', KW], ['الجهراء', KW], ['السالمية', KW], ['فيلكا', KW, 'Q1392962'], ['الجزيرة الخضراء', KW, null, 'الجزيرة الخضراء (الكويت)'],
  ['الدوحة', QA], ['الريان', QA, null, 'الريان (قطر)'], ['الوكرة', QA], ['الخور', QA, null, 'الخور (قطر)'], ['لوسيل', QA],
  ['المنامة', BH], ['المحرق', BH, null, 'المحرق (مدينة)'], ['الرفاع', BH], ['مدينة عيسى', BH], ['شجرة الحياة', BH, null, 'شجرة الحياة (البحرين)'],
  ['مسقط', OM], ['صلالة', OM], ['نزوى', OM], ['صحار', OM], ['صور', OM, null, 'ولاية صور'],

  // medium (30)
  ['مدائن صالح', SA, 'Q27356'], ['جدة التاريخية', SA, 'Q4702264'], ['حي الطريف', SA, 'Q22687629'], ['واحة الأحساء', SA, 'Q311341'], ['قرية الفاو', SA, 'Q2829327'],
  ['خور دبي', AE, 'Q1262853'], ['مسجد البدية', AE, 'Q4115363'], ['واحة العين', AE, 'Q4703456'], ['أم النار', AE, 'Q1429987'], ['الجزيرة الحمراء', AE, 'Q4704143'],
  ['جزيرة بوبيان', KW, 'Q781268'], ['المسجد الكبير', KW, 'Q1432832'], ['قصر السيف', KW, 'Q3564897'], ['برج الحمراء', KW], ['مركز الشيخ جابر الأحمد الثقافي', KW],
  ['الزبارة', QA, 'Q2727469'], ['خور العديد', QA, 'Q1068443'], ['متحف الفن الإسلامي', QA, null, 'متحف الفن الإسلامي (الدوحة)'], ['سوق واقف', QA], ['كتارا', QA],
  ['معبد باربار', BH, 'Q807317'], ['مدافن دلمون', BH, 'Q5276996'], ['قلعة بو ماهر', BH, 'Q65953993'], ['خليج توبلي', BH, 'Q7850899'], ['قلعة عراد', BH],
  ['قلعة بهلاء', OM, 'Q1408909'], ['أرض البخور', OM, 'Q118468'], ['قلعة نخل', OM], ['حصن مطرح', OM], ['رأس الجنز', OM, 'Q1764671'],

  // hard (30)
  ['منطقة حمى الثقافية', SA, 'Q4915544'], ['دومة الجندل', SA, 'Q2719371'], ['قلعة تاروت', SA], ['قرية ذي عين', SA], ['جزر فرسان', SA, 'Q2336295'],
  ['بدع بنت سعود', AE, 'Q56275601'], ['وادي الوريعة', AE, 'Q2538723'], ['جبل الفاية', AE, 'Q6172505'], ['جلفار', AE, 'Q5952848'], ['جزيرة صير بو نعير', AE, 'Q1582347'],
  ['جزيرة أم النمل', KW], ['جزيرة وربة', KW], ['جزيرة قاروه', KW], ['جزيرة كبر', KW], ['جزيرة أم المرادم', KW],
  ['أبراج برزان', QA, null, 'برج برزان'], ['قلعة الركيات', QA], ['جزيرة حالول', QA, null, 'حالول'], ['محمية الريم', QA], ['برج الدوحة', QA],
  ['طريق اللؤلؤ', BH, 'Q1889313'], ['عين أم السجور', BH], ['بيت سيادي', BH], ['مسجد الخميس', BH], ['قلعة الرفاع', BH],
  ['خور روري', OM, 'Q826118'], ['قلهات', OM, 'Q680322'], ['جزر الديمانيات', OM, 'Q3019342'], ['البليد', OM, 'Q12184607'], ['وبار', OM, 'Q14912328'],
];

// These 29 candidate facts occur in an archived bank with the same semantic
// subject/country claim. Each replacement occupies the same country and band.
const GCC_ARCHIVE_REPLACEMENTS = new Map([
  ['الشارقة', ['عجمان', AE, null, 'عجمان (مدينة)']],
  ['فيلكا', ['حولي', KW]],
  ['المنامة', ['سترة', BH, null, 'سترة (البحرين)']],
  ['خور دبي', ['برج العرب', AE, null, 'فندق برج العرب (دبي)']],
  ['مسجد البدية', ['متحف المستقبل', AE]],
  ['واحة العين', ['اللوفر أبوظبي', AE, null, 'اللوفر أبو ظبي']],
  ['أم النار', ['جامع الشيخ زايد الكبير', AE]],
  ['الجزيرة الحمراء', ['برواز دبي', AE]],
  ['الزبارة', ['مشيرب', QA]],
  ['خور العديد', ['دخان', QA, null, 'دخان (مدينة)']],
  ['معبد باربار', ['مدينة حمد', BH]],
  ['مدافن دلمون', ['عالي', BH, null, 'عالي (البحرين)']],
  ['قلعة بو ماهر', ['المالكية', BH, null, 'المالكية (البحرين)']],
  ['خليج توبلي', ['الحد', BH, null, 'الحد (مدينة)']],
  ['قلعة بهلاء', ['جامع السلطان قابوس الأكبر', OM]],
  ['أرض البخور', ['دار الأوبرا السلطانية مسقط', OM]],
  ['قلعة نخل', ['الجبل الأخضر', OM, null, 'الجبل الأخضر (عمان)']],
  ['حصن مطرح', ['وادي شاب', OM]],
  ['رأس الجنز', ['مسندم', OM, null, 'محافظة مسندم']],
  ['بدع بنت سعود', ['مصفح', AE]],
  ['وادي الوريعة', ['الذيد', AE]],
  ['جبل الفاية', ['كلباء', AE]],
  ['جلفار', ['دبا الفجيرة', AE]],
  ['جزيرة صير بو نعير', ['حتا', AE, null, 'حتا (دبي)']],
  ['خور روري', ['خصب', OM, null, 'ولاية خصب']],
  ['قلهات', ['البريمي', OM]],
  ['جزر الديمانيات', ['الرستاق', OM, null, 'ولاية الرستاق']],
  ['البليد', ['عبري', OM, null, 'عبري (سلطنة عمان)']],
  ['وبار', ['إبراء', OM]],
]);

function bandAt(index) {
  return ['easy', 'medium', 'hard'][Math.floor(index / 30)];
}

function buildKuwaitRecords() {
  if (KUWAIT_AREAS.length !== 90) throw new Error(`Kuwait source count: ${KUWAIT_AREAS.length}`);
  return KUWAIT_AREAS.map(([area, governorate, sourcePage], index) => finishRecord({
    sourceRecordId: `csb-kw-area-${String(index + 1).padStart(3, '0')}`,
    category: 'الكويت',
    subject: { type: 'kuwait-area', label: area },
    predicate: { id: 'administrative_governorate', label: 'المحافظة الإدارية' },
    object: { type: 'kuwait-governorate', label: governorate },
    difficultyBand: bandAt(index),
    difficultyMetric: 'editorial_local_familiarity_tier',
    difficultyValue: 90 - index,
    templateId: 'kuwait-area-governorate-v1',
    evidence: {
      profile: 'official_map_legend_v1',
      sourcePage,
      mapTitle: `Areas Per Districts - ${governorate}`,
      area,
      governorate,
    },
    source: {
      title: `التقسيم الإداري لدولة الكويت - ${governorate}`,
      url: CSB_ADMIN_URL,
      publisher: 'الإدارة المركزية للإحصاء - دولة الكويت',
      license: 'Official government publication',
    },
  }));
}

function buildGccRecords() {
  if (GCC_PLACES.length !== 90) throw new Error(`GCC source count: ${GCC_PLACES.length}`);
  const selected = GCC_PLACES.map(record => GCC_ARCHIVE_REPLACEMENTS.get(record[0]) || record);
  if (new Set(selected.map(record => normalize(record[0]))).size !== 90) throw new Error('GCC replacement facts are not unique');
  return selected.map(([place, country, itemId, articleTitle = place], index) => {
    const countryId = GCC_IDS[country];
    const sourceUrl = itemId ? `https://www.wikidata.org/wiki/${itemId}` : wiki(articleTitle);
    return finishRecord({
      sourceRecordId: itemId
        ? `wikidata-${itemId}-P17-${countryId}`
        : `arwiki-gcc-place-${String(index + 1).padStart(3, '0')}`,
      category: 'دول الخليج',
      subject: { type: 'gcc-place', id: itemId || null, label: place },
      predicate: { id: 'P17', label: 'الدولة' },
      object: { type: 'gcc-country', id: countryId, label: country },
      difficultyBand: bandAt(index),
      difficultyMetric: 'editorial_gcc_place_familiarity_tier',
      difficultyValue: 90 - index,
      templateId: 'gcc-place-country-v1',
      evidence: itemId
        ? { profile: 'wikidata_claim_v1', entityId: itemId, property: 'P17', valueId: countryId }
        : { profile: 'arwiki_article_country_v1', articleTitle, country },
      source: {
        title: `${place} - ${itemId ? 'Wikidata' : 'ويكيبيديا العربية'}`,
        url: sourceUrl,
        publisher: itemId ? 'Wikidata' : 'Wikipedia Arabic',
        license: itemId ? 'CC0 1.0' : 'CC BY-SA 4.0',
      },
    });
  });
}

async function fetchText(url, attempts = 8) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json,text/csv;q=0.9,*/*;q=0.8' },
        signal: AbortSignal.timeout(45_000),
      });
      const body = await response.text();
      if (response.ok) return body;
      lastError = new Error(`HTTP ${response.status}: ${body.slice(0, 120)}`);
      const wait = Math.max(Number(response.headers.get('retry-after') || 0) * 1000, attempt * 2_000);
      await new Promise(resolve => setTimeout(resolve, wait));
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, attempt * 2_000));
    }
  }
  throw lastError;
}

async function fetchJson(url) {
  const text = await fetchText(url);
  if (!text.trimStart().startsWith('{')) throw new Error(`Expected JSON from ${url}`);
  return JSON.parse(text);
}

function cleanPlayTitle(value) {
  return String(value || '')
    .replace(/\s*\(مسرحية[^)]*\)\s*$/u, '')
    .trim();
}

const PLAY_CATEGORIES = [
  ['مسرحيات سعودية', SA],
  ['مسرحيات إماراتية', AE],
  ['مسرحيات بحرينية', BH],
  ['مسرحيات قطرية', QA],
];

async function fetchCategoryMembers(category) {
  const url = new URL(ARWIKI_API);
  url.search = new URLSearchParams({
    action: 'query', format: 'json', list: 'categorymembers',
    cmtitle: `تصنيف:${category}`, cmlimit: '500', cmnamespace: '0',
  });
  const document = await fetchJson(url);
  return document.query?.categorymembers || [];
}

async function attachPageviews(records) {
  const output = [];
  for (let offset = 0; offset < records.length; offset += 50) {
    const chunk = records.slice(offset, offset + 50);
    const url = new URL(ARWIKI_API);
    url.search = new URLSearchParams({
      action: 'query', format: 'json', prop: 'pageviews',
      pageids: chunk.map(record => record.pageid).join('|'),
    });
    const document = await fetchJson(url);
    const pages = document.query?.pages || {};
    for (const record of chunk) {
      const views = Object.values(pages[record.pageid]?.pageviews || {})
        .reduce((sum, value) => sum + Number(value || 0), 0);
      output.push({ ...record, pageViews60d: views });
    }
    await new Promise(resolve => setTimeout(resolve, 900));
  }
  return output;
}

async function buildPlayRecords() {
  const cachedKuwait = readJson(LEGACY_PLAY_SEED).records
    .map(record => ({ ...record, country: KW, category: 'مسرحيات كويتية' }));
  const other = [];
  for (const [category, country] of PLAY_CATEGORIES) {
    const members = await fetchCategoryMembers(category);
    other.push(...members.map(record => ({ ...record, category, country })));
    await new Promise(resolve => setTimeout(resolve, 900));
  }

  const byPage = new Map();
  for (const raw of [...cachedKuwait, ...other]) {
    const title = cleanPlayTitle(raw.title);
    if (!title
      || BANNED.test(title)
      || UNSAFE_PLAY_TITLE.test(title)
      || /(?:الكويت|كويت|السعودية|سعودي|الإمارات|إماراتي|البحرين|بحريني|قطر|قطري)/u.test(title)) continue;
    const current = byPage.get(raw.pageid);
    if (current && current.country !== raw.country) {
      current.ambiguous = true;
      continue;
    }
    byPage.set(raw.pageid, { ...raw, cleanTitle: title });
  }
  const candidates = await attachPageviews([...byPage.values()].filter(record => !record.ambiguous));
  const nonKuwait = candidates.filter(record => record.country !== KW);
  const kuwait = candidates.filter(record => record.country === KW)
    .sort((left, right) => right.pageViews60d - left.pageViews60d || left.pageid - right.pageid)
    .slice(0, 90 - nonKuwait.length);
  const selected = [...nonKuwait, ...kuwait]
    .sort((left, right) => right.pageViews60d - left.pageViews60d || left.pageid - right.pageid)
    .slice(0, 90);
  if (selected.length !== 90) throw new Error(`Play source count: ${selected.length}`);

  return selected.map((record, index) => finishRecord({
    sourceRecordId: `arwiki-play-${record.pageid}-country`,
    category: 'مسرحيات خليجية',
    subject: { type: 'gulf-play', id: String(record.pageid), label: record.cleanTitle },
    predicate: { id: 'category_country', label: 'بلد المسرحية' },
    object: { type: 'gcc-country', id: GCC_IDS[record.country], label: record.country },
    difficultyBand: bandAt(index),
    difficultyMetric: 'arwiki_pageviews_60d',
    difficultyValue: record.pageViews60d,
    difficultyOrdinal: index + 1,
    templateId: 'gulf-play-country-v1',
    evidence: {
      profile: 'mediawiki_category_membership_v1',
      pageId: record.pageid,
      articleTitle: record.title,
      categoryTitle: `تصنيف:${record.category}`,
      country: record.country,
      pageViews60d: record.pageViews60d,
    },
    source: {
      title: `${record.title} - ويكيبيديا العربية`,
      url: wiki(record.title),
      publisher: 'Wikipedia Arabic',
      license: 'CC BY-SA 4.0',
    },
  }));
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(cell);
      cell = '';
    } else if (character === '\n') {
      row.push(cell.replace(/\r$/u, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else cell += character;
  }
  const headers = rows.shift();
  return rows.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
}

async function wikidataEntities(ids) {
  const entities = {};
  for (let offset = 0; offset < ids.length; offset += 50) {
    const url = new URL(WIKIDATA_API);
    url.search = new URLSearchParams({
      action: 'wbgetentities', format: 'json', props: 'sitelinks|claims',
      ids: ids.slice(offset, offset + 50).join('|'),
    });
    Object.assign(entities, (await fetchJson(url)).entities || {});
    await new Promise(resolve => setTimeout(resolve, 900));
  }
  return entities;
}

function cleanAirportLabel(value) {
  return String(value || '')
    .replace(/\s*,\s*/gu, ' ')
    .replace(/مطار\s*\(\s*([^)]*?)\s*\)/u, 'مطار $1')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

async function buildAirportRecords() {
  const seedDocument = readJson(LEGACY_AIRPORT_SEED);
  const seeds = [...(seedDocument.datasets?.airports || []), ...AIRPORT_EXTRA_SEEDS];
  const archivedRows = ARCHIVE_BANK_ARTIFACTS.flatMap(artifact =>
    Object.values(readJson(path.join(ROOT, artifact)).categories || {}).flat());
  const archivedAirportRows = archivedRows.filter(question =>
    /^[A-Z]{3}$/u.test(question?.answer || '') && /IATA/iu.test(question?.q || ''));
  const archivedFactKeys = new Set(archivedAirportRows.map(question => {
    const qid = `${question.sourceRecordId || ''} ${question.source?.url || ''}`.match(/Q\d+/u)?.[0];
    return qid && /^[A-Z]{3}$/u.test(question.answer || '') ? `${qid}|${question.answer}` : null;
  }).filter(Boolean));
  const csvText = await fetchText(OUR_AIRPORTS_URL);
  ourAirportsSourceHash = sha256(csvText);
  const ourAirports = parseCsv(csvText);
  const byIata = new Map(ourAirports.filter(record => /^[A-Z]{3}$/u.test(record.iata_code))
    .map(record => [record.iata_code, record]));
  const ids = [...new Set(seeds.map(record => String(record.item).split('/').pop()).filter(id => /^Q\d+$/u.test(id)))];
  const entities = await wikidataEntities(ids);
  const candidates = seeds.map(seed => {
    const itemId = String(seed.item).split('/').pop();
    const operational = byIata.get(seed.iata);
    return {
      ...seed,
      itemId,
      airportNameAr: cleanAirportLabel(seed.itemLabel),
      operational,
      sitelinks: Object.keys(entities[itemId]?.sitelinks || {}).length,
      wikidataIataCodes: (entities[itemId]?.claims?.P238 || [])
        .filter(claim => claim.rank !== 'deprecated')
        .map(claim => claim.mainsnak?.datavalue?.value)
        .filter(value => typeof value === 'string'),
    };
  }).filter(record =>
    /^[A-Z]{3}$/u.test(record.iata)
    && record.operational
    && record.operational.scheduled_service === 'yes'
    && ['large_airport', 'medium_airport'].includes(record.operational.type)
    && !/closed|abandoned/iu.test(`${record.operational.type} ${record.operational.keywords}`)
    && record.wikidataIataCodes.includes(record.iata)
    && !BANNED.test(JSON.stringify(record))
    && !/Q\d+|\b[A-Z]{3}\b/u.test(record.airportNameAr));
  const familiarityRank = new Map(AIRPORT_FAMILIARITY_ORDER.map((iata, index) => [iata, index]));
  const orderAirports = records => [...records].sort((left, right) => {
    const leftRank = familiarityRank.get(left.iata);
    const rightRank = familiarityRank.get(right.iata);
    if (leftRank !== undefined || rightRank !== undefined) {
      if (leftRank === undefined) return 1;
      if (rightRank === undefined) return -1;
      if (leftRank !== rightRank) return leftRank - rightRank;
    }
    return right.sitelinks - left.sitelinks || left.iata.localeCompare(right.iata);
  });
  const operationalUnique = [...new Map(candidates.map(record => [record.iata, record])).values()];
  const baseline = orderAirports(operationalUnique).slice(0, 90);
  const archivedOperational = operationalUnique.filter(record => archivedFactKeys.has(`${record.itemId}|${record.iata}`));
  const baselineArchived = baseline.filter(record => archivedFactKeys.has(`${record.itemId}|${record.iata}`));
  const eligible = operationalUnique.filter(record => !archivedFactKeys.has(`${record.itemId}|${record.iata}`));
  const unique = orderAirports(eligible).slice(0, 90);
  if (unique.length !== 90) throw new Error(`Operational airport source count: ${unique.length}`);
  airportArchiveStats = {
    archiveQuestionCount: archivedAirportRows.length,
    archiveSemanticFacts: archivedFactKeys.size,
    operationalCandidatesExcluded: archivedOperational.length,
    top90OverlapsReplaced: baselineArchived.length,
    finalSemanticOverlap: unique.filter(record => archivedFactKeys.has(`${record.itemId}|${record.iata}`)).length,
  };
  if (airportArchiveStats.finalSemanticOverlap !== 0) throw new Error('Archived airport fact survived exclusion');

  return unique.map((record, index) => finishRecord({
    sourceRecordId: `ourairports-${record.operational.ident}-${record.iata}`,
    category: 'طيران ومطارات',
    subject: {
      type: 'operating-scheduled-airport',
      id: record.operational.ident,
      wikidataId: record.itemId,
      label: record.airportNameAr,
    },
    predicate: { id: 'iata_code', label: 'رمز IATA' },
    object: { type: 'iata-code', label: record.iata },
    difficultyBand: bandAt(index),
    difficultyMetric: 'editorial_gulf_global_airport_familiarity_v1',
    difficultyValue: 90 - index,
    difficultyOrdinal: index + 1,
    templateId: 'operating-airport-iata-v1',
    evidence: {
      profile: 'ourairports_active_wikidata_code_v1',
      ourAirportsIdent: record.operational.ident,
      airportType: record.operational.type,
      scheduledService: record.operational.scheduled_service,
      ourAirportsIataCode: record.operational.iata_code,
      wikidataEntityId: record.itemId,
      wikidataIataCode: record.iata,
      wikidataSitelinks: record.sitelinks,
      familiarityRank: familiarityRank.get(record.iata) ?? null,
      difficultyBasis: familiarityRank.has(record.iata)
        ? 'editorial_gulf_then_global_hub_order'
        : 'wikidata_sitelinks_long_tail',
      countryNameAr: record.countryLabel,
    },
    source: {
      title: `${record.airportNameAr} - OurAirports`,
      url: `https://ourairports.com/airports/${encodeURIComponent(record.operational.ident)}/`,
      publisher: 'OurAirports',
      license: 'Public domain',
    },
    corroboratingSource: {
      title: `${record.airportNameAr} - Wikidata`,
      url: `https://www.wikidata.org/wiki/${record.itemId}`,
      publisher: 'Wikidata',
      license: 'CC0 1.0',
    },
  }));
}

function assertCollection(name, records) {
  if (!Array.isArray(records) || records.length !== 90) throw new Error(`${name}: expected 90 records`);
  if (new Set(records.map(record => record.sourceRecordId)).size !== 90) throw new Error(`${name}: duplicate source ids`);
  if (new Set(records.map(record => `${record.subject.label}|${record.predicate.id}`)).size !== 90) {
    throw new Error(`${name}: duplicate facts`);
  }
  for (const band of ['easy', 'medium', 'hard']) {
    if (records.filter(record => record.difficultyBand === band).length !== 30) throw new Error(`${name}: ${band} count`);
  }
  if (records.some(record => BANNED.test(JSON.stringify(record)))) throw new Error(`${name}: banned text`);
  if (records.some(record => canonicalHash(record) !== record.sourcePayloadHash)) throw new Error(`${name}: payload hash mismatch`);
}

const kuwait = buildKuwaitRecords();
const gulf = buildGccRecords();
const plays = await buildPlayRecords();
const airports = await buildAirportRecords();
const collections = { kuwait, gulf, plays, airports };
for (const [name, records] of Object.entries(collections)) assertCollection(name, records);

const document = {
  schemaVersion: 1,
  sourceProfile: 'gulf_aviation_offline_claims_v1',
  retrievedAt: CAPTURED_AT,
  provenance: {
    kuwaitAdministrativeDivision: {
      publisher: 'الإدارة المركزية للإحصاء - دولة الكويت',
      sourceUrl: CSB_ADMIN_URL,
      publication: 'Administrative Division of Kuwait, Census 2011',
      sourceFileSha256: '06e6510b97c16de9b581bd3e61e896abc9ec8ee61357c1cfd3f5ec19d17d5e62',
      pagesUsed: [16, 17, 18, 19, 20, 21],
    },
    wikidata: {
      api: WIKIDATA_API,
      entityDataUrlPattern: 'https://www.wikidata.org/wiki/Special:EntityData/{QID}.json',
      license: 'CC0 1.0',
      airportSeedRetrievedAt: readJson(LEGACY_AIRPORT_SEED).retrievedAt,
      airportSeedSha256: sha256(fs.readFileSync(LEGACY_AIRPORT_SEED)),
    },
    arabicWikipedia: {
      api: ARWIKI_API,
      license: 'CC BY-SA 4.0',
      kuwaitPlaySeedRetrievedAt: readJson(LEGACY_PLAY_SEED).retrievedAt,
      kuwaitPlaySeedSha256: sha256(fs.readFileSync(LEGACY_PLAY_SEED)),
    },
    ourAirports: {
      sourceUrl: OUR_AIRPORTS_URL,
      license: 'Public domain',
      sourceFileSha256: ourAirportsSourceHash,
      activeSelectionRule: 'scheduled_service=yes AND type IN (large_airport, medium_airport)',
      difficultyRule: 'Gulf-audience familiarity, then globally prominent hubs; Wikidata sitelinks break ties only in the long tail',
    },
    archiveExclusion: {
      artifacts: ARCHIVE_BANK_ARTIFACTS.map(artifact => ({
        artifact,
        artifactSha256: sha256(fs.readFileSync(path.join(ROOT, artifact))),
      })),
      semanticKey: 'airport Wikidata entity + iata_code + IATA answer',
      gccSemanticFactsReplaced: GCC_ARCHIVE_REPLACEMENTS.size,
      ...airportArchiveStats,
    },
  },
  collections,
};

if (WRITE) {
  fs.writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
}
console.log(JSON.stringify({
  mode: WRITE ? 'write' : 'dry-run',
  output: path.relative(ROOT, OUTPUT),
  counts: Object.fromEntries(Object.entries(collections).map(([key, records]) => [key, records.length])),
  playCountries: Object.fromEntries([...new Set(plays.map(record => record.object.label))]
    .sort((left, right) => left.localeCompare(right, 'ar'))
    .map(country => [country, plays.filter(record => record.object.label === country).length])),
  gccArchiveFactsReplaced: GCC_ARCHIVE_REPLACEMENTS.size,
  airportDifficulty: {
    metric: airports[0].difficultyMetric,
    firstTen: airports.slice(0, 10).map(record => `${record.object.label}:${record.subject.label}`),
    archiveExclusion: airportArchiveStats,
    wikidataSitelinksRange: {
      max: Math.max(...airports.map(record => record.evidence.wikidataSitelinks)),
      min: Math.min(...airports.map(record => record.evidence.wikidataSitelinks)),
    },
  },
}, null, 2));
