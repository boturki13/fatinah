#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUTPUT = path.join(ROOT, 'content/questions/structured-sources/wikidata-cities.json');
const ENWIKI_API = 'https://en.wikipedia.org/w/api.php';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';

const CITIES = [
  ['Istanbul','Q43'],['New York City','Q30'],['Los Angeles','Q30'],['Chicago','Q30'],['San Francisco','Q30'],
  ['Miami','Q30'],['Las Vegas','Q30'],['Toronto','Q16'],['Vancouver','Q16'],['Montreal','Q16'],
  ['Sydney','Q408'],['Melbourne','Q408'],['Brisbane','Q408'],['Perth','Q408'],['Shanghai','Q148'],
  ['Guangzhou','Q148'],['Shenzhen','Q148'],['Mumbai','Q668'],['Kolkata','Q668'],['Chennai','Q668'],
  ['Barcelona','Q29'],['Munich','Q183'],['Milan','Q38'],['Venice','Q38'],['Manchester','Q145'],
  ['Liverpool','Q145'],['Marseille','Q142'],['Lyon','Q142'],['Alexandria','Q79'],['Casablanca','Q1028'],
  ['Marrakesh','Q1028'],['Rio de Janeiro','Q155'],['São Paulo','Q155'],['Osaka','Q17'],['Kyoto','Q17'],
  ['Busan','Q884'],['Jeddah','Q851'],['Mecca','Q851'],['Medina','Q851'],['Dubai','Q878'],
  ['Valencia','Q29'],['Seville','Q29'],['Hamburg','Q183'],['Frankfurt','Q183'],['Cologne','Q183'],
  ['Naples','Q38'],['Turin','Q38'],['Florence','Q38'],['Birmingham','Q145'],['Glasgow','Q145'],
  ['Nice','Q142'],['Toulouse','Q142'],['Bordeaux','Q142'],['Zurich','Q39'],['Geneva','Q39'],
  ['Rotterdam','Q55'],['Antwerp','Q31'],['Porto','Q45'],['Yokohama','Q17'],['Nagoya','Q17'],
  ['Kobe','Q17'],['Sapporo','Q17'],['Incheon','Q884'],['Karachi','Q843'],['Lahore','Q843'],
  ['Cape Town','Q258'],['Johannesburg','Q258'],['Durban','Q258'],['Lagos','Q1033'],['Mombasa','Q114'],
  ['Salvador, Bahia','Q155'],['Recife','Q155'],['Guadalajara','Q96'],['Monterrey','Q96'],['Córdoba, Argentina','Q414'],
  ['Rosario, Santa Fe','Q414'],['Valparaíso','Q298'],['Medellín','Q739'],['Cali','Q739'],['Cusco','Q419'],
  ['Auckland','Q664'],['Christchurch','Q664'],['Cebu City','Q928'],['Davao City','Q928'],['Ho Chi Minh City','Q881'],
  ['Da Nang','Q881'],['Chiang Mai','Q869'],['Phuket (city)','Q869'],['Pattaya','Q869'],['Bandung','Q252'],
  ['Surabaya','Q252'],['Hyderabad','Q668'],['Bangalore','Q668'],['Bilbao','Q29'],['Granada','Q29'],
  ['Stuttgart','Q183'],['Leipzig','Q183'],['Dresden','Q183'],['Bologna','Q38'],['Genoa','Q38'],
  ['Palermo','Q38'],['Edinburgh','Q145'],['Lille','Q142'],['Basel','Q39'],['Utrecht','Q55'],
  ['Bruges','Q31'],['Ghent','Q31'],['Daegu','Q884'],['Kano (city)','Q1033'],['Cancún','Q96'],
  ['Salzburg','Q40'],['Innsbruck','Q40'],['Gothenburg','Q34'],['Malmö','Q34'],['Bergen','Q20'],
  ['Kraków','Q36'],['Gdańsk','Q36'],['Dubrovnik','Q224'],['Split, Croatia','Q224'],['Thessaloniki','Q41'],
  ['İzmir','Q43'],['Antalya','Q43'],['Bursa','Q43'],['Adana','Q43'],['Dammam','Q851'],
  ['Khobar','Q851'],['Taif','Q851'],['Abha','Q851'],['Sharjah','Q878'],['Al Ain','Q878'],
  ['Salalah','Q842'],['Muharraq','Q398'],['Al Rayyan','Q846'],['Giza','Q79'],['Luxor','Q79'],
  ['Aswan','Q79'],['Fez, Morocco','Q1028'],['Tangier','Q1028'],['Oran','Q262'],['Sfax','Q948'],
  ['Benghazi','Q1016'],['Basra','Q796'],['Mosul','Q796'],['Aleppo','Q858'],['Aqaba','Q810'],
];

