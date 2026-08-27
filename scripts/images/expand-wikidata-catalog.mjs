#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalogPath = path.join(root, 'content/image-questions/curated-commons.json');
const structured = path.join(root, 'content/questions/structured-sources');
const endpoint = 'https://query.wikidata.org/sparql';
const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
const excludedQuestionContent = /إسرائيل|اسرائيل|إسرائيلي|اسرائيلي|تل أبيب|تل ابيب/i;
const existingIds = new Set(catalog.categories.flatMap(category => category.items.map(item => item.id)));
const readJson = async name => JSON.parse(await fs.readFile(path.join(structured, name), 'utf8'));
const entityBatch = (await readJson('wikidata-entity-batch.json')).records;
const culturalBatch = (await readJson('wikidata-cultural-batch.json')).records;
const countries = (await readJson('world-bank-countries.json')).records;
const animals = (await readJson('inaturalist-animal-taxa.json')).records;
const unescoSites = (await readJson('unesco-archaeological-sites.json')).records;

async function claimRows(entries, property) {
  const rows = [];
  const unique = [...new Map(entries.filter(entry => /^Q\d+$/.test(entry.itemId)).map(entry => [entry.itemId, entry])).values()];
  for (let index = 0; index < unique.length; index += 25) {
    const batch = unique.slice(index, index + 25);
    const url = new URL('https://www.wikidata.org/w/api.php');
    for (const [key, value] of Object.entries({ action: 'wbgetentities', format: 'json', props: 'claims', ids: batch.map(item => item.itemId).join('|') })) url.searchParams.set(key, value);
    let payload; let lastError;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        const response = await fetch(url, { headers: { 'User-Agent': 'FatinahImageCatalog/1.3 (https://ata20.com)' }, signal: AbortSignal.timeout(45_000) });
        if (!response.ok) throw new Error(`Wikidata entities HTTP ${response.status}`);
        payload = await response.json(); break;
      } catch (error) { lastError = error; if (attempt < 4) await new Promise(resolve => setTimeout(resolve, attempt * 1_000)); }
    }
    if (!payload) throw lastError;
    const entities = payload.entities || {};
    for (const entry of batch) {
      const file = entities[entry.itemId]?.claims?.[property]?.[0]?.mainsnak?.datavalue?.value;
      if (file) rows.push({ itemId: entry.itemId, itemLabel: entry.answer, answerLabel: entry.answer, file });
    }
  }
  return rows;
}

const localGeneral = [...entityBatch, ...culturalBatch].map(record => ({ itemId: record.itemId, answer: record.itemLabel }));
const localObjects = culturalBatch.filter(record => record.category === 'اختراعات واكتشافات' || record.category === 'أفلام عربية')
  .map(record => ({ itemId: record.itemId, answer: record.itemLabel }));
const localFlags = countries.map(record => ({ itemId: String(record.translationIndexUrl || '').split('/').pop(), answer: record.countryAr }));
const localAnimals = animals.map(record => ({ itemId: String(record.translationCrossCheck?.entityUrl || '').split('/').pop(), answer: record.commonNameAr }));
const localLandmarks = unescoSites.map(record => ({ itemId: record.siteQid, answer: record.countryNameAr }));
const localTreasures = [...culturalBatch, ...entityBatch].map(record => ({ itemId: record.itemId, answer: record.itemLabel }));
const specs = [
  { name: 'تعرف على الصورة', icon: '🖼️', group: 'صور ومعرفة', target: 113, prefix: 'general', local: () => claimRows(localGeneral, 'P18') },
  { name: 'أعلام منو؟', icon: '🚩', group: 'تاريخ وجغرافيا', target: 125, prefix: 'flagx', local: () => claimRows(localFlags, 'P41') },
  { name: 'شنو هالحيوان؟', icon: '🦁', group: 'علوم وطبيعة', target: 125, prefix: 'animalx', local: () => claimRows(localAnimals, 'P18') },
  { name: 'شنو هالشي؟', icon: '🔭', group: 'معرفة وعلوم', target: 125, prefix: 'objectx', local: () => claimRows(localObjects, 'P18') },
  { name: 'وين هالمعلم؟', icon: '📍', group: 'تاريخ وجغرافيا', target: 125, prefix: 'landmarkx', reserve: 8, uniqueAnswers: false, answer: 'answer', wheres: ['wd:Q41176','wd:Q4989906','wd:Q570116','wd:Q811979','wd:Q839954'].map(type => `?item wdt:P31 ${type}; wdt:P17 ?answer; wdt:P18 ?image.`) },
  { name: 'شنو بالفضاء؟', icon: '🪐', group: 'علوم وطبيعة', target: 125, prefix: 'spacex', answer: 'item', entityLabels: true, wheres: ['wd:Q634','wd:Q523','wd:Q318','wd:Q4235','wd:Q3559','wd:Q2537'].map(type => `?item wdt:P31 ${type}; wdt:P18 ?image.`) },
  { name: 'كنوز الحضارات', icon: '🏺', group: 'تاريخ وجغرافيا', target: 125, prefix: 'treasurex', local: () => claimRows(localTreasures, 'P18') },
  { name: 'منو هاللاعب؟', icon: '⚽', group: 'رياضة', target: 125, prefix: 'playerx', answer: 'item', entityLabels: true, where: '?item wdt:P106 wd:Q937857; wdt:P18 ?image.' },
];

