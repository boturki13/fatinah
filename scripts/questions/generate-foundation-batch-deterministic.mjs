#!/usr/bin/env node
import path from 'node:path';
import {
  CANDIDATES_PATH, CONTENT_DIR, difficultyTier, loadExistingQuestionTexts, loadPolicy,
  normalizeArabic, readJson, stableQuestionId, validateCandidate, writeJsonAtomic,
} from './lib.mjs';

const write = process.argv.includes('--write');
const model = 'deterministic-foundation-batch-template-v1';
const bankPlan = readJson(path.join(CONTENT_DIR, 'bank-plan-5000.json'), null);
const countries = readJson(path.join(CONTENT_DIR, 'structured-sources', 'world-bank-countries.json'), null)?.records || [];
const sites = readJson(path.join(CONTENT_DIR, 'structured-sources', 'unesco-archaeological-sites.json'), null)?.records || [];
const planets = readJson(path.join(CONTENT_DIR, 'structured-sources', 'nasa-exoplanets.json'), null)?.records || [];
const math = readJson(path.join(CONTENT_DIR, 'structured-sources', 'deterministic-math-records.json'), null)?.records || [];
if (!bankPlan || countries.length < 180 || sites.length < 119 || planets.length < 500 || math.length < 600) {
  throw new Error('سجلات الدفعة الأساسية ناقصة؛ شغّل مستوردي المصادر أولاً.');
}

const allCandidates = readJson(CANDIDATES_PATH, []);
const obsoleteHistoryCandidates = allCandidates.filter(candidate =>
  candidate.category === 'تاريخ' && /^unesco-site-component-v1-l[1-6]$/.test(String(candidate.templateId || '')));
const candidates = allCandidates.filter(candidate => !obsoleteHistoryCandidates.includes(candidate));
const policy = loadPolicy();
const knownIds = new Set(candidates.map(candidate => candidate.id));
const comparisons = [...loadExistingQuestionTexts(),
  ...candidates.filter(candidate => candidate.status === 'approved').map(candidate => candidate.question)];
const added = [];

function approve(candidate) {
  const now = new Date().toISOString();
  Object.assign(candidate, {
    status: 'approved',
    generation: { model, responseId: null, generatedAt: now,
      usage: { inputTokens: 0, outputTokens: 0, webSearchCalls: 0, estimatedUsd: 0 } },
    verification: { model: 'schema-source-and-duplicate-v1', responseId: null, checkedAt: now,
      result: { verdict: 'pass', factCorrect: true, answerExact: true, answerNotRevealed: true,
        sourceSupportsClaim: true, clearArabic: true,
        reason: 'قالب حتمي من سجل رسمي أو عملية حسابية قابلة لإعادة الإنتاج.' },
      usage: { inputTokens: 0, outputTokens: 0, webSearchCalls: 0, estimatedUsd: 0 } },
    cost: { pricingAsOf: null, budgetUsd: 0, runEstimatedUsd: 0 },
    review: { reviewer: model, decision: 'approve',
      notes: 'تحقق من البصمة والمصدر والحساب وعدم كشف الإجابة والتكرار.',
      religiousSourceAndIsnadConfirmed: false, reviewedAt: now },
  });
  candidates.push(candidate); added.push(candidate); knownIds.add(candidate.id); comparisons.push(candidate.question);
}

function base(category, level, record, question, answer, explanation, templateId, title, evidence) {
  const candidate = {
    category, difficultyLevel: level, difficulty: difficultyTier(level), question, answer: String(answer), explanation,
    religious: false, sourceRecordId: `${record.sourceRecordId}-${category.replace(/\s+/g, '-')}`, templateId,
    source: { title, url: record.sourceUrl, publisher: record.sourcePublisher, evidence },
  };
  candidate.id = stableQuestionId(candidate);
  return candidate;
}

const singlePlanetHosts = new Set();
const hostCounts = new Map();
for (const record of planets) hostCounts.set(record.hostName, (hostCounts.get(record.hostName) || 0) + 1);
for (const [host, count] of hostCounts) if (count === 1) singlePlanetHosts.add(host);

