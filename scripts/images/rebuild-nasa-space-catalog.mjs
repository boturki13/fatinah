#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalogPath = path.join(root, 'content/image-questions/curated-commons.json');
const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'));
const category = catalog.categories.find(item => item.name === 'شنو بالفضاء؟');
if (!category) throw new Error('فئة شنو بالفضاء؟ غير موجودة');

const specs = [
  { query: 'nebula', answer: 'سديم', count: 45 },
  { query: 'galaxy', answer: 'مجرة', count: 45 },
  { query: 'planet', answer: 'كوكب', count: 45 },
  { query: 'moon', answer: 'قمر طبيعي', count: 45 },
  { query: 'comet', answer: 'مذنب', count: 45 },
  { query: 'star', answer: 'نجم', count: 3 },
];
const groups = [];
const used = new Set();
for (const spec of specs) {
  const url = new URL('https://images-api.nasa.gov/search');
  url.searchParams.set('q', spec.query);
  url.searchParams.set('media_type', 'image');
  url.searchParams.set('page_size', '100');
  const response = await fetch(url, {
    headers: { 'User-Agent': 'FatinahImageCatalog/1.3 (https://ata20.com)' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`NASA ${spec.query}: HTTP ${response.status}`);
  const payload = await response.json();
  const items = [];
  for (const result of payload.collection?.items || []) {
    const data = result.data?.[0];
    const nasaId = String(data?.nasa_id || '').trim();
    const searchable = `${data?.title || ''} ${data?.description || ''}`;
    const nonQuestionImage = /poster|diagram|graphic|illustration|artist|concept|event|workshop|lecture|presentation|crew|team|operations|infrastructure|transportation|habitation|multidisciplinary|conference|auditorium|classroom/i.test(searchable);
    const nonScienceSeries = /^(GRC|NHQ)-/i.test(nasaId);
    if (!nasaId || used.has(nasaId) || nonQuestionImage || nonScienceSeries || !result.links?.some(link => link.render === 'image')) continue;
    used.add(nasaId);
    items.push({
      id: `space-nasa-${nasaId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
      provider: 'nasa',
      nasaId,
      answer: spec.answer,
      prompt: 'شنو نوع الجرم الفضائي الظاهر بالصورة؟',
      alt: `صورة فضائية من NASA تُظهر ${spec.answer === 'نجم' ? 'جرماً مضيئاً' : 'ملامح الجرم أو الظاهرة'} من دون ذكر اسم الإجابة`,
      factUrl: `https://images.nasa.gov/details/${encodeURIComponent(nasaId)}`,
    });
    if (items.length >= spec.count) break;
  }
  if (items.length < spec.count) throw new Error(`NASA ${spec.query}: ${items.length}/${spec.count}`);
  groups.push(items);
}

const additions = [];
while (groups.some(group => group.length)) {
  for (const group of groups) if (group.length) additions.push(group.shift());
}
if (additions.length !== 228) throw new Error(`عدد صور NASA ${additions.length}/228`);
additions.forEach((item, index) => { item.difficulty = Math.min(6, 1 + Math.floor(index / 19)); });
category.target = 125;
category.items = [...category.items.slice(0, 12), ...additions];
catalog.version = 5;
await fs.writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
console.log('✓ فئة الفضاء: 12 صورة أساسية + 113 مطلوبة و115 احتياطية من NASA');