// Difficulty is based on familiarity to the game's Arabic/Gulf audience, not
// population size. The first 30 become easy and the next 30 become medium.
const EDITORIAL_CITY_ORDER = [
  'Istanbul','New York City','Los Angeles','Dubai','Mecca','Medina','Jeddah',
  'Barcelona','Milan','Manchester','Liverpool','Munich','Venice','Rio de Janeiro',
  'São Paulo','Sydney','Melbourne','Toronto','Chicago','San Francisco','Miami',
  'Las Vegas','Alexandria','Casablanca','Osaka','Kyoto','Cape Town','Geneva',
  'Hamburg','Marseille',
  'Vancouver','Montreal','Brisbane','Perth','Shanghai','Guangzhou','Shenzhen',
  'Mumbai','Kolkata','Chennai','Busan','Marrakesh','Valencia','Seville','Frankfurt',
  'Cologne','Naples','Turin','Florence','Birmingham','Glasgow','Nice','Toulouse',
  'Bordeaux','Zurich','Rotterdam','Antwerp','Porto','Yokohama','Nagoya',
];
const editorialRank = new Map(EDITORIAL_CITY_ORDER.map((title, index) => [title, index]));
const ORDERED_CITIES = [...CITIES].sort((left, right) =>
  (editorialRank.get(left[0]) ?? 10_000) - (editorialRank.get(right[0]) ?? 10_000)
  || CITIES.findIndex(row => row[0] === left[0]) - CITIES.findIndex(row => row[0] === right[0]));

const ARABIC_CITY_OVERRIDES = {
  'Ho Chi Minh City': 'مدينة هو تشي منه',
  'Karachi': 'كراتشي',
  'Hyderabad': 'حيدر آباد الهندية',
  'Kobe': 'كوبي',
  'Mombasa': 'مومباسا',
  'Valencia': 'فالنسيا',
  'Da Nang': 'دا نانغ',
  'Phuket (city)': 'مدينة بوكيت',
  'Córdoba, Argentina': 'قرطبة الأرجنتينية',
  'Rosario, Santa Fe': 'روزاريو',
  'Salvador, Bahia': 'سلفادور',
  'Kano (city)': 'كانو',
  'Split, Croatia': 'سبليت',
  'Fez, Morocco': 'فاس',
  'Al Rayyan': 'الريان',
  'Al Ain': 'العين',
  'Khobar': 'الخبر',
};

function chunks(values, size) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
}

async function getJson(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(url, { headers: { 'user-agent': 'FatinahQuestionImporter/3.0 (content snapshot)' } });
    if (response.ok) {
      const payload = await response.json();
      if (payload?.error) throw new Error(`${url.hostname}: ${payload.error.code || 'api-error'} ${payload.error.info || ''}`.trim());
      return payload;
    }
    if (![429, 502, 503, 504].includes(response.status) || attempt === 4) {
      throw new Error(`${url.hostname} HTTP ${response.status}`);
    }
    const retryAfter = Number(response.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1_000 : 1_000 * 2 ** attempt;
    await new Promise(resolve => setTimeout(resolve, Math.min(waitMs, 8_000)));
  }
  throw new Error(`${url.hostname}: exhausted retries`);
}

