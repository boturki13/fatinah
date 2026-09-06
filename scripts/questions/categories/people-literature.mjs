#!/usr/bin/env node

/**
 * Structured-source importer and deterministic offline builder for the four
 * people/literature categories. Normal build and verification never use the
 * network; only `--refresh-source` contacts Wikidata.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertNoLegacyFacts,
  findLegacyFactMatch,
  loadLegacyQuestionRecords,
} from '../legacy-question-policy.mjs';
import { balancedAnswerIndex, optionTooSimilar } from './common.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
export const SOURCE_PATH = path.join(
  ROOT,
  'content/questions/structured-sources/people-literature.wikidata.json',
);
export const SOURCE_ARTIFACT_ID = 'wikidata-people-literature-v2';
export const PEOPLE_LITERATURE_CATEGORIES = Object.freeze([
  'من أنا؟',
  'شخصيات تاريخية',
  'شعراء وأدباء عرب',
  'روايات عالمية',
]);

const LEDGER_ARTIFACT = 'content/questions/structured-sources/people-literature.wikidata.json';
const DATASET_BY_CATEGORY = Object.freeze({
  'من أنا؟': 'whoAmI',
  'شخصيات تاريخية': 'historicalFigures',
  'شعراء وأدباء عرب': 'arabPoets',
  'روايات عالمية': 'worldNovels',
});
const ENDPOINT = 'https://query.wikidata.org/sparql';
const ENTITY_API = 'https://www.wikidata.org/w/api.php';
const USER_AGENT = 'FatinahQuestionBank/4.0 (https://ata20.com; structured source refresh)';
const HUMAN_ID = 'Q5';
const POET_ID = 'Q49757';
const NOVEL_ID = 'Q8261';
const GENERIC_BOOK_ID = 'Q571';
const BAND_NAMES = Object.freeze(['easy', 'medium', 'hard']);

export const MODERN_ARAB_COUNTRIES = Object.freeze([
  ['Q262', 'الجزائر'], ['Q398', 'البحرين'], ['Q970', 'جزر القمر'],
  ['Q977', 'جيبوتي'], ['Q79', 'مصر'], ['Q796', 'العراق'], ['Q810', 'الأردن'],
  ['Q817', 'الكويت'], ['Q822', 'لبنان'], ['Q1016', 'ليبيا'], ['Q1025', 'موريتانيا'],
  ['Q1028', 'المغرب'], ['Q842', 'سلطنة عمان'], ['Q219060', 'دولة فلسطين'],
  ['Q846', 'قطر'], ['Q851', 'السعودية'], ['Q1045', 'الصومال'], ['Q1049', 'السودان'],
  ['Q858', 'سوريا'], ['Q948', 'تونس'], ['Q878', 'الإمارات العربية المتحدة'],
  ['Q805', 'اليمن'],
].map(([id, label]) => Object.freeze({ id, label })));

const ARAB_COUNTRY_IDS = new Set(MODERN_ARAB_COUNTRIES.map(country => country.id));
const BANNED = /(?:إسرائيل|اسرائيل|إسرائيلي|اسرائيلي|تل أبيب|Israel|Israeli|Tel Aviv|إباحي|اباحي|إباحية|اباحية|محتوى جنسي|علاقة جنسية|عارٍ|عارية|porn|erotic)/iu;
const UNSAFE_CREATIVE_WORK = /(?:سدوم|إيروتيك|ايروتيك|بورنو|لوليتا|خمسون ظلاً|خمسون ظلا|مدار السرطان|أزهار في العلية|سورد آرت|ري\s*[:：-]?\s*زيرو|هاروهي|مونوغاتاري|فيت\s*[/／]|رواي(?:ة|ات) خفيفة|عالم آخر|عالم أخر|فتاة الأرنب|أختي لا يمكن|هجوم العمالقة|هلام|دانجون|الشيطان مؤقت|أكاديمية الملك الشيطان|light novel|manga|anime)/iu;
const DISPLAY_NOISE = /[_\u0640\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu;
const DISPLAY_NOISE_TEST = /[_\u0640\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u;

// The first band is selected only from this reviewed registry. Every entry is
// still revalidated as direct P106=Q49757, Q5, deceased, and singleton modern
// Arab-country P27; the list is a fame/editorial gate, not source evidence.
const EASY_ARAB_POET_IDS = Object.freeze([
  'Q207720', 'Q441152', 'Q462649', 'Q446761', 'Q3502921', 'Q2528405',
  'Q1393458', 'Q1395748', 'Q2827555', 'Q4055170', 'Q17057004', 'Q4121866',
  'Q403242', 'Q2642478', 'Q2988864', 'Q3331514', 'Q373008', 'Q4164775',
  'Q4165546', 'Q7110528', 'Q2756697', 'Q4739184', 'Q12227863', 'Q471044',
  'Q5436178',
  // Reviewed modern writers/poets added to keep the easy band recognisable
  // after semantic legacy exclusions remove several household names.
  'Q541622', 'Q2837662', 'Q16011654', 'Q1391690', 'Q47121035', 'Q7111346',
  'Q3318377', 'Q4164629', 'Q2843598', 'Q12195077', 'Q12206507', 'Q3543837',
  'Q954315', 'Q12239967', 'Q3416184', 'Q5949773', 'Q6809158',
  'Q10964244', 'Q1472416', 'Q16119862', 'Q6932348', 'Q9188670', 'Q12181758',
  'Q16939468', 'Q4664646', 'Q4695975', 'Q6413854', 'Q4063288', 'Q4840646',
  'Q12178860', 'Q12207054', 'Q12221563', 'Q12220181', 'Q12218947', 'Q12212819',
  'Q12223811', 'Q12224173', 'Q12228368', 'Q12207931', 'Q12208208', 'Q12203622',
  'Q12205779', 'Q12218945', 'Q12223584', 'Q2784436', 'Q2827520', 'Q5438996',
  'Q6755240', 'Q12250889',
]);
const EASY_ARAB_POET_RANK = new Map(EASY_ARAB_POET_IDS.map((id, index) => [id, index + 1]));
const EDITORIAL_POET_EXCLUSIONS = new Set([
  'Q317832', 'Q885411', 'Q1951817', 'Q4285686', 'Q2016818', 'Q17149840',
  'Q3277762', 'Q4118622', 'Q4666088', 'Q10974116', 'Q18918574', 'Q12208113',
  'Q14948949', 'Q7427056',
]);

// Records whose available Arabic occupation/position labels create a
// misleading riddle even though the underlying entity is otherwise valid.
// They are excluded editorially instead of silently rewriting Wikidata facts.
const EDITORIAL_PERSON_EXCLUSIONS = new Set([
  'Q152316', // Prince Harry: polo-player label paired with a memoir
  'Q10993',  // Tiger Woods: Arabic label missing for professional golfer
  'Q41421',  // Michael Jordan: malformed current Arabic entity label
  'Q43063',  // Franz Ferdinand: generic monarch position is misleading
  'Q191789', // Martha Washington: politician occupation label is misleading
  'Q233652', // Bess Truman: politician occupation label is misleading
]);

// A compact, reviewed supplement to the locally cached Mintaka people. It is
// only a discovery list: every entity is fetched again and must independently
// pass the Q5, date, Arabic-label, occupation, and defining-fact checks.
const EDITORIAL_HISTORICAL_PERSON_IDS = Object.freeze([
  'Q254', 'Q255', 'Q448', 'Q535', 'Q5592', 'Q5582', 'Q5593', 'Q5597',
  'Q5598', 'Q619', 'Q687', 'Q720', 'Q762', 'Q8011', 'Q8442', 'Q8582',
  'Q868', 'Q8743', 'Q8739', 'Q8747', 'Q8963', 'Q9036', 'Q913', 'Q935',
  'Q1001', 'Q1048', 'Q1339', 'Q1405', 'Q1496', 'Q3044', 'Q4430',
  'Q5264', 'Q5682', 'Q5686', 'Q5879', 'Q6101', 'Q6527', 'Q6691',
  'Q7186', 'Q7226', 'Q7243', 'Q7245', 'Q7251', 'Q7259', 'Q7322',
  'Q8016', 'Q8958', 'Q9061', 'Q9068', 'Q9215', 'Q9358', 'Q9554',
  'Q10261', 'Q16731', 'Q18826', 'Q30875', 'Q33866', 'Q34296',
  'Q34787', 'Q41532', 'Q52929', 'Q191472',
]);

// Closed set of literary novel subtypes. It deliberately omits light novels,
// graphic novels, web-novel series, romance/erotic subtypes, and adaptations.
const SAFE_NOVEL_GENRE_IDS = Object.freeze([
  'Q1940294', 'Q3056541', 'Q465821', 'Q908667', 'Q2561390', 'Q44563',
  'Q512207', 'Q2016518', 'Q286328', 'Q538812', 'Q1248788', 'Q319226',
  'Q12132683', 'Q1426213', 'Q26928598', 'Q26987767', 'Q59342621',
  'Q67200374', 'Q6045975', 'Q192782', 'Q192239', 'Q208505', 'Q3440959',
  'Q21615367', 'Q223945', 'Q8261',
]);
const SAFE_NOVEL_GENRE_SET = new Set(SAFE_NOVEL_GENRE_IDS);
const BLOCKED_WORK_CLASS_IDS = new Set([
  'Q747381',      // light novel
  'Q104213567',   // light-novel series
  'Q725377',      // graphic novel
  'Q104902491',   // web-novel series
  'Q2421000',     // novelization
]);

// Reviewed seed registry of genuine novels. Wikidata still supplies every
// displayed fact and must prove one safe P136/P279* path to Q8261.
const EDITORIAL_WORLD_NOVEL_IDS = Object.freeze([
  'Q1396889', 'Q147787', 'Q170583', 'Q150827', 'Q183883', 'Q181488', 'Q6511',
  'Q163297', 'Q164974', 'Q82464', 'Q326914', 'Q193417', 'Q70806', 'Q215410',
  'Q182961', 'Q219552', 'Q189811', 'Q212340', 'Q207332', 'Q202009', 'Q200920',
  'Q215894', 'Q2870', 'Q151883', 'Q647379', 'Q457289', 'Q235795', 'Q274744',
  'Q206870', 'Q278208', 'Q523076', 'Q192649', 'Q326909', 'Q743180', 'Q612688',
  'Q212898', 'Q465360', 'Q860577', 'Q3107329', 'Q463108', 'Q595950', 'Q658288',
  'Q837934', 'Q460583', 'Q816528', 'Q1059553', 'Q1213085', 'Q1164083',
  'Q690362', 'Q1771810', 'Q836841', 'Q1570068', 'Q313129', 'Q1373644',
  'Q2362563', 'Q581180', 'Q2320903', 'Q705839', 'Q678277', 'Q1156969',
  'Q2092894', 'Q1233795', 'Q1195793', 'Q1618413', 'Q1168105', 'Q15080194',
  'Q692988', 'Q1045464', 'Q187655', 'Q968314', 'Q1129859', 'Q2267287',
  'Q330996', 'Q638327', 'Q1199651', 'Q1093483', 'Q1570020', 'Q1286961',
  'Q1217792', 'Q2449570', 'Q2476841', 'Q5400672', 'Q2668054', 'Q1197989',
  'Q1581581', 'Q1164830', 'Q1215312', 'Q2070380', 'Q137052', 'Q2712800',
  'Q2048624', 'Q567062', 'Q1788243', 'Q2896338', 'Q728622', 'Q2833629',
  'Q249242', 'Q1538984', 'Q2527126', 'Q1978467', 'Q599585', 'Q543562',
  'Q748075', 'Q784226', 'Q902712', 'Q1115619', 'Q1210978', 'Q2386048',
  'Q499564', 'Q472222', 'Q21162257', 'Q552238', 'Q1171287', 'Q3902626',
  'Q22263533', 'Q587945', 'Q1515513', 'Q1211006', 'Q97516163', 'Q941462',
  'Q2631465', 'Q980534', 'Q1145932', 'Q1444052', 'Q1736859', 'Q2156104',
  'Q969970', 'Q556786', 'Q1771746', 'Q3202572', 'Q1167837', 'Q5051290',
  'Q1917901', 'Q1615525', 'Q475459', 'Q2422578', 'Q1171407', 'Q2165270',
  'Q2659052', 'Q898056', 'Q1992620', 'Q2412167', 'Q646231', 'Q1776855',
  'Q991706', 'Q2948187', 'Q948984', 'Q570080', 'Q3962486', 'Q3823447',
  'Q5561577', 'Q880125', 'Q3363072', 'Q2603408', 'Q1450848', 'Q2056663',
  'Q822690', 'Q1605244', 'Q2632128', 'Q1249082', 'Q1247736', 'Q3300215',
  'Q3225437', 'Q1249393', 'Q2466980', 'Q805878', 'Q2293598', 'Q1635110',
  'Q3300421', 'Q1134140', 'Q2718131', 'Q1965615', 'Q1199412', 'Q386293',
  'Q1548029', 'Q206503', 'Q643203', 'Q96020629', 'Q2296752', 'Q2499771',
  'Q1044767', 'Q899334', 'Q248096', 'Q929821', 'Q339761', 'Q247372',
  'Q1050479', 'Q80771', 'Q578895', 'Q612523', 'Q1194031', 'Q772435',
  'Q1897870', 'Q277260', 'Q2387225', 'Q678251', 'Q386305', 'Q1784288',
  'Q1768890', 'Q2095705', 'Q1194357', 'Q1493270', 'Q100997892', 'Q2124771',
  'Q890170', 'Q1248760', 'Q2659311', 'Q1215261', 'Q58798753', 'Q1199348',
  'Q884454', 'Q2604590', 'Q3406503', 'Q3822155', 'Q3326411', 'Q1875311',
  'Q3079804', 'Q7728268', 'Q4784', 'Q806174', 'Q4411712', 'Q3187145',
  'Q3882301', 'Q7062779', 'Q7301985', 'Q10480203', 'Q4821361', 'Q3021799',
  'Q5246853', 'Q3149381', 'Q3987215', 'Q1394147', 'Q3549380', 'Q7765253',
  'Q108437440', 'Q60675668', 'Q385502', 'Q2696218', 'Q1767509', 'Q260016',
  'Q7716387', 'Q3822000', 'Q3548905', 'Q6945931', 'Q228988', 'Q4778145',
  'Q7746103', 'Q4919375', 'Q3874433', 'Q1936914', 'Q7719249', 'Q7745995',
  'Q347308', 'Q7549452', 'Q5052503', 'Q7737781', 'Q56761781',
]);
const EDITORIAL_NOVEL_RANK = new Map(EDITORIAL_WORLD_NOVEL_IDS.map((id, index) => [id, index + 1]));

const POET_QUERY = `SELECT DISTINCT ?item WHERE {
  ?item wdt:P31 wd:${HUMAN_ID}; wdt:P106 wd:${POET_ID}; wdt:P27 ?country; wdt:P570 ?deathDate.
  VALUES ?country { ${MODERN_ARAB_COUNTRIES.map(country => `wd:${country.id}`).join(' ')} }
} LIMIT 1600`;
const NOVEL_QUERY = `SELECT DISTINCT ?item WHERE {
  VALUES ?item { ${EDITORIAL_WORLD_NOVEL_IDS.map(id => `wd:${id}`).join(' ')} }
  ?item wdt:P136 ?genre.
  VALUES ?genre { ${SAFE_NOVEL_GENRE_IDS.map(id => `wd:${id}`).join(' ')} }
}`;

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const qidNumber = value => Number(String(value || '').replace(/^Q/u, '')) || 0;
const entityUrl = id => `https://www.wikidata.org/wiki/${id}`;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const cleanDisplay = value => String(value || '')
  .normalize('NFKC')
  .replace(DISPLAY_NOISE, ' ')
  .replace(/\s+و\s+/gu, ' و')
  .replace(/\s+/gu, ' ')
  .trim();
const normalize = value => cleanDisplay(value)
  .toLowerCase()
  .replace(/[\u064b-\u065f\u0670]/gu, '')
  .replace(/[\s\p{P}\p{S}]+/gu, '');

function jsonRead(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function jsonCanonical(value) {
  if (Array.isArray(value)) return `[${value.map(jsonCanonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${jsonCanonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sourceContentHash(source) {
  return sha256(jsonCanonical({
    schemaVersion: source.schemaVersion,
    sourceArtifactId: source.sourceArtifactId,
    constraints: source.constraints,
    modernArabCountries: source.modernArabCountries,
    datasets: source.datasets,
  }));
}

async function fetchJson(url, label) {
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 6) await sleep(attempt * 1_250);
    }
  }
  throw lastError;
}

async function fetchSparql(query, label) {
  const url = `${ENDPOINT}?${new URLSearchParams({ query, format: 'json' })}`;
  const payload = await fetchJson(url, label);
  return payload?.results?.bindings || [];
}

async function fetchEntities(ids, cache = new Map()) {
  const missing = [...new Set(ids)].filter(id => /^Q\d+$/u.test(id) && !cache.has(id));
  const batches = [];
  for (let offset = 0; offset < missing.length; offset += 50) batches.push(missing.slice(offset, offset + 50));
  for (let offset = 0; offset < batches.length; offset += 5) {
    const window = batches.slice(offset, offset + 5);
    const payloads = await Promise.all(window.map(async (batch, index) => {
      const url = `${ENTITY_API}?${new URLSearchParams({
        action: 'wbgetentities', format: 'json', ids: batch.join('|'),
        props: 'labels|claims|sitelinks', languages: 'ar', languagefallback: '0', origin: '*',
      })}`;
      return fetchJson(url, `Wikidata entities batch ${offset + index + 1}/${batches.length}`);
    }));
    payloads.forEach((payload, index) => {
      for (const id of window[index]) cache.set(id, payload.entities?.[id] || null);
    });
  }
  return cache;
}

function statementValue(statement) {
  if (statement?.rank === 'deprecated' || statement?.mainsnak?.snaktype !== 'value') return null;
  return statement.mainsnak.datavalue?.value ?? null;
}

function entityClaimEntries(entity, property, kind = 'entity') {
  const entries = [];
  for (const statement of entity?.claims?.[property] || []) {
    const raw = statementValue(statement);
    const value = kind === 'entity' ? raw?.id : raw;
    if (!value) continue;
    entries.push({ statementId: statement.id, rank: statement.rank || 'normal', value });
  }
  return entries;
}

function distinctEntityClaim(entity, property) {
  const entries = entityClaimEntries(entity, property);
  const ids = [...new Set(entries.map(entry => entry.value))];
  return {
    property,
    statementCount: entries.length,
    distinctValueCount: ids.length,
    valueIds: ids,
    statements: entries.map(entry => ({
      statementId: entry.statementId, rank: entry.rank, valueId: entry.value,
    })),
  };
}

function distinctTimeClaim(entity, property) {
  const entries = entityClaimEntries(entity, property, 'time');
  const keyFor = value => `${value.time}|${value.precision}|${value.calendarmodel || ''}`;
  const unique = new Map(entries.map(entry => [keyFor(entry.value), entry.value]));
  return {
    property,
    statementCount: entries.length,
    distinctValueCount: unique.size,
    values: [...unique.values()].map(value => ({
      time: value.time, precision: value.precision, calendarModel: value.calendarmodel || null,
    })),
    statements: entries.map(entry => ({
      statementId: entry.statementId,
      rank: entry.rank,
      value: {
        time: entry.value.time,
        precision: entry.value.precision,
        calendarModel: entry.value.calendarmodel || null,
      },
    })),
  };
}

function singletonTimeEvidence(entity, property, minimumPrecision = 9) {
  const claim = distinctTimeClaim(entity, property);
  if (claim.distinctValueCount !== 1 || Number(claim.values[0]?.precision) < minimumPrecision) return null;
  return { ...claim, value: claim.values[0] };
}

function singletonEntityEvidence(entity, property, labelById) {
  const claim = distinctEntityClaim(entity, property);
  if (claim.distinctValueCount !== 1) return null;
  const valueId = claim.valueIds[0];
  const valueLabel = labelById.get(valueId) || '';
  if (!valueLabel) return null;
  return { ...claim, valueId, valueLabel };
}

function selectedEntityEvidence(entity, property, labelById) {
  const claim = distinctEntityClaim(entity, property);
  const selectedValueId = claim.valueIds.find(valueId => labelById.get(valueId));
  if (!selectedValueId) return null;
  return {
    ...claim,
    selectedValueId,
    selectedValueLabel: labelById.get(selectedValueId),
    selectedStatementIds: claim.statements
      .filter(statement => statement.valueId === selectedValueId)
      .map(statement => statement.statementId),
  };
}

function uniqueYearEvidence(entity, property) {
  const claim = distinctTimeClaim(entity, property);
  const years = [...new Set(claim.values.map(value => signedYear(value.time)).filter(year => year !== null))];
  if (years.length !== 1) return null;
  return { ...claim, distinctYearCount: 1, selectedYear: years[0] };
}

function arabicLabel(entity) {
  const label = entity?.labels?.ar;
  return label?.language === 'ar' ? cleanDisplay(label.value) : '';
}

function safeArabicLabel(entity) {
  const label = arabicLabel(entity);
  return label && /\p{Script=Arabic}/u.test(label) && !/[A-Za-z]/u.test(label)
    && !/^Q\d+$/u.test(label) && !BANNED.test(label) ? label : '';
}

function sitelinkCount(entity) {
  return Object.keys(entity?.sitelinks || {}).length;
}

function signedYear(time) {
  const match = /^([+-])(\d{1,16})-/u.exec(String(time || ''));
  if (!match) return null;
  const year = Number(match[2]);
  return match[1] === '-' ? -year : year;
}

function sortByDifficulty(records) {
  return [...records].sort((left, right) =>
    Number(right.difficultyScore) - Number(left.difficultyScore)
      || Number(right.sitelinks) - Number(left.sitelinks)
      || left.subjectId.localeCompare(right.subjectId, 'en'));
}

function dedupeByLabel(records, labelField) {
  const seen = new Set();
  return records.filter(record => {
    const key = normalize(record[labelField]);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function hydrateClassHierarchy(startIds, cache) {
  let frontier = [...new Set(startIds)];
  for (let depth = 0; depth < 10 && frontier.length; depth += 1) {
    await fetchEntities(frontier, cache);
    const parents = [];
    for (const id of frontier) {
      if (id === NOVEL_ID) continue;
      for (const entry of entityClaimEntries(cache.get(id), 'P279')) parents.push(entry.value);
    }
    frontier = [...new Set(parents)].filter(id => !cache.has(id));
  }
  await fetchEntities([NOVEL_ID], cache);
}

function subclassPath(startId, cache) {
  const queue = [[startId]];
  const visited = new Set();
  while (queue.length) {
    const pathIds = queue.shift();
    const current = pathIds.at(-1);
    if (current === NOVEL_ID) {
      const edges = [];
      for (let index = 0; index < pathIds.length - 1; index += 1) {
        const fromId = pathIds[index];
        const toId = pathIds[index + 1];
        const statement = entityClaimEntries(cache.get(fromId), 'P279')
          .find(entry => entry.value === toId);
        if (!statement) return null;
        edges.push({
          fromId, property: 'P279', statementId: statement.statementId,
          rank: statement.rank, toId,
        });
      }
      return { rootId: NOVEL_ID, nodeIds: pathIds, edges };
    }
    if (visited.has(current)) continue;
    visited.add(current);
    const parents = entityClaimEntries(cache.get(current), 'P279')
      .map(entry => entry.value)
      .filter(id => !visited.has(id))
      .sort((a, b) => a.localeCompare(b, 'en'));
    for (const parent of parents) queue.push([...pathIds, parent]);
  }
  return null;
}

function loadHumanSeedIds() {
  const artifacts = [];
  const ids = new Set();
  const mintakaPath = path.join(ROOT, 'content/questions/structured-sources/mintaka-ar.json');
  const typesPath = path.join(ROOT, 'content/questions/structured-sources/mintaka-answer-types.json');
  if (fs.existsSync(mintakaPath) && fs.existsSync(typesPath)) {
    const mintakaText = fs.readFileSync(mintakaPath, 'utf8');
    const typesText = fs.readFileSync(typesPath, 'utf8');
    const records = JSON.parse(mintakaText).records || [];
    const types = JSON.parse(typesText).types || {};
    for (const record of records) {
      if (/^Q\d+$/u.test(record.answerEntityId)
        && (types[record.answerEntityId] || []).includes(HUMAN_ID)) ids.add(record.answerEntityId);
    }
    artifacts.push({ path: path.relative(ROOT, mintakaPath), sha256: sha256(mintakaText) });
    artifacts.push({ path: path.relative(ROOT, typesPath), sha256: sha256(typesText) });
  }
  const entityBatchPath = path.join(ROOT, 'content/questions/structured-sources/wikidata-entity-batch.json');
  if (fs.existsSync(entityBatchPath)) {
    const text = fs.readFileSync(entityBatchPath, 'utf8');
    for (const record of JSON.parse(text).records || []) {
      if (record.property === 'P50' && /^Q\d+$/u.test(record.answerId)) ids.add(record.answerId);
    }
    artifacts.push({ path: path.relative(ROOT, entityBatchPath), sha256: sha256(text) });
  }
  for (const id of EDITORIAL_HISTORICAL_PERSON_IDS) ids.add(id);
  if (ids.size < 300) throw new Error(`Human seed set is too small (${ids.size}).`);
  return { ids: [...ids].sort((a, b) => a.localeCompare(b, 'en')), artifacts };
}

const ROLE_RULES = Object.freeze([
  ['astronaut', /(?:رائد فضاء|رائدة فضاء|رائد كون)/u],
  ['religious', /(?:بابا|قس|كاهن|لاهوتي|عالم عقيدة|رجل دين|داعية)/u],
  // Keep this before athlete: the word رياضياتي begins with رياضي.
  ['scientist', /(?:عالم|عالمة|فيزيائي|كيميائي|فلكي|رياضياتي|مخترع|مهندس|طبيب|باحث)/u],
  ['athlete', /(?:لاعب|رياضي|ملاكم|متسابق|تنس|كرة القدم|سباح|كرة السلة|غولف)/u],
  ['activist', /(?:ناشط|ناشطة|حقوقي|مناضل|مصلح اجتماعي|بيئي|حماية البيئة)/u],
  ['actor', /(?:ممثل|ممثلة|كوميدي|مؤدي أصوات)/u],
  ['filmmaker', /(?:مخرج|مخرجة|منتج أفلام|سينمائي)/u],
  ['music', /(?:مغن|مغنية|موسيقي|موسيقية|ملحن|عازف|رابر|مؤلف موسيقي)/u],
  ['writer', /(?:كاتب|كاتبة|شاعر|شاعرة|روائي|روائية|أديب|أديبة|صحفي|مسرحي)/u],
  ['statesperson', /(?:سياسي|سياسية|رئيس|رئيسة|ملك|ملكة|ملكية|عاهل|رجل دولة|إمبراطور|حاكم|سلطان|أمير|دبلوماسي)/u],
  ['military', /(?:عسكري|قائد عسكري|ضابط|جنرال|مشير)/u],
  ['visual-artist', /(?:رسام|رسامة|نحات|فنان تشكيلي|مصور)/u],
  ['law', /(?:محام|محامية|قاض|قاضية|قانوني)/u],
  ['business', /(?:رجل أعمال|سيدة أعمال|مقاول|مصرفي|مدير تنفيذي)/u],
]);
const ACCEPTABLE_AWARD = /(?:نوبل|أوسكار|الأوسكار|غرامي|الكرة الذهبية|بوليتزر|غولدن غلوب|بافتا|إيمي|السعفة الذهبية|مركز كينيدي|جوائز جويا|الموسيقى الأمريكية|جائزة .*(?:أفضل|السلام|الأدب|العلوم|الرياضة)|قاعة مشاهير|قاعة الشهرة|وسام الحرية الرئاسي|ميدالية فيلدز|تورينغ|شارلمان|أنسفيلد|سيدني للسلام|بطل الاتحاد السوفيتي|ألعاب أولمبية|ميدالية أولمبية|إم في بي)/u;
const REJECTED_AWARD = /(?:إيغ نوبل|تايم 100|شخصية العام|وسام الحمام|وسام النجوم الثلاثة|فرسان مالطة|وسام ليوبولد|وسام سيرافيم|نيشان بيوس|فارس حدث|وسام الشوك|وسام العائلة الملكية|جزيرة إليس|عضوية قاعة مشاهير كاليفورنيا)/u;
const GOVERNING_POSITION = /^(?:رئيس(?! تنفيذي)|نائب رئيس|وزير|ملك(?:\s|$)|ملكة(?:\s|$)|عاهل|إمبراطور|حاكم|سلطان|أمير|شاه|فرعون|خان|شوغون|قنصل|عضو مجلس (?:الشيوخ|النواب)|زعيم|الزعيم|الأمين الأول.*حزب|لورد إيرلندا|كبير مستشاري)/u;
const RELIGIOUS_POSITION = /(?:بابا|بطريرك|رئيس أساقفة|أسقف)/u;
const HEAD_OF_STATE_POSITION = /^(?:رئيس الولايات|رئيس روسيا|رئيس (?:ال)?جمهورية|رئيس كوبا|رئيس الاتحاد|رئيس (?:ال)?وزراء|ملك(?:\s|$)|ملكة(?:\s|$)|عاهل|إمبراطور|سلطان|شاه|فرعون|الزعيم الأعلى)/u;

function isGoverningPosition(label) {
  return GOVERNING_POSITION.test(label)
    && !/^(?:رئيس لجنة|رئيس مجلس الإدارة|رئيس هيئة|رئيس جامعة|رئيس شركة|رئيس مهرجان|رئيس تحرير)/u.test(label);
}

function governingPositionPriority(label) {
  if (/^رئيس (?!مجلس|لجنة|هيئة|جامعة|شركة|مهرجان|تحرير|الكومنولث)/u.test(label)
    || /^(?:ملك(?:\s|$)|ملكة(?:\s|$)|عاهل المملكة|إمبراطور|سلطان|شاه|فرعون|الزعيم الأعلى)/u.test(label)) return 900;
  if (/^(?:رئيس (?:ال)?وزراء|رئيس مجلس مفوضي الشعب)/u.test(label)) return 800;
  if (/^(?:نائب رئيس|وزير الخارجية|وزير العدل|وزير(?:\s|$)|الأمين الأول.*حزب)/u.test(label)) return 600;
  if (/^(?:قنصل روماني|شوغون|خان)/u.test(label)) return 450;
  if (/^(?:أمير|لورد|ناخب|رئيس الكومنولث)/u.test(label)) return 150;
  return 300;
}

function roleFamily(label) {
  const plain = String(label || '').replace(/[\u064b-\u065f\u0670]/gu, '');
  return ROLE_RULES.find(([, pattern]) => pattern.test(plain))?.[0] || '';
}

function selectOccupation(entity, cache, requestedFamily = '') {
  const claim = distinctEntityClaim(entity, 'P106');
  const candidates = claim.statements.map((statement, statementIndex) => {
    const label = safeArabicLabel(cache.get(statement.valueId));
    return { ...statement, statementIndex, label, family: roleFamily(label) };
  }).filter(candidate => candidate.label && candidate.family);
  const positionLabels = entityClaimEntries(entity, 'P39')
    .map(entry => safeArabicLabel(cache.get(entry.value)))
    .filter(Boolean);
  const firstFamily = [...candidates].sort((left, right) => left.statementIndex - right.statementIndex)[0]?.family;
  let preferredFamily = requestedFamily;
  if (!preferredFamily && positionLabels.some(label => RELIGIOUS_POSITION.test(label))
    && candidates.some(candidate => candidate.family === 'religious')) preferredFamily = 'religious';
  else if (!preferredFamily && positionLabels.some(label => HEAD_OF_STATE_POSITION.test(label))
    && candidates.some(candidate => candidate.family === 'statesperson')) preferredFamily = 'statesperson';
  else if (!preferredFamily && positionLabels.some(isGoverningPosition)
    && candidates.some(candidate => candidate.family === 'statesperson')
    && !new Set(['athlete', 'actor', 'filmmaker', 'music', 'astronaut']).has(firstFamily)) {
    preferredFamily = 'statesperson';
  } else if (!preferredFamily && candidates.some(candidate => candidate.family === 'astronaut')) {
    preferredFamily = 'astronaut';
  } else if (!preferredFamily && candidates.some(candidate => candidate.family === 'athlete')) {
    preferredFamily = 'athlete';
  } else if (!preferredFamily && candidates.some(candidate => candidate.family === 'activist')) {
    preferredFamily = 'activist';
  }
  candidates.sort((left, right) =>
    (right.family === preferredFamily ? 1 : 0) - (left.family === preferredFamily ? 1 : 0)
      || left.statementIndex - right.statementIndex
      || sitelinkCount(cache.get(right.valueId)) - sitelinkCount(cache.get(left.valueId))
      || left.valueId.localeCompare(right.valueId, 'en'));
  const selected = candidates[0];
  if (!selected) return null;
  return {
    ...claim,
    selectedValueId: selected.valueId,
    selectedValueLabel: selected.label,
    selectedStatementId: selected.statementId,
    roleFamily: selected.family,
  };
}

const WRITTEN_WORK_CLASSES = new Set([
  'Q571', 'Q8261', 'Q7725634', 'Q47461344', 'Q1667921', 'Q614101',
  'Q47068459', 'Q17710986',
]);
const MUSIC_WORK_CLASSES = new Set(['Q105543609', 'Q482994', 'Q7366', 'Q134556', 'Q2188189']);
const SCREEN_WORK_CLASSES = new Set(['Q11424', 'Q5398426', 'Q15416']);

function factRoleHint(property, label, factEntity, availableFamilies, firstFamily) {
  const has = family => availableFamilies.has(family);
  if (property === 'P39') {
    if (RELIGIOUS_POSITION.test(label) && has('religious')) return 'religious';
    if (GOVERNING_POSITION.test(label) && has('statesperson')) return 'statesperson';
  }
  if (property === 'P166') {
    if (/(?:غرامي|موسيقى|أغنية|ألبوم|روك آند رول)/u.test(label) && has('music')) return 'music';
    if (/(?:الكرة الذهبية|لاعب|رياضي|أولمبي|إم في بي|كرة القدم|كرة السلة)/u.test(label)
      && has('athlete')) return 'athlete';
    if (/(?:السلام|حقوق الإنسان|أنسفيلد)/u.test(label) && has('activist')) return 'activist';
    if (/(?:أفضل فلم|أفضل فيلم|رسوم متحركة|مخرج)/u.test(label) && has('filmmaker')) return 'filmmaker';
    if (/(?:أوسكار|الأوسكار|غولدن غلوب|بافتا|إيمي|تمثيل|ممثل|ممثلة)/u.test(label)
      && has('actor')) return 'actor';
  }
  if (property === 'P800') {
    const types = new Set(entityClaimEntries(factEntity, 'P31').map(entry => entry.value));
    if ([...types].some(id => MUSIC_WORK_CLASSES.has(id)) && has('music')) return 'music';
    if ([...types].some(id => WRITTEN_WORK_CLASSES.has(id)) && has('writer')) {
      if ((firstFamily === 'scientist' || firstFamily === 'religious') && has(firstFamily)) return firstFamily;
      return 'writer';
    }
    if ([...types].some(id => SCREEN_WORK_CLASSES.has(id))) {
      if (firstFamily === 'actor' || firstFamily === 'filmmaker') return firstFamily;
      if (has('actor')) return 'actor';
      if (has('filmmaker')) return 'filmmaker';
    }
  }
  return '';
}

function selectDefiningFact(entity, properties, cache, family) {
  const candidates = [];
  const positionFamilies = new Set(['statesperson', 'religious', 'military', 'law', 'business']);
  const availableFamilies = new Set(entityClaimEntries(entity, 'P106')
    .map(entry => roleFamily(safeArabicLabel(cache.get(entry.value))))
    .filter(Boolean));
  const firstFamily = entityClaimEntries(entity, 'P106')
    .map(entry => roleFamily(safeArabicLabel(cache.get(entry.value))))
    .find(Boolean) || '';
  for (const property of properties) {
    const claim = distinctEntityClaim(entity, property);
    for (const statement of claim.statements) {
      const factEntity = cache.get(statement.valueId);
      const label = safeArabicLabel(factEntity);
      if (!label || UNSAFE_CREATIVE_WORK.test(label)) continue;
      if (property === 'P39' && (!positionFamilies.has(family)
        || (family === 'statesperson' && !isGoverningPosition(label))
        || (family === 'religious' && !RELIGIOUS_POSITION.test(label))
        || (family === 'military' && !/(?:قائد|رئيس أركان|وزير حرب|ضابط)/u.test(label))
        || (family === 'law' && !/(?:قاض|وزير العدل|مدعي)/u.test(label))
        || (family === 'business' && !/(?:رئيس تنفيذي|رئيس مجلس الإدارة)/u.test(label)))) continue;
      if (property === 'P166' && (REJECTED_AWARD.test(label)
        || /(?:راتزي|أسوأ)/u.test(label)
        || (!ACCEPTABLE_AWARD.test(label)
          && !(label.startsWith('جائزة') && sitelinkCount(factEntity) >= 18)))) continue;
      let propertyBonus;
      if (property === 'P39') propertyBonus = 1_400;
      else if (property === 'P800') propertyBonus = positionFamilies.has(family) ? 950 : 1_300;
      else propertyBonus = 850;
      const roleHint = factRoleHint(property, label, factEntity, availableFamilies, firstFamily);
      candidates.push({
        property,
        statement,
        label,
        sitelinks: sitelinkCount(factEntity),
        score: sitelinkCount(factEntity) + propertyBonus + (roleHint ? 500 : 0)
          + (property === 'P39' ? governingPositionPriority(label) : 0),
        roleHint,
        claim,
      });
    }
  }
  candidates.sort((left, right) => right.score - left.score
    || right.sitelinks - left.sitelinks
    || left.property.localeCompare(right.property, 'en')
    || left.statement.valueId.localeCompare(right.statement.valueId, 'en'));
  const selected = candidates[0];
  if (!selected) return null;
  return {
    ...selected.claim,
    selectedValueId: selected.statement.valueId,
    selectedValueLabel: selected.label,
    selectedStatementId: selected.statement.statementId,
    selectedRank: selected.statement.rank,
    selectedValueSitelinks: selected.sitelinks,
    selectionRoleHint: selected.roleHint || null,
  };
}

function humanRecord(entity, dataset, cache) {
  if (EDITORIAL_PERSON_EXCLUSIONS.has(entity?.id)) return null;
  const subjectLabel = safeArabicLabel(entity);
  if (!subjectLabel) return null;
  const instanceOf = distinctEntityClaim(entity, 'P31');
  if (instanceOf.distinctValueCount !== 1 || instanceOf.valueIds[0] !== HUMAN_ID) return null;
  const birthDate = singletonTimeEvidence(entity, 'P569', 9);
  const birthYear = signedYear(birthDate?.value?.time);
  if (!birthDate || birthYear === null) return null;
  if (dataset === 'whoAmI' && (birthYear < 1900 || birthYear > 2010)) return null;
  if (dataset === 'historicalFigures' && (birthYear >= 1900 || birthYear < -1500)) return null;
  let occupation = selectOccupation(entity, cache);
  const properties = ['P800', 'P39', 'P166'];
  if (!occupation) return null;
  const definingFact = selectDefiningFact(entity, properties, cache, occupation.roleFamily);
  if (!definingFact) return null;
  if (definingFact.selectionRoleHint) {
    occupation = selectOccupation(entity, cache, definingFact.selectionRoleHint) || occupation;
  }
  const definingFactClaims = Object.fromEntries(properties.map(property => [
    property,
    distinctEntityClaim(entity, property),
  ]));
  const recordKey = `wikidata-${entity.id}-${definingFact.property}-${definingFact.selectedValueId}`;
  return {
    recordKey,
    subjectId: entity.id,
    subjectLabel,
    birthYear,
    eraBucket: Math.floor(birthYear / (dataset === 'whoAmI' ? 25 : 100)),
    occupationId: occupation.selectedValueId,
    occupationLabel: occupation.selectedValueLabel,
    roleFamily: occupation.roleFamily,
    clueProperty: definingFact.property,
    clueId: definingFact.selectedValueId,
    clueLabel: definingFact.selectedValueLabel,
    sitelinks: sitelinkCount(entity),
    difficultyScore: sitelinkCount(entity),
    popularityMetric: 'wikimedia-sitelink-count',
    claim: {
      instanceOf: { ...instanceOf, requiredValueId: HUMAN_ID },
      birthDate,
      occupation,
      definingFact,
      definingFactClaims,
    },
  };
}

function poetRecord(entity, labelById) {
  if (EDITORIAL_POET_EXCLUSIONS.has(entity?.id)) return null;
  const subjectLabel = safeArabicLabel(entity);
  if (!subjectLabel) return null;
  const instanceOf = distinctEntityClaim(entity, 'P31');
  if (instanceOf.distinctValueCount !== 1 || instanceOf.valueIds[0] !== HUMAN_ID) return null;
  const occupation = distinctEntityClaim(entity, 'P106');
  const poetStatements = occupation.statements.filter(statement => statement.valueId === POET_ID);
  if (!poetStatements.length) return null;
  const citizenship = singletonEntityEvidence(entity, 'P27', labelById);
  if (!citizenship || !ARAB_COUNTRY_IDS.has(citizenship.valueId)) return null;
  const birthDate = singletonTimeEvidence(entity, 'P569', 9);
  const deathDate = singletonTimeEvidence(entity, 'P570', 9);
  const birthYear = signedYear(birthDate?.value?.time);
  const deathYear = signedYear(deathDate?.value?.time);
  // A modern-state nationality question is not asked about pre-modern poets.
  if (!birthDate || !deathDate || birthYear < 1800 || deathYear > 2020) return null;
  const editorialFameRank = EASY_ARAB_POET_RANK.get(entity.id) || null;
  return {
    recordKey: `wikidata-${entity.id}-P27-${citizenship.valueId}`,
    subjectId: entity.id,
    subjectLabel,
    countryId: citizenship.valueId,
    countryLabel: citizenship.valueLabel,
    birthYear,
    editorialFameRank,
    editorialEasyCandidate: Boolean(editorialFameRank),
    sitelinks: sitelinkCount(entity),
    difficultyScore: editorialFameRank ? 1_000_000 - editorialFameRank : sitelinkCount(entity),
    popularityMetric: editorialFameRank
      ? 'editorial-arab-poet-fame-v1+wikimedia-sitelink-count'
      : 'wikimedia-sitelink-count',
    claim: {
      instanceOf: { ...instanceOf, requiredValueId: HUMAN_ID },
      occupation: {
        ...occupation,
        requiredValueId: POET_ID,
        matchingStatementIds: poetStatements.map(statement => statement.statementId),
      },
      citizenship,
      birthDate,
      deathDate,
      editorialRegistry: editorialFameRank ? {
        registry: 'fatinah-famous-arab-poets-v1',
        entityId: entity.id,
        rank: editorialFameRank,
      } : null,
    },
  };
}

function novelRecord(entity, authorEntity, labelById, cache) {
  const subjectLabel = safeArabicLabel(entity);
  const authorLabel = safeArabicLabel(authorEntity);
  if (!subjectLabel || !authorLabel || UNSAFE_CREATIVE_WORK.test(subjectLabel)) return null;
  const workInstanceOf = distinctEntityClaim(entity, 'P31');
  if (!workInstanceOf.distinctValueCount
    || (workInstanceOf.distinctValueCount === 1 && workInstanceOf.valueIds[0] === GENERIC_BOOK_ID)
    || workInstanceOf.valueIds.some(id => BLOCKED_WORK_CLASS_IDS.has(id))) return null;
  const genre = distinctEntityClaim(entity, 'P136');
  if (genre.valueIds.some(id => BLOCKED_WORK_CLASS_IDS.has(id))) return null;
  const qualifyingGenres = genre.valueIds
    .filter(id => SAFE_NOVEL_GENRE_SET.has(id))
    .map(id => ({ id, path: subclassPath(id, cache) }))
    .filter(candidate => candidate.path?.nodeIds?.at(-1) === NOVEL_ID)
    .sort((left, right) => SAFE_NOVEL_GENRE_IDS.indexOf(left.id) - SAFE_NOVEL_GENRE_IDS.indexOf(right.id)
      || left.id.localeCompare(right.id, 'en'));
  if (!qualifyingGenres.length) return null;
  const directClassId = qualifyingGenres[0].id;
  const author = singletonEntityEvidence(entity, 'P50', labelById);
  if (!author || author.valueId !== authorEntity?.id) return null;
  const authorInstanceOf = distinctEntityClaim(authorEntity, 'P31');
  if (authorInstanceOf.distinctValueCount !== 1 || authorInstanceOf.valueIds[0] !== HUMAN_ID) return null;
  const language = selectedEntityEvidence(entity, 'P407', labelById);
  const authorBirthDate = uniqueYearEvidence(authorEntity, 'P569');
  const authorBirthYear = authorBirthDate?.selectedYear;
  if (!language || !authorBirthDate || authorBirthYear === null) return null;
  return {
    recordKey: `wikidata-${entity.id}-P50-${authorEntity.id}`,
    subjectId: entity.id,
    subjectLabel,
    authorId: authorEntity.id,
    authorLabel,
    authorBirthYear,
    languageId: language.selectedValueId,
    languageLabel: language.selectedValueLabel,
    genreId: directClassId,
    genreLabel: safeArabicLabel(cache.get(directClassId)),
    editorialRank: EDITORIAL_NOVEL_RANK.get(entity.id),
    sitelinks: sitelinkCount(entity),
    difficultyScore: sitelinkCount(entity),
    popularityMetric: 'wikimedia-sitelink-count-on-editorially-reviewed-novels-v1',
    claim: {
      workInstanceOf: {
        ...workInstanceOf,
        genericBookOnlyIdRejected: GENERIC_BOOK_ID,
      },
      classification: {
        ...genre,
        property: 'P136',
        directClassId,
        directClassLabel: safeArabicLabel(cache.get(directClassId)) || null,
        requiredRootClassId: NOVEL_ID,
        path: qualifyingGenres[0].path,
      },
      author,
      authorInstanceOf: {
        subjectId: authorEntity.id,
        ...authorInstanceOf,
        requiredValueId: HUMAN_ID,
      },
      language,
      authorBirthDate,
      editorialRegistry: {
        registry: 'fatinah-world-novels-v1',
        entityId: entity.id,
        rank: EDITORIAL_NOVEL_RANK.get(entity.id),
      },
    },
  };
}

function tooSimilar(left, right) {
  return optionTooSimilar(left, right);
}

function insertCorrectOption(record, distractors, correct) {
  const a = qidNumber(record.subjectId) % 4;
  const options = [...distractors];
  options.splice(a, 0, correct);
  return { a, options };
}

function personOptionContract(pool, record) {
  const candidates = pool.filter(candidate => {
    if (candidate.subjectId === record.subjectId || candidate.roleFamily !== record.roleFamily
      || tooSimilar(candidate.subjectLabel, record.subjectLabel)) return false;
    const samePropertyValues = candidate.claim?.definingFactClaims?.[record.clueProperty]?.valueIds || [];
    return !samePropertyValues.includes(record.clueId);
  }).sort((left, right) => {
    const leftExact = left.occupationId === record.occupationId ? 1 : 0;
    const rightExact = right.occupationId === record.occupationId ? 1 : 0;
    const leftEra = left.eraBucket === record.eraBucket ? 1 : 0;
    const rightEra = right.eraBucket === record.eraBucket ? 1 : 0;
    return rightEra - leftEra
      || rightExact - leftExact
      || Math.abs(left.birthYear - record.birthYear) - Math.abs(right.birthYear - record.birthYear)
      || right.sitelinks - left.sitelinks
      || left.subjectId.localeCompare(right.subjectId, 'en');
  });
  const picked = [];
  for (const candidate of candidates) {
    if (picked.some(item => tooSimilar(item.subjectLabel, candidate.subjectLabel))) continue;
    picked.push(candidate);
    if (picked.length === 3) break;
  }
  if (picked.length !== 3) return null;
  const contract = insertCorrectOption(record, picked.map(candidate => ({
    label: candidate.subjectLabel,
    entityId: candidate.subjectId,
    recordKey: candidate.recordKey,
  })), {
    label: record.subjectLabel,
    entityId: record.subjectId,
    recordKey: record.recordKey,
  });
  return {
    ...contract,
    semanticGroup: `human-role:${record.roleFamily}`,
    exactOccupationOptionCount: contract.options.filter(option => {
      const candidate = pool.find(item => item.recordKey === option.recordKey);
      return candidate?.occupationId === record.occupationId;
    }).length,
    maximumBirthYearDistance: Math.max(...picked.map(candidate =>
      Math.abs(candidate.birthYear - record.birthYear))),
  };
}

function poetOptionContract(record) {
  const answerIndex = MODERN_ARAB_COUNTRIES.findIndex(country => country.id === record.countryId);
  if (answerIndex < 0) return null;
  const distractors = [];
  for (let step = 1; step < MODERN_ARAB_COUNTRIES.length * 2 && distractors.length < 3; step += 1) {
    const candidate = MODERN_ARAB_COUNTRIES[(answerIndex + step * 5) % MODERN_ARAB_COUNTRIES.length];
    if (candidate.id !== record.countryId && !distractors.some(item => item.id === candidate.id)) {
      distractors.push(candidate);
    }
  }
  const contract = insertCorrectOption(record, distractors.map(country => ({
    label: country.label,
    entityId: country.id,
    recordKey: `arab-country-${country.id}`,
  })), {
    label: record.countryLabel,
    entityId: record.countryId,
    recordKey: `arab-country-${record.countryId}`,
  });
  return { ...contract, semanticGroup: 'modern-arab-country' };
}

function novelOptionContract(pool, record) {
  const candidates = pool.filter(candidate => candidate.subjectId !== record.subjectId
    && candidate.languageId === record.languageId
    && candidate.authorId !== record.authorId
    && !tooSimilar(candidate.authorLabel, record.authorLabel))
    .sort((left, right) => {
      const leftEra = Math.floor(left.authorBirthYear / 50) === Math.floor(record.authorBirthYear / 50) ? 1 : 0;
      const rightEra = Math.floor(right.authorBirthYear / 50) === Math.floor(record.authorBirthYear / 50) ? 1 : 0;
      return rightEra - leftEra
        || Math.abs(left.authorBirthYear - record.authorBirthYear)
          - Math.abs(right.authorBirthYear - record.authorBirthYear)
        || right.sitelinks - left.sitelinks
        || left.authorId.localeCompare(right.authorId, 'en');
    });
  const picked = [];
  for (const candidate of candidates) {
    if (picked.some(item => item.authorId === candidate.authorId
      || tooSimilar(item.authorLabel, candidate.authorLabel))) continue;
    picked.push(candidate);
    if (picked.length === 3) break;
  }
  if (picked.length !== 3) return null;
  const contract = insertCorrectOption(record, picked.map(candidate => ({
    label: candidate.authorLabel,
    entityId: candidate.authorId,
    recordKey: candidate.recordKey,
  })), {
    label: record.authorLabel,
    entityId: record.authorId,
    recordKey: record.recordKey,
  });
  return {
    ...contract,
    semanticGroup: `human-author-language:${record.languageId}`,
    maximumAuthorBirthYearDistance: Math.max(...picked.map(candidate =>
      Math.abs(candidate.authorBirthYear - record.authorBirthYear))),
  };
}

function withStableOptionContracts(records, contractFor) {
  let pool = records.map(record => ({ ...record }));
  for (let pass = 0; pass < 4; pass += 1) {
    const next = pool.map(record => ({ ...record, optionContract: contractFor(pool, record) }))
      .filter(record => record.optionContract);
    if (next.length === pool.length) return next;
    pool = next;
  }
  return pool.map(record => ({ ...record, optionContract: contractFor(pool, record) }))
    .filter(record => record.optionContract);
}

export function rebuildPeopleLiteratureOptionContracts({ sourcePath = SOURCE_PATH } = {}) {
  const source = jsonRead(sourcePath);
  const datasets = source?.datasets || {};
  datasets.whoAmI = withStableOptionContracts(
    datasets.whoAmI || [], personOptionContract);
  datasets.historicalFigures = withStableOptionContracts(
    datasets.historicalFigures || [], personOptionContract);
  datasets.arabPoets = (datasets.arabPoets || [])
    .map(record => ({ ...record, optionContract: poetOptionContract(record) }))
    .filter(record => record.optionContract);
  datasets.worldNovels = withStableOptionContracts(
    datasets.worldNovels || [], novelOptionContract);
  for (const [dataset, records] of Object.entries(datasets)) {
    if (records.length < 100) {
      throw new Error(`${dataset}: only ${records.length}/100 after strict option rebuild`);
    }
  }
  if (source.constraints?.humans) {
    source.constraints.humans.optionGrouping = 'same-role-family-then-nearest-birth-era-v2-strict-distinct';
  }
  if (source.constraints?.novels) {
    source.constraints.novels.optionGrouping = 'same-original-language-then-nearest-author-era-v2-strict-distinct';
  }
  source.contentSha256 = sourceContentHash(source);
  fs.writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
  return source;
}

export async function refreshPeopleLiteratureSource({ outputPath = SOURCE_PATH } = {}) {
  const retrievedAt = new Date().toISOString();
  const seeds = loadHumanSeedIds();
  const [poetBindings, novelBindings] = await Promise.all([
    fetchSparql(POET_QUERY, 'Arab poets query'),
    fetchSparql(NOVEL_QUERY, 'Reviewed novels query'),
  ]);
  const bindingIds = bindings => [...new Set(bindings.map(binding =>
    String(binding.item?.value || '').split('/').pop()).filter(id => /^Q\d+$/u.test(id)))];
  const poetIds = bindingIds(poetBindings);
  const novelIds = bindingIds(novelBindings);
  const cache = new Map();
  await fetchEntities([...seeds.ids, ...poetIds, ...novelIds], cache);

  const humanEntities = seeds.ids.map(id => cache.get(id)).filter(Boolean);
  const poetEntities = poetIds.map(id => cache.get(id)).filter(Boolean);
  const novelEntities = novelIds.map(id => cache.get(id)).filter(Boolean);
  const humanCandidates = humanEntities.filter(entity => {
    const birth = singletonTimeEvidence(entity, 'P569', 9);
    const year = signedYear(birth?.value?.time);
    return year !== null && year >= -1500 && year <= 2010;
  }).sort((left, right) => sitelinkCount(right) - sitelinkCount(left)).slice(0, 1200);

  const relatedIds = new Set();
  for (const entity of humanCandidates) {
    for (const property of ['P106', 'P800', 'P166', 'P39']) {
      for (const entry of entityClaimEntries(entity, property)) relatedIds.add(entry.value);
    }
  }
  for (const entity of poetEntities) {
    for (const entry of entityClaimEntries(entity, 'P27')) relatedIds.add(entry.value);
  }
  for (const entity of novelEntities) {
    for (const property of ['P50', 'P31', 'P136', 'P407']) {
      for (const entry of entityClaimEntries(entity, property)) relatedIds.add(entry.value);
    }
  }
  await fetchEntities([...relatedIds], cache);

  const novelAuthorIds = novelEntities.flatMap(entity =>
    entityClaimEntries(entity, 'P50').map(entry => entry.value));
  await fetchEntities(novelAuthorIds, cache);
  const novelGenreIds = novelEntities.flatMap(entity =>
    entityClaimEntries(entity, 'P136').map(entry => entry.value));
  await hydrateClassHierarchy(novelGenreIds, cache);

  const labelById = new Map([...cache.entries()].map(([id, entity]) => [id, safeArabicLabel(entity)]));
  let whoAmI = dedupeByLabel(sortByDifficulty(humanCandidates
    .map(entity => humanRecord(entity, 'whoAmI', cache)).filter(Boolean)), 'subjectLabel').slice(0, 300);
  let historicalFigures = dedupeByLabel(sortByDifficulty(humanCandidates
    .map(entity => humanRecord(entity, 'historicalFigures', cache)).filter(Boolean)), 'subjectLabel').slice(0, 240);
  let arabPoets = dedupeByLabel(sortByDifficulty(poetEntities
    .map(entity => poetRecord(entity, labelById)).filter(Boolean)), 'subjectLabel').slice(0, 320);
  let worldNovels = dedupeByLabel(sortByDifficulty(novelEntities.map(entity => {
    const authorId = distinctEntityClaim(entity, 'P50').valueIds[0];
    return novelRecord(entity, cache.get(authorId), labelById, cache);
  }).filter(Boolean)), 'subjectLabel');

  whoAmI = withStableOptionContracts(whoAmI, personOptionContract);
  historicalFigures = withStableOptionContracts(historicalFigures, personOptionContract);
  arabPoets = arabPoets.map(record => ({ ...record, optionContract: poetOptionContract(record) }))
    .filter(record => record.optionContract);
  worldNovels = withStableOptionContracts(worldNovels, novelOptionContract);

  const datasets = {
    whoAmI: sortByDifficulty(whoAmI),
    historicalFigures: sortByDifficulty(historicalFigures),
    arabPoets: sortByDifficulty(arabPoets),
    worldNovels: sortByDifficulty(worldNovels),
  };
  for (const [name, records] of Object.entries(datasets)) {
    if (records.length < 100) throw new Error(`${name}: only ${records.length}/100 eligible records.`);
  }
  if (datasets.arabPoets.filter(record => record.editorialEasyCandidate).length < 30) {
    throw new Error('arabPoets: fewer than 30 reviewed famous easy candidates.');
  }

  const document = {
    schemaVersion: 2,
    sourceArtifactId: SOURCE_ARTIFACT_ID,
    sourceProfile: 'wikidata-source-record-fields-v2',
    endpoint: ENDPOINT,
    entityApi: ENTITY_API,
    retrievedAt,
    license: 'CC0 1.0',
    constraints: {
      humans: {
        instanceOfProperty: 'P31', requiredValueId: HUMAN_ID,
        occupationProperty: 'P106', definingFactProperties: ['P800', 'P166', 'P39'],
        optionGrouping: 'same-role-family-then-nearest-birth-era-v1',
      },
      poets: {
        property: 'P106', requiredValueId: POET_ID,
        citizenshipProperty: 'P27', citizenshipDistinctValueCount: 1,
        countryRegistry: 'current-arab-league-member-states-v1',
        minimumBirthYear: 1800, deceasedOnly: true,
        easyRegistry: 'fatinah-famous-arab-poets-v1',
      },
      novels: {
        workInstanceOfProperty: 'P31', genericBookOnlyIdRejected: GENERIC_BOOK_ID,
        classificationProperty: 'P136', subclassProperty: 'P279',
        requiredRootClassId: NOVEL_ID, blockedClasses: [...BLOCKED_WORK_CLASS_IDS],
        authorProperty: 'P50', authorDistinctValueCount: 1,
        authorInstanceOfProperty: 'P31', authorRequiredValueId: HUMAN_ID,
        languageProperty: 'P407', languageSelection: 'one documented original-language value',
        editorialRegistry: 'fatinah-world-novels-v1',
        optionGrouping: 'same-original-language-then-nearest-author-era-v1',
      },
      textCleaning: {
        normalization: 'NFKC', removed: ['underscore', 'tatweel', 'bidi-controls'],
      },
      difficulty: {
        metric: 'editorial-fame-gate-for-arab-poet-easy; otherwise Wikimedia sitelink count',
        order: 'descending',
        bands: { easy: 'ranks 1-30', medium: 'ranks 31-60', hard: 'ranks 61-90' },
      },
    },
    queries: {
      arabPoets: { sha256: sha256(POET_QUERY), sparql: POET_QUERY },
      worldNovels: { sha256: sha256(NOVEL_QUERY), sparql: NOVEL_QUERY },
      humanSeeds: {
        method: 'locally cached entity IDs revalidated against Wikidata claims',
        artifacts: seeds.artifacts,
      },
      editorialRegistries: {
        famousArabPoetsSha256: sha256(EASY_ARAB_POET_IDS.join('|')),
        worldNovelsSha256: sha256(EDITORIAL_WORLD_NOVEL_IDS.join('|')),
        historicalPeopleDiscoverySha256: sha256(EDITORIAL_HISTORICAL_PERSON_IDS.join('|')),
      },
    },
    modernArabCountries: MODERN_ARAB_COUNTRIES,
    datasets,
  };
  document.contentSha256 = sourceContentHash(document);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`);
  return document;
}

function validSubclassEvidence(classification) {
  const pathEvidence = classification?.path;
  return classification?.property === 'P136'
    && classification?.valueIds?.includes(classification.directClassId)
    && SAFE_NOVEL_GENRE_SET.has(classification.directClassId)
    && classification.requiredRootClassId === NOVEL_ID
    && pathEvidence?.nodeIds?.[0] === classification.directClassId
    && pathEvidence?.nodeIds?.at(-1) === NOVEL_ID
    && Array.isArray(pathEvidence.edges)
    && pathEvidence.edges.length === pathEvidence.nodeIds.length - 1
    && pathEvidence.edges.every((edge, index) => edge.property === 'P279'
      && edge.fromId === pathEvidence.nodeIds[index]
      && edge.toId === pathEvidence.nodeIds[index + 1]
      && Boolean(edge.statementId));
}

function cleanTextInvariant(value) {
  const text = String(value || '');
  return text === cleanDisplay(text) && !DISPLAY_NOISE_TEST.test(text);
}

function sourceErrors(source) {
  const errors = [];
  const fail = message => errors.push(message);
  if (source?.schemaVersion !== 2) fail('source.schemaVersion must be 2');
  if (source?.sourceArtifactId !== SOURCE_ARTIFACT_ID) fail('unexpected sourceArtifactId');
  if (source?.contentSha256 !== sourceContentHash(source || {})) fail('source contentSha256 mismatch');
  const datasets = source?.datasets || {};
  const allRecordKeys = new Set();

  for (const [dataset, records] of Object.entries(datasets)) {
    if (!Array.isArray(records) || records.length < 100) fail(`${dataset}: fewer than 100 source records`);
    let previous = Infinity;
    for (const record of records || []) {
      if (!record?.recordKey || allRecordKeys.has(record.recordKey)) fail(`${dataset}: duplicate/missing recordKey`);
      allRecordKeys.add(record?.recordKey);
      if (!/^Q\d+$/u.test(record?.subjectId || '')) fail(`${record?.recordKey}: invalid subjectId`);
      if (!cleanTextInvariant(record?.subjectLabel) || !/\p{Script=Arabic}/u.test(record?.subjectLabel || '')
        || /[A-Za-z]/u.test(record?.subjectLabel || '') || BANNED.test(JSON.stringify(record))) {
        fail(`${record?.recordKey}: unsafe or unclean Arabic display text`);
      }
      if (!Number.isInteger(record?.sitelinks) || record.sitelinks < 0
        || !Number.isFinite(record?.difficultyScore)) fail(`${record?.recordKey}: invalid popularity data`);
      if (record.difficultyScore > previous) fail(`${dataset}: source is not difficulty-sorted`);
      previous = record.difficultyScore;
      const contract = record.optionContract;
      if (!contract || !Number.isInteger(contract.a) || contract.a < 0 || contract.a > 3
        || !Array.isArray(contract.options) || contract.options.length !== 4
        || new Set(contract.options.map(option => option.entityId)).size !== 4
        || new Set(contract.options.map(option => normalize(option.label))).size !== 4) {
        fail(`${record?.recordKey}: invalid option contract`);
      }
      if (contract?.options?.some(option => !cleanTextInvariant(option.label)
        || BANNED.test(option.label))) fail(`${record?.recordKey}: unclean option contract`);
    }
  }

  for (const dataset of ['whoAmI', 'historicalFigures']) {
    const records = datasets[dataset] || [];
    const byKey = new Map(records.map(record => [record.recordKey, record]));
    for (const record of records) {
      const human = record.claim?.instanceOf;
      const occupation = record.claim?.occupation;
      const fact = record.claim?.definingFact;
      const factClaim = record.claim?.definingFactClaims?.[record.clueProperty];
      if (human?.distinctValueCount !== 1 || human.valueIds?.[0] !== HUMAN_ID) {
        fail(`${record.recordKey}: person is not exactly P31=Q5`);
      }
      if (record.claim?.birthDate?.distinctValueCount !== 1
        || signedYear(record.claim.birthDate.value?.time) !== record.birthYear) {
        fail(`${record.recordKey}: invalid singleton birth-year evidence`);
      }
      if (!occupation?.valueIds?.includes(record.occupationId)
        || occupation.selectedValueId !== record.occupationId
        || occupation.selectedValueLabel !== record.occupationLabel
        || occupation.roleFamily !== record.roleFamily
        || !occupation.statements?.some(statement => statement.statementId === occupation.selectedStatementId
          && statement.valueId === record.occupationId)) {
        fail(`${record.recordKey}: invalid occupation selection`);
      }
      const allowedProperties = ['P800', 'P39', 'P166'];
      if (!allowedProperties.includes(record.clueProperty)
        || fact?.property !== record.clueProperty
        || fact.selectedValueId !== record.clueId
        || fact.selectedValueLabel !== record.clueLabel
        || !fact.valueIds?.includes(record.clueId)
        || !fact.statements?.some(statement => statement.statementId === fact.selectedStatementId
          && statement.valueId === record.clueId)
        || !factClaim?.valueIds?.includes(record.clueId)) {
        fail(`${record.recordKey}: invalid defining-fact selection`);
      }
      const correct = record.optionContract?.options?.[record.optionContract.a];
      if (correct?.entityId !== record.subjectId || correct?.recordKey !== record.recordKey
        || correct?.label !== record.subjectLabel) fail(`${record.recordKey}: wrong correct person option`);
      for (const option of record.optionContract?.options || []) {
        const candidate = byKey.get(option.recordKey);
        if (!candidate || candidate.subjectId !== option.entityId || candidate.subjectLabel !== option.label
          || candidate.roleFamily !== record.roleFamily) {
          fail(`${record.recordKey}: person distractor is not from the same role family`);
          continue;
        }
        if (candidate.subjectId !== record.subjectId
          && candidate.claim?.definingFactClaims?.[record.clueProperty]?.valueIds?.includes(record.clueId)) {
          fail(`${record.recordKey}: defining clue also applies to a distractor`);
        }
      }
    }
  }

  const poets = datasets.arabPoets || [];
  let famousPoetCount = 0;
  for (const record of poets) {
    const human = record.claim?.instanceOf;
    const occupation = record.claim?.occupation;
    const citizenship = record.claim?.citizenship;
    if (human?.distinctValueCount !== 1 || human.valueIds?.[0] !== HUMAN_ID
      || occupation?.requiredValueId !== POET_ID || !occupation.valueIds?.includes(POET_ID)
      || !occupation.matchingStatementIds?.length) fail(`${record.recordKey}: invalid direct poet identity`);
    if (citizenship?.distinctValueCount !== 1 || citizenship.valueId !== record.countryId
      || !ARAB_COUNTRY_IDS.has(record.countryId)) fail(`${record.recordKey}: invalid modern-Arab P27 singleton`);
    if (record.birthYear < 1800 || record.claim?.birthDate?.distinctValueCount !== 1
      || record.claim?.deathDate?.distinctValueCount !== 1
      || signedYear(record.claim.deathDate.value?.time) > 2020) {
      fail(`${record.recordKey}: nationality could be historically misleading or mutable`);
    }
    if (record.editorialEasyCandidate) {
      famousPoetCount += 1;
      if (record.claim?.editorialRegistry?.registry !== 'fatinah-famous-arab-poets-v1'
        || !EASY_ARAB_POET_RANK.has(record.subjectId)) fail(`${record.recordKey}: bad famous-poet registry proof`);
    }
    const correct = record.optionContract?.options?.[record.optionContract.a];
    if (correct?.entityId !== record.countryId || correct?.label !== record.countryLabel
      || record.optionContract?.options?.some(option => !ARAB_COUNTRY_IDS.has(option.entityId))) {
      fail(`${record.recordKey}: invalid country option contract`);
    }
  }
  if (famousPoetCount < 30) fail(`arabPoets: only ${famousPoetCount}/30 famous easy candidates`);

  const novels = datasets.worldNovels || [];
  const novelsByKey = new Map(novels.map(record => [record.recordKey, record]));
  for (const record of novels) {
    const workType = record.claim?.workInstanceOf;
    const author = record.claim?.author;
    const authorHuman = record.claim?.authorInstanceOf;
    const language = record.claim?.language;
    if (!workType?.distinctValueCount
      || (workType.distinctValueCount === 1 && workType.valueIds?.[0] === GENERIC_BOOK_ID)
      || workType.valueIds?.some(id => BLOCKED_WORK_CLASS_IDS.has(id))) {
      fail(`${record.recordKey}: generic-book-only or blocked P31`);
    }
    if (!validSubclassEvidence(record.claim?.classification)) fail(`${record.recordKey}: invalid P136/P279 novel proof`);
    if (author?.distinctValueCount !== 1 || author.valueId !== record.authorId
      || authorHuman?.distinctValueCount !== 1 || authorHuman.valueIds?.[0] !== HUMAN_ID) {
      fail(`${record.recordKey}: author is not a single Q5 human`);
    }
    if (!language?.valueIds?.includes(record.languageId)
      || language.selectedValueId !== record.languageId
      || language.selectedValueLabel !== record.languageLabel
      || record.claim?.authorBirthDate?.distinctYearCount !== 1
      || record.claim.authorBirthDate.selectedYear !== record.authorBirthYear) {
      fail(`${record.recordKey}: missing selected language/unified author-era evidence`);
    }
    if (record.claim?.editorialRegistry?.registry !== 'fatinah-world-novels-v1'
      || !EDITORIAL_NOVEL_RANK.has(record.subjectId)
      || UNSAFE_CREATIVE_WORK.test(record.subjectLabel)) fail(`${record.recordKey}: failed novel editorial gate`);
    const correct = record.optionContract?.options?.[record.optionContract.a];
    if (correct?.entityId !== record.authorId || correct?.label !== record.authorLabel
      || correct?.recordKey !== record.recordKey) fail(`${record.recordKey}: wrong correct author option`);
    for (const option of record.optionContract?.options || []) {
      const candidate = novelsByKey.get(option.recordKey);
      if (!candidate || candidate.authorId !== option.entityId || candidate.authorLabel !== option.label
        || candidate.languageId !== record.languageId) {
        fail(`${record.recordKey}: author distractor is not same-language sourced human`);
      }
    }
  }
  return errors;
}

function naturalArabicDisplayLabel(value) {
  return String(value || '')
    .replace(/مغن مؤلف/gu, 'مغنٍ وكاتب أغانٍ')
    .replace(/ممثل تلفزي/gu, 'ممثل تلفزيوني')
    .replace(/شخص سئ/gu, 'شخص سيئ')
    .replace(/\bفلم\b/gu, 'فيلم');
}

function questionText(record, dataset) {
  if (dataset === 'arabPoets') {
    return `ما جنسية الشاعر أو الأديب العربي «${record.subjectLabel}»؟`;
  }
  if (dataset === 'worldNovels') return `من مؤلف رواية «${record.subjectLabel}»؟`;
  const role = naturalArabicDisplayLabel(record.occupationLabel);
  const clue = naturalArabicDisplayLabel(record.clueLabel);
  if (dataset === 'whoAmI') {
    if (record.clueProperty === 'P800') return `أُعرف مهنيًا بصفة «${role}»، ومن أعمالي البارزة «${clue}». فمن أنا؟`;
    if (record.clueProperty === 'P39') return `أُعرف مهنيًا بصفة «${role}»، وتوليت منصب «${clue}». فمن أنا؟`;
    return `أُعرف مهنيًا بصفة «${role}»، وقد نلت «${clue}». فمن أنا؟`;
  }
  const positiveCenturyNames = [
    '', 'الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع',
    'الثامن', 'التاسع', 'العاشر', 'الحادي عشر', 'الثاني عشر', 'الثالث عشر',
    'الرابع عشر', 'الخامس عشر', 'السادس عشر', 'السابع عشر', 'الثامن عشر',
    'التاسع عشر', 'العشرين',
  ];
  const centuryNumber = record.birthYear > 0
    ? Math.floor((record.birthYear - 1) / 100) + 1
    : Math.floor((Math.abs(record.birthYear) - 1) / 100) + 1;
  const centuryName = positiveCenturyNames[centuryNumber] || String(centuryNumber);
  const era = `من مواليد القرن ${centuryName}${record.birthYear < 0 ? ' قبل الميلاد' : ''}`;
  if (record.clueProperty === 'P800') {
    return `أي شخصية تاريخية ${era}، عُرفت مهنيًا بصفة «${role}»، ومن أعمالها البارزة «${clue}»؟`;
  }
  if (record.clueProperty === 'P39') {
    return `أي شخصية تاريخية ${era}، عُرفت مهنيًا بصفة «${role}»، وتولت منصب «${clue}»؟`;
  }
  return `أي شخصية تاريخية ${era}، عُرفت مهنيًا بصفة «${role}»، ونالت «${clue}»؟`;
}

function templateSuffix(property) {
  if (property === 'P800') return 'notable-work';
  if (property === 'P166') return 'award';
  if (property === 'P39') return 'position';
  return 'fact';
}

function expectedQuestionContract(category, record) {
  const dataset = DATASET_BY_CATEGORY[category];
  if (!dataset) return null;
  if (dataset === 'whoAmI' || dataset === 'historicalFigures') {
    return {
      dataset,
      q: questionText(record, dataset),
      answer: record.subjectLabel,
      answerEntityId: record.subjectId,
      factKey: `wikidata:${record.subjectId}:${record.clueProperty}:${record.clueId}`,
      templateId: `wikidata-${dataset === 'whoAmI' ? 'who-am-i' : 'historical'}-role-${templateSuffix(record.clueProperty)}-v2`,
      verificationProfile: 'wikidata-q5-role-defining-fact-option-exclusive-v2',
      answerSemanticType: 'human',
      optionSemanticGroup: record.optionContract.semanticGroup,
      legacyFact: { anchors: [record.clueLabel, record.subjectLabel], minAnchors: 2 },
      evidence: `تثبت P31 أن الإجابة إنسان، وتثبت P106 المهنة/الدور، وتثبت ${record.clueProperty} الحقيقة التعريفية؛ ويستبعد عقد الخيارات أي شخص تنطبق عليه الحقيقة نفسها.`,
    };
  }
  if (dataset === 'arabPoets') {
    return {
      dataset,
      q: questionText(record, dataset),
      answer: record.countryLabel,
      answerEntityId: record.countryId,
      factKey: `wikidata:${record.subjectId}:P27:${record.countryId}`,
      templateId: 'wikidata-arab-poet-single-modern-citizenship-v2',
      verificationProfile: 'wikidata-q5-direct-q49757-single-modern-p27-deceased-v2',
      answerSemanticType: 'modern-arab-country',
      optionSemanticGroup: record.optionContract.semanticGroup,
      legacyFact: { anchors: [record.subjectLabel, record.countryLabel], minAnchors: 2 },
      evidence: `تثبت P31=Q5 وP106=${POET_ID} مباشرة، وتثبت P27 جنسية واحدة من قائمة الدول العربية الحديثة، مع تاريخي ميلاد ووفاة ثابتين.`,
    };
  }
  return {
    dataset,
    q: questionText(record, dataset),
    answer: record.authorLabel,
    answerEntityId: record.authorId,
    factKey: `wikidata:${record.subjectId}:P50:${record.authorId}`,
    templateId: 'wikidata-reviewed-novel-single-human-author-v2',
    verificationProfile: 'wikidata-p136-q8261-path-single-human-p50-v2',
    answerSemanticType: 'human-author',
    optionSemanticGroup: record.optionContract.semanticGroup,
    legacyFact: { anchors: [record.subjectLabel, record.authorLabel], minAnchors: 2 },
    evidence: `تثبت P136/P279 أن النوع يصل إلى ${NOVEL_ID}، وتستبعد P31 الكتاب العام وحده والفئات المحظورة، وتثبت P50 مؤلفًا بشريًا وحيدًا؛ وكل الخيارات من لغة العمل وحقبة المؤلف الأقرب.`,
  };
}

function recordSupportsQuestionContract(category, record) {
  const dataset = DATASET_BY_CATEGORY[category];
  if (!dataset || !record?.optionContract) return false;
  if (dataset === 'whoAmI' || dataset === 'historicalFigures') {
    const allowed = ['P800', 'P39', 'P166'];
    const human = record.claim?.instanceOf;
    const occupation = record.claim?.occupation;
    const fact = record.claim?.definingFact;
    return human?.distinctValueCount === 1 && human.valueIds?.[0] === HUMAN_ID
      && record.claim?.birthDate?.distinctValueCount === 1
      && allowed.includes(record.clueProperty)
      && occupation?.selectedValueId === record.occupationId
      && occupation?.valueIds?.includes(record.occupationId)
      && occupation?.roleFamily === record.roleFamily
      && fact?.property === record.clueProperty
      && fact?.selectedValueId === record.clueId
      && fact?.valueIds?.includes(record.clueId)
      && record.claim?.definingFactClaims?.[record.clueProperty]?.valueIds?.includes(record.clueId);
  }
  if (dataset === 'arabPoets') {
    return record.claim?.instanceOf?.distinctValueCount === 1
      && record.claim.instanceOf.valueIds?.[0] === HUMAN_ID
      && record.claim?.occupation?.valueIds?.includes(POET_ID)
      && record.claim.occupation.requiredValueId === POET_ID
      && record.claim?.citizenship?.distinctValueCount === 1
      && record.claim.citizenship.valueId === record.countryId
      && ARAB_COUNTRY_IDS.has(record.countryId)
      && record.birthYear >= 1800
      && record.claim?.deathDate?.distinctValueCount === 1;
  }
  const workType = record.claim?.workInstanceOf;
  return workType?.distinctValueCount > 0
    && !(workType.distinctValueCount === 1 && workType.valueIds?.[0] === GENERIC_BOOK_ID)
    && !workType.valueIds?.some(id => BLOCKED_WORK_CLASS_IDS.has(id))
    && validSubclassEvidence(record.claim?.classification)
    && record.claim?.author?.distinctValueCount === 1
    && record.claim.author.valueId === record.authorId
    && record.claim?.authorInstanceOf?.distinctValueCount === 1
    && record.claim.authorInstanceOf.valueIds?.[0] === HUMAN_ID
    && record.claim?.language?.valueIds?.includes(record.languageId)
    && record.claim.language.selectedValueId === record.languageId
    && record.claim?.authorBirthDate?.distinctYearCount === 1
    && record.claim?.editorialRegistry?.registry === 'fatinah-world-novels-v1';
}

function builtQuestion(category, dataset, record) {
  const expected = expectedQuestionContract(category, record);
  const options = record.optionContract.options;
  const verificationClaim = record.claim;
  return {
    category,
    id: `gq-${sha256(`people-literature-v2|${category}|${record.recordKey}`).slice(0, 20)}`,
    q: expected.q,
    o: options.map(option => option.label),
    a: record.optionContract.a,
    answer: expected.answer,
    answerEntityId: expected.answerEntityId,
    optionEntityIds: options.map(option => option.entityId),
    optionSourceRecordKeys: options.map(option => option.recordKey),
    d: 0,
    band: '',
    rank: record.difficultyScore,
    sitelinks: record.sitelinks,
    popularityMetric: record.popularityMetric,
    factKey: expected.factKey,
    sourceRecordId: record.recordKey,
    sourceArtifactId: SOURCE_ARTIFACT_ID,
    sourceRecordKey: record.recordKey,
    templateId: expected.templateId,
    verificationProfile: expected.verificationProfile,
    verification: {
      profile: 'source_record_fields_v1',
      artifact: LEDGER_ARTIFACT,
      collection: `datasets.${dataset}`,
      recordIdField: 'recordKey',
      recordId: record.recordKey,
      fields: { recordKey: record.recordKey, claim: verificationClaim },
      claim: verificationClaim,
    },
    answerSemanticType: expected.answerSemanticType,
    optionSemanticGroup: expected.optionSemanticGroup,
    legacyFact: expected.legacyFact,
    claim: record.claim,
    source: {
      title: `${record.subjectLabel} — Wikidata`,
      url: entityUrl(record.subjectId),
      publisher: 'Wikidata',
      license: 'CC0 1.0',
      evidence: expected.evidence,
    },
  };
}

function buildDataset(category, records, dataset, oldNorms, bannedPattern, legacyRecords) {
  const output = [];
  const subtypeCounts = new Map();
  const usedQuestionTexts = new Set();
  for (const record of sortByDifficulty(records)) {
    if ((dataset === 'whoAmI' || dataset === 'historicalFigures')
      && ['جوائز الغولدن غلوب','جائزة الأوسكار','جائزة غرامي','رئيس الوزراء','إمبراطور','عاهل','ملك']
        .some(label => normalize(record.clueLabel) === normalize(label))) continue;
    if (dataset === 'arabPoets' && output.length < 30 && !record.editorialEasyCandidate) continue;
    if (dataset === 'worldNovels' && (subtypeCounts.get(record.genreId) || 0) >= 18) continue;
    const question = builtQuestion(category, dataset, record);
    const normalizedQuestion = normalize(question.q);
    if (usedQuestionTexts.has(normalizedQuestion)
      || (normalize(question.answer).length >= 3 && normalizedQuestion.includes(normalize(question.answer)))
      || bannedPattern.test(JSON.stringify({ q: question.q, o: question.o, answer: question.answer }))
      || oldNorms.has(normalize(question.q))
      || findLegacyFactMatch(question, legacyRecords)) continue;
    output.push(question);
    usedQuestionTexts.add(normalizedQuestion);
    if (dataset === 'worldNovels') {
      subtypeCounts.set(record.genreId, (subtypeCounts.get(record.genreId) || 0) + 1);
    }
    if (output.length === 90) break;
  }
  if (output.length !== 90) throw new Error(`${category}: ${output.length}/90 after quality and legacy exclusions`);
  if (dataset === 'arabPoets' && output.slice(0, 30).some(question => {
    const record = records.find(item => item.recordKey === question.sourceRecordKey);
    return !record?.editorialEasyCandidate;
  })) throw new Error('شعراء وأدباء عرب: easy band escaped the editorial fame gate');
  if (dataset === 'worldNovels' && subtypeCounts.size < 8) {
    throw new Error(`روايات عالمية: only ${subtypeCounts.size}/8 novel subtypes`);
  }
  output.forEach((question, index) => {
    const bandIndex = Math.floor(index / 30);
    question.band = BAND_NAMES[bandIndex];
    question.d = bandIndex * 2 + 1 + (index % 2);
    question.optionLayoutOrdinal = index;
    const targetIndex = balancedAnswerIndex(category, index);
    const optionRows = question.o.map((label, optionIndex) => ({
      label,
      entityId: question.optionEntityIds[optionIndex],
      recordKey: question.optionSourceRecordKeys[optionIndex],
      correct: optionIndex === question.a,
    }));
    const correct = optionRows.find(option => option.correct);
    const distractors = optionRows.filter(option => !option.correct);
    distractors.splice(targetIndex, 0, correct);
    question.o = distractors.map(option => option.label);
    question.optionEntityIds = distractors.map(option => option.entityId);
    question.optionSourceRecordKeys = distractors.map(option => option.recordKey);
    question.a = targetIndex;
  });
  return output;
}

export function buildPeopleLiteratureCategories({
  sourcePath = SOURCE_PATH,
  oldQuestions = new Set(),
  bannedPattern = BANNED,
  legacyRecords = loadLegacyQuestionRecords(),
} = {}) {
  const source = jsonRead(sourcePath);
  const errors = sourceErrors(source);
  if (errors.length) throw new Error(`Invalid people/literature source:\n- ${errors.join('\n- ')}`);
  const oldNorms = new Set([...oldQuestions].map(normalize));
  return {
    'من أنا؟': buildDataset('من أنا؟', source.datasets.whoAmI, 'whoAmI', oldNorms, bannedPattern, legacyRecords),
    'شخصيات تاريخية': buildDataset('شخصيات تاريخية', source.datasets.historicalFigures, 'historicalFigures', oldNorms, bannedPattern, legacyRecords),
    'شعراء وأدباء عرب': buildDataset('شعراء وأدباء عرب', source.datasets.arabPoets, 'arabPoets', oldNorms, bannedPattern, legacyRecords),
    'روايات عالمية': buildDataset('روايات عالمية', source.datasets.worldNovels, 'worldNovels', oldNorms, bannedPattern, legacyRecords),
  };
}

/**
 * Ledger-v2 predicate for one question and its resolved source record. Exact
 * question and option contracts make changes to any option detectable here.
 */
