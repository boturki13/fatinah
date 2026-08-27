#!/usr/bin/env node
import crypto from 'node:crypto';
import path from 'node:path';
import {
  CONTENT_DIR,
  familyContentViolations,
  loadPolicy,
  writeJsonAtomic,
} from './lib.mjs';

const write = process.argv.includes('--write');
const retrievedAt = new Date().toISOString();
const policy = loadPolicy();
const base = 'الأمثال العامية- مشروحة ومرتبة على الحرف الأول من المثل (الطبعة الثانية)';
const pages = ['حرف الألف', 'حرف الباء', 'حرف التاء', 'حرف الثاء', 'حرف الجيم'];
const decode = value => String(value)
  .replace(/<[^>]+>/g, ' ')
  .replace(/&#160;|&nbsp;/g, ' ')
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/&#8203;/g, '')
  .replace(/\s+/g, ' ')
  .trim();
const records = [];

for (const chapter of pages) {
  const page = `${base}/${chapter}`;
  const api = new URL('https://ar.wikisource.org/w/api.php');
  for (const [key, value] of Object.entries({ action: 'parse', format: 'json', prop: 'text', page })) {
    api.searchParams.set(key, value);
  }
  const response = await fetch(api, {
    headers: { 'User-Agent': 'FatinahQuestionBank/1.3 (https://ata20.com)' },
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`Wikisource HTTP ${response.status}`);
  const html = (await response.json()).parse?.text?.['*'] || '';
  const pattern = /<b>([^]*?)<\/b>[^]*?<dl><dd>([^]*?)<\/dd>/g;
  let match;
  while ((match = pattern.exec(html))) {
    const proverb = decode(match[1]).replace(/^[«»“”"']+|[«»“”"']+$/g, '').trim();
    const meaning = decode(match[2]);
    if (proverb.split(/\s+/).length < 4 || meaning.length < 20) continue;
    const canonical = { proverb, meaning: meaning.slice(0, 360) };
    const proverbFingerprint = crypto.createHash('sha1').update(proverb).digest('hex').slice(0, 10);
    const sourceRecord = {
      sourceRecordId: `wikisource-proverb-${records.length + 1}-${proverbFingerprint}`,
      ...canonical,
      sourceUrl: `https://ar.wikisource.org/wiki/${encodeURIComponent(page)}`,
      sourcePublisher: 'ويكي مصدر — كتاب أحمد تيمور',
      retrievedAt,
      sourcePayloadHash: crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
    };
    if (familyContentViolations({ category: 'أمثال', ...sourceRecord }, policy).length) continue;
    records.push(sourceRecord);
    if (records.length >= 180) break;
  }
  if (records.length >= 180) break;
}
if (records.length < 150) throw new Error(`الأمثال المستخرجة غير كافية: ${records.length}`);
const document = {
  schemaVersion: 1,
  sourceProfile: 'curated_trusted_records_v1',
  pages,
  retrievedAt,
  records,
};
const output = path.join(CONTENT_DIR, 'structured-sources', 'wikisource-proverbs.json');
if (write) writeJsonAtomic(output, document);
console.log(JSON.stringify({
  mode: write ? 'write' : 'dry-run',
  records: records.length,
  output: write ? path.relative(process.cwd(), output) : null,
  aiCalls: 0,
  estimatedAiCostUsd: 0,
}, null, 2));
