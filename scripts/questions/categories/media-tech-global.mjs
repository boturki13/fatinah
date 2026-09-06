#!/usr/bin/env node

/**
 * Offline deterministic builder for seven media, technology and global-facts
 * categories. Network access belongs exclusively to the colocated importer:
 * content/questions/structured-sources/media-tech-global-import.mjs.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const WIKIDATA_ARTIFACT = 'content/questions/structured-sources/media-tech-global.wikidata.json';
const SPORTS_ARTIFACT = 'content/questions/structured-sources/media-tech-global.sports.json';
export const SOURCE_PATHS = Object.freeze([WIKIDATA_ARTIFACT, SPORTS_ARTIFACT]);
export const MEDIA_TECH_GLOBAL_CATEGORIES = Object.freeze([
  'كرتون وأنمي',
  'تقنية وإنترنت',
  'سينما وأفلام عربية',
  'اختراعات واكتشافات',
  'أندية ومنتخبات',
  'أحداث غيرت العالم',
  'منظمات دولية',
]);

// Editorial familiarity calibrated for Arabic/Gulf players. Wikimedia
// sitelinks remain a secondary signal inside each tier, not the sole reason
// an item is placed in the easy band.
const ARABIC_AUDIENCE_FAMILIAR = new Set([
  // Arabic films with broad regional circulation or major international recognition.
  'Q38620429','Q117705910','Q13475554','Q1766235','Q38421581','Q20751326',
  'Q51834948','Q65954726',
  'Q183480','Q51713','Q60220726','Q196305','Q474334','Q229851','Q2474765',
  'Q1433417','Q18150347','Q402799','Q689579','Q484531',
  'Q5994','Q1734','Q2005','Q28865','Q2407','Q7987','Q47043','Q9798','Q80728',
  'Q8777','Q79757','Q127956','Q58148','Q162339','Q174174','Q186263','Q179744','Q199769',
  'Q160077','Q151340','Q130861','Q154182','Q173034','Q1402078','Q151005',
  'Q180182','Q36749','Q233568','Q33132','Q911972','Q235344','Q219230',
  'Q207165','Q696835','Q153376','Q296754','Q459447','Q52226','Q482402',
  'Q714777','Q862054','Q1504861','Q1194052','Q1308854','Q836128','Q325985',
  'Q208529','Q153858','Q160161','Q308999','Q504347','Q696931','Q943277',
  'Q1065','Q7817','Q42262','Q8475','Q54129','Q6867','Q47543','Q132551',
  'Q170424','Q166546','Q4173083','Q146165','Q205995','Q151991','Q309195',
  'Q337456','Q215613','Q45433','Q107569','Q157169','Q325523','Q663492',
  'Q253988','Q757276','Q1010514','Q659012','Q40358','Q1264411','Q688592',
  'Q2867530','Q48192','Q1856835','Q356694','Q4164494','Q12239049',
]);

function arabicAudiencePopularity(record) {
  const familiar = record.popularity?.curatedTier !== 'not-curated'
    || ARABIC_AUDIENCE_FAMILIAR.has(record.subjectId);
  return {
    ...record.popularity,
    curatedTier: familiar ? 'widely-known-arabic-or-global' : 'not-curated',
    score: (familiar ? 2_000_000 : 0) + Number(record.popularity?.score || 0),
    metric: 'curated-arabic-gulf-familiarity+global-sitelinks+property-complexity',
  };
}

function rankedWikidataRecords(records) {
  return [...records].map(record => ({ ...record, popularity: arabicAudiencePopularity(record) }))
    .sort((left, right) => right.popularity.score - left.popularity.score
      || right.sitelinks - left.sitelinks || left.subjectId.localeCompare(right.subjectId, 'en'));
}

const SOURCE_ARTIFACT_IDS = Object.freeze({
  wikidata: 'media-tech-global-wikidata-v1',
  sports: 'media-tech-global-sports-v1',
});
const REVIEW_DATE = process.env.FATINAH_BANK_REVIEW_DATE || '2026-09-05';
const BANDS = ['easy', 'medium', 'hard'];
const BANNED = /(?:\u0625\u0633\u0631\u0627\u0626\u064a\u0644|\u0627\u0633\u0631\u0627\u0626\u064a\u0644|Israel|Israeli|Tel Aviv|\u062a\u0644 \u0623\u0628\u064a\u0628|\u062a\u0644 \u0627\u0628\u064a\u0628|\u0625\u0628\u0627\u062d|\u0627\u0628\u0627\u062d|porn|hentai|ecchi|\u0647\u0646\u062a\u0627ي)/iu;
const VARIABLE_TIME = /(?:\u062d\u0627\u0644يًا|\u062d\u0627ليا|\u0627\u0644آن|\u0647ذا \u0627\u0644عام|\u0627\u0644موسم \u0627\u0644حالي|\u0623حدث|\u0622خر \u0628طل)/u;
const PROHIBITED_INVENTION = /(?:\u0646\u0638ر\u064aة|\u0645\u0628ر\u0647ن\u0629|\u0641\u0631ض\u064aة|\u0645\u0628د\u0623|\u062c\u0632\u064aر\u0629|\u062c\u0632ر|\u062d\u062fس\u064aة|\u0641\u0644سف\u0629|\u0623\u064aديولو\u062cيا)/u;

const INVENTION_EXCLUDED_IDS = new Set([
  'Q68', 'Q9158', 'Q101674', 'Q234657', 'Q391744', 'Q23645',
  'Q305876', 'Q300867', 'Q6686945', 'Q6714735', 'Q14169302',
]);
const AMBIGUOUS_EVENT_IDS = new Set([
  'Q369560', 'Q456993', 'Q815161', 'Q162284', 'Q700960',
  'Q162357', 'Q275019', 'Q169436', 'Q156681',
]);

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const normalize = value => String(value || '')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[\u064b-\u065f\u0670]/gu, '')
  .replace(/[إأآٱ]/gu, 'ا')
  .replace(/ى/gu, 'ي')
  .replace(/ة/gu, 'ه')
  .replace(/[\s\p{P}\p{S}]+/gu, '');
const clean = value => String(value || '').trim().replace(/\?/gu, '؟').replace(/\s{2,}/gu, ' ');

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

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function recordPayloadHash(record) {
  const { sourcePayloadHash: ignored, ...payload } = record;
  return sha256(canonical(payload));
}

function tooSimilar(left, right) {
  const a = normalize(left); const b = normalize(right);
  if (!a || !b) return true;
  if (/^\d+(?:[.,–-]\d+)?$/u.test(a) && /^\d+(?:[.,–-]\d+)?$/u.test(b)) return false;
  return a === b || (Math.min(a.length, b.length) >= 5 && (a.includes(b) || b.includes(a)));
}

function qidNumber(value) {
  return Number(String(value || '').replace(/\D/gu, '').slice(-9)) || 0;
}

function claimTriple(record, predicate, object = record.answerId || record.answer) {
  return { subject: record.subjectId || record.claim?.subject || record.recordKey,
    predicate, object: String(object), sourceRecordKey: record.recordKey };
}

function sourceRecordVerification(artifact, collection, record, fields, claim) {
  return {
    profile: 'source_record_fields_v1', artifact, collection,
    recordIdField: 'recordKey', recordId: record.recordKey, fields, claim,
  };
}

function quotedSubject(question) {
  return /[«]([^»]+)[»]/u.exec(String(question || ''))?.[1] || '';
}

function archiveCategory(value) {
  const key = normalize(value);
  if (key === normalize('أنمي')) return 'كرتون وأنمي';
  if (key === normalize('أفلام عربية')) return 'سينما وأفلام عربية';
  if (key === normalize('علوم وتقنية')) return 'تقنية وإنترنت';
  if (['رياضة', 'كأس العالم', 'دوري أبطال أوروبا'].some(name => key === normalize(name))) {
    return 'أندية ومنتخبات';
  }
  if (key === normalize('تاريخ')) return 'أحداث غيرت العالم';
  return String(value || '');
}

function addArchivedSportsFact(entry, sportsFacts, sportsMatchFacts) {
  const question = String(entry?.q || entry?.question || '');
  const context = `${question} ${entry?.source?.title || ''} ${entry?.source?.publisher || ''} ${entry?.source?.url || ''}`;
  let factType = null;
  if (/(?:وصيف|خسر)/u.test(question)) factType = 'runnerUp';
  else if (/(?:كم انته|ما نتيجة|نتيجة نهائي)/u.test(question)) factType = 'score';
  else if (/(?:فاز|بطل|توّج|تُوّج)/u.test(question)) factType = 'champion';
  if (!factType) return;
  const matchId = /(?:match\s*|المباراة رقم\s*)(\d{1,12})/iu.exec(context)?.[1];
  if (matchId) sportsMatchFacts.add(`${matchId}|${factType}`);
  let provider = null;
  if (/(?:FIFA|كأس العالم)/iu.test(context)) provider = 'FIFA';
  else if (/(?:UEFA|uefachampionsleague|دوري أبطال أوروبا|كأس أوروبا)/iu.test(context)) provider = 'UEFA';
  if (!provider) return;
  const year = Number((/World Cup\s+(\d{4})/iu.exec(context)
    || /seasons\/(\d{4})/iu.exec(context)
    || /(?:سنة|عام|نهائي)[^\d]{0,35}(\d{4})/u.exec(context))?.[1]);
  if (Number.isInteger(year)) sportsFacts.add(`${provider}|${year}|${factType}`);
}

function oldFactIndex(oldQuestions, oldRecords) {
  const questionTexts = new Set([...oldQuestions].map(normalize));
  const factKeys = new Set(); const subjectAnswers = new Set(); const entityAnswers = new Set();
  const categoryAnswerContexts = new Map(); const answerContexts = new Map();
  const sportsFacts = new Set(); const sportsMatchFacts = new Set();
  for (const entry of oldRecords || []) {
    const category = archiveCategory(entry?.category);
    const question = entry?.q || entry?.question || '';
    const answer = entry?.answer || (Number.isInteger(entry?.a) ? entry?.o?.[entry.a] : '') || '';
    if (question) questionTexts.add(normalize(question));
    if (entry?.factKey) factKeys.add(String(entry.factKey));
    const subject = quotedSubject(question);
    if (category && subject && answer) subjectAnswers.add(`${normalize(category)}|${normalize(subject)}|${normalize(answer)}`);
    if (category && question && answer) {
      const key = `${normalize(category)}|${normalize(answer)}`;
      if (!categoryAnswerContexts.has(key)) categoryAnswerContexts.set(key, []);
      categoryAnswerContexts.get(key).push(normalize(`${question} ${entry?.source?.title || ''}`));
    }
    if (question && answer) {
      const key = normalize(answer);
      if (!answerContexts.has(key)) answerContexts.set(key, []);
      answerContexts.get(key).push(normalize(`${question} ${entry?.source?.title || ''}`));
    }
    const qid = /\/wiki\/(Q\d+)/u.exec(String(entry?.source?.url || ''))?.[1];
    if (qid && answer) entityAnswers.add(`${qid}|${normalize(answer)}`);
    const verificationClaim = entry?.verification?.claim;
    if (verificationClaim?.subject && verificationClaim?.predicate && verificationClaim?.object != null) {
      factKeys.add(`claim:${verificationClaim.subject}|${verificationClaim.predicate}|${verificationClaim.object}`);
    }
    addArchivedSportsFact(entry, sportsFacts, sportsMatchFacts);
  }
  return { questionTexts, factKeys, subjectAnswers, categoryAnswerContexts, answerContexts,
    entityAnswers, sportsFacts, sportsMatchFacts };
}

function isOldFact(oldIndex, category, record, factKey, q, answer, predicate) {
  const sportFactType = record.provider && ['champion','runnerUp','score'].includes(predicate)
    ? predicate : null;
  const sportRepeat = sportFactType && (oldIndex.sportsFacts.has(`${record.provider}|${record.year}|${sportFactType}`)
    || (record.matchId && oldIndex.sportsMatchFacts.has(`${record.matchId}|${sportFactType}`)));
  const subjectNorm = normalize(record.subjectLabel || record.season);
  const sameAnswerContexts = oldIndex.categoryAnswerContexts.get(
    `${normalize(archiveCategory(category))}|${normalize(answer)}`) || [];
  const subjectMentionRepeat = subjectNorm.length >= 4
    && sameAnswerContexts.some(context => context.includes(subjectNorm));
  // Old banks sometimes filed invention questions under sport or general
  // knowledge. For inventor/designer relations, the subject + answer pair is
  // the semantic fact regardless of its former category.
  const oldAnswerContexts = oldIndex.answerContexts.get(normalize(answer)) || [];
  const inventionRepeat = ['P61', 'P287'].includes(predicate) && subjectNorm.length >= 4
    && oldAnswerContexts.some(context => context.includes(subjectNorm));
  return sportRepeat
    || inventionRepeat
    || subjectMentionRepeat
    || oldIndex.questionTexts.has(normalize(q))
    || oldIndex.factKeys.has(factKey)
    || oldIndex.factKeys.has(`claim:${record.subjectId || record.claim?.subject}|${predicate}|${record.answerId || answer}`)
    || oldIndex.subjectAnswers.has(`${normalize(archiveCategory(category))}|${normalize(record.subjectLabel || record.season)}|${normalize(answer)}`)
    || (record.subjectId && oldIndex.entityAnswers.has(`${record.subjectId}|${normalize(answer)}`));
}

function chooseOptions(pool, record, answer, answerKey, seedIndex) {
  const candidates = [];
  const start = Math.max(0, pool.indexOf(record));
  for (let step = 1; step < pool.length * 3 && candidates.length < 3; step += 1) {
    const candidate = pool[(start + step) % pool.length];
    const label = clean(candidate.__answer);
    const key = String(candidate.__answerKey);
    if (!label || key === String(answerKey) || tooSimilar(label, answer)
      || candidates.some(value => value.key === key || tooSimilar(value.label, label))) continue;
    candidates.push({ label, key, recordKey: candidate.recordKey });
  }
  if (candidates.length !== 3) throw new Error(`${record.recordKey}: insufficient homogeneous distractors`);
  const correctIndex = Math.abs(Number(seedIndex)) % 4;
  candidates.splice(correctIndex, 0, { label: clean(answer), key: String(answerKey), recordKey: record.recordKey });
  return { o: candidates.map(value => value.label), a: correctIndex,
    optionEntityIds: candidates.map(value => value.key),
    optionSourceRecordKeys: candidates.map(value => value.recordKey) };
}

function balancedAnswerSlot(category, position) {
  const offset = Number.parseInt(sha256(`${category}|answer-slot-offset`).slice(0, 8), 16) % 4;
  const band = Math.floor(position / 30);
  const localPosition = position % 30;
  const extraSlots = [
    [offset, (offset + 1) % 4],
    [(offset + 2) % 4, (offset + 3) % 4],
    [offset, (offset + 2) % 4],
  ][band];
  const slots = [...Array.from({ length: 28 }, (_, index) => index % 4), ...extraSlots]
    .map((answerIndex, index) => ({
      answerIndex, order: sha256(`${category}|answer-slot-order|${band}|${index}`),
    })).sort((left, right) => left.order.localeCompare(right.order));
  return slots[localPosition].answerIndex;
}

function repositionRendered(rendered, targetIndex) {
  const move = values => {
    const copy = [...values];
    const [correct] = copy.splice(rendered.a, 1);
    copy.splice(targetIndex, 0, correct);
    return copy;
  };
  return {
    o: move(rendered.o),
    a: targetIndex,
    optionEntityIds: move(rendered.optionEntityIds),
    optionSourceRecordKeys: move(rendered.optionSourceRecordKeys),
  };
}

function questionSpec(dataset, record) {
  if (dataset === 'animation') return {
    category: 'كرتون وأنمي', predicate: 'P57',
    templateId: record.claim.classification?.creativeKind === 'animated-film'
      ? 'wikidata-animated-film-single-director-v1' : 'wikidata-anime-series-single-director-v1',
    q: record.claim.classification?.creativeKind === 'animated-film'
      ? `من أخرج فيلم الرسوم المتحركة «${record.subjectLabel}»؟`
      : `من أخرج مسلسل الأنمي «${record.subjectLabel}»؟`,
    answer: record.answerLabel,
    answerKey: record.answerId, answerSemanticType: 'human-director', optionSemanticGroup: 'human-director',
  };
  if (dataset === 'arabicFilms') return {
    category: 'سينما وأفلام عربية', predicate: 'P57', templateId: 'wikidata-arabic-film-single-director-v1',
    q: `من أخرج الفيلم العربي «${record.subjectLabel}»؟`, answer: record.answerLabel,
    answerKey: record.answerId, answerSemanticType: 'human-director', optionSemanticGroup: 'human-director',
  };
  if (dataset === 'technology') return {
    category: 'تقنية وإنترنت', predicate: 'P178', templateId: 'wikidata-technology-single-organization-developer-v1',
    q: `ما الجهة التي طوّرت «${technologyProductLabel(record)}»؟`, answer: record.answerLabel,
    answerKey: record.answerId, answerSemanticType: 'organization', optionSemanticGroup: 'technology-developer-organization',
  };
  if (dataset === 'inventions') {
    const relation = record.claim.inventorOrDesigner.property;
    const kind = record.claim.classification.curatedKind;
    const wording = kind === 'programming-language' ? `من صمّم لغة البرمجة «${record.subjectLabel}»؟`
      : kind === 'constructed-language' ? `من ابتكر اللغة المصطنعة «${record.subjectLabel}»؟`
        : `من ينسب إليه اختراع «${record.subjectLabel}»؟`;
    return { category: 'اختراعات واكتشافات', predicate: relation,
      templateId: `wikidata-clear-${kind}-${relation.toLowerCase()}-v1`, q: wording,
      answer: record.answerLabel, answerKey: record.answerId,
      answerSemanticType: 'human-inventor-or-designer', optionSemanticGroup: 'human-inventor-or-designer' };
  }
  if (dataset === 'events') return {
    category: 'أحداث غيرت العالم', predicate: 'P580', templateId: 'wikidata-completed-event-single-start-year-v1',
    q: `في أي عام بدأ الحدث التاريخي «${record.subjectLabel}»؟`, answer: record.answerLabel,
    answerKey: record.answerId, answerSemanticType: 'calendar-year', optionSemanticGroup: 'historical-event-year',
  };
  if (dataset === 'organizations') return {
    category: 'منظمات دولية', predicate: 'P159', templateId: 'wikidata-active-international-organization-single-city-hq-v1',
    q: `في أي مدينة يقع مقر المنظمة الدولية «${record.subjectLabel}»؟`,
    answer: record.answerLabel, answerKey: record.answerId, answerSemanticType: 'city', optionSemanticGroup: 'headquarters-city',
  };
  throw new Error(`unknown dataset: ${dataset}`);
}

function technologyProductLabel(record){
  const developer=String(record.answerLabel||'').trim();
  let label=String(record.subjectLabel||'').trim();
  if(developer) label=label.replace(new RegExp(developer.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'giu'),' ');
  return clean(label)
    .replace(/^[-–—:،\s]+|[-–—:،\s]+$/gu,'')
    .replace(/\(\s*\)/gu,'')
    .replace(/\s+(?:من|لـ|ل)\s*$/u,'')
    .trim();
}

function sportsQuestionSpec(record) {
  const isFifa = record.provider === 'FIFA';
  const subject = isFifa ? `كأس العالم FIFA عام ${record.season}`
    : `دوري أبطال أوروبا UEFA موسم ${record.season}`;
  const teamType = isFifa ? 'منتخب' : 'نادٍ';
  let q;
  if (record.factType === 'champion') q = `أي ${teamType} تُوّج بلقب ${subject}؟`;
  else if (record.factType === 'runnerUp') q = `أي ${teamType} حلّ وصيفًا في ${subject}؟`;
  else q = `ما نتيجة نهائي ${subject} بين «${record.home}» و«${record.away}» بالترتيب، قبل ركلات الترجيح إن وُجدت؟`;
  const answerSemanticType = record.factType === 'score' ? 'football-score'
    : isFifa ? 'national-football-team' : 'football-club';
  return { category: 'أندية ومنتخبات', predicate: record.factType,
    templateId: `${record.provider.toLowerCase()}-historical-final-${record.factType.toLowerCase()}-v1`,
    q, answer: record.answer, answerKey: `${record.provider}:${record.answer}`,
    answerSemanticType, optionSemanticGroup: answerSemanticType };
}

const verifierArtifactCache = new Map();

function verifierArtifact(relativePath) {
  if (!verifierArtifactCache.has(relativePath)) {
    verifierArtifactCache.set(relativePath, readJson(relativePath));
  }
  return verifierArtifactCache.get(relativePath);
}

function expectedRenderedOptions(dataset, sourceRecord, spec, position) {
  try {
    if (dataset === 'sports') {
      const ranked = [...verifierArtifact(SPORTS_ARTIFACT).records]
        .sort((left, right) => left.difficultyPropertyRank - right.difficultyPropertyRank
          || left.popularityRank - right.popularityRank
          || left.recordKey.localeCompare(right.recordKey, 'en'));
      const pool = ranked.filter(record => record.provider === sourceRecord.provider
          && record.factType === sourceRecord.factType)
        .map(record => {
          const candidateSpec = sportsQuestionSpec(record);
          return { ...record, __answer: candidateSpec.answer, __answerKey: candidateSpec.answerKey };
        });
      const record = pool.find(candidate => candidate.recordKey === sourceRecord.recordKey);
      if (!record) return null;
      return repositionRendered(chooseOptions(pool, record, spec.answer, spec.answerKey,
        sourceRecord.year + sourceRecord.difficultyPropertyRank), balancedAnswerSlot(spec.category, position));
    }
    const ranked = rankedWikidataRecords(verifierArtifact(WIKIDATA_ARTIFACT).datasets[dataset]);
    const pool = ranked.map(record => {
      const candidateSpec = questionSpec(dataset, record);
      return { ...record, __answer: candidateSpec.answer, __answerKey: candidateSpec.answerKey };
    });
    const record = pool.find(candidate => candidate.recordKey === sourceRecord.recordKey);
    if (!record) return null;
    return repositionRendered(chooseOptions(pool, record, spec.answer, spec.answerKey,
      qidNumber(sourceRecord.subjectId)), balancedAnswerSlot(spec.category, position));
  } catch {
    return null;
  }
}

function builtQuestion(dataset, record, spec, rendered, artifact, collection, position) {
  const factKey = dataset === 'sports'
    ? `${record.provider.toLowerCase()}:${record.competition}:${record.season}:${record.factType}`
    : `wikidata:${record.subjectId}:${spec.predicate}:${record.answerId}`;
  const verificationClaim = claimTriple(record, spec.predicate, record.answerId || record.answer);
  const fields = dataset === 'sports'
    ? { provider: record.provider, competition: record.competition, season: record.season,
      factType: record.factType, answer: record.answer, claim: record.claim }
    : { subjectId: record.subjectId, subjectLabel: record.subjectLabel, answerId: record.answerId,
      answerLabel: record.answerLabel, claim: record.claim };
  const bandIndex = Math.floor(position / 30);
  const positioned = repositionRendered(rendered, balancedAnswerSlot(spec.category, position));
  return {
    category: spec.category,
    id: `gq-${sha256(`media-tech-global|${spec.category}|${factKey}`).slice(0, 20)}`,
    q: clean(spec.q), o: positioned.o, a: positioned.a, answer: clean(spec.answer),
    d: bandIndex * 2 + 1 + (position % 2), band: BANDS[bandIndex],
    factKey, sourceRecordId: record.recordKey, sourceArtifactId: dataset === 'sports'
      ? SOURCE_ARTIFACT_IDS.sports : SOURCE_ARTIFACT_IDS.wikidata,
    sourceRecordKey: record.recordKey, templateId: spec.templateId,
    answerEntityId: String(spec.answerKey), optionEntityIds: positioned.optionEntityIds,
    optionSourceRecordKeys: positioned.optionSourceRecordKeys,
    difficultyOrdinal: position + 1,
    answerSemanticType: spec.answerSemanticType, optionSemanticGroup: spec.optionSemanticGroup,
    rank: dataset === 'sports'
      ? 4_000_000 - record.difficultyPropertyRank * 1_000_000 - record.popularityRank
      : record.popularity.score,
    difficultyBasis: dataset === 'sports'
      ? 'official-final-fact-property+global-recency'
      : record.popularity.metric,
    popularity: dataset === 'sports'
      ? { propertyRank: record.difficultyPropertyRank, globalRecencyRank: record.popularityRank }
      : record.popularity,
    claim: record.claim,
    source: {
      title: dataset === 'sports' ? `${record.provider} — ${record.competition} ${record.season}`
        : `${record.subjectLabel} — Wikidata`,
      url: record.sourceUrl, publisher: record.sourcePublisher, license: record.sourceLicense,
      evidence: dataset === 'sports'
        ? `سجل النهائي الرسمي: ${record.champion} ضد ${record.runnerUp}، والنتيجة ${record.score}.`
        : `لقطة موثقة للخاصية ${spec.predicate} مع قيد القيمة الوحيدة والتصنيف الدلالي.`,
    },
    verification: sourceRecordVerification(artifact, collection, record, fields, verificationClaim),
    review: { status: 'automated_structure_pass', reviewer: 'Fatinah media-tech-global factual gate',
      reviewedAt: REVIEW_DATE, basis: 'deterministic_source_claim_pending_verification',
      humanReviewRequired: false, factualVerificationRequired: true },
  };
}

function buildWikidataDataset(dataset, records, oldIndex, globalQuestionNorms) {
  const ranked = rankedWikidataRecords(records);
  const pool = ranked.map(record => {
    const spec = questionSpec(dataset, record);
    return { ...record, __answer: spec.answer, __answerKey: spec.answerKey };
  });
  const output = [];
  for (const record of pool) {
    const spec = questionSpec(dataset, record);
    const factKey = `wikidata:${record.subjectId}:${spec.predicate}:${record.answerId}`;
    if (!spec.q.includes('«»') && normalize(spec.q).includes(normalize(spec.answer))) continue;
    if (isOldFact(oldIndex, spec.category, record, factKey, spec.q, spec.answer, spec.predicate)
      || globalQuestionNorms.has(normalize(spec.q))) continue;
    const rendered = chooseOptions(pool, record, spec.answer, spec.answerKey, qidNumber(record.subjectId));
    const question = builtQuestion(dataset, record, spec, rendered, WIKIDATA_ARTIFACT,
      `datasets.${dataset}`, output.length);
    output.push(question); globalQuestionNorms.add(normalize(question.q));
    if (output.length === 90) break;
  }
  if (output.length !== 90) throw new Error(`${questionSpec(dataset, records[0]).category}: ${output.length}/90 after semantic archive exclusions`);
  return output;
}

function buildSports(records, oldIndex, globalQuestionNorms) {
  const ranked = [...records].sort((left, right) => left.difficultyPropertyRank - right.difficultyPropertyRank
    || left.popularityRank - right.popularityRank || left.recordKey.localeCompare(right.recordKey, 'en'));
  const typedPools = new Map();
  for (const record of ranked) {
    const key = `${record.provider}:${record.factType}`;
    if (!typedPools.has(key)) typedPools.set(key, []);
    const spec = sportsQuestionSpec(record);
    typedPools.get(key).push({ ...record, __answer: spec.answer, __answerKey: spec.answerKey });
  }
  const output = [];
  for (const factType of ['champion','runnerUp','score']) {
    let accepted = 0;
    for (const raw of ranked.filter(record => record.factType === factType)) {
      const spec = sportsQuestionSpec(raw);
      const record = typedPools.get(`${raw.provider}:${raw.factType}`)
        .find(value => value.recordKey === raw.recordKey);
      const factKey = `${raw.provider.toLowerCase()}:${raw.competition}:${raw.season}:${raw.factType}`;
      if (isOldFact(oldIndex, spec.category, raw, factKey, spec.q, spec.answer, spec.predicate)
        || globalQuestionNorms.has(normalize(spec.q))) continue;
      const pool = typedPools.get(`${raw.provider}:${raw.factType}`);
      const rendered = chooseOptions(pool, record, spec.answer, spec.answerKey,
        raw.year + raw.difficultyPropertyRank);
      const question = builtQuestion('sports', raw, spec, rendered, SPORTS_ARTIFACT, 'records', output.length);
      output.push(question); globalQuestionNorms.add(normalize(question.q));
      accepted += 1;
      if (accepted === 30) break;
    }
    if (accepted !== 30) throw new Error(`أندية ومنتخبات/${factType}: ${accepted}/30 after semantic archive exclusions`);
  }
  return output;
}

function sourceErrors(wikidata, sports) {
  const errors = [];
  const fail = message => errors.push(message);
  if (wikidata?.schemaVersion !== 1 || wikidata?.sourceArtifactId !== SOURCE_ARTIFACT_IDS.wikidata
    || wikidata?.contentSha256 !== contentHash(wikidata || {})) fail('invalid Wikidata snapshot envelope/hash');
  if (sports?.schemaVersion !== 1 || sports?.sourceArtifactId !== SOURCE_ARTIFACT_IDS.sports
    || sports?.contentSha256 !== contentHash(sports || {})) fail('invalid sports snapshot envelope/hash');
  const recordKeys = new Set();
  for (const [dataset, rows] of Object.entries(wikidata?.datasets || {})) {
    if (!Array.isArray(rows) || rows.length < 90) fail(`${dataset}: source has fewer than 90 records`);
    for (const record of rows || []) {
      if (!record.recordKey || recordKeys.has(record.recordKey)) fail(`${dataset}: duplicate/missing recordKey`);
      recordKeys.add(record.recordKey);
      if (record.sourcePayloadHash !== recordPayloadHash(record)) fail(`${record.recordKey}: payload hash mismatch`);
      if (!/^Q\d+$/u.test(record.subjectId) || !record.subjectLabel || BANNED.test(JSON.stringify(record))) fail(`${record.recordKey}: invalid/banned entity`);
      if (!record.popularity?.hasArabicWikipediaArticle || !Number.isInteger(record.sitelinks)
        || record.popularity?.globalSitelinks !== record.sitelinks
        || !String(record.popularity?.metric).includes('property-complexity')) fail(`${record.recordKey}: incomplete difficulty evidence`);
    }
  }
  for (const record of sports?.records || []) {
    if (!record.recordKey || recordKeys.has(record.recordKey)) fail('sports: duplicate/missing recordKey');
    recordKeys.add(record.recordKey);
    if (record.sourcePayloadHash !== recordPayloadHash(record) || !['FIFA','UEFA'].includes(record.provider)
      || !['champion','runnerUp','score'].includes(record.factType)
      || /participant|count/iu.test(String(record.claim?.predicate || ''))
      || BANNED.test(JSON.stringify(record))) fail(`${record.recordKey}: invalid sports record`);
  }
  if ((sports?.records || []).length < 120) fail(`sports source: ${sports?.records?.length || 0}; expected at least 120`);
  return errors;
}

export function buildMediaTechGlobalCategories({
  wikidataSourcePath = path.join(ROOT, WIKIDATA_ARTIFACT),
  sportsSourcePath = path.join(ROOT, SPORTS_ARTIFACT),
  oldQuestions = new Set(), oldRecords = [],
} = {}) {
  const wikidata = JSON.parse(fs.readFileSync(wikidataSourcePath, 'utf8'));
  const sports = JSON.parse(fs.readFileSync(sportsSourcePath, 'utf8'));
  const errors = sourceErrors(wikidata, sports);
  if (errors.length) throw new Error(`Invalid media-tech-global sources:\n- ${errors.join('\n- ')}`);
  const archiveIndex = oldFactIndex(oldQuestions, oldRecords);
  const seenQuestions = new Set();
  return {
    'كرتون وأنمي': buildWikidataDataset('animation', wikidata.datasets.animation, archiveIndex, seenQuestions),
    'تقنية وإنترنت': buildWikidataDataset('technology', wikidata.datasets.technology, archiveIndex, seenQuestions),
    'سينما وأفلام عربية': buildWikidataDataset('arabicFilms', wikidata.datasets.arabicFilms, archiveIndex, seenQuestions),
    'اختراعات واكتشافات': buildWikidataDataset('inventions', wikidata.datasets.inventions, archiveIndex, seenQuestions),
    'أندية ومنتخبات': buildSports(sports.records, archiveIndex, seenQuestions),
    'أحداث غيرت العالم': buildWikidataDataset('events', wikidata.datasets.events, archiveIndex, seenQuestions),
    'منظمات دولية': buildWikidataDataset('organizations', wikidata.datasets.organizations, archiveIndex, seenQuestions),
  };
}

function same(left, right) {
  return canonical(left) === canonical(right);
}

function validSingleton(claim, valueId) {
  return claim?.distinctValueCount === 1 && claim?.valueIds?.[0] === valueId;
}

/**
 * Custom verifier callback for factual-verifier.mjs. It recomputes the exact
 * wording and answer from the independently resolved source record, then checks
 * the category-specific claim invariants.
 */