export function verifyPeopleLiteratureQuestion(question, record) {
  try {
    if (!question || !record || question.sourceRecordKey !== record.recordKey
      || question.sourceRecordId !== record.recordKey) return false;
    const expected = expectedQuestionContract(question.category, record);
    if (!expected || !recordSupportsQuestionContract(question.category, record)) return false;
    const expectedId = `gq-${sha256(`people-literature-v2|${question.category}|${record.recordKey}`).slice(0, 20)}`;
    const verification = question.verification;
    if (question.id !== expectedId
      || question.sourceArtifactId !== SOURCE_ARTIFACT_ID
      || verification?.profile !== 'source_record_fields_v1'
      || verification.artifact !== LEDGER_ARTIFACT
      || verification.collection !== `datasets.${expected.dataset}`
      || verification.recordIdField !== 'recordKey'
      || verification.recordId !== record.recordKey
      || verification.fields?.recordKey !== record.recordKey
      || jsonCanonical(Object.keys(verification).sort()) !== jsonCanonical([
        'artifact', 'claim', 'collection', 'fields', 'profile', 'recordId', 'recordIdField',
      ])
      || jsonCanonical(Object.keys(verification.fields || {}).sort()) !== jsonCanonical(['claim', 'recordKey'])) return false;
    const canonicalClaim = jsonCanonical(record.claim);
    if (jsonCanonical(question.claim) !== canonicalClaim
      || jsonCanonical(verification.claim) !== canonicalClaim
      || jsonCanonical(verification.fields?.claim) !== canonicalClaim) return false;
    if (question.q !== expected.q || question.answer !== expected.answer
      || question.answerEntityId !== expected.answerEntityId
      || question.templateId !== expected.templateId
      || question.verificationProfile !== expected.verificationProfile
      || question.factKey !== expected.factKey
      || question.answerSemanticType !== expected.answerSemanticType
      || question.optionSemanticGroup !== expected.optionSemanticGroup
      || question.rank !== record.difficultyScore
      || question.sitelinks !== record.sitelinks
      || question.popularityMetric !== record.popularityMetric
      || jsonCanonical(question.legacyFact) !== jsonCanonical(expected.legacyFact)) return false;
    const bandIndex = BAND_NAMES.indexOf(question.band);
    if (bandIndex < 0 || ![bandIndex * 2 + 1, bandIndex * 2 + 2].includes(question.d)) return false;
    const contract = record.optionContract;
    if (!Number.isInteger(question.optionLayoutOrdinal)
      || question.optionLayoutOrdinal < 0 || question.optionLayoutOrdinal > 89) return false;
    const targetIndex = balancedAnswerIndex(question.category, question.optionLayoutOrdinal);
    const contractRows = contract.options.map((option, optionIndex) => ({
      ...option, correct: optionIndex === contract.a,
    }));
    const correct = contractRows.find(option => option.correct);
    const expectedOptions = contractRows.filter(option => !option.correct);
    expectedOptions.splice(targetIndex, 0, correct);
    if (question.a !== targetIndex
      || jsonCanonical(question.o) !== jsonCanonical(expectedOptions.map(option => option.label))
      || jsonCanonical(question.optionEntityIds) !== jsonCanonical(expectedOptions.map(option => option.entityId))
      || jsonCanonical(question.optionSourceRecordKeys) !== jsonCanonical(expectedOptions.map(option => option.recordKey))
      || question.o?.[question.a] !== expected.answer
      || question.optionEntityIds?.[question.a] !== expected.answerEntityId
      || new Set(question.o?.map(normalize)).size !== 4
      || new Set(question.optionEntityIds).size !== 4) return false;
    if (!question.source?.url || question.source.url !== entityUrl(record.subjectId)
      || question.source?.title !== `${record.subjectLabel} — Wikidata`
      || question.source?.publisher !== 'Wikidata' || question.source?.license !== 'CC0 1.0'
      || question.source?.evidence !== expected.evidence
      || jsonCanonical(Object.keys(question.source).sort()) !== jsonCanonical([
        'evidence', 'license', 'publisher', 'title', 'url',
      ])) return false;
    const visible = JSON.stringify({ q: question.q, o: question.o, answer: question.answer });
    return !BANNED.test(visible) && !DISPLAY_NOISE_TEST.test(visible);
  } catch {
    return false;
  }
}

