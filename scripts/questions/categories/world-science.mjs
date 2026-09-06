import fs from 'node:fs';
import path from 'node:path';
import {
  finalizeCategory,
  makeOptions,
  normalizeArabic,
  sha256,
} from './common.mjs';
import { findLegacyFactMatch } from '../legacy-question-policy.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const artifactCache = new Map();
const read = relativePath => {
  if (!artifactCache.has(relativePath)) {
    artifactCache.set(relativePath, JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8')));
  }
  return artifactCache.get(relativePath);
};
const ARTIFACTS = {
  countries: 'content/questions/structured-sources/world-bank-countries.json',
  cities: 'content/questions/structured-sources/wikidata-cities.json',
  currencies: 'content/questions/structured-sources/currency-names-ar.json',
  animals: 'content/questions/structured-sources/inaturalist-animal-taxa.json',
  elements: 'content/questions/structured-sources/chemical-elements.json',
  physics: 'content/questions/structured-sources/bipm-si-units.json',
  football: 'content/questions/structured-sources/fifa-world-cup-matches.json',
};

const blocked = /(?:إسرائيل|اسرائيل|إسرائيلي|اسرائيلي|Israel|Israeli|Tel Aviv|تل أبيب|تل ابيب|إباحي|اباحي)/iu;
const GEOGRAPHIC_LOCATION_TEMPLATES = new Set(['city-country-v3', 'fifa-match-city-v3']);

export function geographicAnswerLeak(question) {
  if (!GEOGRAPHIC_LOCATION_TEMPLATES.has(question?.templateId)) return false;
  const answer = normalizeArabic(question?.answer);
  return answer.length >= 3 && normalizeArabic(question?.q).includes(answer);
}

function sourceRecordVerification(artifact, recordIdField, recordId, fields, claim) {
  return {
    profile: 'source_record_fields_v1', artifact, collection: 'records', recordIdField,
    recordId: String(recordId), fields, claim,
  };
}

function source(title, url, publisher, license) {
  return { title, url: String(url).replace(/^http:/u, 'https:'), publisher, license };
}

function rawLegacyProbe(raw) {
  return {
    q: raw.q,
    answer: String(raw.answer),
    verification: raw.verification,
    legacyFact: raw.metadata?.legacyFact,
  };
}

function isFresh(raw, legacyRecords) {
  return !legacyRecords?.length || !findLegacyFactMatch(rawLegacyProbe(raw), legacyRecords);
}

function rotateAfter(values, answer) {
  const normalized = normalizeArabic(answer);
  const index = values.findIndex(value => normalizeArabic(value) === normalized);
  if (index < 0) return values;
  return [...values.slice(index + 1), ...values.slice(0, index + 1)];
}

function countryOrder(records) {
  const familiarity = [
    'KW','SA','AE','QA','BH','OM','EG','IQ','JO','LB','SY','YE','MA','DZ','TN','LY',
    'US','GB','FR','DE','IT','ES','CN','JP','IN','RU','TR','CA','AU','BR','MX','AR',
    'KR','ID','MY','SG','TH','PK','IR','AF','SD','ET','NG','ZA','KE','SO','MR','DJ',
    'PS','GR','PT','NL','BE','CH','AT','SE','NO','DK','FI','IS','IE','PL','UA','RO',
    'CZ','HU','BG','HR','RS','BA','AL','NZ','CL','CO','PE','VE','CU','JM','PA','CR',
    'DO','GT','HN','NI','SV','UY','PY','BO','EC','GY','SR','BD','LK','NP','VN','PH',
    'MM','KH','LA','MN','KZ','UZ','TM','KG','TJ','AZ','GE','AM','CY','LU','MC','LI',
    'SM','VA','AD','EE','LV','LT','SK','SI','ME','MK','MD','BY','GH','CI','SN','ML',
    'NE','TD','CM','GA','CG','CD','AO','ZM','ZW','BW','NA','MZ','TZ','UG','RW','BI',
    'MW','MG','MU','SC','CV','GM','GN','GW','SL','LR','TG','BJ','BF','LS','SZ','FJ',
    'PG','WS','TO','VU','SB','KI','TV','NR','MV','BN','BT','TL','BZ','BS','BB','TT',
    'GD','LC','VC','AG','DM','KN','HT','GQ','CF','ST','KM','ER','SS','BWI',
  ];
  const rank = new Map(familiarity.map((iso, index) => [iso, index]));
  return [...records].sort((left, right) =>
    (rank.get(left.iso2) ?? 10_000) - (rank.get(right.iso2) ?? 10_000)
    || left.countryAr.localeCompare(right.countryAr, 'ar'));
}

const CITY_REGION_GROUPS = [
  ['Q43','Q851','Q878','Q842','Q398','Q846','Q79','Q1028','Q262','Q948','Q1016','Q796','Q858','Q810'],
  ['Q29','Q183','Q38','Q145','Q142','Q39','Q55','Q31','Q45','Q40','Q34','Q20','Q36','Q224','Q41'],
  ['Q148','Q668','Q17','Q884','Q843','Q881','Q869','Q252'],
  ['Q30','Q16','Q96','Q414','Q298','Q739','Q419','Q155'],
  ['Q258','Q1033','Q114'],
  ['Q408','Q664','Q928'],
];
const cityRegionFor = qid => CITY_REGION_GROUPS.findIndex(group => group.includes(qid));

function cityRaw(record, all) {
  const allCountries = [...new Set(all.map(row => row.countryNameAr))];
  const regional = [...new Set(all.filter(row => cityRegionFor(row.countryQid) === cityRegionFor(record.countryQid))
    .map(row => row.countryNameAr))];
  return {
    q: `في أي دولة تقع مدينة «${record.cityNameAr}»؟`,
    answer: record.countryNameAr,
    answerPool: [
      ...rotateAfter(regional, record.countryNameAr).map(value => ({ value, tier: 'regional' })),
      ...rotateAfter(allCountries, record.countryNameAr).map(value => ({ value, tier: 'global' })),
    ],
    factKey: `city-country:${record.cityQid}:${record.countryQid}`,
    sourceRecordId: record.sourceRecordId,
    templateId: 'city-country-v3',
    rank: all.length - record.familiarityRank,
    source: source(`${record.cityNameAr} — الدولة`, record.sourceUrl, record.sourcePublisher, 'CC0 1.0'),
    verification: sourceRecordVerification(
      ARTIFACTS.cities, 'sourceRecordId', record.sourceRecordId,
      { cityQid: record.cityQid, cityNameAr: record.cityNameAr, countryQid: record.countryQid, countryNameAr: record.countryNameAr },
      { subject: record.cityQid, predicate: 'country', object: record.countryQid },
    ),
    metadata: {
      answerSemanticType: 'country', optionSemanticGroup: `country-region-${cityRegionFor(record.countryQid)}`,
      legacyFact: { anchors: [record.cityNameAr, record.countryNameAr], minAnchors: 2 },
    },
  };
}

function buildCities(legacyRecords) {
  const all = read(ARTIFACTS.cities).records.filter(record =>
    record.cityQid && record.cityNameAr && record.countryQid && record.countryNameAr
    && !blocked.test(JSON.stringify(record)));
  const raws = all.map(record => cityRaw(record, all))
    .filter(raw => !geographicAnswerLeak(raw) && isFresh(raw, legacyRecords)).slice(0, 90);
  if (raws.length !== 90) throw new Error(`حقائق المدن الجديدة غير كافية: ${raws.length}`);
  return finalizeCategory('مدن وعواصم', raws);
}

const elementSymbolsByFamiliarity = [
  'H','O','C','N','Fe','Ag','Cu','Al','He','Na','Cl','Ca','K','Mg','Si','S','P','Zn','Hg','Pb','U','Ne','Ar','Li','Ni','Co','Cr','Sn','I','F',
  'Br','Pt','Ti','Mn','W','B','Ba','Be','Cd','Cs','Ga','Ge','Kr','Mo','Rb','Se','Sr','Xe','Zr','Pd','Ir','Os','Rh','Ru','Sb','Te','Tl','V','As',
  'Ac','Am','At','Bk','Cf','Ce','Cm','Dy','Er','Eu','Fr','Gd','Hf','Ho','In','La','Lu','Nd','Np','Pa','Pm','Po','Pr','Pu','Ra','Re','Sc','Sm','Ta','Tb',
];

function orderedElements() {
  const records = read(ARTIFACTS.elements).records.filter(record => Number(record.atomicNumber) <= 118);
  const bySymbol = new Map(records.map(record => [record.symbol, record]));
  const known = elementSymbolsByFamiliarity.map(symbol => bySymbol.get(symbol)).filter(Boolean);
  const used = new Set(known.map(record => record.symbol));
  return [...known, ...records.filter(record => !used.has(record.symbol)).sort((a, b) => a.atomicNumber - b.atomicNumber)];
}

function elementDisplayName(record) {
  return record.itemLabel.startsWith('ال') ? record.itemLabel : `ال${record.itemLabel}`;
}

function elementQuestionRaw(record, predicate, records, index) {
  const asksSymbol = predicate === 'symbol';
  const neighbours = [...records.slice(index + 1), ...records.slice(0, index)]
    .sort((left, right) => Math.abs(left.atomicNumber - record.atomicNumber) - Math.abs(right.atomicNumber - record.atomicNumber));
  return {
    q: asksSymbol
      ? `ما الرمز الكيميائي لعنصر «${elementDisplayName(record)}»؟`
      : `ما العدد الذري لعنصر «${elementDisplayName(record)}»؟`,
    answer: record[predicate],
    answerPool: [
      ...neighbours.slice(0, 10).map(row => ({ value: row[predicate], tier: 'nearby-element' })),
      ...neighbours.slice(10).map(row => ({ value: row[predicate], tier: 'element-fallback' })),
    ],
    factKey: `element:${record.item}:${predicate}`,
    sourceRecordId: `iupac-element-${record.atomicNumber}`,
    templateId: asksSymbol ? 'element-symbol-v2' : 'element-atomic-number-v2',
    rank: 119 - record.atomicNumber,
    source: source(`${record.itemLabel} — سجل العنصر`, record.item, 'Wikidata', 'CC0 1.0'),
    verification: sourceRecordVerification(
      ARTIFACTS.elements, 'item', record.item,
      { itemLabel: record.itemLabel, symbol: record.symbol, atomicNumber: record.atomicNumber },
      { subject: record.item, predicate, object: record[predicate] },
    ),
    metadata: {
      answerSemanticType: asksSymbol ? 'chemical-symbol' : 'atomic-number',
      optionSemanticGroup: asksSymbol ? 'chemical-symbol' : 'atomic-number',
      legacyFact: { anchors: [record.itemLabel, String(record[predicate])], minAnchors: 2 },
    },
  };
}

function physicsUnitRaw(record, predicate, records) {
  const asksUnit = predicate === 'unitAr';
  const answer = record[predicate];
  const values = records.map(row => row[predicate]);
  return {
    q: asksUnit
      ? `ما وحدة قياس «${record.quantityAr}» في النظام الدولي للوحدات؟`
      : `ما الرمز الدولي لوحدة «${record.unitAr}»؟`,
    answer,
    answerPool: rotateAfter(values, answer).map(value => ({ value, tier: asksUnit ? 'si-unit-name' : 'si-symbol' })),
    factKey: `si-unit:${record.sourceRecordId}:${predicate}`,
    sourceRecordId: record.sourceRecordId,
    templateId: asksUnit ? 'si-quantity-unit-v1' : 'si-unit-symbol-v1',
    rank: 30 - record.familiarityRank,
    source: source('كتيب النظام الدولي للوحدات', record.sourceUrl, record.sourcePublisher, 'BIPM publication'),
    verification: sourceRecordVerification(
      ARTIFACTS.physics, 'sourceRecordId', record.sourceRecordId,
      { quantityAr: record.quantityAr, unitAr: record.unitAr, symbol: record.symbol, familiarityRank: record.familiarityRank },
      { subject: record.quantityEn, predicate, object: answer },
    ),
    metadata: {
      answerSemanticType: asksUnit ? 'si-unit' : 'si-unit-symbol',
      optionSemanticGroup: asksUnit ? 'si-unit' : 'si-unit-symbol',
      legacyFact: { anchors: [asksUnit ? record.quantityAr : record.unitAr, String(answer)], minAnchors: 2 },
    },
  };
}

function selectFreshElementBand(candidates, count, predicate, legacyRecords, optionRecords) {
  const selected = [];
  for (const record of candidates) {
    const raw = elementQuestionRaw(record, predicate, optionRecords, optionRecords.indexOf(record));
    if (!isFresh(raw, legacyRecords)) continue;
    selected.push({ record, predicate, raw });
    if (selected.length === count) break;
  }
  if (selected.length !== count) throw new Error(`حقائق الكيمياء الجديدة غير كافية (${predicate}): ${selected.length}`);
  return selected;
}

function buildPhysicsChemistry(legacyRecords) {
  const elements = orderedElements().filter(record => !blocked.test(JSON.stringify(record)));
  const easyChem = selectFreshElementBand(elements.slice(0, 40), 15, 'symbol', legacyRecords, elements);
  const easyIds = new Set(easyChem.map(item => item.record.item));
  const mediumChem = selectFreshElementBand(elements.slice(20, 85).filter(record => !easyIds.has(record.item)), 15, 'symbol', legacyRecords, elements);
  const used = new Set([...easyChem, ...mediumChem].map(item => item.record.item));
  const hardChem = selectFreshElementBand(elements.slice(45).filter(record => !used.has(record.item)), 15, 'atomicNumber', legacyRecords, elements);

  const units = read(ARTIFACTS.physics).records.filter(record => !blocked.test(JSON.stringify(record)));
  if (units.length !== 29) throw new Error(`سجلات وحدات BIPM غير مكتملة: ${units.length}`);
  const unitNames = units.map(record => physicsUnitRaw(record, 'unitAr', units));
  const symbolPool = units.map(record => physicsUnitRaw(record, 'symbol', units));
  const easyPhysics = unitNames.slice(0, 15);
  // Common SI symbols (including °C) belong in medium. Less familiar named
  // derived units belong in hard; this avoids placing katal/steradian before °C.
  const mediumPhysics = [...symbolPool.slice(0, 14), symbolPool[15]];
  const hardPhysics = [...unitNames.slice(16, 29), symbolPool[14], symbolPool[28]];
  const allPhysics = [...easyPhysics, ...mediumPhysics, ...hardPhysics];
  const stale = allPhysics.find(raw => !isFresh(raw, legacyRecords));
  if (stale) throw new Error(`أُعيدت حقيقة فيزيائية قديمة: ${stale.q}`);

  const raws = [
    ...easyChem.map(item => item.raw), ...easyPhysics,
    ...mediumChem.map(item => item.raw), ...mediumPhysics,
    ...hardChem.map(item => item.raw), ...hardPhysics,
  ];
  return {
    questions: finalizeCategory('فيزياء وكيمياء', raws),
    chemistrySelections: [...easyChem, ...mediumChem, ...hardChem],
  };
}

const currencyRegions = [
  ['KWD','SAR','AED','QAR','BHD','OMR','EGP','IQD','JOD','MAD','DZD','TND','LYD','SDG','TRY','IRR'],
  ['USD','CAD','MXN','ARS','CLP','COP','PEN','UYU','PYG','BOB','VES','DOP','JMD','TTD','BBD','BSD','BZD','CRC','GTQ','HNL','NIO','PAB','XCD'],
  ['EUR','GBP','CHF','RUB','SEK','NOK','DKK','PLN','CZK','HUF','RON','BGN'],
  ['JPY','CNY','INR','KRW','PKR','IDR','MYR','SGD','AFN','BDT','LKR','NPR','THB','VND','PHP','HKD','TWD','MOP','KZT','UZS'],
  ['ZAR','NGN','KES','ETB','GHS','UGX','TZS','RWF','MUR','SCR'],
  ['AUD','NZD','FJD','PGK','WST','TOP','VUV','MVR'],
];

function currencyRaw(record, records) {
  const names = records.map(row => row.nameAr);
  const region = currencyRegions.find(codes => codes.includes(record.code)) || [];
  const regionalRows = rotateAfter(region, record.code).map(code => records.find(row => row.code === code)).filter(Boolean);
  const answerRoot = normalizeArabic(record.nameAr.split(/\s+/u)[0]);
  const roots = new Set([answerRoot]);
  const distinctRegional = regionalRows.filter(row => {
    const root = normalizeArabic(row.nameAr.split(/\s+/u)[0]);
    if (roots.has(root)) return false;
    roots.add(root);
    return true;
  });
  const globalFallback = records.filter(row => !roots.has(normalizeArabic(row.nameAr.split(/\s+/u)[0])));
  return {
    q: `ما العملة التي يرمز لها دوليًا بالرمز ${record.code}؟`,
    answer: record.nameAr,
    answerPool: [
      ...distinctRegional.map(row => ({ value: row.nameAr, tier: 'regional-distinct-root' })),
      ...globalFallback.map(row => ({ value: row.nameAr, tier: 'global-distinct-root' })),
      ...rotateAfter(names, record.nameAr).map(value => ({ value, tier: 'last-resort' })),
    ],
    factKey: `currency-name:${record.code}`,
    sourceRecordId: record.sourceRecordId,
    templateId: 'cldr-currency-name-v1',
    rank: 91 - record.familiarityRank,
    source: source(`CLDR — ${record.code}`, record.sourceUrl, record.sourcePublisher, 'Unicode License v3'),
    verification: sourceRecordVerification(
      ARTIFACTS.currencies, 'sourceRecordId', record.sourceRecordId,
      { code: record.code, nameAr: record.nameAr, familiarityRank: record.familiarityRank },
      { subject: record.code, predicate: 'arabic_currency_name', object: record.nameAr },
    ),
    metadata: {
      answerSemanticType: 'currency-name', optionSemanticGroup: 'currency-name',
      legacyFact: { anchors: [record.code, record.nameAr], minAnchors: 2 },
    },
  };
}

function buildCurrencies(legacyRecords) {
  const records = read(ARTIFACTS.currencies).records.filter(record => !blocked.test(JSON.stringify(record)));
  if (records.length < 90) throw new Error(`سجلات العملات غير كافية: ${records.length}`);
  const questions = records.map(record => currencyRaw(record, records))
    .filter(raw => isFresh(raw, legacyRecords)).slice(0, 90);
  if (questions.length !== 90) throw new Error(`حقائق العملات الجديدة غير كافية: ${questions.length}`);
  return finalizeCategory('عملات العالم', questions);
}

// These lists are editorial selections from the sourced iNaturalist snapshot.
// They intentionally avoid opaque or ambiguous Arabic labels and keep target
// records disjoint across the three levels and the true/false category.
const ANIMAL_TARGET_NAMES = Object.freeze({
  easy: Object.freeze([
    'أسد','نمر','فيل الأدغال الأفريقي','ذئب رمادي','دب بني','دب قطبي','جمل عربي','حوت أزرق',
    'فرس النهر','وحيد القرن الأبيض','فهد','شمبانزي شائع','شاهين','طاووس هندي','هدهد','لقلق أبيض',
    'كوالا','خنزير بري','ذبابة منزلية','صرصور أمريكي','حوت قاتل','حلزون التفاح الذهبي',
    'تنين كومودو','تمساح النيل','عوسق أمريكي','حرباء شائعة','ضفدع أخضر','سمك ذهبي',
    'نسر أسمر','عنكبوت أحمر الظهر',
  ]),
  medium: Object.freeze([
    'ثعلب أحمر','راكون شائع','قندس أمريكي','دب أسود أمريكي','أرنب أوروبي','قنفذ أوروبي',
    'أسد البحر الكاليفورني','بيسون أمريكي','خنزير الماء','أسد الجبال','قضاعة بحرية','جاموس أفريقي',
    'زرزور أوروبي','ديك رومي بري','بلشون أبيض كبير','نورس أسود الرأس','بومة مخططة','عوسق شائع',
    'قاطور أمريكي','إغوانة خضراء','سلحفاة مزركشة','ثعبان العشب','شبوط شائع','سمكة التنين الحمراء',
    'تنين البحر العشبي','عثة قمرية','نحل العسل الشرقي','علجوم أمريكي',
    'أخطبوط المحيط الهادئ العملاق','أخطبوط شرق المحيط الهادئ الأحمر',
  ]),
  hard: Object.freeze([
    'أيل أبيض الذيل','سنجاب رمادي شرقي','قيوط','ثعلب قطبي','رنة','فيل آسيوي','خلد الماء','سرقاط',
    'حوت العنبر','ليمور حلقي الذيل','إنسان الغاب البورنيوي','وحيد القرن الأسود','عناق الأرض',
    'شيطان تسمانيا','قضاعة أوراسية','غزال طومسون','عقاب ذهبية','حدأة سوداء','بطة موسكوفية',
    'سنونو الشجرة','كركي شائع','كناري أوروبي','وقواق شائع','بلشون أزرق كبير','نسر رومي',
    'عقاب نساري','قيق أزرق','سنجاب ثعلبي','سلحفاة نهاشة شائعة','أصلة بورمية',
  ]),
});

const TRUE_FALSE_ANIMAL_NAMES = Object.freeze([
  'أيل أحمر','قندس أوراسي','جرذ بني','ثعلب رمادي','فقمة رمادية','خروف البحر الأمريكي','حوت أبيض','ثور المسك',
  'عقعق أوراسي','غراب مقنع','حسون أوراسي','نسر أسود','بلشون أخضر','حمام نيوزيلندي','نورس غربي','غطاس صغير',
  'تمساح أمريكي','سحلية خضراء أوروبية','إغوانة صحراوية','سلحفاة منقطة','سلحفاة هيرمان',
  'سلحفاة حمراء القدم','سلحفاة صفراء القدم','سلحفاة تكساس','أنقليس نيوزيلندي',
  'وروار أوروبي','دلفين ريسو','سمكة الضفدع العملاق','سلحفاة سودانية','غرير أوروبي',
]);

const animalGroups = {
  Mammalia: 'الثدييات', Aves: 'الطيور', Reptilia: 'الزواحف',
  Actinopterygii: 'الأسماك شعاعية الزعانف', Amphibia: 'البرمائيات',
  Insecta: 'الحشرات', Mollusca: 'الرخويات', Arachnida: 'العنكبيات',
};

function animalDisplayName(record) {
  return ({
    'عقاب ذهبية': 'عقاب ذهبي',
    'وحيد قرن هندي': 'وحيد القرن الهندي',
    'وَمْبَت شائع': 'ومبت شائع',
    'شمبانزي شائع': 'شمبانزي',
    'راكون شائع': 'راكون',
    'نحل العسل الغربي': 'نحل العسل',
  })[record.commonNameAr] || record.commonNameAr;
}

function curatedAnimalRecords(records, names, label) {
  const byName = new Map(records.map(record => [normalizeArabic(record.commonNameAr), record]));
  const selected = names.map(name => byName.get(normalizeArabic(name)));
  const missing = names.filter((_, index) => !selected[index]);
  if (missing.length) throw new Error(`${label}: سجلات حيوانات منسقة مفقودة: ${missing.join('، ')}`);
  if (new Set(selected.map(record => record.taxonId)).size !== selected.length) {
    throw new Error(`${label}: سجل حيوان منسق مكرر`);
  }
  return selected;
}

function animalRaw(record, predicate, records) {
  const groups = Object.values(animalGroups);
  const groupRows = records.filter(row => row.iconicTaxon === record.iconicTaxon);
  if (predicate === 'iconicTaxon') {
    return {
      q: `إلى أي مجموعة حيوانية ينتمي «${animalDisplayName(record)}»؟`,
      answer: animalGroups[record.iconicTaxon], answerPool: rotateAfter(groups, animalGroups[record.iconicTaxon]),
      factKey: `animal:${record.taxonId}:iconicTaxon`, templateId: 'animal-group-v2',
      metadata: {
        answerSemanticType: 'animal-group', optionSemanticGroup: 'animal-group',
        legacyFact: { anchors: [animalDisplayName(record), animalGroups[record.iconicTaxon]], minAnchors: 2 },
      },
    };
  }
  return {
    q: `ما الاسم العلمي للحيوان «${animalDisplayName(record)}»؟`,
    answer: record.scientificName,
    answerPool: [
      ...rotateAfter(groupRows.map(row => row.scientificName), record.scientificName).map(value => ({ value, tier: 'same-group' })),
      ...rotateAfter(records.map(row => row.scientificName), record.scientificName).map(value => ({ value, tier: 'global' })),
    ],
    factKey: `animal:${record.taxonId}:scientificName`, templateId: 'animal-scientific-name-v2',
    metadata: {
      answerSemanticType: 'scientific-name', optionSemanticGroup: `scientific-${record.iconicTaxon}`,
      legacyFact: { anchors: [animalDisplayName(record), record.scientificName], minAnchors: 2, bidirectional: true },
    },
  };
}

function animalGroupChoiceRaw(group) {
  const [target, ...distractors] = group;
  const targetGroup = animalGroups[target?.iconicTaxon];
  if (!targetGroup || group.length !== 4
      || new Set(group.map(record => record.taxonId)).size !== 4
      || new Set(group.map(record => animalDisplayName(record))).size !== 4
      || distractors.some(record => record.iconicTaxon === target.iconicTaxon)) {
    throw new Error(`مجموعة خيارات الحيوان غير صالحة: ${target?.sourceRecordId || '-'}`);
  }
  return {
    q: `من بين ${group.map(record => `«${animalDisplayName(record)}»`).join('، ')}، أي حيوان ينتمي إلى مجموعة «${targetGroup}»؟`,
    answer: animalDisplayName(target),
    answerPool: distractors.map(record => ({ value: animalDisplayName(record), tier: 'different-animal-group' })),
    factKey: `animal:${target.taxonId}:iconicTaxon`,
    sourceRecordId: target.sourceRecordId,
    templateId: 'animal-group-choice-v1',
    rank: Number(target.observationsCountAtRetrieval || 0),
    source: source(`${target.commonNameAr} — iNaturalist`, target.sourceUrl, target.sourcePublisher, 'iNaturalist API terms'),
    verification: {
      profile: 'source_record_set_v1', artifact: ARTIFACTS.animals, collection: 'records', recordIdField: 'sourceRecordId',
      records: group.map(record => ({
        recordId: String(record.sourceRecordId),
        fields: { taxonId: record.taxonId, commonNameAr: record.commonNameAr, scientificName: record.scientificName, iconicTaxon: record.iconicTaxon },
      })),
      claim: { domain: 'animal-member-of-group', subject: String(target.taxonId), predicate: 'iconicTaxon', object: target.iconicTaxon },
    },
    metadata: {
      answerSemanticType: 'animal-common-name', optionSemanticGroup: 'animal-common-name',
      animalChoiceClaims: group.map(record => ({
        recordId: String(record.sourceRecordId), name: animalDisplayName(record), iconicTaxon: record.iconicTaxon,
      })),
      targetAnimalGroup: target.iconicTaxon,
      legacyFact: { anchors: [animalDisplayName(target), targetGroup], minAnchors: 2 },
    },
  };
}

function completeAnimalRaw(raw, record) {
  const predicate = raw.templateId === 'animal-group-v2' ? 'iconicTaxon'
    : 'scientificName';
  return {
    ...raw,
    sourceRecordId: record.sourceRecordId,
    rank: Number(record.observationsCountAtRetrieval || 0),
    source: source(`${record.commonNameAr} — iNaturalist`, record.sourceUrl, record.sourcePublisher, 'iNaturalist API terms'),
    verification: sourceRecordVerification(
      ARTIFACTS.animals, 'sourceRecordId', record.sourceRecordId,
      { taxonId: record.taxonId, commonNameAr: record.commonNameAr, scientificName: record.scientificName, iconicTaxon: record.iconicTaxon },
      { subject: String(record.taxonId), predicate, object: predicate === 'iconicTaxon' ? record.iconicTaxon : record[predicate] },
    ),
  };
}

function buildAnimals(legacyRecords) {
  const records = read(ARTIFACTS.animals).records.filter(record =>
    animalGroups[record.iconicTaxon] && !blocked.test(JSON.stringify(record)));
  const easyRecords = curatedAnimalRecords(records, ANIMAL_TARGET_NAMES.easy, 'علوم سهلة');
  const mediumRecords = curatedAnimalRecords(records, ANIMAL_TARGET_NAMES.medium, 'علوم متوسطة');
  const hardRecords = curatedAnimalRecords(records, ANIMAL_TARGET_NAMES.hard, 'علوم صعبة');
  const allTargetIds = [...easyRecords, ...mediumRecords, ...hardRecords].map(record => record.taxonId);
  if (new Set(allTargetIds).size !== 90) throw new Error('سجلات مستويات علوم وطبيعة ليست متباينة بالكامل');

  const easyGroup = easyRecords.map(record =>
    completeAnimalRaw(animalRaw(record, 'iconicTaxon', records), record))
    .filter(raw => isFresh(raw, legacyRecords));
  const mediumChoice = mediumRecords.map((target, index) => {
    const rotated = [...mediumRecords.slice((index * 7 + 5) % mediumRecords.length), ...mediumRecords];
    const group = [target];
    const usedGroups = new Set([target.iconicTaxon]);
    for (const candidate of rotated) {
      if (candidate.taxonId === target.taxonId || usedGroups.has(candidate.iconicTaxon)) continue;
      group.push(candidate);
      usedGroups.add(candidate.iconicTaxon);
      if (group.length === 4) break;
    }
    const raw = animalGroupChoiceRaw(group);
    return isFresh(raw, legacyRecords) ? raw : null;
  }).filter(Boolean);
  const scientific = hardRecords.map(record =>
    completeAnimalRaw(animalRaw(record, 'scientificName', records), record))
    .filter(raw => isFresh(raw, legacyRecords));
  if (easyGroup.length !== 30 || mediumChoice.length !== 30 || scientific.length !== 30) {
    throw new Error(`حقائق العلوم الجديدة غير كافية: easy=${easyGroup.length}, medium=${mediumChoice.length}, scientific=${scientific.length}`);
  }
  return {
    questions: finalizeCategory('علوم وطبيعة', [...easyGroup, ...mediumChoice, ...scientific]),
    usedAnimalIds: new Set(allTargetIds),
  };
}

function oneTrueRaw({
  domain, templateId, artifact, recordIdField, target, group,
  subject, actual, wrongValue, fields, label, promptNoun, sourceFor, legacyRecords,
}) {
  const claims = group.map((record, index) => {
    const actualValue = String(actual(record));
    const presentedValue = index === 0 ? actualValue : String(wrongValue(record, index, group));
    return {
      recordId: String(record[recordIdField]),
      subject: subject(record),
      actualValue,
      presentedValue,
      text: `${subject(record)} — ${presentedValue}`,
    };
  });
  if (new Set(claims.map(claim => claim.actualValue)).size !== 4
      || new Set(claims.map(claim => claim.presentedValue)).size !== 4
      || claims.slice(1).some(claim => claim.actualValue === claim.presentedValue)) {
    throw new Error(`${domain}: قيم العبارات لا تشكل جوابًا فريدًا بلا تسريب`);
  }
  const answer = claims[0].text;
  const promptSubjects = group.map(subject);
  const promptOffset = Number.parseInt(sha256(`${domain}|${target[recordIdField]}|prompt`).slice(0, 8), 16) % promptSubjects.length;
  const orderedPromptSubjects = [...promptSubjects.slice(promptOffset), ...promptSubjects.slice(0, promptOffset)];
  const raw = {
    q: `أي العبارات التالية صحيحة؟ اختر العلاقة الصحيحة ${label} من بين ${promptNoun}: ${orderedPromptSubjects.map(value => `«${value}»`).join('، ')}.`,
    answer,
    answerPool: claims.slice(1).map(claim => claim.text),
    factKey: `one-true:${domain}:${target[recordIdField]}:${actual(target)}`,
    sourceRecordId: String(target[recordIdField]),
    templateId,
    rank: Number(target.familiarityRank || target.observationsCountAtRetrieval || 0),
    source: sourceFor(target),
    verification: {
      profile: 'source_record_set_v1', artifact, collection: 'records', recordIdField,
      records: group.map(record => ({ recordId: String(record[recordIdField]), fields: fields(record) })),
      claim: { domain, subject: subject(target), predicate: domain, object: String(actual(target)) },
    },
    metadata: {
      answerSemanticType: 'factual-pair', optionSemanticGroup: `one-true-${domain}`,
      truthClaims: claims, promptSubjects: orderedPromptSubjects,
      legacyFact: { anchors: [subject(target), String(actual(target))], minAnchors: 2 },
    },
  };
  return isFresh(raw, legacyRecords) ? raw : null;
}

function groupedTargets(rows, start, count) {
  return rows.slice(start, start + count).map((target, index) => {
    const absolute = start + index;
    const offsets = rows.length >= 24 ? [7, 16, 23] : [3, 7, 11];
    return [target, ...offsets.map(offset => rows[(absolute + offset) % rows.length])];
  });
}

function buildTrueFalse({ legacyRecords, chemistrySelections, usedAnimalIds }) {
  const elementBands = [chemistrySelections.slice(0, 15), chemistrySelections.slice(15, 30), chemistrySelections.slice(30, 45)];
  const elementRaws = elementBands.flatMap(band => groupedTargets(band, 0, band.length).map(group => {
    const targetSelection = group[0];
    const target = targetSelection.record;
    const predicate = targetSelection.predicate === 'symbol' ? 'atomicNumber' : 'symbol';
    const records = group.map(item => item.record);
    return oneTrueRaw({
      domain: `element-${predicate}`, templateId: 'one-true-element-v1', artifact: ARTIFACTS.elements,
      recordIdField: 'item', target, group: records,
      subject: elementDisplayName, actual: record => record[predicate],
      wrongValue: (_record, index, values) => values[1 + (index % (values.length - 1))][predicate],
      fields: record => ({ itemLabel: record.itemLabel, symbol: record.symbol, atomicNumber: record.atomicNumber }),
      label: predicate === 'symbol' ? 'بين العنصر ورمزه الكيميائي' : 'بين العنصر وعدده الذري',
      promptNoun: 'العناصر التالية',
      sourceFor: record => source(`${elementDisplayName(record)} — سجل العنصر`, record.item, 'Wikidata', 'CC0 1.0'),
      legacyRecords,
    });
  }).filter(Boolean).slice(0, 10));

  const animalRecords = read(ARTIFACTS.animals).records.filter(record =>
    animalGroups[record.iconicTaxon] && !usedAnimalIds.has(record.taxonId) && !blocked.test(JSON.stringify(record)));
  const animalCandidates = curatedAnimalRecords(animalRecords, TRUE_FALSE_ANIMAL_NAMES, 'اختر العبارة الصحيحة — الحيوانات');
  const animalBands = [animalCandidates.slice(0, 10), animalCandidates.slice(10, 20), animalCandidates.slice(20, 30)];
  const animalQuestionGroups = new Set();
  const animalRaws = animalBands.flatMap((band, bandIndex) => band.map((target, targetIndex) => {
    let group = null;
    for (let attempt = 0; attempt < animalCandidates.length && !group; attempt += 1) {
      const offset = (bandIndex * 17 + targetIndex * 7 + attempt * 5 + 3) % animalCandidates.length;
      const companions = [...animalCandidates.slice(offset), ...animalCandidates.slice(0, offset)]
        .filter(record => record.taxonId !== target.taxonId);
      const candidateGroup = [target];
      const usedGroups = new Set([target.iconicTaxon]);
      for (const record of companions) {
        if (usedGroups.has(record.iconicTaxon)) continue;
        candidateGroup.push(record);
        usedGroups.add(record.iconicTaxon);
        if (candidateGroup.length === 4) break;
      }
      const signature = candidateGroup.map(record => record.taxonId).sort((left, right) => left - right).join('|');
      if (candidateGroup.length === 4 && !animalQuestionGroups.has(signature)) {
        animalQuestionGroups.add(signature);
        group = candidateGroup;
      }
    }
    if (!group) throw new Error(`تعذر تكوين مجموعة عبارات فريدة للحيوان ${animalDisplayName(target)}`);
    return oneTrueRaw({
    domain: 'animal-group', templateId: 'one-true-animal-group-v1', artifact: ARTIFACTS.animals,
    recordIdField: 'sourceRecordId', target: group[0], group,
    subject: animalDisplayName, actual: record => animalGroups[record.iconicTaxon],
    wrongValue: (_record, index, values) => animalGroups[values[1 + (index % (values.length - 1))].iconicTaxon],
    fields: record => ({ commonNameAr: record.commonNameAr, iconicTaxon: record.iconicTaxon, taxonId: record.taxonId }),
    label: 'بين الحيوان ومجموعته الحيوانية',
    promptNoun: 'الحيوانات التالية',
    sourceFor: record => source(`${animalDisplayName(record)} — iNaturalist`, record.sourceUrl, record.sourcePublisher, 'iNaturalist API terms'),
    legacyRecords,
  });
  }).filter(Boolean));

  const countryRecords = countryOrder(read(ARTIFACTS.countries).records.filter(record =>
    record.iso3 && record.countryAr && !['MT'].includes(record.iso2) && !blocked.test(JSON.stringify(record))));
  const countryBands = [countryRecords.slice(0, 30), countryRecords.slice(30, 60), countryRecords.slice(60, 90)];
  const countryRaws = countryBands.flatMap(band => groupedTargets(band, 0, band.length).map(group => oneTrueRaw({
    domain: 'country-iso3', templateId: 'one-true-country-iso3-v1', artifact: ARTIFACTS.countries,
    recordIdField: 'sourceRecordId', target: group[0], group,
    subject: record => record.countryAr, actual: record => record.iso3,
    wrongValue: (_record, index, values) => values[1 + (index % (values.length - 1))].iso3,
    fields: record => ({ countryAr: record.countryAr, iso3: record.iso3 }),
    label: 'بين الدولة ورمزها وفق معيار ISO 3166-1 ذي الأحرف الثلاثة',
    promptNoun: 'الدول التالية',
    sourceFor: record => source(`${record.countryAr} — بيانات الدولة`, record.sourceUrl, record.sourcePublisher, 'World Bank Terms of Use'),
    legacyRecords,
  })).filter(Boolean).slice(0, 10));

  if (elementRaws.length !== 30 || animalRaws.length !== 30 || countryRaws.length !== 30) {
    throw new Error(`عبارات الاختيار غير مكتملة: elements=${elementRaws.length}, animals=${animalRaws.length}, countries=${countryRaws.length}`);
  }
  const raws = [
    ...elementRaws.slice(0, 10), ...animalRaws.slice(0, 10), ...countryRaws.slice(0, 10),
    ...elementRaws.slice(10, 20), ...animalRaws.slice(10, 20), ...countryRaws.slice(10, 20),
    ...elementRaws.slice(20, 30), ...animalRaws.slice(20, 30), ...countryRaws.slice(20, 30),
  ];
  return finalizeCategory('اختر العبارة الصحيحة', raws);
}

function teamLabel(value) {
  return ({
    'جمهورية ألمانيا الاتحادية': 'ألمانيا الغربية',
    'جمهورية ألمانيا الديمقراطية': 'ألمانيا الشرقية',
    'جمهورية كوريا': 'كوريا الجنوبية',
    'جمهورية كوريا الديمقراطية الشعبية': 'كوريا الشمالية',
    'جمهورية الصين الشعبية': 'الصين',
    'جمهورية أيرلندا': 'أيرلندا',
    'المملكة العربية السعودية': 'السعودية',
    'الولايات المتحدة الأمريكية': 'الولايات المتحدة',
  })[value] || value;
}

function stageLabel(value, year = null) {
  if (['Group Stage', 'المرحلة الأولى', 'مباريات المجموعة'].includes(value)) return 'دور المجموعات';
  if (['المباراة الفاصلة لتحديد المركز الثالث', 'مباراة تحديد المركز الثالث'].includes(value)) return 'مباراة المركز الثالث';
  if (value === 'الدور الثاني') {
    return Number(year) > 0 && Number(year) < 1986
      ? 'الدور الثاني (مرحلة المجموعات الثانية)'
      : 'دور الستة عشر';
  }
  return value;
}

const stagePool = ['دور المجموعات','الدور الثاني (مرحلة المجموعات الثانية)','دور الستة عشر','الدور ربع النهائي','المباراة نصف النهائية','المباراة النهائية','مباراة المركز الثالث'];
const LUSAIL_CITY_SOURCE_URL = 'https://inside.fifa.com/ar/news/fifa-president-attends-lusail-stadium-test-event-ar';
const FOOTBALL_CITY_NAME_OVERRIDES = new Map([
  ['تالوكا', 'تولوكا'],
  ['كوبه', 'كوبي'],
]);

function footballCity(record) {
  if (Number(record.year) === 2022 && record.stadium === 'استاد لوسيل') {
    return { name: 'لوسيل', sourceUrl: LUSAIL_CITY_SOURCE_URL };
  }
  return { name: FOOTBALL_CITY_NAME_OVERRIDES.get(record.city) || record.city, sourceUrl: record.sourceUrl };
}

function footballRank(record) {
  const importance = {
    'المباراة النهائية': 7, 'المباراة نصف النهائية': 6, 'الدور ربع النهائي': 5,
    'دور الستة عشر': 4, 'مباراة تحديد المركز الثالث': 3,
    'المباراة الفاصلة لتحديد المركز الثالث': 3, 'الدور الثاني': 2,
    'مباريات المجموعة': 1, 'Group Stage': 1, 'المرحلة الأولى': 1,
  }[record.stage] || 0;
  return record.year * 10 + importance;
}

function scoreOptions(record) {
  const home = Number(record.homeScore);
  const away = Number(record.awayScore);
  const answer = `${home}–${away}`;
  const candidates = [
    `${away}–${home}`, `${Math.max(0, home - 1)}–${away}`, `${home + 1}–${away}`,
    `${home}–${Math.max(0, away - 1)}`, `${home}–${away + 1}`, `${Math.max(0, home - 1)}–${away + 1}`,
  ];
  return { answer, pool: candidates.filter(value => value !== answer) };
}

function footballRaw(record, type, all) {
  const home = teamLabel(record.home);
  const away = teamLabel(record.away);
  const stage = stageLabel(record.stage, record.year);
  const venueCity = footballCity(record);
  let q;
  let answer;
  let answerPool;
  if (type === 'score') {
    const score = scoreOptions(record);
    q = `كم كان عدد أهداف ${home} ثم ${away}، بالترتيب، في ${stage} من كأس العالم ${record.year}، قبل ركلات الترجيح إن وجدت؟`;
    answer = score.answer;
    answerPool = score.pool;
  } else if (type === 'stage') {
    q = `في أي دور من كأس العالم ${record.year} أقيمت مباراة ${home} و${away}؟`;
    answer = stage;
    answerPool = rotateAfter(stagePool, stage);
  } else {
    q = `في أي مدينة أقيمت مباراة ${home} و${away} في ${stage} من كأس العالم ${record.year}؟`;
    answer = venueCity.name;
    const readableCity = value => /[\u0600-\u06ff]/u.test(value || '') && !/[A-Za-z]/u.test(value || '');
    const sameYear = all.filter(row => row.year === record.year)
      .map(row => footballCity(row).name).filter(readableCity);
    answerPool = [
      ...rotateAfter(sameYear, answer).map(value => ({ value, tier: 'same-tournament' })),
      ...rotateAfter(all.map(row => footballCity(row).name).filter(readableCity), answer)
        .map(value => ({ value, tier: 'global' })),
    ];
  }
  const answerType = type === 'stage' ? 'stage' : type;
  return {
    q, answer, answerPool,
    factKey: `fifa-match:${record.matchId}:${type}`,
    sourceRecordId: record.sourceRecordId,
    templateId: `fifa-match-${type}-v3`,
    rank: footballRank(record),
    source: source(`كأس العالم ${record.year}: ${home} — ${away}`,
      type === 'city' ? venueCity.sourceUrl : record.sourceUrl, record.sourcePublisher, 'FIFA API terms'),
    verification: sourceRecordVerification(
      ARTIFACTS.football, 'sourceRecordId', record.sourceRecordId,
      { matchId: record.matchId, year: record.year, home: record.home, away: record.away, homeScore: record.homeScore, awayScore: record.awayScore, stage: record.stage, stadium: record.stadium, city: record.city },
      { subject: record.matchId, predicate: type, object: answer },
    ),
    metadata: {
      answerSemanticType: answerType, optionSemanticGroup: `football-${answerType}`,
      legacyFact: { anchors: [String(record.year), home, away, String(answer)], minAnchors: 3 },
    },
  };
}

function footballTeamFamiliarity(record) {
  const order = [
    'البرازيل','ألمانيا','الأرجنتين','فرنسا','إيطاليا','إسبانيا','إنجلترا','هولندا','البرتغال',
    'أوروغواي','بلجيكا','كرواتيا','المكسيك','اليابان','كوريا الجنوبية','الولايات المتحدة',
    'السعودية','المغرب','تونس','الجزائر','مصر','الكاميرون','نيجيريا','غانا','السنغال',
  ];
  const rank = new Map(order.map((team, index) => [team, order.length - index]));
  return (rank.get(teamLabel(record.home)) || 0) + (rank.get(teamLabel(record.away)) || 0);
}

function footballStageImportance(record) {
  return {
    'المباراة النهائية': 6,
    'المباراة نصف النهائية': 5,
    'الدور ربع النهائي': 4,
    'دور الستة عشر': 3,
    'مباراة المركز الثالث': 2,
    'دور المجموعات': 1,
  }[stageLabel(record.stage, record.year)] || 0;
}

function footballRowsByYear(rows) {
  const years = [...new Set(rows.map(record => record.year))].sort((left, right) => right - left);
  const queues = new Map(years.map(year => [year, rows.filter(record => record.year === year)
    .sort((left, right) => footballStageImportance(right) - footballStageImportance(left)
      || footballTeamFamiliarity(right) - footballTeamFamiliarity(left)
      || String(left.matchId).localeCompare(String(right.matchId)))]));
  const spread = [];
  const longest = Math.max(...queues.values().map(queue => queue.length), 0);
  for (let offset = 0; offset < longest; offset += 1) {
    for (const year of years) if (queues.get(year)[offset]) spread.push(queues.get(year)[offset]);
  }
  return spread;
}

function viableFootballRaw(record, type, all, legacyRecords) {
  const raw = footballRaw(record, type, all);
  if (!isFresh(raw, legacyRecords)) return null;
  try { makeOptions(raw.answer, raw.answerPool, raw.factKey); }
  catch { return null; }
  return raw;
}

function buildFootball(legacyRecords) {
  const all = read(ARTIFACTS.football).records
    .filter(record => record.matchId && record.home && record.away
      && Number.isFinite(Number(record.homeScore)) && Number.isFinite(Number(record.awayScore))
      && !blocked.test(JSON.stringify(record)))
    .sort((left, right) => footballRank(right) - footballRank(left)
      || String(left.matchId).localeCompare(String(right.matchId)));
  const used = new Set();
  const easy = [];
  const easyYearCounts = new Map();
  const easyQuotas = new Map([
    ['دور المجموعات', 8], ['دور الستة عشر', 8], ['الدور ربع النهائي', 8], ['المباراة نصف النهائية', 6],
  ]);
  for (const [stage, quota] of easyQuotas) {
    let selectedForStage = 0;
    for (const minimumYear of [2010, 2002, 1970]) {
      const candidates = footballRowsByYear(all.filter(record =>
        record.year >= minimumYear && stageLabel(record.stage, record.year) === stage));
      for (const record of candidates) {
        if (selectedForStage >= quota) break;
        if (used.has(record.matchId) || (easyYearCounts.get(record.year) || 0) >= 10) continue;
        const raw = viableFootballRaw(record, 'stage', all, legacyRecords);
        if (!raw) continue;
        easy.push(raw);
        used.add(record.matchId);
        selectedForStage += 1;
        easyYearCounts.set(record.year, (easyYearCounts.get(record.year) || 0) + 1);
      }
      if (selectedForStage >= quota) break;
    }
  }

  const medium = [];
  const mediumYearCounts = new Map();
  // Finals are reserved for the separate «أندية ومنتخبات» source set, so a
  // World Cup final score never appears twice under two categories.
  const knockoutStages = new Set(['دور الستة عشر','الدور ربع النهائي','المباراة نصف النهائية','مباراة المركز الثالث']);
  for (const limits of [{ minimumYear: 2002, maximumPerYear: 6 }, { minimumYear: 1990, maximumPerYear: 6 }, { minimumYear: 1970, maximumPerYear: Infinity }]) {
    const candidates = footballRowsByYear(all.filter(record =>
      record.year >= limits.minimumYear && knockoutStages.has(stageLabel(record.stage, record.year))));
    for (const record of candidates) {
      if (medium.length >= 30) break;
      if (used.has(record.matchId) || (mediumYearCounts.get(record.year) || 0) >= limits.maximumPerYear) continue;
      const raw = viableFootballRaw(record, 'score', all, legacyRecords);
      if (!raw) continue;
      medium.push(raw);
      used.add(record.matchId);
      mediumYearCounts.set(record.year, (mediumYearCounts.get(record.year) || 0) + 1);
    }
    if (medium.length >= 30) break;
  }

  const hard = [];
  const hardYearCounts = new Map();
  const hardStageCounts = new Map();
  const cityCandidates = footballRowsByYear(all.filter(record =>
    /[\u0600-\u06ff]/u.test(record.city || '') && !/[A-Za-z]/u.test(record.city || '')));
  for (const limits of [{ year: 3, stage: 8 }, { year: 4, stage: 10 }, { year: Infinity, stage: Infinity }]) {
    for (const record of cityCandidates) {
      const stage = stageLabel(record.stage, record.year);
      if (hard.length >= 30) break;
      if (used.has(record.matchId)
          || (hardYearCounts.get(record.year) || 0) >= limits.year
          || (hardStageCounts.get(stage) || 0) >= limits.stage) continue;
      const raw = viableFootballRaw(record, 'city', all, legacyRecords);
      if (!raw) continue;
      hard.push(raw);
      used.add(record.matchId);
      hardYearCounts.set(record.year, (hardYearCounts.get(record.year) || 0) + 1);
      hardStageCounts.set(stage, (hardStageCounts.get(stage) || 0) + 1);
    }
    if (hard.length >= 30) break;
  }

  if (easy.length !== 30 || medium.length !== 30 || hard.length !== 30) {
    throw new Error(`حقائق كرة القدم الجديدة غير كافية: easy=${easy.length}, medium=${medium.length}, hard=${hard.length}`);
  }
  return finalizeCategory('كرة القدم', [...easy, ...medium, ...hard]);
}

const suspectNames = ['أحمد','بدر','جاسم','خالد','راشد','سالم','طلال','فهد','ناصر','وليد','يوسف','زياد'];
const permutations = [];
function buildPermutations(remaining, chosen = []) {
  if (!remaining.length) permutations.push(chosen);
  else remaining.forEach((value, index) => buildPermutations(
    [...remaining.slice(0, index), ...remaining.slice(index + 1)], [...chosen, value],
  ));
}
buildPermutations([0, 1, 2, 3]);

function statementTruth(statement, culprit) {
  if (statement.kind === 'guilty') return statement.subject === culprit;
  if (statement.kind === 'innocent') return statement.subject !== culprit;
  if (statement.kind === 'oneOf') return statement.first === culprit || statement.second === culprit;
  return statement.first !== culprit && statement.second !== culprit;
}

function logicSolutions(statements, requiredTrueStatements) {
  return [0, 1, 2, 3].filter(culprit => statements.reduce((count, statement) =>
    count + Number(statementTruth(statement, culprit)), 0) === requiredTrueStatements);
}

function canonicalPuzzle(statements, requiredTrueStatements) {
  let best = null;
  for (const mapping of permutations) {
    const rows = statements.map((statement, speaker) => {
      if (statement.kind === 'guilty' || statement.kind === 'innocent') {
        return { speaker: mapping[speaker], text: `${statement.kind}:${mapping[statement.subject]}` };
      }
      let first = mapping[statement.first];
      let second = mapping[statement.second];
      if (first > second) [first, second] = [second, first];
      return { speaker: mapping[speaker], text: `${statement.kind}:${first},${second}` };
    }).sort((left, right) => left.speaker - right.speaker);
    const signature = `${requiredTrueStatements}|${rows.map(row => row.text).join(';')}`;
    if (best === null || signature < best) best = signature;
  }
  return best;
}

function statementText(statement, suspects) {
  if (statement.kind === 'guilty') return `${suspects[statement.subject]} هو السارق`;
  if (statement.kind === 'innocent') return `${suspects[statement.subject]} بريء`;
  if (statement.kind === 'oneOf') return `السارق إما ${suspects[statement.first]} وإما ${suspects[statement.second]}`;
  return `السارق ليس ${suspects[statement.first]} ولا ${suspects[statement.second]}`;
}

function logicKindCounts(statements) {
  return Object.fromEntries(['guilty', 'innocent', 'oneOf', 'neither']
    .map(kind => [kind, statements.filter(statement => statement.kind === kind).length]));
}

function balancedLogicProfile(puzzle, band) {
  const counts = logicKindCounts(puzzle.statements);
  if (band === 'easy') return counts.guilty === 2 && counts.innocent === 2;
  if (band === 'medium') return Object.values(counts).every(count => count === 1);
  return counts.oneOf === 2 && counts.neither === 2;
}

function selectBalancedLogicPuzzles(rows, band) {
  const requirements = band === 'easy' ? [1, 3] : [1, 2, 3];
  const solutionPatterns = band === 'easy'
    ? {
      1: [0,1,2,3,0,1,2,3,0,1,2,3,0,1,3],
      3: [0,1,2,3,0,1,2,3,0,1,2,3,1,2,2],
    }
    : {
      1: [0,1,2,3,0,1,2,3,0,1],
      2: [2,3,0,1,2,3,0,1,2,3],
      3: [0,3,1,2,0,3,1,2,0,3],
    };
  const selectedByRequirement = new Map();
  for (const required of requirements) {
    const eligible = rows.filter(puzzle =>
      puzzle.requiredTrueStatements === required && balancedLogicProfile(puzzle, band));
    const selected = [];
    for (const solution of solutionPatterns[required]) {
      const candidate = eligible.filter(puzzle => puzzle.solution === solution && !selected.includes(puzzle))
        .sort((left, right) => sha256(`${band}|${required}|${left.canonical}`)
          .localeCompare(sha256(`${band}|${required}|${right.canonical}`)))[0];
      if (!candidate) throw new Error(`ألغاز ${band}: لا يوجد مرشح متوازن للشرط ${required} والحل ${solution}`);
      selected.push(candidate);
    }
    selectedByRequirement.set(required, selected);
  }
  const interleaved = [];
  const longest = Math.max(...selectedByRequirement.values().map(group => group.length));
  for (let index = 0; index < longest; index += 1) {
    for (const required of requirements) {
      const puzzle = selectedByRequirement.get(required)[index];
      if (puzzle) interleaved.push(puzzle);
    }
  }
  if (interleaved.length !== 30 || new Set(interleaved.map(puzzle => puzzle.canonical)).size !== 30) {
    throw new Error(`ألغاز ${band}: فشل اختيار 30 بنية متوازنة وفريدة`);
  }
  return interleaved;
}

function puzzleCandidates() {
  const claims = [];
  for (let subject = 0; subject < 4; subject += 1) claims.push({ kind: 'guilty', subject }, { kind: 'innocent', subject });
  for (let first = 0; first < 4; first += 1) for (let second = first + 1; second < 4; second += 1) {
    claims.push({ kind: 'oneOf', first, second }, { kind: 'neither', first, second });
  }
  const buckets = { easy: new Map(), medium: new Map(), hard: new Map() };
  for (const first of claims) for (const second of claims) for (const third of claims) for (const fourth of claims) {
    const statements = [first, second, third, fourth];
    if (new Set(statements.map(item => JSON.stringify(item))).size !== 4) continue;
    const compoundCount = statements.filter(item => item.kind === 'oneOf' || item.kind === 'neither').length;
    const band = compoundCount === 0 ? 'easy' : compoundCount === 2 ? 'medium' : compoundCount === 4 ? 'hard' : null;
    if (!band) continue;
    for (const requiredTrueStatements of [1, 2, 3]) {
      const solutions = logicSolutions(statements, requiredTrueStatements);
      if (solutions.length !== 1) continue;
      const canonical = canonicalPuzzle(statements, requiredTrueStatements);
      if (!buckets[band].has(canonical)) {
        buckets[band].set(canonical, { statements, requiredTrueStatements, solution: solutions[0], canonical });
      }
    }
  }
  return Object.fromEntries(Object.entries(buckets)
    .map(([band, rows]) => [band, selectBalancedLogicPuzzles([...rows.values()], band)]));
}

function buildDetectivePuzzles() {
  const candidates = puzzleCandidates();
  for (const band of ['easy', 'medium', 'hard']) {
    if (candidates[band].length !== 30) throw new Error(`ألغاز ${band} غير كافية: ${candidates[band].length}`);
  }
  const selected = [...candidates.easy, ...candidates.medium, ...candidates.hard];
  const questions = selected.map((puzzle, index) => {
    const suspects = Array.from({ length: 4 }, (_, offset) => suspectNames[(index + offset * 3) % suspectNames.length]);
    const statements = puzzle.statements.map((statement, speaker) => ({ speaker, ...statement }));
    const answer = suspects[puzzle.solution];
    const questionText = detectiveQuestionText(suspects, statements, puzzle.requiredTrueStatements);
    const kindCounts = logicKindCounts(statements);
    const logicComplexity = {
      compoundStatementCount: kindCounts.oneOf + kindCounts.neither,
      statementKindCounts: kindCounts,
    };
    return {
      q: questionText,
      answer, answerPool: suspects,
      factKey: `logic:${sha256(puzzle.canonical).slice(0, 20)}`,
      sourceRecordId: `logic-${sha256(puzzle.canonical).slice(0, 20)}`,
      templateId: 'detective-unique-solution-v3',
      rank: 90 - index,
      source: source('المنطق القضوي الكلاسيكي', 'https://plato.stanford.edu/entries/logic-classical/', 'Stanford Encyclopedia of Philosophy', 'Reference use'),
      verification: {
        profile: 'logic_unique_solution_v1',
        claim: { suspects, statements, requiredTrueStatements: puzzle.requiredTrueStatements, solution: puzzle.solution },
      },
      metadata: {
        answerSemanticType: 'person-name', optionSemanticGroup: 'logic-suspect',
        logicSuspects: suspects, logicStatements: statements,
        requiredTrueStatements: puzzle.requiredTrueStatements,
        canonicalLogicStructure: puzzle.canonical,
        logicComplexity,
      },
    };
  });
  return finalizeCategory('ألغاز بوليسية', questions);
}

function detectiveQuestionText(suspects, statements, requiredTrueStatements) {
  const spoken = statements.map(statement => `${suspects[statement.speaker]}: «${statementText(statement, suspects)}»`).join('؛ ');
  const truthText = requiredTrueStatements === 1 ? 'قول واحد فقط صحيح'
    : requiredTrueStatements === 2 ? 'قولان فقط صحيحان' : 'ثلاثة أقوال فقط صحيحة';
  return `قال أربعة مشتبهين في سرقة: ${spoken}. ${truthText}؛ من السارق؟`;
}

export function buildWorldScienceCategories({ legacyRecords = [], oldQuestions = new Set() } = {}) {
  void oldQuestions;
  const physicsChemistry = buildPhysicsChemistry(legacyRecords);
  const nature = buildAnimals(legacyRecords);
  return {
    'اختر العبارة الصحيحة': buildTrueFalse({
      legacyRecords,
      chemistrySelections: physicsChemistry.chemistrySelections,
      usedAnimalIds: nature.usedAnimalIds,
    }),
    'كرة القدم': buildFootball(legacyRecords),
    'علوم وطبيعة': nature.questions,
    'مدن وعواصم': buildCities(legacyRecords),
    'عملات العالم': buildCurrencies(legacyRecords),
    'فيزياء وكيمياء': physicsChemistry.questions,
    'ألغاز بوليسية': buildDetectivePuzzles(),
  };
}

function canonicalValue(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameValue(left, right) {
  return canonicalValue(left) === canonicalValue(right);
}

function verifyRawBinding(question, expected, category) {
  if (geographicAnswerLeak(question)) return false;
  let expectedOptions;
  try {
    expectedOptions = makeOptions(expected.answer, expected.answerPool, `${category}|${expected.factKey}`).o
      .map(normalizeArabic).sort();
  } catch { return false; }
  const metadataMatches = Object.entries(expected.metadata || {})
    .every(([key, value]) => sameValue(question[key], value));
  return metadataMatches
    && question.q === expected.q
    && question.id === `gq-${sha256(`next-v2|${category}|${expected.factKey}|${expected.q}`).slice(0, 20)}`
    && question.answer === String(expected.answer)
    && question.templateId === expected.templateId
    && question.sourceRecordId === String(expected.sourceRecordId)
    && question.factKey === expected.factKey
    && question.rank === Number(expected.rank || 0)
    && sameValue(question.source, expected.source)
    && sameValue(question.verification, expected.verification)
    && sameValue(question.o.map(normalizeArabic).sort(), expectedOptions);
}

function verifyOneTrueQuestion(question, records) {
  if (!Array.isArray(records) || records.length !== 4 || !Array.isArray(question.truthClaims)
      || question.truthClaims.length !== 4 || !Array.isArray(question.promptSubjects)
      || question.promptSubjects.length !== 4 || question.o.length !== 4) return false;
  const configs = {
    'one-true-element-v1': {
      artifact: ARTIFACTS.elements, recordIdField: 'item',
      domains: new Set(['element-symbol', 'element-atomicNumber']), subject: elementDisplayName,
      value: (record, domain) => domain === 'element-symbol' ? record.symbol : record.atomicNumber,
      label: domain => domain === 'element-symbol' ? 'بين العنصر ورمزه الكيميائي' : 'بين العنصر وعدده الذري',
      promptNoun: 'العناصر التالية',
      fields: record => ({ itemLabel: record.itemLabel, symbol: record.symbol, atomicNumber: record.atomicNumber }),
      sourceFor: record => source(`${elementDisplayName(record)} — سجل العنصر`, record.item, 'Wikidata', 'CC0 1.0'),
    },
    'one-true-animal-group-v1': {
      artifact: ARTIFACTS.animals, recordIdField: 'sourceRecordId',
      domains: new Set(['animal-group']), subject: animalDisplayName,
      value: record => animalGroups[record.iconicTaxon], label: () => 'بين الحيوان ومجموعته الحيوانية',
      promptNoun: 'الحيوانات التالية',
      fields: record => ({ commonNameAr: record.commonNameAr, iconicTaxon: record.iconicTaxon, taxonId: record.taxonId }),
      sourceFor: record => source(`${animalDisplayName(record)} — iNaturalist`, record.sourceUrl, record.sourcePublisher, 'iNaturalist API terms'),
    },
    'one-true-country-iso3-v1': {
      artifact: ARTIFACTS.countries, recordIdField: 'sourceRecordId',
      domains: new Set(['country-iso3']), subject: record => record.countryAr,
      value: record => record.iso3, label: () => 'بين الدولة ورمزها وفق معيار ISO 3166-1 ذي الأحرف الثلاثة',
      promptNoun: 'الدول التالية',
      fields: record => ({ countryAr: record.countryAr, iso3: record.iso3 }),
      sourceFor: record => source(`${record.countryAr} — بيانات الدولة`, record.sourceUrl, record.sourcePublisher, 'World Bank Terms of Use'),
    },
  };
  const config = configs[question.templateId];
  const domain = question.verification?.claim?.domain;
  if (!config || !config.domains.has(domain)
      || question.verification?.artifact !== config.artifact
      || question.verification?.collection !== 'records'
      || question.verification?.recordIdField !== config.recordIdField) return false;
  const recordIds = records.map(record => String(record[config.recordIdField]));
  const actualValues = records.map(record => String(config.value(record, domain)));
  if (new Set(recordIds).size !== 4 || new Set(actualValues).size !== 4) return false;
  const expectedClaims = records.map((record, index) => {
    const actualValue = actualValues[index];
    const presentedValue = index === 0 ? actualValue : actualValues[1 + (index % 3)];
    const subject = config.subject(record);
    return { recordId: recordIds[index], subject, actualValue, presentedValue, text: `${subject} — ${presentedValue}` };
  });
  const target = records[0];
  const targetId = recordIds[0];
  const targetValue = actualValues[0];
  const expectedVerification = {
    profile: 'source_record_set_v1', artifact: config.artifact, collection: 'records', recordIdField: config.recordIdField,
    records: records.map(record => ({ recordId: String(record[config.recordIdField]), fields: config.fields(record) })),
    claim: { domain, subject: config.subject(target), predicate: domain, object: targetValue },
  };
  const subjects = records.map(config.subject);
  const offset = Number.parseInt(sha256(`${domain}|${targetId}|prompt`).slice(0, 8), 16) % subjects.length;
  const expectedPromptSubjects = [...subjects.slice(offset), ...subjects.slice(0, offset)];
  const expectedQ = `أي العبارات التالية صحيحة؟ اختر العلاقة الصحيحة ${config.label(domain)} من بين ${config.promptNoun}: ${expectedPromptSubjects.map(value => `«${value}»`).join('، ')}.`;
  const expectedOptions = new Set(expectedClaims.map(claim => claim.text));
  return question.q === expectedQ
    && question.id === `gq-${sha256(`next-v2|اختر العبارة الصحيحة|one-true:${domain}:${targetId}:${targetValue}|${expectedQ}`).slice(0, 20)}`
    && question.answer === expectedClaims[0].text
    && question.sourceRecordId === targetId
    && question.factKey === `one-true:${domain}:${targetId}:${targetValue}`
    && question.rank === Number(target.familiarityRank || target.observationsCountAtRetrieval || 0)
    && question.answerSemanticType === 'factual-pair'
    && question.optionSemanticGroup === `one-true-${domain}`
    && sameValue(question.source, config.sourceFor(target))
    && sameValue(question.verification, expectedVerification)
    && sameValue(question.truthClaims, expectedClaims)
    && sameValue(question.promptSubjects, expectedPromptSubjects)
    && sameValue(question.legacyFact, { anchors: [config.subject(target), String(targetValue)], minAnchors: 2 })
    && question.o.length === 4 && question.o.every(option => expectedOptions.has(option));
}

function verifyAnimalGroupChoice(question, records) {
  if (question.templateId !== 'animal-group-choice-v1'
      || question.verification?.profile !== 'source_record_set_v1'
      || question.verification?.artifact !== ARTIFACTS.animals
      || question.verification?.collection !== 'records'
      || question.verification?.recordIdField !== 'sourceRecordId'
      || !Array.isArray(records) || records.length !== 4) return false;
  try {
    return verifyRawBinding(question, animalGroupChoiceRaw(records), 'علوم وطبيعة');
  } catch { return false; }
}

export function verifyWorldScienceQuestion(question, record) {
  if (question.verification?.profile === 'source_record_set_v1') {
    if (question.templateId === 'animal-group-choice-v1') return verifyAnimalGroupChoice(question, record);
    return verifyOneTrueQuestion(question, record);
  }
  if (!record) return null;
  if (question.templateId === 'city-country-v3') {
    const records = read(ARTIFACTS.cities).records.filter(item =>
      item.cityQid && item.cityNameAr && item.countryQid && item.countryNameAr
      && !blocked.test(JSON.stringify(item)));
    return verifyRawBinding(question, cityRaw(record, records), 'مدن وعواصم');
  }
  if (question.templateId === 'element-symbol-v2') {
    const records = orderedElements().filter(item => !blocked.test(JSON.stringify(item)));
    return verifyRawBinding(question, elementQuestionRaw(record, 'symbol', records,
      records.findIndex(item => item.item === record.item)), 'فيزياء وكيمياء');
  }
  if (question.templateId === 'element-atomic-number-v2') {
    const records = orderedElements().filter(item => !blocked.test(JSON.stringify(item)));
    return verifyRawBinding(question, elementQuestionRaw(record, 'atomicNumber', records,
      records.findIndex(item => item.item === record.item)), 'فيزياء وكيمياء');
  }
  if (question.templateId === 'si-quantity-unit-v1') {
    return verifyRawBinding(question, physicsUnitRaw(record, 'unitAr', read(ARTIFACTS.physics).records), 'فيزياء وكيمياء');
  }
  if (question.templateId === 'si-unit-symbol-v1') {
    return verifyRawBinding(question, physicsUnitRaw(record, 'symbol', read(ARTIFACTS.physics).records), 'فيزياء وكيمياء');
  }
  if (question.templateId === 'cldr-currency-name-v1') {
    return verifyRawBinding(question, currencyRaw(record,
      read(ARTIFACTS.currencies).records.filter(item => !blocked.test(JSON.stringify(item)))), 'عملات العالم');
  }
  if (question.templateId === 'animal-group-v2') {
    const records = read(ARTIFACTS.animals).records.filter(item =>
      animalGroups[item.iconicTaxon] && !blocked.test(JSON.stringify(item)));
    return verifyRawBinding(question, completeAnimalRaw(animalRaw(record, 'iconicTaxon', records), record), 'علوم وطبيعة');
  }
  if (question.templateId === 'animal-scientific-name-v2') {
    const records = read(ARTIFACTS.animals).records.filter(item =>
      animalGroups[item.iconicTaxon] && !blocked.test(JSON.stringify(item)));
    return verifyRawBinding(question, completeAnimalRaw(animalRaw(record, 'scientificName', records), record), 'علوم وطبيعة');
  }
  if (question.templateId === 'animal-arabic-name-v2') {
    const records = read(ARTIFACTS.animals).records.filter(item =>
      animalGroups[item.iconicTaxon] && !blocked.test(JSON.stringify(item)));
    return verifyRawBinding(question, completeAnimalRaw(animalRaw(record, 'commonNameAr', records), record), 'علوم وطبيعة');
  }
  if (question.templateId?.startsWith('fifa-match-')) {
    const type = question.templateId.replace(/^fifa-match-|-v3$/gu, '');
    const records = read(ARTIFACTS.football).records.filter(item =>
      item.matchId && item.home && item.away && Number.isFinite(Number(item.homeScore))
      && Number.isFinite(Number(item.awayScore)) && !blocked.test(JSON.stringify(item)))
      .sort((left, right) => footballRank(right) - footballRank(left)
        || String(left.matchId).localeCompare(String(right.matchId)));
    return verifyRawBinding(question, footballRaw(record, type, records), 'كرة القدم');
  }
  return null;
}

function verifyDetectiveQuestion(question) {
  const claim = question.verification?.claim;
  const suspects = claim?.suspects;
  const statements = claim?.statements;
  if (question.templateId !== 'detective-unique-solution-v3'
      || question.verification?.profile !== 'logic_unique_solution_v1'
      || !Array.isArray(suspects) || suspects.length !== 4 || new Set(suspects).size !== 4
      || !Array.isArray(statements) || statements.length !== 4
      || ![1, 2, 3].includes(claim.requiredTrueStatements)
      || statements.some((statement, speaker) => statement.speaker !== speaker)) return false;
  const solutions = logicSolutions(statements, claim.requiredTrueStatements);
  if (solutions.length !== 1 || solutions[0] !== claim.solution) return false;
  const expectedQuestion = detectiveQuestionText(suspects, statements, claim.requiredTrueStatements);
  const canonical = canonicalPuzzle(statements, claim.requiredTrueStatements);
  const digest = sha256(canonical).slice(0, 20);
  const kindCounts = logicKindCounts(statements);
  const compoundStatementCount = kindCounts.oneOf + kindCounts.neither;
  const expectedBand = compoundStatementCount === 0 ? 'easy'
    : compoundStatementCount === 2 ? 'medium' : compoundStatementCount === 4 ? 'hard' : null;
  return question.q === expectedQuestion
    && question.id === `gq-${sha256(`next-v2|ألغاز بوليسية|logic:${digest}|${expectedQuestion}`).slice(0, 20)}`
    && question.answer === suspects[solutions[0]]
    && question.sourceRecordId === `logic-${digest}`
    && question.factKey === `logic:${digest}`
    && sameValue(question.logicSuspects, suspects)
    && sameValue(question.logicStatements, statements)
    && question.requiredTrueStatements === claim.requiredTrueStatements
    && question.canonicalLogicStructure === canonical
    && question.band === expectedBand
    && sameValue(question.logicComplexity, { compoundStatementCount, statementKindCounts: kindCounts })
    && sameValue(question.source, source('المنطق القضوي الكلاسيكي',
      'https://plato.stanford.edu/entries/logic-classical/',
      'Stanford Encyclopedia of Philosophy', 'Reference use'));
}

function resolveWorldQuestionRecord(question) {
  if (question.verification?.profile === 'logic_unique_solution_v1') {
    return verifyDetectiveQuestion(question);
  }
  const artifact = question.verification?.artifact;
  if (!Object.values(ARTIFACTS).includes(artifact)) return false;
  const collection = String(question.verification?.collection || 'records').split('.')
    .filter(Boolean).reduce((value, key) => value?.[key], read(artifact));
  if (!Array.isArray(collection)) return false;
  const recordIdField = question.verification?.recordIdField;
  if (question.verification?.profile === 'source_record_set_v1') {
    const records = question.verification.records?.map(specification =>
      collection.find(record => String(record?.[recordIdField]) === String(specification.recordId)));
    return records?.length === 4 && records.every(Boolean)
      && verifyWorldScienceQuestion(question, records);
  }
  const record = collection.find(item =>
    String(item?.[recordIdField]) === String(question.verification?.recordId));
  return Boolean(record) && verifyWorldScienceQuestion(question, record);
}

function verifyNatureSelection(question, position) {
  const band = ['easy', 'medium', 'hard'][Math.floor(position / 30)];
  const expectedTemplate = {
    easy: 'animal-group-v2', medium: 'animal-group-choice-v1', hard: 'animal-scientific-name-v2',
  }[band];
  const expectedName = ANIMAL_TARGET_NAMES[band][position % 30];
  const actualName = question.verification?.profile === 'source_record_set_v1'
    ? question.verification?.records?.[0]?.fields?.commonNameAr
    : question.verification?.fields?.commonNameAr;
  return question.templateId === expectedTemplate
    && normalizeArabic(actualName) === normalizeArabic(expectedName);
}

export function verifyWorldScienceCategories(categories) {
  const expected = new Set(['اختر العبارة الصحيحة','كرة القدم','علوم وطبيعة','مدن وعواصم','عملات العالم','فيزياء وكيمياء','ألغاز بوليسية']);
  if (Object.keys(categories).length !== expected.size || Object.keys(categories).some(category => !expected.has(category))) return false;
  const ids = new Set(); const questions = new Set(); const facts = new Set();
  const categoriesValid = Object.entries(categories).every(([category, rows]) => {
    if (rows.length !== 90) return false;
    const valid = rows.every((rawQuestion, position) => {
      const question = { category, ...rawQuestion };
      const bandIndex = Math.floor(position / 30);
      if (!/^gq-[a-f0-9]{20}$/u.test(question.id) || ids.has(question.id)
          || questions.has(normalizeArabic(question.q)) || facts.has(question.factKey)
          || question.band !== ['easy', 'medium', 'hard'][bandIndex]
          || question.d !== bandIndex * 2 + 1 + (position % 2)
          || !Array.isArray(question.o) || question.o.length !== 4
          || new Set(question.o.map(normalizeArabic)).size !== 4
          || !Number.isInteger(question.a) || question.a < 0 || question.a > 3
          || question.o[question.a] !== question.answer
          || geographicAnswerLeak(question)
          || (category === 'علوم وطبيعة' && !verifyNatureSelection(question, position))
          || (category === 'اختر العبارة الصحيحة' && !question.q.startsWith('أي العبارات التالية صحيحة؟'))
          || (category === 'كرة القدم' && /(?:تالوكا|كوبه)/u.test(JSON.stringify({ q: question.q, o: question.o, answer: question.answer })))
          || (category === 'ألغاز بوليسية' && question.rank !== 90 - position)
          || blocked.test(JSON.stringify({ q: question.q, o: question.o, answer: question.answer }))) return false;
      try { for (let left = 0; left < 4; left += 1) for (let right = left + 1; right < 4; right += 1) {
        if (normalizeArabic(question.o[left]) === normalizeArabic(question.o[right])) return false;
      } } catch { return false; }
      if (!resolveWorldQuestionRecord(question)) return false;
      ids.add(question.id); questions.add(normalizeArabic(question.q)); facts.add(question.factKey);
      return true;
    });
    if (!valid) return false;
    for (const band of ['easy', 'medium', 'hard']) {
      const bandRows = rows.filter(question => question.band === band);
      const slots = Array.from({ length: 4 }, (_, slot) => bandRows.filter(question => question.a === slot).length);
      if (bandRows.length !== 30 || Math.max(...slots) - Math.min(...slots) > 1) return false;
    }
    return true;
  });
  if (!categoriesValid) return false;

  const natureTargetIds = new Set(categories['علوم وطبيعة'].map(question => question.sourceRecordId));
  const trueFalseAnimalTargets = categories['اختر العبارة الصحيحة']
    .filter(question => question.templateId === 'one-true-animal-group-v1')
    .map(question => question.sourceRecordId);
  if (natureTargetIds.size !== 90 || trueFalseAnimalTargets.length !== 30
      || new Set(trueFalseAnimalTargets).size !== 30
      || trueFalseAnimalTargets.some(id => natureTargetIds.has(id))) return false;

  const logic = categories['ألغاز بوليسية'];
  const expectedKinds = {
    easy: { guilty: 60, innocent: 60, oneOf: 0, neither: 0 },
    medium: { guilty: 30, innocent: 30, oneOf: 30, neither: 30 },
    hard: { guilty: 0, innocent: 0, oneOf: 60, neither: 60 },
  };
  for (const band of ['easy', 'medium', 'hard']) {
    const rows = logic.filter(question => question.band === band);
    const kindCounts = logicKindCounts(rows.flatMap(question => question.logicStatements));
    if (!sameValue(kindCounts, expectedKinds[band])) return false;
    const requiredCounts = Object.fromEntries([1, 2, 3]
      .map(required => [required, rows.filter(question => question.requiredTrueStatements === required).length]));
    if (band === 'easy') {
      if (requiredCounts[1] !== 15 || requiredCounts[2] !== 0 || requiredCounts[3] !== 15) return false;
    } else if (requiredCounts[1] !== 10 || requiredCounts[2] !== 10 || requiredCounts[3] !== 10) return false;
  }
  return true;
}

export const WORLD_SCIENCE_SOURCE_PATHS = Object.freeze(Object.values(ARTIFACTS));