export function verifyMediaTechGlobalQuestionFact(question, record) {
  const position = Number(question?.difficultyOrdinal) - 1;
  const expectedBandIndex = Math.floor(position / 30);
  if (!question || !record || question.sourceRecordId !== record.recordKey
    || question.sourceRecordKey !== record.recordKey
    || question.verification?.recordId !== record.recordKey
    || question.verification?.recordIdField !== 'recordKey'
    || question.verification?.profile !== 'source_record_fields_v1'
    || !Array.isArray(question.o) || question.o.length !== 4
    || new Set(question.o.map(normalize)).size !== 4
    || !Number.isInteger(question.a) || question.a < 0 || question.a >= question.o.length
    || !Number.isInteger(question.difficultyOrdinal) || position < 0 || position >= 90
    || question.band !== BANDS[expectedBandIndex]
    || question.d !== expectedBandIndex * 2 + 1 + (position % 2)
    || question.answer !== question.o?.[question.a]
    || question.source?.url !== record.sourceUrl
    || question.source?.publisher !== record.sourcePublisher
    || question.source?.license !== record.sourceLicense
    || !same(question.claim, record.claim)) return false;
  let dataset;
  if (question.category === 'كرتون وأنمي') dataset = 'animation';
  else if (question.category === 'سينما وأفلام عربية') dataset = 'arabicFilms';
  else if (question.category === 'تقنية وإنترنت') dataset = 'technology';
  else if (question.category === 'اختراعات واكتشافات') dataset = 'inventions';
  else if (question.category === 'أحداث غيرت العالم') dataset = 'events';
  else if (question.category === 'منظمات دولية') dataset = 'organizations';
  if (dataset) {
    const spec = questionSpec(dataset, record);
    const expectedOptions = expectedRenderedOptions(dataset, record, spec, position);
    const expectedFactKey = `wikidata:${record.subjectId}:${spec.predicate}:${record.answerId}`;
    const expectedFields = { subjectId: record.subjectId, subjectLabel: record.subjectLabel,
      answerId: record.answerId, answerLabel: record.answerLabel, claim: record.claim };
    const expectedAnswerIndex = balancedAnswerSlot(spec.category, position);
    if (question.q !== spec.q || question.answer !== spec.answer || question.templateId !== spec.templateId
      || question.factKey !== expectedFactKey
      || question.id !== `gq-${sha256(`media-tech-global|${spec.category}|${expectedFactKey}`).slice(0, 20)}`
      || question.verification.artifact !== WIKIDATA_ARTIFACT
      || question.verification.collection !== `datasets.${dataset}`
      || question.sourceArtifactId !== SOURCE_ARTIFACT_IDS.wikidata
      || !same(question.verification.fields, expectedFields)
      || question.source.title !== `${record.subjectLabel} — Wikidata`
      || question.source.evidence !== `لقطة موثقة للخاصية ${spec.predicate} مع قيد القيمة الوحيدة والتصنيف الدلالي.`
      || question.a !== expectedAnswerIndex
      || !expectedOptions || !same({ o: question.o, a: question.a,
        optionEntityIds: question.optionEntityIds,
        optionSourceRecordKeys: question.optionSourceRecordKeys }, expectedOptions)
      || question.answerEntityId !== String(spec.answerKey)
      || question.optionEntityIds?.[question.a] !== String(spec.answerKey)
      || question.optionSourceRecordKeys?.[question.a] !== record.recordKey
      || !same(question.verification.claim, claimTriple(record, spec.predicate, record.answerId))) return false;
    if (dataset === 'animation') return ['Q63952888','Q202866'].includes(record.claim.classification?.requiredValueId)
      && ((record.claim.classification?.requiredValueId === 'Q63952888'
        && record.claim.classification?.creativeKind === 'anime-television-series')
        || (record.claim.classification?.requiredValueId === 'Q202866'
          && record.claim.classification?.creativeKind === 'animated-film'))
      && validSingleton(record.claim.director, record.answerId)
      && record.claim.directorInstanceOf?.valueIds?.includes('Q5')
      && record.claim.familySafety?.intersection?.length === 0;
    if (dataset === 'arabicFilms') return record.claim.classification?.requiredValueId === 'Q11424'
      && validSingleton(record.claim.originalLanguage, 'Q13955')
      && record.claim.countryOfOrigin?.matchedValueIds?.length > 0
      && validSingleton(record.claim.director, record.answerId)
      && record.claim.familySafety?.intersection?.length === 0;
    if (dataset === 'technology') return validSingleton(record.claim.developer, record.answerId)
      && record.claim.developerOrganization?.hierarchyPathValidatedByQuery === true
      && !record.claim.developerOrganization?.valueIds?.includes('Q5');
    if (dataset === 'inventions') return validSingleton(record.claim.inventorOrDesigner, record.answerId)
      && !INVENTION_EXCLUDED_IDS.has(record.subjectId)
      && record.claim.editorialCuration?.clearInvention === true
      && record.claim.editorialCuration?.disputedAttributionExcluded === true
      && !PROHIBITED_INVENTION.test(record.subjectLabel);
    if (dataset === 'events') return record.claim.start?.distinctValueCount === 1
      && record.claim.end?.distinctValueCount === 1 && record.claim.temporalScope?.singleClearStart === true
      && record.claim.temporalScope?.ongoing === false && record.claim.temporalScope?.durationDays <= 62
      && !AMBIGUOUS_EVENT_IDS.has(record.subjectId)
      && !new RegExp(`(^|\\D)${record.claim.start.year}(\\D|$)`, 'u').test(record.subjectLabel)
      && question.answer === String(record.claim.start.year);
    return validSingleton(record.claim.headquarters, record.answerId)
      && record.claim.headquartersCity?.hierarchyPathValidatedByQuery === true
      && record.claim.temporalValidity?.currentlyExistingAtValidAsOf === true
      && record.claim.temporalValidity?.activeRegistry === 'reviewed-active-international-organizations-v1'
      && /^\d{4}-\d{2}-\d{2}$/u.test(record.claim.temporalValidity.validAsOf);
  }
  if (question.category !== 'أندية ومنتخبات') return false;
  const spec = sportsQuestionSpec(record);
  const expectedOptions = expectedRenderedOptions('sports', record, spec, position);
  const expectedFactKey = `${record.provider.toLowerCase()}:${record.competition}:${record.season}:${record.factType}`;
  const expectedFields = { provider: record.provider, competition: record.competition,
    season: record.season, factType: record.factType, answer: record.answer, claim: record.claim };
  const expectedAnswerIndex = balancedAnswerSlot(spec.category, position);
  return ['FIFA','UEFA'].includes(record.provider) && ['champion','runnerUp','score'].includes(record.factType)
    && question.q === spec.q && question.answer === record.answer && question.templateId === spec.templateId
    && question.factKey === expectedFactKey
    && question.id === `gq-${sha256(`media-tech-global|${spec.category}|${expectedFactKey}`).slice(0, 20)}`
    && question.verification.artifact === SPORTS_ARTIFACT && question.verification.collection === 'records'
    && question.sourceArtifactId === SOURCE_ARTIFACT_IDS.sports
    && same(question.verification.fields, expectedFields)
    && question.source.title === `${record.provider} — ${record.competition} ${record.season}`
    && question.source.evidence === `سجل النهائي الرسمي: ${record.champion} ضد ${record.runnerUp}، والنتيجة ${record.score}.`
    && question.a === expectedAnswerIndex
    && expectedOptions && same({ o: question.o, a: question.a,
      optionEntityIds: question.optionEntityIds,
      optionSourceRecordKeys: question.optionSourceRecordKeys }, expectedOptions)
    && question.answerEntityId === String(spec.answerKey)
    && question.optionEntityIds?.[question.a] === String(spec.answerKey)
    && question.optionSourceRecordKeys?.[question.a] === record.recordKey
    && same(question.verification.claim, claimTriple(record, spec.predicate, record.answer))
    && record.claim?.predicate === record.factType && record.claim?.object === record.answer
    && !/participant|count/iu.test(String(record.claim?.predicate || ''));
}