function tamperVariants(question) {
  const optionIndex = question.a === 0 ? 1 : 0;
  const changedOptions = [...question.o];
  changedOptions[optionIndex] = `${changedOptions[optionIndex]} مختلف`;
  const changedLayoutOrdinal = Array.from({ length: 90 }, (_, index) => index)
    .find(index => balancedAnswerIndex(question.category, index) !== question.a);
  return [
    { ...question, q: `${question.q} ` },
    { ...question, answer: `${question.answer} مختلف` },
    { ...question, o: changedOptions },
    { ...question, a: (question.a + 1) % 4 },
    { ...question, sourceRecordId: `${question.sourceRecordId}-tampered` },
    { ...question, source: { ...question.source, url: `${question.source.url}?tampered=1` } },
    { ...question, source: { ...question.source, title: `${question.source.title} مختلف` } },
    { ...question, rank: question.rank + 1 },
    { ...question, optionLayoutOrdinal: changedLayoutOrdinal },
    { ...question, claim: {} },
    { ...question, claim: { ...question.claim, object: 'Q0' } },
    { ...question, claim: {
      ...question.claim,
      definingFact: { ...question.claim?.definingFact, selectedValueId: 'Q0' },
    } },
    { ...question, verification: { ...question.verification, claim: {} } },
  ];
}