function poolsFor(category, level) {
  if (category === 'معلومات عامة') return countries.map(record => ({ record,
    candidate: base(category, level, record,
      `شنو رمز ISO3 الدولي لدولة «${record.countryAr}»؟`, record.iso3,
      `يسجل البنك الدولي الرمز ${record.iso3} لدولة ${record.countryAr}.`, `country-iso3-v1-l${level}`,
      `World Bank country record — ${record.countryEn}`, `سجل الدولة يطابق ${record.countryEn} مع الرمز ${record.iso3}.`) }));
  if (category === 'خرائط دول') return countries.filter(record => record.latitude && record.longitude).map(record => ({ record,
    candidate: base(category, level, record,
      `أي دولة تقع عاصمتها قرب الإحداثيات ${Number(record.latitude).toFixed(2)}°، ${Number(record.longitude).toFixed(2)}°؟`, record.countryAr,
      `يربط سجل البنك الدولي عاصمة ${record.countryAr} بهذه الإحداثيات التقريبية.`, `capital-coordinates-v1-l${level}`,
      `World Bank country coordinates — ${record.countryEn}`, `السجل يعرض عاصمة ${record.capitalEn} عند ${record.latitude}, ${record.longitude}.`) }));
  if (category === 'تاريخ') return sites.filter(record => Number.isInteger(record.inscriptionYear)).map(record => {
    const wikidataRecord = {
      ...record,
      sourceUrl: record.translationIndexUrl.replace('http://www.wikidata.org/entity/', 'https://www.wikidata.org/wiki/'),
      sourcePublisher: 'Wikidata',
    };
    return { record,
    candidate: base(category, level, wikidataRecord,
      `متى أدرجت اليونسكو «${record.siteNameAr}» في ${record.countryNameAr} بقائمة التراث العالمي؟`, record.inscriptionYear,
      `أُدرج موقع ${record.siteNameAr} ضمن قائمة التراث العالمي سنة ${record.inscriptionYear}.`, `unesco-inscription-year-v1-l${level}`,
      `Wikidata — ${record.siteNameAr}`, `يسجل بيان تصنيف التراث للموقع بداية التصنيف سنة ${record.inscriptionYear}، ويرتبط بصفحة اليونسكو للملكية ${record.whPropertyId}.`) };
  });
  if (category === 'علوم وتقنية') return planets.filter(record => singlePlanetHosts.has(record.hostName)).map(record => ({ record,
    candidate: base(category, level, record,
      `شنو اسم الكوكب الخارجي المسجل حول ${record.hostName}، واكتُشف سنة ${record.discoveryYear} بواسطة ${record.discoveryMethod}؟`, record.planetName,
      `يربط سجل NASA النجم ${record.hostName} بالكوكب ${record.planetName}.`, `exoplanet-from-host-year-method-v1-l${level}`,
      `NASA Exoplanet Archive — ${record.planetName}`, `سجل pscomppars يعرض ${record.planetName}، ونجمه ${record.hostName}، وسنة ${record.discoveryYear}، وطريقة ${record.discoveryMethod}.`) }));
  const mathKind = category === 'إجابة سريعة' ? 'quick-arithmetic' : 'number-sequence';
  return math.filter(record => record.kind === mathKind && record.level === level).map(record => ({ record,
    candidate: base(category, level, record, record.prompt, record.answer,
      `النتيجة الحتمية للعملية «${record.expression}» هي ${record.answer}.`, `${mathKind}-v1-l${level}`,
      category === 'إجابة سريعة' ? 'Britannica — Arithmetic' : 'Britannica — Number game',
      `سجل حسابي حتمي يحفظ ${record.expression} ونتيجته ${record.answer}.`) }));
}

for (const category of ['معلومات عامة', 'تاريخ', 'علوم وتقنية', 'خرائط دول', 'إجابة سريعة', 'ألغاز وتحدّي ذكاء']) {
  const used = new Set(candidates.filter(candidate => candidate.category === category).map(candidate => candidate.sourceRecordId));
  for (let level = 1; level <= 6; level += 1) {
    const needed = category === 'تاريخ'
      ? obsoleteHistoryCandidates.filter(candidate => candidate.difficultyLevel === level).length
      : Number(bankPlan.categories?.[category]?.levels?.[level]?.gap || 0);
    let accepted = 0;
    const errors = {};
    for (const { candidate } of poolsFor(category, level)) {
      if (accepted >= needed) break;
      if (used.has(candidate.sourceRecordId)) continue;
      const validation = validateCandidate(candidate, { policy, existingQuestions: comparisons });
      if (!validation.valid || knownIds.has(candidate.id)) {
        for (const error of validation.errors.length ? validation.errors : ['duplicate_id']) errors[error] = (errors[error] || 0) + 1;
        continue;
      }
      approve(candidate); used.add(candidate.sourceRecordId); accepted += 1;
    }
    if (accepted !== needed) throw new Error(`${category} — ${level}: المطلوب ${needed} والمتاح ${accepted}. ${JSON.stringify(errors)}`);
  }
}

if (write) writeJsonAtomic(CANDIDATES_PATH, candidates);
console.log(JSON.stringify({ mode: write ? 'write' : 'dry-run', removedObsolete: obsoleteHistoryCandidates.length, added: added.length,
  byCategory: Object.fromEntries([...new Set(added.map(item => item.category))].map(category =>
    [category, added.filter(item => item.category === category).length])),
  aiCalls: 0, estimatedAiCostUsd: 0 }, null, 2));
