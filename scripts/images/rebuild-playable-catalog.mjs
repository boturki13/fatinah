#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalogPath = path.join(root, 'content/image-questions/curated-commons.json');
const endpoint = 'https://query.wikidata.org/sparql';
const userAgent = 'FatinahImageCatalog/1.3 (https://ata20.com)';
const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
const excludedQuestionContent = /إسرائيل|اسرائيل|إسرائيلي|اسرائيلي|تل أبيب|تل ابيب/i;
const remainingOnly = process.argv.includes('--remaining');
const fromSpace = process.argv.includes('--from-space');
const onlyTreasure = process.argv.includes('--only-treasure');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const qid = value => String(value || '').split('/').pop();
const filename = value => decodeURIComponent(String(value || '').split('/Special:FilePath/').pop() || '')
  .replace(/_/g, ' ').trim();

async function fetchJson(url, timeout = 90_000) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/sparql-results+json', 'User-Agent': userAgent },
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 5) await sleep(attempt * 1_200);
    }
  }
  throw lastError;
}

async function queryRows(where, limit = 260) {
  const query = `SELECT DISTINCT ?item ?image ?sitelinks WHERE {
    ${where}
    ?item wdt:P18 ?image; wikibase:sitelinks ?sitelinks.
    ?article schema:about ?item; schema:isPartOf <https://ar.wikipedia.org/>.
  } ORDER BY DESC(?sitelinks) LIMIT ${limit}`;
  const url = new URL(endpoint);
  url.searchParams.set('format', 'json');
  url.searchParams.set('query', query);
  const payload = await fetchJson(url);
  return payload.results.bindings.map(binding => ({
    itemId: qid(binding.item?.value),
    file: filename(binding.image?.value),
    sitelinks: Number(binding.sitelinks?.value || 0),
  })).filter(row => /^Q\d+$/.test(row.itemId) && row.file);
}

async function queryLocationRows(where, limit = 320) {
  const query = `SELECT DISTINCT ?item ?answer ?image ?sitelinks WHERE {
    ${where}
    ?item wdt:P17 ?answer; wdt:P18 ?image; wikibase:sitelinks ?sitelinks.
    ?article schema:about ?item; schema:isPartOf <https://ar.wikipedia.org/>.
  } ORDER BY DESC(?sitelinks) LIMIT ${limit}`;
  const url = new URL(endpoint);
  url.searchParams.set('format', 'json');
  url.searchParams.set('query', query);
  const payload = await fetchJson(url);
  return payload.results.bindings.map(binding => ({
    itemId: qid(binding.item?.value),
    answerId: qid(binding.answer?.value),
    file: filename(binding.image?.value),
    sitelinks: Number(binding.sitelinks?.value || 0),
  })).filter(row => /^Q\d+$/.test(row.itemId) && /^Q\d+$/.test(row.answerId) && row.file);
}

async function addArabicLabels(rows, labelKey = 'itemId') {
  const result = [];
  for (let index = 0; index < rows.length; index += 50) {
    const batch = rows.slice(index, index + 50);
    const ids = [...new Set(batch.map(row => row[labelKey]))];
    const url = new URL('https://www.wikidata.org/w/api.php');
    for (const [key, value] of Object.entries({
      action: 'wbgetentities', format: 'json', props: 'labels', languages: 'ar', ids: ids.join('|'),
    })) url.searchParams.set(key, value);
    const payload = await fetchJson(url, 45_000);
    for (const row of batch) {
      const label = payload.entities?.[row[labelKey]]?.labels?.ar?.value?.trim();
      if (label) result.push({ ...row, answer: label });
    }
  }
  return result;
}

async function localAnimalRows() {
  const sourcePath = path.join(root, 'content/questions/structured-sources/inaturalist-animal-taxa.json');
  const records = JSON.parse(await fs.readFile(sourcePath, 'utf8')).records;
  const result = [];
  for (let index = 0; index < records.length; index += 40) {
    const batch = records.slice(index, index + 40);
    const ids = batch.map(record => qid(record.translationCrossCheck?.entityUrl)).filter(id => /^Q\d+$/.test(id));
    const url = new URL('https://www.wikidata.org/w/api.php');
    for (const [key, value] of Object.entries({
      action: 'wbgetentities', format: 'json', props: 'claims|sitelinks', ids: ids.join('|'),
    })) url.searchParams.set(key, value);
    const payload = await fetchJson(url, 45_000);
    for (const record of batch) {
      const itemId = qid(record.translationCrossCheck?.entityUrl);
      const entity = payload.entities?.[itemId];
      const file = entity?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
      if (file) result.push({
        itemId,
        answer: record.commonNameAr,
        file,
        sitelinks: Object.keys(entity.sitelinks || {}).length,
      });
    }
  }
  return result.sort((left, right) => right.sitelinks - left.sitelinks);
}