export function verifyPeopleLiteratureCategories(categories, {
  sourcePath = SOURCE_PATH,
  oldQuestions = new Set(),
  bannedPattern = BANNED,
  legacyRecords = loadLegacyQuestionRecords(),
} = {}) {
  const source = jsonRead(sourcePath);
  const errors = sourceErrors(source);
  const oldNorms = new Set([...oldQuestions].map(normalize));
  const sourceByDataset = Object.fromEntries(Object.entries(source.datasets || {})
    .map(([dataset, records]) => [dataset, new Map(records.map(record => [record.recordKey, record]))]));
  const ids = new Set();
  const normalizedQuestions = new Set();
  const factKeys = new Set();
  let semanticLegacyMatches = 0;
  let tamperChecks = 0;
  let rejectedTamperChecks = 0;

  for (const category of PEOPLE_LITERATURE_CATEGORIES) {
    const dataset = DATASET_BY_CATEGORY[category];
    const byKey = sourceByDataset[dataset] || new Map();
    const rows = categories?.[category] || [];
    if (rows.length !== 90) errors.push(`${category}: ${rows.length}/90`);
    let previousRank = Infinity;
    const bandCounts = { easy: 0, medium: 0, hard: 0 };
    const subtypeCounts = new Map();
    rows.forEach((question, index) => {
      const record = byKey.get(question.sourceRecordKey);
      bandCounts[question.band] = (bandCounts[question.band] || 0) + 1;
      const expectedBandIndex = Math.floor(index / 30);
      if (question.band !== BAND_NAMES[expectedBandIndex]
        || question.d !== expectedBandIndex * 2 + 1 + (index % 2)
        || question.optionLayoutOrdinal !== index) errors.push(`${question.id}: bad difficulty band/layout ordinal`);
      if (question.rank > previousRank) errors.push(`${category}: difficulty is not fame-ordered at ${index}`);
      previousRank = question.rank;
      if (!question.id || ids.has(question.id)) errors.push(`${question.id}: duplicate/missing id`);
      ids.add(question.id);
      if (!question.factKey || factKeys.has(question.factKey)) errors.push(`${question.id}: duplicate/missing factKey`);
      factKeys.add(question.factKey);
      const qNorm = normalize(question.q);
      if (!qNorm || normalizedQuestions.has(qNorm) || oldNorms.has(qNorm)) errors.push(`${question.id}: duplicate/old question text`);
      normalizedQuestions.add(qNorm);
      if (bannedPattern.test(JSON.stringify(question)) || DISPLAY_NOISE_TEST.test(JSON.stringify({ q: question.q, o: question.o }))) {
        errors.push(`${question.id}: banned or unclean content`);
      }
      if (!record || question.sourceArtifactId !== SOURCE_ARTIFACT_ID) {
        errors.push(`${question.id}: broken provenance`);
      } else if (!verifyPeopleLiteratureQuestion(question, record)) {
        errors.push(`${question.id}: ledger-v2 individual verification failed`);
      }
      const legacyMatch = findLegacyFactMatch(question, legacyRecords);
      if (legacyMatch) {
        semanticLegacyMatches += 1;
        errors.push(`${question.id}: semantic legacy match (${legacyMatch.reason})`);
      }
      if (record) {
        for (const tampered of tamperVariants(question)) {
          tamperChecks += 1;
          if (!verifyPeopleLiteratureQuestion(tampered, record)) rejectedTamperChecks += 1;
          else errors.push(`${question.id}: individual verifier accepted tampering`);
        }
      }

      if ((dataset === 'whoAmI' || dataset === 'historicalFigures') && record) {
        for (const key of question.optionSourceRecordKeys || []) {
          const candidate = byKey.get(key);
          if (!candidate || candidate.roleFamily !== record.roleFamily) {
            errors.push(`${question.id}: non-homogeneous person option`);
          }
        }
        if (!/(?:أعمال|نلت|نالت|توليت منصب|تولت منصب)/u.test(question.q)
          || !question.q.includes(naturalArabicDisplayLabel(record.occupationLabel))
          || (dataset === 'whoAmI' && /(?:وُلد|ولدت|ميلاد|توفي|وفاة)/u.test(question.q))) {
          errors.push(`${question.id}: person clue lacks role+defining achievement or uses dates`);
        }
      } else if (dataset === 'arabPoets' && record) {
        if (index < 30 && !record.editorialEasyCandidate) errors.push(`${question.id}: easy poet is not editorially famous`);
        if (record.claim?.occupation?.requiredValueId !== POET_ID || record.birthYear < 1800) {
          errors.push(`${question.id}: invalid poet/editorial nationality basis`);
        }
      } else if (dataset === 'worldNovels' && record) {
        subtypeCounts.set(record.genreId, (subtypeCounts.get(record.genreId) || 0) + 1);
        for (const key of question.optionSourceRecordKeys || []) {
          const candidate = byKey.get(key);
          if (!candidate || candidate.languageId !== record.languageId) {
            errors.push(`${question.id}: author option is not from same work language`);
          }
        }
      }
    });
    for (const band of BAND_NAMES) if (bandCounts[band] !== 30) errors.push(`${category}: ${band}=${bandCounts[band]}/30`);
    if (dataset === 'worldNovels') {
      if (subtypeCounts.size < 8) errors.push(`روايات عالمية: subtype diversity=${subtypeCounts.size}/8`);
      for (const [genreId, count] of subtypeCounts) if (count > 18) errors.push(`روايات عالمية: ${genreId} subtype count ${count}>18`);
    }
  }
  if (rejectedTamperChecks !== tamperChecks) errors.push(`tamper rejection ${rejectedTamperChecks}/${tamperChecks}`);
  return {
    valid: errors.length === 0,
    errors,
    sourceArtifactId: source.sourceArtifactId,
    sourceContentSha256: source.contentSha256,
    questionCount: PEOPLE_LITERATURE_CATEGORIES.reduce((sum, category) =>
      sum + (categories?.[category]?.length || 0), 0),
    semanticLegacyMatches,
    tamperChecks: { total: tamperChecks, rejected: rejectedTamperChecks },
    distribution: Object.fromEntries(PEOPLE_LITERATURE_CATEGORIES.map(category => [category, {
      count: categories?.[category]?.length || 0,
      bands: Object.fromEntries(BAND_NAMES.map(band => [band,
        (categories?.[category] || []).filter(question => question.band === band).length])),
    }])),
  };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  if (process.argv.includes('--refresh-source')) await refreshPeopleLiteratureSource();
  if (process.argv.includes('--rebuild-option-contracts')) {
    rebuildPeopleLiteratureOptionContracts();
  }
  const legacyRecords = loadLegacyQuestionRecords();
  const categories = buildPeopleLiteratureCategories({ legacyRecords });
  assertNoLegacyFacts(categories, legacyRecords);
  const report = verifyPeopleLiteratureCategories(categories, { legacyRecords });
  console.log(JSON.stringify(report, null, 2));
  if (!report.valid) process.exitCode = 1;
}