const pagesByRequestedTitle = new Map();
for (const rows of chunks(ORDERED_CITIES, 40)) {
  const payload = await getJson(ENWIKI_API, {
    action: 'query', format: 'json', formatversion: '2', redirects: '1',
    prop: 'pageprops', ppprop: 'wikibase_item', titles: rows.map(row => row[0]).join('|'), origin: '*',
  });
  const normalized = new Map([...(payload.query?.normalized || []), ...(payload.query?.redirects || [])]
    .map(row => [row.from, row.to]));
  for (const [title] of rows) {
    let resolved = title;
    const seen = new Set();
    while (normalized.has(resolved) && !seen.has(resolved)) {
      seen.add(resolved);
      resolved = normalized.get(resolved);
    }
    const page = payload.query?.pages?.find(item => item.title === resolved);
    if (!page?.pageprops?.wikibase_item) throw new Error(`تعذر ربط مدينة Wikidata: ${title} -> ${resolved}`);
    pagesByRequestedTitle.set(title, { title: page.title, qid: page.pageprops.wikibase_item });
  }
}

const entities = new Map();
const cityQids = [...new Set([...pagesByRequestedTitle.values()].map(item => item.qid))];
for (const ids of chunks(cityQids, 20)) {
  const payload = await getJson(WIKIDATA_API, {
    action: 'wbgetentities', format: 'json', formatversion: '2', ids: ids.join('|'),
    props: 'labels|claims', languages: 'ar|en', languagefallback: '1', origin: '*',
  });
  for (const [qid, entity] of Object.entries(payload.entities || {})) entities.set(qid, entity);
}
const countryQids = [...new Set(ORDERED_CITIES.map(row => row[1]))];
for (const ids of chunks(countryQids, 45)) {
  const payload = await getJson(WIKIDATA_API, {
    action: 'wbgetentities', format: 'json', formatversion: '2', ids: ids.join('|'),
    props: 'labels', languages: 'ar|en', languagefallback: '1', origin: '*',
  });
  for (const [qid, entity] of Object.entries(payload.entities || {})) {
    const existing = entities.get(qid);
    entities.set(qid, existing ? { ...existing, labels: entity.labels } : entity);
  }
}

const seen = new Set();
const records = ORDERED_CITIES.map(([requestedTitle, countryQid], familiarityIndex) => {
  const page = pagesByRequestedTitle.get(requestedTitle);
  const entity = entities.get(page.qid);
  const countries = (entity?.claims?.P17 || []).map(claim => claim.mainsnak?.datavalue?.value?.id).filter(Boolean);
  if (!countries.includes(countryQid)) {
    throw new Error(`${requestedTitle} (${page.qid}) لا يحمل الدولة المتوقعة ${countryQid}: ${countries.join(',')}`);
  }
  const cityNameAr = ARABIC_CITY_OVERRIDES[requestedTitle] || entity.labels?.ar?.value;
  const countryNameAr = entities.get(countryQid)?.labels?.ar?.value;
  if (!cityNameAr || !countryNameAr) {
    throw new Error(`تسمية عربية ناقصة: ${requestedTitle}; city=${cityNameAr || '-'}; country=${countryNameAr || '-'}; countryQid=${countryQid}`);
  }
  if (seen.has(page.qid)) throw new Error(`مدينة مكررة: ${requestedTitle} -> ${page.qid}`);
  seen.add(page.qid);
  return {
    sourceRecordId: `wikidata-city-${page.qid.toLowerCase()}`,
    cityQid: page.qid,
    cityNameAr,
    countryQid,
    countryNameAr,
    familiarityRank: familiarityIndex + 1,
    sourceUrl: `https://www.wikidata.org/wiki/${page.qid}`,
    sourcePublisher: 'Wikidata',
    sourcePayloadHash: crypto.createHash('sha256').update(JSON.stringify(entity)).digest('hex'),
    wikipediaPage: page.title,
  };
});

const output = {
  schemaVersion: 1,
  sourceProfile: 'wikidata_city_country_snapshot_v1',
  retrievedAt: new Date().toISOString(),
  selectionPolicy: 'مدن غير عواصم في الغالب، مرتبة تحريرياً وفق شهرتها لدى الجمهور العربي والخليجي ثم العالمي؛ علاقة الدولة مثبتة في P17.',
  records,
};
fs.writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${records.length} city-country records to ${path.relative(ROOT, OUTPUT)}`);