async function rankExistingCategory(name, { answerByInstanceOf = null } = {}) {
  const category = catalog.categories.find(item => item.name === name);
  const candidates = (category?.items || []).slice(12).map(item => ({
    item,
    itemId: qid(item.factUrl),
  })).filter(row => /^Q\d+$/.test(row.itemId));
  const result = [];
  for (let index = 0; index < candidates.length; index += 40) {
    const batch = candidates.slice(index, index + 40);
    const url = new URL('https://www.wikidata.org/w/api.php');
    for (const [key, value] of Object.entries({
      action: 'wbgetentities', format: 'json', props: answerByInstanceOf ? 'sitelinks|claims' : 'sitelinks', ids: batch.map(row => row.itemId).join('|'),
    })) url.searchParams.set(key, value);
    const payload = await fetchJson(url, 45_000);
    for (const row of batch) {
      const entity = payload.entities?.[row.itemId];
      const instanceOf = entity?.claims?.P31?.map(claim => claim.mainsnak?.datavalue?.value?.id).find(id => answerByInstanceOf?.[id]);
      const answer = instanceOf ? answerByInstanceOf[instanceOf] : row.item.answer;
      result.push({
        itemId: row.itemId,
        answer,
        file: row.item.file,
        sitelinks: Object.keys(entity?.sitelinks || {}).length,
      });
    }
  }
  return result.sort((left, right) => right.sitelinks - left.sitelinks);
}

function interleave(groups) {
  const output = [];
  const queues = groups.map(group => [...group]);
  while (queues.some(group => group.length)) {
    for (const group of queues) if (group.length) output.push(group.shift());
  }
  return output;
}

function cleanRows(rows, usedAnswers = new Set(), uniqueAnswers = true) {
  const seenItems = new Set();
  return rows.filter(row => {
    const answer = String(row.answer || '').trim();
    if (!answer || answer.length > 48 || excludedQuestionContent.test(answer) ||
        /[A-Za-z]{3}|\bNGC\b|\bHD\b|\b2MASS\b|\d{3,}/i.test(answer)) return false;
    if (seenItems.has(row.itemId) || (uniqueAnswers && usedAnswers.has(answer))) return false;
    seenItems.add(row.itemId);
    if (uniqueAnswers) usedAnswers.add(answer);
    return true;
  });
}

const addedDifficulty = index => Math.min(6, 1 + Math.floor(index / 19));
function catalogItems({ prefix, rows, base = [], target, prompt, alt, reserve = 25, uniqueAnswers = true }) {
  const usedAnswers = new Set(base.map(item => item.answer));
  const accepted = cleanRows(rows, usedAnswers, uniqueAnswers);
  const needed = target - base.length;
  if (accepted.length < needed + reserve) throw new Error(`${prefix}: المرشحون النظيفون ${accepted.length}/${needed + reserve}`);
  const additions = accepted.slice(0, needed + Math.max(reserve, 30)).map((row, index) => ({
    id: `${prefix}-${row.itemId.toLowerCase()}`,
    difficulty: addedDifficulty(index),
    answer: row.answer,
    file: row.file,
    alt,
    ...(prompt ? { prompt } : {}),
    factUrl: `https://www.wikidata.org/wiki/${row.itemId}`,
  }));
  return [...base, ...additions];
}

async function ranked(types, perType = 220) {
  const groups = [];
  for (const type of types) {
    const rows = await queryRows(`?item wdt:P31/wdt:P279* wd:${type}.`, perType);
    groups.push(await addArabicLabels(rows));
  }
  return interleave(groups);
}