export function verifyMediaTechGlobalCategories(categories, {
  wikidataSourcePath = path.join(ROOT, WIKIDATA_ARTIFACT),
  sportsSourcePath = path.join(ROOT, SPORTS_ARTIFACT),
  oldQuestions = new Set(), oldRecords = [],
} = {}) {
  const wikidata = JSON.parse(fs.readFileSync(wikidataSourcePath, 'utf8'));
  const sports = JSON.parse(fs.readFileSync(sportsSourcePath, 'utf8'));
  const errors = sourceErrors(wikidata, sports);
  const oldIndex = oldFactIndex(oldQuestions, oldRecords);
  const sourceByKey = new Map([
    ...Object.values(wikidata.datasets).flat(), ...sports.records,
  ].map(record => [record.recordKey, record]));
  const ids = new Set(); const questions = new Set(); const facts = new Set();
  for (const category of MEDIA_TECH_GLOBAL_CATEGORIES) {
    const rows = categories?.[category] || [];
    if (rows.length !== 90) errors.push(`${category}: ${rows.length}/90`);
    const bandCounts = { easy: 0, medium: 0, hard: 0 };
    const answerSlots = [0, 0, 0, 0];
    const bandAnswerSlots = Object.fromEntries(BANDS.map(band => [band, [0, 0, 0, 0]]));
    let previousRank = Infinity;
    rows.forEach((question, index) => {
      bandCounts[question.band] = (bandCounts[question.band] || 0) + 1;
      if (Number.isInteger(question.a) && question.a >= 0 && question.a < 4) {
        answerSlots[question.a] += 1;
        if (bandAnswerSlots[question.band]) bandAnswerSlots[question.band][question.a] += 1;
      }
      if (question.rank > previousRank) errors.push(`${category}: non-monotonic familiarity at ${index}`);
      previousRank = question.rank;
      if (!Number.isInteger(question.d) || question.d < 1 || question.d > 6) errors.push(`${question.id}: invalid difficulty`);
      if (index < 30 && question.category !== 'أندية ومنتخبات'
        && question.popularity?.curatedTier !== 'widely-known-arabic-or-global') {
        errors.push(`${category}/${question.id}: easy item lacks Arabic/Gulf familiarity curation`);
      }
      if (question.difficultyOrdinal !== index + 1
        || question.band !== BANDS[Math.floor(index / 30)]
        || question.d !== Math.floor(index / 30) * 2 + 1 + (index % 2)) {
        errors.push(`${question.id}: difficulty order/band mismatch`);
      }
      if (!question.difficultyBasis || /hash/iu.test(question.difficultyBasis)) errors.push(`${question.id}: hash/empty difficulty basis`);
      if (!question.id || ids.has(question.id)) errors.push(`${question.id}: duplicate/missing id`); ids.add(question.id);
      const qNorm = normalize(question.q);
      if (!qNorm || questions.has(qNorm) || oldIndex.questionTexts.has(qNorm)) errors.push(`${question.id}: duplicate/old wording`);
      questions.add(qNorm);
      if (!question.factKey || facts.has(question.factKey) || oldIndex.factKeys.has(question.factKey)) errors.push(`${question.id}: duplicate/old factKey`);
      facts.add(question.factKey);
      const wordingWithoutQuotedSubject = question.q.replace(/«[^\u00bb]*»/gu, '');
      if (BANNED.test(JSON.stringify(question)) || VARIABLE_TIME.test(wordingWithoutQuotedSubject)) errors.push(`${question.id}: banned/time-variable content`);
      if (!Array.isArray(question.o) || question.o.length !== 4 || new Set(question.o.map(normalize)).size !== 4
        || question.o[question.a] !== question.answer
        || question.o.filter(value => normalize(value) === normalize(question.answer)).length !== 1) errors.push(`${question.id}: invalid options`);
      if (!Array.isArray(question.optionEntityIds) || question.optionEntityIds.length !== 4
        || new Set(question.optionEntityIds).size !== 4
        || question.optionEntityIds[question.a] !== question.answerEntityId) errors.push(`${question.id}: invalid typed option ids`);
      const record = sourceByKey.get(question.sourceRecordId);
      if (!record || question.sourceRecordKey !== question.sourceRecordId
        || !verifyMediaTechGlobalQuestionFact(question, record)) errors.push(`${question.id}: source/template/claim verification failed`);
      if (!question.source?.url?.startsWith('https://') || question.verification?.profile !== 'source_record_fields_v1'
        || !SOURCE_PATHS.includes(question.verification.artifact)) errors.push(`${question.id}: invalid standard provenance`);
      if (record && isOldFact(oldIndex, category, record, question.factKey, question.q,
        question.answer, question.verification?.claim?.predicate)) {
        errors.push(`${question.id}: semantically repeats archive fact`);
      }
      if (category === 'تقنية وإنترنت' && question.answerSemanticType !== 'organization') errors.push(`${question.id}: technology answer is not organization-typed`);
      if (category === 'اختراعات واكتشافات' && PROHIBITED_INVENTION.test(question.q)) errors.push(`${question.id}: prohibited invention kind`);
    });
    for (const band of BANDS) if (bandCounts[band] !== 30) errors.push(`${category}: ${band}=${bandCounts[band]}/30`);
    if (Math.max(...answerSlots) - Math.min(...answerSlots) > 1) {
      errors.push(`${category}: unbalanced answer positions ${answerSlots.join('/')}`);
    }
    for (const band of BANDS) {
      if (Math.max(...bandAnswerSlots[band]) - Math.min(...bandAnswerSlots[band]) > 1) {
        errors.push(`${category}/${band}: unbalanced answer positions ${bandAnswerSlots[band].join('/')}`);
      }
    }
  }
  const expectedKeys = new Set(MEDIA_TECH_GLOBAL_CATEGORIES);
  if (Object.keys(categories || {}).length !== expectedKeys.size
    || Object.keys(categories || {}).some(category => !expectedKeys.has(category))) errors.push('unexpected/missing category keys');
  return {
    valid: errors.length === 0, errors,
    questionCount: MEDIA_TECH_GLOBAL_CATEGORIES.reduce((sum, category) => sum + (categories?.[category]?.length || 0), 0),
    sourceArtifacts: { [SOURCE_ARTIFACT_IDS.wikidata]: wikidata.contentSha256,
      [SOURCE_ARTIFACT_IDS.sports]: sports.contentSha256 },
    distribution: Object.fromEntries(MEDIA_TECH_GLOBAL_CATEGORIES.map(category => [category, {
      count: categories?.[category]?.length || 0,
      bands: Object.fromEntries(BANDS.map(band => [band,
        (categories?.[category] || []).filter(question => question.band === band).length])),
    }])),
  };
}

function archivedRecords() {
  const records = [];
  const archiveDirectory = path.join(ROOT, 'server-assets/question-bank/archive');
  if (!fs.existsSync(archiveDirectory)) return records;
  for (const name of fs.readdirSync(archiveDirectory).filter(value => /-bank\.json$/u.test(value))) {
    const document = readJson(`server-assets/question-bank/archive/${name}`);
    for (const [category, rows] of Object.entries(document.categories || {})) {
      for (const row of rows || []) records.push({ category, ...row });
    }
  }
  return records;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const oldRecords = archivedRecords();
  const categories = buildMediaTechGlobalCategories({ oldRecords });
  const report = verifyMediaTechGlobalCategories(categories, { oldRecords });
  console.log(JSON.stringify(report, null, 2));
  if (!report.valid) process.exitCode = 1;
}
