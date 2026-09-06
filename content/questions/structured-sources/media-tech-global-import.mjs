#!/usr/bin/env node

/**
 * Refresh the isolated source snapshots used by media-tech-global.mjs.
 *
 * The checked-in snapshots are the normal, offline build inputs. This importer
 * is the only networked part of the pipeline. It intentionally revalidates
 * singleton claims and type constraints instead of copying the older shared
 * question-source artifacts.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const WIKIDATA_OUTPUT = path.join(HERE, 'media-tech-global.wikidata.json');
const SPORTS_OUTPUT = path.join(HERE, 'media-tech-global.sports.json');
const WRITE = process.argv.includes('--write');
const WIKIDATA_ENDPOINT = 'https://query.wikidata.org/sparql';
const WIKIDATA_ENTITY_API = 'https://www.wikidata.org/w/api.php';
const FIFA_API = 'https://api.fifa.com/api/v3';
const USER_AGENT = 'FatinahQuestionBank/3.0 (https://ata20.com; media-tech-global refresh)';
const VALID_AS_OF = process.env.FATINAH_MEDIA_TECH_VALID_AS_OF || '2026-09-05';
const BANNED = /(?:\u0625\u0633\u0631\u0627\u0626\u064a\u0644|\u0627\u0633\u0631\u0627\u0626\u064a\u0644|Israel|Israeli|Tel Aviv|\u062a\u0644 \u0623\u0628\u064a\u0628|\u062a\u0644 \u0627\u0628\u064a\u0628|\u0625\u0628\u0627\u062d|\u0627\u0628\u0627\u062d|porn|hentai|ecchi|\u0647\u0646\u062a\u0627\u064a|\u0625\u064a\u062a\u0634\u064a)/iu;
const UNSAFE_CREATIVE_WORK = /(?:\u0631\u062c\u0627\u0621 \u064a\u0627 \u0645\u0639\u0644\u0645\u062a\u064a|\u0623\u0639\u0638\u0645 \u062d\u0628 \u0623\u0648\u0644|\u0633\u0628\u064a\u062f \u063a\u0631\u0627\u0641\u0631|678|\u0639\u0644\u0649 \u0643\u0641 \u0639\u0641\u0631\u064a\u062a|\u062d\u0627\u062f\u062b \u0627\u0644\u0646\u064a\u0644 \u0647\u064a\u0644\u062a\u0648\u0646)/iu;
const PROHIBITED_INVENTION = /(?:\u0646\u0638\u0631\u064a\u0629|\u0645\u0628\u0631\u0647\u0646\u0629|\u0641\u0631\u0636\u064a\u0629|\u0645\u0628\u062f\u0623|\u062c\u0632\u064a\u0631\u0629|\u062c\u0632\u0631|\u062d\u062f\u0633\u064a\u0629|\u0641\u0644\u0633\u0641\u0629|\u0623\u064a\u062f\u064a\u0648\u0644\u0648\u062c\u064a\u0627|\u0627\u0634\u062a\u0631\u0627\u0643\u064a\u0629|\u0634\u064a\u0648\u0639\u064a\u0629|\u062d\u0631\u0628|\u0627\u0643\u062a\u0634\u0627\u0641 \u062c\u063a\u0631\u0627\u0641\u064a)/iu;

const ANIME_CLASS = 'Q63952888';
const ANIMATED_FILM_CLASS = 'Q202866';
const FILM_CLASS = 'Q11424';
const HUMAN_CLASS = 'Q5';
const ORGANIZATION_CLASS = 'Q43229';
const HISTORICAL_EVENT_CLASS = 'Q13418847';
const CITY_CLASS = 'Q515';
const PROGRAMMING_LANGUAGE_CLASS = 'Q9143';
const CONSTRUCTED_LANGUAGE_CLASS = 'Q33215';
const ARABIC_LANGUAGE = 'Q13955';
const UNSAFE_GENRES = new Set(['Q219559', 'Q172067', 'Q291', 'Q185529', 'Q599558']);
// Editorial exclusions cover broad labels with contested attribution, duplicate
// concepts, or Arabic labels that do not produce a natural standalone question.
const INVENTION_EXCLUDED_IDS = new Set([
  'Q68', 'Q9158', 'Q101674', 'Q234657', 'Q391744', 'Q23645',
  'Q305876', 'Q300867', 'Q6686945', 'Q6714735', 'Q14169302',
]);
const AMBIGUOUS_EVENT_IDS = new Set([
  'Q369560', 'Q456993', 'Q815161', 'Q162284', 'Q700960',
  'Q162357', 'Q275019', 'Q169436', 'Q156681',
]);
const INACTIVE_OR_UNESTABLISHED_ORGANIZATION_IDS = new Set(['Q1785413', 'Q806667']);
const ARAB_COUNTRIES = [
  'Q262','Q398','Q970','Q977','Q79','Q796','Q810','Q817','Q822','Q1016','Q1025',
  'Q1028','Q842','Q219060','Q846','Q851','Q1045','Q1049','Q858','Q948','Q878','Q805',
];

// A small, explicit display-label layer fixes awkward literal translations in
// the Arabic Wikidata labels without changing the sourced entity or claim.
const ARABIC_SUBJECT_OVERRIDES = new Map([
  ['Q221679', 'عائلة روبنسون'],
  ['Q64744044', 'روح'],
  ['Q182254', 'فيلم عائلة سيمبسون'],
  ['Q1090697', 'فيلم توم وجيري'],
  ['Q183480', 'جوجل أدسنس'],
  ['Q18150347', 'جوجل فت'],
  ['Q1995050', 'مايكروسوفت ماث سولفر'],
  ['Q664672', 'بحث جوجل في الشفرة المصدرية'],
  ['Q17355735', 'بروتون ميل'],
  ['Q1162673', 'جهاز هولتر'],
  ['Q296187', 'إيه بي إل'],
  ['Q810009', 'بي سي بي إل'],
  ['Q188531', 'أوبجكتف-سي'],
  ['Q860654', 'إم إل'],
]);

// The item registry bounds the expensive hierarchy checks and makes refreshes
// independent from the previous shared sources. Each item is still revalidated
// against live P31/P178 claims by the query and entity API.
const TECH_SEED_IDS = [
  'Q40984','Q4885200','Q780442','Q136469','Q213602','Q183480','Q51713','Q218924',
  'Q231136','Q60220726','Q623456','Q219885','Q196305','Q474334','Q7276397','Q7854718',
  'Q369089','Q229851','Q17355735','Q17590603','Q1147445','Q305910','Q2474765','Q580318',
  'Q71694','Q8029','Q60827595','Q606550','Q116038','Q19407678','Q79608','Q116894231',
  'Q402799','Q1433417','Q18150347','Q15940106','Q689579','Q864680','Q1133580','Q23542287',
  'Q28470421','Q483101','Q855381','Q1068438','Q55774523','Q724878','Q51712','Q135964',
  'Q1198691','Q2334242','Q484531','Q1048294','Q1995050','Q79593','Q1417729','Q18844946',
  'Q47134419','Q117428','Q876646','Q892647','Q2595529','Q45319394','Q133141215',
  'Q688988','Q904150','Q306106','Q540202','Q378530','Q343961','Q2755835','Q14628801',
  'Q15918054','Q596031','Q720287','Q1347061','Q30943865','Q39048590','Q108582200',
  'Q29364625','Q594062','Q664672','Q122381','Q1542670','Q2736257','Q28446850',
  'Q94277753','Q7202970','Q1196945','Q2263597','Q2394058','Q1788938','Q4040782',
  'Q2078655','Q11072391','Q736181','Q1289689','Q1358512','Q3656354','Q1853389',
  'Q16971518','Q50414488','Q60748043','Q120759195','Q568991','Q1132555','Q1142403',
  'Q1537691','Q1753743','Q2704444','Q54621410','Q298929','Q384622','Q151524',
  'Q3110764','Q1161680','Q1206328','Q1335388','Q2018814','Q6954417','Q2706736',
  'Q17144173','Q56280421','Q23038417','Q15952517','Q136556923','Q360295','Q1187310',
  'Q1394019','Q2252819','Q2497805','Q19599499','Q24807477','Q16928072','Q98098840',
  'Q109620998','Q795920','Q631011','Q3325183','Q3533171','Q3543859','Q2006475',
  'Q2547997','Q7544153',
];

const ORGANIZATION_SEED_IDS = [
  'Q1065','Q7184','Q7817','Q7825','Q7172','Q7795','Q7779','Q42262','Q41550','Q8475',
  'Q54129','Q6867','Q47543','Q132551','Q170424','Q4173083','Q166546','Q146165','Q205995',
  'Q151991','Q309195','Q337456','Q215613','Q45433','Q816706','Q107569','Q380340',
  'Q157169','Q325523','Q1993710','Q461736','Q218868','Q663492','Q8874','Q253988',
  'Q579663','Q757276','Q27396','Q1142901','Q942284','Q1334284','Q735279','Q28346',
  'Q170','Q1010514','Q659012','Q245076','Q1354497','Q670356','Q689768','Q40358',
  'Q392770','Q189966','Q1548793','Q701642','Q42584','Q1142430','Q1264411','Q695267',
  'Q333727','Q2867530','Q2020649','Q453851','Q688592','Q48192','Q951292','Q496967',
  'Q1667016','Q593768','Q1559556','Q1170531','Q42709','Q72781','Q162027','Q2297150',
  'Q29774','Q2989312','Q369760','Q1251615','Q1354096','Q1376533','Q1388484','Q685547',
  'Q806667','Q6054110','Q15278864','Q2622118','Q1153045','Q677691','Q1785413',
  'Q2420112','Q190650','Q241824','Q1531665','Q1856835','Q7157377','Q1666462',
  'Q356694','Q668205','Q4164494','Q4816582','Q2561760','Q1666544','Q55200','Q146905',
  'Q6054186','Q6402371','Q300085','Q12239049','Q13231715','Q117032291','Q131876495',
  'Q2629175','Q3075682','Q1331783','Q1378028','Q2029901','Q14816384','Q22976638',
  'Q333536','Q1665759','Q3523113','Q386559','Q3512342','Q4783148','Q3152339',
  'Q5963265','Q65227050','Q3075387','Q5060362','Q5970551','Q48748710','Q2974848',
  'Q1340188','Q30596094','Q56064561','Q4783192','Q5513635','Q6053726','Q8035994',
  'Q102354124','Q6052211','Q6538965','Q63122539',
];

// Only concrete, engineered artifacts/processes are present here. The broader
// Wikidata P61 population is deliberately not queried because it mixes in
// theories, ideologies, equations, islands and disputed geographic claims.
const PHYSICAL_INVENTION_IDS = [
  'Q68','Q17517','Q9158','Q171','Q466','Q6368','Q7987','Q267298','Q646','Q80728',
  'Q8777','Q79757','Q127956','Q58148','Q162339','Q174174','Q186263','Q179744',
  'Q253','Q471846','Q208138','Q199769','Q54837','Q214893','Q622424','Q873501',
  'Q1753339','Q485257','Q1136790','Q13692','Q852555','Q6686945','Q1037810',
  'Q143899','Q1022471','Q691783','Q902739','Q1638417','Q2296346','Q610863',
  'Q3400387','Q2042740','Q7540752','Q1124226','Q871725','Q148270','Q1055065',
  'Q2197698','Q5372','Q11442','Q5994','Q1734','Q47043','Q9798','Q101674',
  'Q79984','Q188631','Q391744','Q146578','Q334055','Q15411420','Q1369967',
  'Q6714735','Q902796','Q14169302','Q379754','Q2224989','Q1162673','Q522906',
  'Q905964','Q1255515','Q1340688','Q1541241','Q230825','Q1413723','Q884259',
  'Q1753035','Q384549','Q4210298','Q139032','Q1425307','Q749635','Q840916',
  'Q23645','Q192970','Q21161871','Q2042740','Q2224989',
];

const CURATED_FAMILIAR = new Set([
  // Animation titles with broad Arabic or global recognition. This manual tier
  // keeps recent hits and household titles from being underrated merely because
  // they have accumulated fewer language editions than older, less familiar work.
  'Q662','Q689114','Q697616','Q715718','Q437808','Q5362638','Q700424','Q705344',
  'Q784812','Q51803319','Q5474120','Q309459','Q544992','Q20422190','Q1660381','Q282490',
  'Q171048','Q104905','Q187278','Q213326','Q182254','Q28891','Q39571','Q322328',
  'Q27044293','Q24832112','Q249967','Q632668','Q18619153','Q275432','Q113373276',
  'Q324262','Q10298666','Q113877606','Q22970530','Q81205','Q97925311','Q15270775',
  'Q23013169','Q112801489','Q15985075','Q18740903','Q28840385','Q56850065','Q136625',
  'Q114707487','Q7845294','Q28065409','Q107473453','Q114242678','Q124378349','Q16386722',
  // Canonical and widely circulated Arab films, calibrated for Arabic audiences
  // rather than ordered solely by the number of Wikipedia language editions.
  'Q251692','Q4120222','Q5087239','Q5374095','Q5979565','Q6461037','Q11098941',
  'Q12182286','Q3227217','Q3275390','Q3275897','Q4118714','Q4703985','Q4749885',
  'Q5017745','Q6967610','Q12180743','Q12191935','Q1532162','Q20386762','Q20419264',
  'Q2511054','Q3205314','Q3224635','Q3576812','Q4984665','Q54863886','Q6488924',
  'Q6494505','Q6821824','Q6946635','Q7398365','Q7429382','Q7919811','Q909465',
  // Familiar technology products whose Arabic/global recognition is stronger
  // than raw sitelink counts suggest.
  'Q40984','Q4885200','Q136469','Q213602','Q218924','Q231136','Q7854718','Q60827595',
  'Q17590603','Q17355735','Q19407678','Q116894231','Q15940106','Q23542287',
  'Q55774523','Q2334242','Q108582200','Q30943865','Q94277753','Q120759195',
  'Q29364625','Q51712','Q14628801',
  'Q68','Q17517','Q9158','Q171','Q466','Q6368','Q267298','Q80728','Q59','Q15777',
  'Q2005','Q28865','Q2407','Q6534','Q38789','Q160077','Q16470','Q130847','Q233568',
  'Q143','Q42478','Q161053','Q81571','Q207316','Q42979','Q83303','Q131140',
  'Q132874','Q169478','Q575650','Q1037810',
  'Q1065','Q7184','Q7817','Q42262','Q41550','Q8475','Q54129','Q47543',
]);

const UEFA_FINALS = [
  { season: '2009/10', champion: 'إنتر ميلان', runnerUp: 'بايرن ميونخ', score: '2–0' },
  { season: '2010/11', champion: 'برشلونة', runnerUp: 'مانشستر يونايتد', score: '3–1' },
  { season: '2011/12', champion: 'تشيلسي', runnerUp: 'بايرن ميونخ', score: '1–1' },
  { season: '2012/13', champion: 'بايرن ميونخ', runnerUp: 'بوروسيا دورتموند', score: '2–1' },
  { season: '2013/14', champion: 'ريال مدريد', runnerUp: 'أتلتيكو مدريد', score: '4–1' },
  { season: '2014/15', champion: 'برشلونة', runnerUp: 'يوفنتوس', score: '3–1' },
  { season: '2015/16', champion: 'ريال مدريد', runnerUp: 'أتلتيكو مدريد', score: '1–1' },
  { season: '2016/17', champion: 'ريال مدريد', runnerUp: 'يوفنتوس', score: '4–1' },
  { season: '2017/18', champion: 'ريال مدريد', runnerUp: 'ليفربول', score: '3–1' },
  { season: '2018/19', champion: 'ليفربول', runnerUp: 'توتنهام هوتسبير', score: '2–0' },
  { season: '2019/20', champion: 'بايرن ميونخ', runnerUp: 'باريس سان جيرمان', score: '1–0' },
  { season: '2020/21', champion: 'تشيلسي', runnerUp: 'مانشستر سيتي', score: '1–0' },
  { season: '2021/22', champion: 'ريال مدريد', runnerUp: 'ليفربول', score: '1–0' },
  { season: '2022/23', champion: 'مانشستر سيتي', runnerUp: 'إنتر ميلان', score: '1–0' },
  { season: '2023/24', champion: 'ريال مدريد', runnerUp: 'بوروسيا دورتموند', score: '2–0' },
  { season: '2008/09', champion: 'برشلونة', runnerUp: 'مانشستر يونايتد', score: '2–0' },
  { season: '2007/08', champion: 'مانشستر يونايتد', runnerUp: 'تشيلسي', score: '1–1' },
  { season: '2006/07', champion: 'إيه سي ميلان', runnerUp: 'ليفربول', score: '2–1' },
  { season: '2005/06', champion: 'برشلونة', runnerUp: 'أرسنال', score: '2–1' },
  { season: '2004/05', champion: 'ليفربول', runnerUp: 'إيه سي ميلان', score: '3–3' },
  { season: '2003/04', champion: 'بورتو', runnerUp: 'موناكو', score: '3–0' },
  { season: '2002/03', champion: 'إيه سي ميلان', runnerUp: 'يوفنتوس', score: '0–0' },
  { season: '2001/02', champion: 'ريال مدريد', runnerUp: 'باير ليفركوزن', score: '2–1' },
  { season: '2000/01', champion: 'بايرن ميونخ', runnerUp: 'فالنسيا', score: '1–1' },
  { season: '1999/00', champion: 'ريال مدريد', runnerUp: 'فالنسيا', score: '3–0' },
  { season: '1998/99', champion: 'مانشستر يونايتد', runnerUp: 'بايرن ميونخ', score: '2–1' },
  { season: '1997/98', champion: 'ريال مدريد', runnerUp: 'يوفنتوس', score: '1–0' },
  { season: '1996/97', champion: 'بوروسيا دورتموند', runnerUp: 'يوفنتوس', score: '3–1' },
  { season: '1995/96', champion: 'يوفنتوس', runnerUp: 'أياكس أمستردام', score: '1–1' },
  { season: '1994/95', champion: 'أياكس أمستردام', runnerUp: 'إيه سي ميلان', score: '1–0' },
  { season: '1993/94', champion: 'إيه سي ميلان', runnerUp: 'برشلونة', score: '4–0' },
  { season: '1992/93', champion: 'أولمبيك مرسيليا', runnerUp: 'إيه سي ميلان', score: '1–0' },
  { season: '1991/92', champion: 'برشلونة', runnerUp: 'سامبدوريا', score: '1–0' },
  { season: '1990/91', champion: 'ريد ستار بلغراد', runnerUp: 'أولمبيك مرسيليا', score: '0–0' },
  { season: '1989/90', champion: 'إيه سي ميلان', runnerUp: 'بنفيكا', score: '1–0' },
];
const FIFA_YEARS = new Set([1966,1970,1974,1978,1982,1986,1990,1994,1998,2002,2006,2010,2014,2018,2022]);

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const entityId = value => String(value || '').split('/').pop();
const entityUrl = id => `https://www.wikidata.org/wiki/${id}`;
const normalize = value => String(value || '').normalize('NFKC').trim();

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function contentHash(document) {
  const { contentSha256: ignored, ...payload } = document;
  return sha256(canonical(payload));
}

async function fetchJson(url, label) {
  let lastError;
  for (let attempt = 1; attempt <= 7; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 7) await sleep(attempt * 1_250);
    }
  }
  throw lastError;
}

async function fetchSparql(name, query) {
  const url = `${WIKIDATA_ENDPOINT}?${new URLSearchParams({ format: 'json', query })}`;
  const payload = await fetchJson(url, name);
  return payload?.results?.bindings || [];
}

async function fetchEntities(ids) {
  const unique = [...new Set(ids)].filter(id => /^Q\d+$/u.test(id));
  const cache = new Map();
  for (let offset = 0; offset < unique.length; offset += 50) {
    const batch = unique.slice(offset, offset + 50);
    const url = `${WIKIDATA_ENTITY_API}?${new URLSearchParams({
      action: 'wbgetentities', format: 'json', ids: batch.join('|'),
      props: 'labels|claims|sitelinks', languages: 'ar|en', languagefallback: '0', origin: '*',
    })}`;
    const payload = await fetchJson(url, `Wikidata entity batch ${offset / 50 + 1}`);
    for (const id of batch) cache.set(id, payload.entities?.[id] || null);
    if (offset + 50 < unique.length) await sleep(900);
  }
  return cache;
}

function bindingRows(bindings, answerVariable) {
  const seen = new Set();
  const rows = [];
  for (const binding of bindings) {
    const subjectId = entityId(binding.item?.value);
    const answerId = entityId(binding[answerVariable]?.value);
    const subjectLabel = normalize(binding.itemLabel?.value);
    const answerLabel = normalize(binding[`${answerVariable}Label`]?.value);
    if (!/^Q\d+$/u.test(subjectId) || !/^Q\d+$/u.test(answerId)
      || !subjectLabel || !answerLabel || /^Q\d+$/u.test(subjectLabel)
      || /^Q\d+$/u.test(answerLabel) || BANNED.test(`${subjectLabel} ${answerLabel}`)
      || UNSAFE_CREATIVE_WORK.test(subjectLabel) || seen.has(subjectId)) continue;
    seen.add(subjectId);
    rows.push({ subjectId, subjectLabel, answerId, answerLabel,
      sitelinks: Number(binding.sitelinks?.value || 0) });
  }
  return rows;
}

function eventBindingRows(bindings) {
  const seen = new Set();
  const rows = [];
  for (const binding of bindings) {
    const subjectId = entityId(binding.item?.value);
    const subjectLabel = normalize(binding.itemLabel?.value);
    if (!/^Q\d+$/u.test(subjectId) || !subjectLabel || /^Q\d+$/u.test(subjectLabel)
      || BANNED.test(subjectLabel) || seen.has(subjectId)) continue;
    seen.add(subjectId);
    rows.push({ subjectId, subjectLabel, answerId: '', answerLabel: '',
      start: binding.start?.value, end: binding.end?.value,
      sitelinks: Number(binding.sitelinks?.value || 0) });
  }
  return rows;
}

function statementValue(statement) {
  if (statement?.rank === 'deprecated' || statement?.mainsnak?.snaktype !== 'value') return null;
  return statement.mainsnak.datavalue?.value ?? null;
}

function entityClaim(entity, property) {
  const statements = [];
  for (const statement of entity?.claims?.[property] || []) {
    const value = statementValue(statement);
    const valueId = value?.id;
    if (!valueId) continue;
    statements.push({ statementId: statement.id, rank: statement.rank || 'normal', valueId });
  }
  const valueIds = [...new Set(statements.map(statement => statement.valueId))];
  return { property, statementCount: statements.length, distinctValueCount: valueIds.length,
    valueIds, statements };
}

function timeClaim(entity, property) {
  const statements = [];
  for (const statement of entity?.claims?.[property] || []) {
    const value = statementValue(statement);
    if (!value?.time) continue;
    statements.push({ statementId: statement.id, rank: statement.rank || 'normal',
      value: { time: value.time, precision: Number(value.precision),
        calendarModel: value.calendarmodel || null } });
  }
  const values = [...new Map(statements.map(statement => [canonical(statement.value), statement.value])).values()];
  return { property, statementCount: statements.length, distinctValueCount: values.length,
    values, statements };
}

function arabicLabel(entity) {
  return normalize(entity?.labels?.ar?.value);
}

function hasHumanType(entity) {
  return entityClaim(entity, 'P31').valueIds.includes(HUMAN_CLASS);
}

function familiarity(subjectId, sitelinks, propertyComplexity) {
  const curatedTier = CURATED_FAMILIAR.has(subjectId) ? 'widely-known-arabic-or-global' : 'not-curated';
  const score = (CURATED_FAMILIAR.has(subjectId) ? 1_000_000 : 0)
    + Math.min(999_999, Number(sitelinks) * 1_000)
    - Number(propertyComplexity || 0) * 100_000;
  return { metric: 'curated-arabic-familiarity+global-sitelinks+property-complexity',
    curatedTier, hasArabicWikipediaArticle: true, globalSitelinks: Number(sitelinks),
    propertyComplexity: Number(propertyComplexity || 0), score };
}

function baseRecord(row, dataset, claim, propertyComplexity = 1) {
  const recordKey = `media-tech-global-${dataset}-${row.subjectId}`;
  const subjectLabel = ARABIC_SUBJECT_OVERRIDES.get(row.subjectId) || row.subjectLabel;
  const record = {
    recordKey, subjectId: row.subjectId, subjectLabel,
    answerId: row.answerId, answerLabel: row.answerLabel, sitelinks: row.sitelinks,
    popularity: familiarity(row.subjectId, row.sitelinks, propertyComplexity), claim,
    sourceUrl: entityUrl(row.subjectId), sourcePublisher: 'Wikidata', sourceLicense: 'CC0 1.0',
    retrievedAt: `${VALID_AS_OF}T00:00:00.000Z`,
  };
  if (subjectLabel !== row.subjectLabel) {
    record.sourceSubjectLabel = row.subjectLabel;
    record.labelNormalization = 'editorial-arabic-display-v1';
  }
  record.sourcePayloadHash = sha256(canonical(record));
  return record;
}

function singletonEntity(claim, expectedId) {
  return claim.distinctValueCount === 1 && claim.valueIds[0] === expectedId;
}

function inventionComplexity(row) {
  if (row.inventionKind === 'engineered-invention') return 1;
  if (row.inventionKind === 'constructed-language') return 4;
  return 2;
}

async function buildWikidataSnapshot() {
  const techRoots = ['Q7397','Q166142','Q35127','Q9143'];
  const queries = {
    animation: `SELECT DISTINCT ?item ?itemLabel ?director ?directorLabel ?sitelinks WHERE {
      ?item wdt:P31 wd:${ANIME_CLASS}; wdt:P57 ?director; wikibase:sitelinks ?sitelinks.
      FILTER NOT EXISTS { ?item wdt:P57 ?other. FILTER(?other != ?director) }
      ?article schema:about ?item; schema:isPartOf <https://ar.wikipedia.org/>.
      SERVICE wikibase:label { bd:serviceParam wikibase:language "ar". }
    } ORDER BY DESC(?sitelinks) LIMIT 240`,
    animatedFilms: `SELECT DISTINCT ?item ?itemLabel ?director ?directorLabel ?sitelinks WHERE {
      ?item wdt:P31 wd:${ANIMATED_FILM_CLASS}; wdt:P57 ?director; wikibase:sitelinks ?sitelinks.
      FILTER NOT EXISTS { ?item wdt:P57 ?other. FILTER(?other != ?director) }
      ?article schema:about ?item; schema:isPartOf <https://ar.wikipedia.org/>.
      SERVICE wikibase:label { bd:serviceParam wikibase:language "ar". }
    } ORDER BY DESC(?sitelinks) LIMIT 420`,
    arabicFilms: `SELECT DISTINCT ?item ?itemLabel ?director ?directorLabel ?sitelinks WHERE {
      VALUES ?country { ${ARAB_COUNTRIES.map(id => `wd:${id}`).join(' ')} }
      ?item wdt:P31 wd:${FILM_CLASS}; wdt:P495 ?country; wdt:P364 wd:${ARABIC_LANGUAGE};
        wdt:P57 ?director; wikibase:sitelinks ?sitelinks.
      FILTER NOT EXISTS { ?item wdt:P57 ?other. FILTER(?other != ?director) }
      FILTER NOT EXISTS { ?item wdt:P364 ?otherLanguage. FILTER(?otherLanguage != wd:${ARABIC_LANGUAGE}) }
      ?article schema:about ?item; schema:isPartOf <https://ar.wikipedia.org/>.
      SERVICE wikibase:label { bd:serviceParam wikibase:language "ar". }
    } ORDER BY DESC(?sitelinks) LIMIT 320`,
    technology: `SELECT DISTINCT ?item ?itemLabel ?developer ?developerLabel ?sitelinks WHERE {
      VALUES ?item { ${TECH_SEED_IDS.map(id => `wd:${id}`).join(' ')} }
      VALUES ?techRoot { ${techRoots.map(id => `wd:${id}`).join(' ')} }
      ?item wdt:P31/wdt:P279* ?techRoot; wdt:P178 ?developer; wikibase:sitelinks ?sitelinks.
      ?developer wdt:P31/wdt:P279* wd:${ORGANIZATION_CLASS}.
      FILTER(?item != ?developer)
      FILTER NOT EXISTS { ?developer wdt:P31 wd:${HUMAN_CLASS} }
      FILTER NOT EXISTS { ?item wdt:P178 ?other. FILTER(?other != ?developer) }
      ?article schema:about ?item; schema:isPartOf <https://ar.wikipedia.org/>.
      SERVICE wikibase:label { bd:serviceParam wikibase:language "ar". }
    } ORDER BY DESC(?sitelinks)`,
    events: `SELECT DISTINCT ?item ?itemLabel ?start ?end ?sitelinks WHERE {
      ?item wdt:P31/wdt:P279* wd:${HISTORICAL_EVENT_CLASS}; wdt:P580 ?start;
        wdt:P582 ?end; wikibase:sitelinks ?sitelinks.
      ?article schema:about ?item; schema:isPartOf <https://ar.wikipedia.org/>.
      SERVICE wikibase:label { bd:serviceParam wikibase:language "ar". }
      FILTER(YEAR(?start) >= 1000 && YEAR(?start) <= 2020 && YEAR(?end) <= 2020)
    } ORDER BY DESC(?sitelinks) LIMIT 420`,
    organizations: `SELECT DISTINCT ?item ?itemLabel ?hq ?hqLabel ?sitelinks WHERE {
      VALUES ?item { ${ORGANIZATION_SEED_IDS.map(id => `wd:${id}`).join(' ')} }
      VALUES ?organizationRoot { wd:Q484652 wd:Q245065 }
      ?item wdt:P31/wdt:P279* ?organizationRoot; wdt:P159 ?hq; wikibase:sitelinks ?sitelinks.
      ?hq wdt:P31/wdt:P279* wd:${CITY_CLASS}.
      FILTER NOT EXISTS { ?item wdt:P576 ?dissolved }
      FILTER NOT EXISTS { ?item wdt:P159 ?other. FILTER(?other != ?hq) }
      ?article schema:about ?item; schema:isPartOf <https://ar.wikipedia.org/>.
      SERVICE wikibase:label { bd:serviceParam wikibase:language "ar". }
    } ORDER BY DESC(?sitelinks)`,
    programmingLanguages: `SELECT DISTINCT ?item ?itemLabel ?designer ?designerLabel ?sitelinks WHERE {
      ?item wdt:P31/wdt:P279* wd:${PROGRAMMING_LANGUAGE_CLASS}; wdt:P287 ?designer;
        wikibase:sitelinks ?sitelinks. ?designer wdt:P31 wd:${HUMAN_CLASS}.
      FILTER NOT EXISTS { ?item wdt:P287 ?other. FILTER(?other != ?designer) }
      ?article schema:about ?item; schema:isPartOf <https://ar.wikipedia.org/>.
      SERVICE wikibase:label { bd:serviceParam wikibase:language "ar". }
    } ORDER BY DESC(?sitelinks) LIMIT 220`,
    constructedLanguages: `SELECT DISTINCT ?item ?itemLabel ?creator ?creatorLabel ?sitelinks WHERE {
      ?item wdt:P31/wdt:P279* wd:${CONSTRUCTED_LANGUAGE_CLASS}; wdt:P170 ?creator;
        wikibase:sitelinks ?sitelinks. ?creator wdt:P31 wd:${HUMAN_CLASS}.
      FILTER NOT EXISTS { ?item wdt:P170 ?other. FILTER(?other != ?creator) }
      ?article schema:about ?item; schema:isPartOf <https://ar.wikipedia.org/>.
      SERVICE wikibase:label { bd:serviceParam wikibase:language "ar". }
    } ORDER BY DESC(?sitelinks) LIMIT 120`,
  };

  const bindings = {};
  for (const [name, query] of Object.entries(queries)) {
    bindings[name] = await fetchSparql(name, query);
    await sleep(350);
  }

  const animationRows = [
    ...bindingRows(bindings.animation, 'director').map(row => ({ ...row,
      creativeKind: 'anime-television-series', requiredClass: ANIME_CLASS })),
    ...bindingRows(bindings.animatedFilms, 'director').map(row => ({ ...row,
      creativeKind: 'animated-film', requiredClass: ANIMATED_FILM_CLASS })),
  ];
  const filmRows = bindingRows(bindings.arabicFilms, 'director');
  const technologyRows = bindingRows(bindings.technology, 'developer');
  const eventRows = eventBindingRows(bindings.events);
  const organizationRows = bindingRows(bindings.organizations, 'hq');
  const programmingRows = bindingRows(bindings.programmingLanguages, 'designer')
    .map(row => ({ ...row, inventionKind: 'programming-language', relationProperty: 'P287' }));
  const constructedRows = bindingRows(bindings.constructedLanguages, 'creator')
    .map(row => ({ ...row, inventionKind: 'constructed-language', relationProperty: 'P170' }));

  const physicalBindings = await fetchSparql('curated physical inventions', `
    SELECT DISTINCT ?item ?itemLabel ?inventor ?inventorLabel ?sitelinks WHERE {
      VALUES ?item { ${PHYSICAL_INVENTION_IDS.map(id => `wd:${id}`).join(' ')} }
      ?item wdt:P61 ?inventor; wikibase:sitelinks ?sitelinks. ?inventor wdt:P31 wd:${HUMAN_CLASS}.
      FILTER NOT EXISTS { ?item wdt:P61 ?other. FILTER(?other != ?inventor) }
      ?article schema:about ?item; schema:isPartOf <https://ar.wikipedia.org/>.
      SERVICE wikibase:label { bd:serviceParam wikibase:language "ar". }
    } ORDER BY DESC(?sitelinks)`);
  const physicalRows = bindingRows(physicalBindings, 'inventor')
    .filter(row => !INVENTION_EXCLUDED_IDS.has(row.subjectId)
      && !PROHIBITED_INVENTION.test(row.subjectLabel))
    .map(row => ({ ...row, inventionKind: 'engineered-invention', relationProperty: 'P61' }));
  const inventionRows = [...physicalRows, ...programmingRows, ...constructedRows]
    .sort((left, right) => familiarity(right.subjectId, right.sitelinks, inventionComplexity(right)).score
      - familiarity(left.subjectId, left.sitelinks, inventionComplexity(left)).score
      || left.subjectId.localeCompare(right.subjectId, 'en'));

  const allRows = [animationRows, filmRows, technologyRows, eventRows, organizationRows, inventionRows].flat();
  const entities = await fetchEntities(allRows.flatMap(row => [row.subjectId, row.answerId]).filter(Boolean));
  const records = { animation: [], arabicFilms: [], technology: [], inventions: [], events: [], organizations: [] };

  for (const row of animationRows) {
    const item = entities.get(row.subjectId); const answer = entities.get(row.answerId);
    const classification = entityClaim(item, 'P31'); const director = entityClaim(item, 'P57');
    const genres = entityClaim(item, 'P136');
    if (!classification.valueIds.includes(row.requiredClass) || !singletonEntity(director, row.answerId)
      || !hasHumanType(answer) || genres.valueIds.some(id => UNSAFE_GENRES.has(id))) continue;
    records.animation.push(baseRecord(row, 'animation', {
      classification: { ...classification, requiredValueId: row.requiredClass,
        creativeKind: row.creativeKind },
      director: { ...director, valueId: row.answerId, valueLabel: row.answerLabel },
      directorInstanceOf: { subjectId: row.answerId, ...entityClaim(answer, 'P31'), requiredValueId: HUMAN_CLASS },
      familySafety: { checkedProperties: ['P136'], prohibitedGenreIds: [...UNSAFE_GENRES], intersection: [] },
    }, 1));
  }

  for (const row of filmRows) {
    const item = entities.get(row.subjectId); const answer = entities.get(row.answerId);
    const classification = entityClaim(item, 'P31'); const director = entityClaim(item, 'P57');
    const language = entityClaim(item, 'P364'); const origin = entityClaim(item, 'P495');
    const genres = entityClaim(item, 'P136');
    const matchedArabCountries = origin.valueIds.filter(id => ARAB_COUNTRIES.includes(id));
    if (!classification.valueIds.includes(FILM_CLASS) || !singletonEntity(director, row.answerId)
      || !singletonEntity(language, ARABIC_LANGUAGE) || !matchedArabCountries.length
      || !hasHumanType(answer) || genres.valueIds.some(id => UNSAFE_GENRES.has(id))) continue;
    records.arabicFilms.push(baseRecord(row, 'arabic-film', {
      classification: { ...classification, requiredValueId: FILM_CLASS },
      originalLanguage: { ...language, requiredValueId: ARABIC_LANGUAGE },
      countryOfOrigin: { ...origin, allowedValueIds: ARAB_COUNTRIES, matchedValueIds: matchedArabCountries },
      director: { ...director, valueId: row.answerId, valueLabel: row.answerLabel },
      directorInstanceOf: { subjectId: row.answerId, ...entityClaim(answer, 'P31'), requiredValueId: HUMAN_CLASS },
      familySafety: { checkedProperties: ['P136'], prohibitedGenreIds: [...UNSAFE_GENRES], intersection: [] },
    }, 1));
  }

  for (const row of technologyRows) {
    const item = entities.get(row.subjectId); const answer = entities.get(row.answerId);
    const developer = entityClaim(item, 'P178'); const answerTypes = entityClaim(answer, 'P31');
    if (!singletonEntity(developer, row.answerId) || answerTypes.valueIds.includes(HUMAN_CLASS)) continue;
    records.technology.push(baseRecord(row, 'technology', {
      classification: { ...entityClaim(item, 'P31'), requiredRootIds: techRoots,
        hierarchyPathValidatedByQuery: true },
      developer: { ...developer, valueId: row.answerId, valueLabel: row.answerLabel },
      developerOrganization: { subjectId: row.answerId, ...answerTypes,
        requiredRootClassId: ORGANIZATION_CLASS, hierarchyPathValidatedByQuery: true,
        humanClassRejected: HUMAN_CLASS },
    }, 1));
  }

  for (const row of inventionRows) {
    const item = entities.get(row.subjectId); const answer = entities.get(row.answerId);
    const relation = entityClaim(item, row.relationProperty);
    if (INVENTION_EXCLUDED_IDS.has(row.subjectId)
      || !singletonEntity(relation, row.answerId) || !hasHumanType(answer)
      || PROHIBITED_INVENTION.test(row.subjectLabel)) continue;
    records.inventions.push(baseRecord(row, 'invention', {
      classification: { ...entityClaim(item, 'P31'), curatedKind: row.inventionKind,
        requiredRootClassId: row.inventionKind === 'programming-language' ? PROGRAMMING_LANGUAGE_CLASS
          : row.inventionKind === 'constructed-language' ? CONSTRUCTED_LANGUAGE_CLASS : null,
        hierarchyPathValidatedByQuery: row.inventionKind !== 'engineered-invention' },
      inventorOrDesigner: { ...relation, valueId: row.answerId, valueLabel: row.answerLabel },
      answerInstanceOf: { subjectId: row.answerId, ...entityClaim(answer, 'P31'), requiredValueId: HUMAN_CLASS },
      editorialCuration: { registry: 'clear-engineered-inventions-v1', clearInvention: true,
        disputedAttributionExcluded: true, theoriesIdeasAndGeographyExcluded: true },
    }, inventionComplexity(row)));
  }

  for (const row of eventRows) {
    const item = entities.get(row.subjectId); const start = timeClaim(item, 'P580'); const end = timeClaim(item, 'P582');
    if (start.distinctValueCount !== 1 || end.distinctValueCount !== 1
      || start.values[0].precision < 9 || end.values[0].precision < 9) continue;
    const startTime = start.values[0].time.replace(/^\+/u, '');
    const endTime = end.values[0].time.replace(/^\+/u, '');
    const startDate = new Date(startTime); const endDate = new Date(endTime);
    const durationDays = (endDate - startDate) / 86_400_000;
    const year = Number(/^\+?(\d{4,})-/u.exec(start.values[0].time)?.[1]);
    if (!Number.isInteger(year) || year < 1000 || year > 2020 || !Number.isFinite(durationDays)
      || durationDays < 0 || durationDays > 62 || BANNED.test(row.subjectLabel)
      || AMBIGUOUS_EVENT_IDS.has(row.subjectId)
      || new RegExp(`(^|\\D)${year}(\\D|$)`, 'u').test(row.subjectLabel)) continue;
    const eventRow = { ...row, answerId: `year-${year}`, answerLabel: String(year) };
    records.events.push(baseRecord(eventRow, 'historical-event', {
      classification: { ...entityClaim(item, 'P31'), requiredRootClassId: HISTORICAL_EVENT_CLASS,
        hierarchyPathValidatedByQuery: true },
      start: { ...start, value: start.values[0], year }, end: { ...end, value: end.values[0] },
      temporalScope: { completedBefore: '2021-01-01', ongoing: false, durationDays,
        singleClearStart: true },
    }, 1));
  }

  for (const row of organizationRows) {
    const item = entities.get(row.subjectId); const hqEntity = entities.get(row.answerId);
    const headquarters = entityClaim(item, 'P159');
    if (INACTIVE_OR_UNESTABLISHED_ORGANIZATION_IDS.has(row.subjectId)
      || !singletonEntity(headquarters, row.answerId)
      || entityClaim(item, 'P576').distinctValueCount !== 0) continue;
    records.organizations.push(baseRecord(row, 'organization', {
      classification: { ...entityClaim(item, 'P31'), requiredRootIds: ['Q484652','Q245065'],
        hierarchyPathValidatedByQuery: true },
      headquarters: { ...headquarters, valueId: row.answerId, valueLabel: row.answerLabel },
      headquartersCity: { subjectId: row.answerId, ...entityClaim(hqEntity, 'P31'),
        requiredRootClassId: CITY_CLASS, hierarchyPathValidatedByQuery: true },
      temporalValidity: { validAsOf: VALID_AS_OF, dissolvedClaimCount: 0,
        activeRegistry: 'reviewed-active-international-organizations-v1',
        currentlyExistingAtValidAsOf: true },
    }, 1));
  }

  for (const rows of Object.values(records)) rows.sort((left, right) =>
    right.popularity.score - left.popularity.score || right.sitelinks - left.sitelinks
      || left.subjectId.localeCompare(right.subjectId, 'en'));
  const minimums = { animation: 95, arabicFilms: 120, technology: 100,
    inventions: 100, events: 120, organizations: 100 };
  process.stderr.write(`${JSON.stringify(Object.fromEntries(Object.entries(records)
    .map(([name, rows]) => [name, rows.length])))}\n`);
  for (const [dataset, minimum] of Object.entries(minimums)) {
    if (records[dataset].length < minimum) throw new Error(`${dataset}: ${records[dataset].length}/${minimum}`);
  }
  const trimLimits = { animation: 300, arabicFilms: 150, technology: 150,
    inventions: 150, events: 150, organizations: 150 };
  const trimmed = Object.fromEntries(Object.entries(records)
    .map(([name, rows]) => [name, rows.slice(0, trimLimits[name] || 150)]));
  const document = {
    schemaVersion: 1, sourceArtifactId: 'media-tech-global-wikidata-v1',
    sourceProfile: 'wikidata-singleton-typed-claims-v1', endpoint: WIKIDATA_ENDPOINT,
    entityApi: WIKIDATA_ENTITY_API, retrievedAt: `${VALID_AS_OF}T00:00:00.000Z`,
    validAsOf: VALID_AS_OF, license: 'CC0 1.0',
    difficultyPolicy: 'curated-arabic-familiarity+global-sitelinks+property-complexity; never hash',
    querySha256: Object.fromEntries(Object.entries(queries).map(([name, query]) => [name, sha256(query)])),
    datasets: trimmed,
  };
  document.contentSha256 = contentHash(document);
  return document;
}

function localizedDescription(value) {
  if (!Array.isArray(value)) return '';
  const arabic = value.find(item => /^ar(?:-|$)/iu.test(String(item?.Locale || '')));
  return normalize(arabic?.Description || value[0]?.Description);
}

function fifaTeam(team) {
  return localizedDescription(team?.TeamName) || normalize(team?.ShortClubName);
}

async function fifaFinals() {
  const seasonsUrl = `${FIFA_API}/seasons?idCompetition=17&language=ar&count=100`;
  const seasonsPayload = await fetchJson(seasonsUrl, 'FIFA World Cup seasons');
  const seasons = (seasonsPayload?.Results || []).filter(season =>
    FIFA_YEARS.has(Number(String(season.StartDate || '').slice(0, 4))));
  const finals = [];
  for (const season of seasons) {
    const year = Number(String(season.StartDate).slice(0, 4));
    const sourceUrl = `${FIFA_API}/calendar/matches?language=ar&count=500&IdCompetition=17&IdSeason=${season.IdSeason}`;
    const payload = await fetchJson(sourceUrl, `FIFA ${year}`);
    const candidates = (payload?.Results || []).filter(match =>
      localizedDescription(match.StageName) === '\u0627\u0644\u0645\u0628\u0627\u0631\u0627\u0629 \u0627\u0644\u0646\u0647\u0627\u0626\u064a\u0629');
    if (candidates.length !== 1) throw new Error(`FIFA ${year}: expected one final, received ${candidates.length}`);
    const match = candidates[0]; const home = fifaTeam(match.Home); const away = fifaTeam(match.Away);
    const winnerId = String(match.Winner || '');
    const champion = winnerId === String(match.Home?.IdTeam) ? home
      : winnerId === String(match.Away?.IdTeam) ? away : '';
    const runnerUp = champion === home ? away : champion === away ? home : '';
    if (!champion || !runnerUp || !Number.isInteger(match.Home?.Score) || !Number.isInteger(match.Away?.Score)
      || BANNED.test(`${home} ${away}`)) throw new Error(`FIFA ${year}: invalid final record`);
    finals.push({ provider: 'FIFA', competition: '\u0643\u0623\u0633 \u0627\u0644\u0639\u0627\u0644\u0645', season: String(year),
      year, matchId: String(match.IdMatch), champion, runnerUp,
      score: `${match.Home.Score}\u2013${match.Away.Score}`, home, away, sourceUrl,
      sourcePublisher: 'FIFA', sourceLicense: 'FIFA terms of use' });
  }
  if (finals.length !== 15) throw new Error(`FIFA finals: ${finals.length}/15`);
  return finals.sort((left, right) => right.year - left.year);
}

function sportsFact(final, factType, index) {
  const answer = final[factType];
  const providerKey = final.provider.toLowerCase();
  const record = {
    recordKey: `media-tech-global-${providerKey}-${final.season.replace('/', '-')}-${factType}`,
    provider: final.provider, competition: final.competition, season: final.season,
    year: final.year || Number(final.season.slice(-2)) + 2000, matchId: final.matchId || null,
    home: final.home || final.champion, away: final.away || final.runnerUp,
    champion: final.champion, runnerUp: final.runnerUp, score: final.score,
    factType, answer, difficultyPropertyRank: { champion: 1, runnerUp: 2, score: 3 }[factType],
    popularityRank: index + 1, sourceUrl: final.sourceUrl,
    sourcePublisher: final.sourcePublisher, sourceLicense: final.sourceLicense,
    retrievedAt: `${VALID_AS_OF}T00:00:00.000Z`,
    claim: { subject: `${final.provider}:${final.competition}:${final.season}`,
      predicate: factType, object: answer, beforePenaltyShootout: factType === 'score' },
  };
  record.sourcePayloadHash = sha256(canonical(record));
  return record;
}

async function buildSportsSnapshot() {
  const fifa = await fifaFinals();
  const uefa = UEFA_FINALS.map(final => ({ ...final, provider: 'UEFA',
    competition: '\u062fوري أبطال أوروبا',
    sourceUrl: 'https://www.uefa.com/uefachampionsleague/history/winners/finals/',
    sourcePublisher: 'UEFA', sourceLicense: 'UEFA terms of use',
    year: Number(final.season.slice(0, 4)) + 1,
    home: final.champion, away: final.runnerUp })).sort((left, right) => right.year - left.year);
  const finals = [...fifa, ...uefa];
  const records = ['champion','runnerUp','score'].flatMap(factType =>
    finals.map((final, index) => sportsFact(final, factType, index)));
  if (records.length < 120 || new Set(records.map(record => record.recordKey)).size !== records.length) {
    throw new Error(`sports records: ${records.length}; expected at least 120 unique facts`);
  }
  const document = {
    schemaVersion: 1, sourceArtifactId: 'media-tech-global-sports-v1',
    sourceProfile: 'official-fifa-uefa-historical-finals-v1', retrievedAt: `${VALID_AS_OF}T00:00:00.000Z`,
    validAsOf: VALID_AS_OF, difficultyPolicy: 'fact-property then recent global prominence; never hash',
    sources: { fifa: `${FIFA_API}/seasons?idCompetition=17&language=ar&count=100`,
      uefa: 'https://www.uefa.com/uefachampionsleague/history/winners/finals/' }, records,
  };
  document.contentSha256 = contentHash(document);
  return document;
}

const [wikidata, sports] = await Promise.all([buildWikidataSnapshot(), buildSportsSnapshot()]);
if (WRITE) {
  fs.writeFileSync(WIKIDATA_OUTPUT, `${JSON.stringify(wikidata, null, 2)}\n`);
  fs.writeFileSync(SPORTS_OUTPUT, `${JSON.stringify(sports, null, 2)}\n`);
}
console.log(JSON.stringify({ mode: WRITE ? 'write' : 'dry-run',
  outputs: WRITE ? [WIKIDATA_OUTPUT, SPORTS_OUTPUT] : [],
  datasets: Object.fromEntries(Object.entries(wikidata.datasets).map(([name, rows]) => [name, rows.length])),
  sports: sports.records.length }, null, 2));