async function addArabicLabels(rows) {
  const result = [];
  for (let index = 0; index < rows.length; index += 50) {
    const batch = rows.slice(index, index + 50);
    const url = new URL('https://www.wikidata.org/w/api.php');
    for (const [key, value] of Object.entries({ action: 'wbgetentities', format: 'json', props: 'labels', languages: 'ar', ids: batch.map(item => item.itemId).join('|') })) url.searchParams.set(key, value);
    const response = await fetch(url, { headers: { 'User-Agent': 'FatinahImageCatalog/1.3 (https://ata20.com)' }, signal: AbortSignal.timeout(45_000) });
    if (!response.ok) throw new Error(`Wikidata labels HTTP ${response.status}`);
    const entities = (await response.json()).entities || {};
    for (const row of batch) { const label = entities[row.itemId]?.labels?.ar?.value; if (label) result.push({ ...row, answerLabel: label }); }
  }
  return result;
}

async function sparqlRows(spec) {
  const collected = [];
  for (const where of spec.wheres || [spec.where]) {
  const answerSelect = spec.answer === 'answer' ? '?answer ?answerLabel' : '';
  const itemLabelSelect = spec.entityLabels ? '' : '?itemLabel';
  const labelBlock = spec.entityLabels ? '' : `SERVICE wikibase:label { bd:serviceParam wikibase:language "ar". ?item rdfs:label ?itemLabel.
      ${spec.answer === 'answer' ? '?answer rdfs:label ?answerLabel.' : ''} }
    FILTER(LANG(?itemLabel)="ar" ${spec.answer === 'answer' ? '&& LANG(?answerLabel)="ar"' : ''})`;
  const query = `SELECT DISTINCT ?item ${itemLabelSelect} ?image ${answerSelect} WHERE { ${where} ${labelBlock} } LIMIT ${spec.entityLabels ? 200 : spec.wheres ? 120 : 320}`;
  const url = new URL(endpoint); url.searchParams.set('format', 'json'); url.searchParams.set('query', query);
  let payload; let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/sparql-results+json', 'User-Agent': 'FatinahImageCatalog/1.3 (https://ata20.com)' }, signal: AbortSignal.timeout(90_000) });
      if (!response.ok) throw new Error(`${spec.name}: SPARQL HTTP ${response.status}`);
      payload = await response.json(); break;
    } catch (error) { lastError = error; if (attempt < 4) await new Promise(resolve => setTimeout(resolve, attempt * 1_000)); }
  }
  if (!payload) throw lastError;
  collected.push(...payload.results.bindings.map(binding => ({
    itemId: String(binding.item?.value || '').split('/').pop(),
    answerLabel: String((spec.answer === 'answer' ? binding.answerLabel : binding.itemLabel)?.value || '').trim(),
    file: decodeURIComponent(String(binding.image?.value || '').split('/Special:FilePath/').pop() || '').replace(/_/g, ' ').trim(),
  })));
  }
  return spec.entityLabels ? addArabicLabels(collected) : collected;
}

for (const spec of specs) {
  let category = catalog.categories.find(item => item.name === spec.name);
  if (!category) { category = { name: spec.name, icon: spec.icon, group: spec.group, items: [] }; catalog.categories.push(category); }
  category.target = spec.target;
  const reserve = Number(spec.reserve ?? 25);
  if (category.items.length >= spec.target + reserve) {
    console.log(`✓ ${spec.name}: ${category.items.length} مرشحاً محفوظاً لهدف ${spec.target}`);
    continue;
  }
  const usedAnswers = new Set(category.items.map(item => item.answer));
  const rows = spec.local ? await spec.local() : await sparqlRows(spec);
  for (const row of rows) {
    if (category.items.length >= spec.target + 60) break;
    if (!/^Q\d+$/.test(row.itemId) || !row.answerLabel || !row.file ||
        excludedQuestionContent.test(row.answerLabel) ||
        (spec.uniqueAnswers !== false && usedAnswers.has(row.answerLabel))) continue;
    const id = `${spec.prefix}-${row.itemId.toLowerCase()}`;
    if (existingIds.has(id)) continue;
    category.items.push({ id, difficulty: 1 + (category.items.length % 6), answer: row.answerLabel, file: row.file,
      alt: `صورة واضحة مرتبطة بعنصر من فئة ${spec.name} من دون كتابة اسم الإجابة داخل الوصف`,
      ...(spec.name === 'كنوز الحضارات' ? { prompt: 'شنو اسم هالكنز أو الأثر الظاهر بالصورة؟' } : {}),
      ...(spec.name === 'تعرف على الصورة' ? { prompt: 'شنو الشي الظاهر بالصورة؟' } : {}),
      factUrl: `https://www.wikidata.org/wiki/${row.itemId}` });
    existingIds.add(id); usedAnswers.add(row.answerLabel);
  }
  if (category.items.length < spec.target + reserve) throw new Error(`${spec.name}: المرشحون ${category.items.length}/${spec.target + reserve}`);
  console.log(`✓ ${spec.name}: ${category.items.length} مرشحاً لهدف ${spec.target}`);
  catalog.version = 3;
  await fs.writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
}
catalog.version = 3;
await fs.writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