async function replaceCategory(name, items, target) {
  const category = catalog.categories.find(item => item.name === name);
  if (!category) throw new Error(`الفئة غير موجودة: ${name}`);
  category.target = target;
  category.items = items;
  catalog.version = 4;
  await fs.writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`✓ ${name}: ${items.length} مرشحاً نظيفاً لهدف ${target}`);
}

const baseFor = name => catalog.categories.find(category => category.name === name)?.items.slice(0, 12) || [];

if (!remainingOnly) {
  if (!onlyTreasure) {
    const objectRows = await ranked(['Q39546', 'Q34379', 'Q1497805'], 190);
    await replaceCategory('شنو هالشي؟', catalogItems({
      prefix: 'objectx', rows: objectRows, base: baseFor('شنو هالشي؟'), target: 125,
      alt: 'صورة واضحة لقطعة أو أداة ملموسة، مع إبقاء اسمها مخفياً أثناء السؤال',
    }), 125);
  }

  const treasureRows = await ranked(['Q220659', 'Q860861', 'Q87167', 'Q41207'], 180);
  await replaceCategory('كنوز الحضارات', catalogItems({
    prefix: 'treasurex', rows: treasureRows, base: baseFor('كنوز الحضارات'), target: 125,
    reserve: 80,
    prompt: 'شنو اسم هالكنز أو الأثر الظاهر بالصورة؟',
    alt: 'صورة واضحة لقطعة تاريخية أو أثر محفوظ، مع إبقاء اسم الإجابة مخفياً أثناء السؤال',
  }), 125);

  if (!onlyTreasure) {
    const generalRows = await ranked(['Q3314483', 'Q42889', 'Q34379', 'Q39546'], 180);
    await replaceCategory('تعرف على الصورة', catalogItems({
      prefix: 'generalx', rows: generalRows, target: 113,
      prompt: 'شنو الشي الظاهر بالصورة؟',
      alt: 'صورة واضحة لعنصر حقيقي مطلوب التعرف عليه، مع إبقاء اسمه مخفياً أثناء السؤال',
    }), 113);
  }
}

if (!fromSpace && !onlyTreasure) {
  const animalRows = await localAnimalRows();
  await replaceCategory('شنو هالحيوان؟', catalogItems({
    prefix: 'animalx', rows: animalRows, base: baseFor('شنو هالحيوان؟'), target: 125,
    alt: 'صورة واضحة لحيوان تظهر هيئته وأبرز علاماته من دون ذكر اسمه',
  }), 125);
}

if (!onlyTreasure) {
const spaceRows = await rankExistingCategory('شنو بالفضاء؟', { answerByInstanceOf: {
  Q634: 'كوكب', Q523: 'نجم', Q318: 'مجرة', Q4235: 'سديم', Q3559: 'مذنب', Q2537: 'قمر طبيعي',
} });
await replaceCategory('شنو بالفضاء؟', catalogItems({
  prefix: 'spacex', rows: spaceRows, base: baseFor('شنو بالفضاء؟'), target: 125,
  reserve: 8, uniqueAnswers: false,
  prompt: 'شنو نوع الجرم الفضائي الظاهر بالصورة؟',
  alt: 'صورة واضحة لجرم أو ظاهرة فضائية، مع إبقاء اسم الإجابة مخفياً أثناء السؤال',
}), 125);

const playerRows = await rankExistingCategory('منو هاللاعب؟');
await replaceCategory('منو هاللاعب؟', catalogItems({
  prefix: 'playerx', rows: playerRows, base: baseFor('منو هاللاعب؟'), target: 125,
  reserve: 8,
  alt: 'صورة واضحة للاعب أو لاعبة كرة قدم، مع إبقاء الاسم مخفياً أثناء السؤال',
}), 125);

const locationRows = await rankExistingCategory('وين هالمعلم؟');
await replaceCategory('وين هالمعلم؟', catalogItems({
  prefix: 'landmarkx', rows: locationRows, base: baseFor('وين هالمعلم؟'), target: 125,
  reserve: 8, uniqueAnswers: false,
  alt: 'صورة واضحة لمعلم معروف تظهر ملامحه المعمارية من دون ذكر الدولة',
}), 125);
}

catalog.version = 4;
await fs.writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
console.log('✓ اكتملت إعادة بناء كتالوج الصور القابل للعب');
