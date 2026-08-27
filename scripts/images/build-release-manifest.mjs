#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadImageQuestionBank } from '../questions/lib.mjs';
import { familySafetyDecision } from './family-safety-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'server-assets', 'question-images', 'release-manifest.json');
const excludedCategories = new Set(['منو هاللاعب؟']);
const published = process.argv.includes('--published');
const bank = loadImageQuestionBank();
const items = [];

for (const [category, questions] of Object.entries(bank)) {
  if (excludedCategories.has(category)) continue;
  if (questions.length !== 125) throw new Error(`${category}: العدد ${questions.length}/125.`);
  for (const question of questions) {
    const safety = familySafetyDecision(category, question);
    if (!safety.allowed) throw new Error(`${question.id}: مرفوض حسب سياسة المحتوى العائلي (${safety.reason}).`);
    if (question.review?.status !== 'approved') throw new Error(`${question.id}: السؤال غير معتمد.`);
    if (!question.image?.alt || !question.image?.factSource?.url || !question.image?.rights?.sourcePage) {
      throw new Error(`${question.id}: بيانات الوصول أو المصدر أو الحقوق ناقصة.`);
    }
    for (const asset of question.image.assets || []) {
      const url = new URL(asset.url);
      if (url.protocol !== 'https:' || url.hostname !== 'ata20.com' ||
          !url.pathname.startsWith('/assets/question-images/')) {
        throw new Error(`${question.id}: رابط أصل غير موثوق.`);
      }
      const relativePath = url.pathname.slice('/assets/question-images/'.length);
      const localPath = path.join(root, 'server-assets', 'question-images', relativePath);
      const bytes = fs.readFileSync(localPath);
      if (bytes.byteLength !== asset.bytes) throw new Error(`${question.id}: حجم ${relativePath} غير مطابق.`);
      const sha256 = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== asset.sha256) throw new Error(`${question.id}: بصمة ${relativePath} غير مطابقة.`);
      items.push({
        questionId: question.id,
        category,
        relativePath,
        url: asset.url,
        mimeType: asset.mimeType,
        bytes: asset.bytes,
        sha256: asset.sha256,
      });
    }
  }
}

const categories = [...new Set(items.map(item => item.category))].sort((a, b) => a.localeCompare(b, 'ar'));
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  status: published ? 'published' : 'ready_for_upload_not_published',
  ...(published ? { publishedAt: new Date().toISOString() } : {}),
  activationRule: 'لا تُفعّل الفئة في التطبيق قبل رفع كل الملفات والتحقق من استجابة HTTPS والبصمة.',
  excludedCategories: [...excludedCategories],
  categoryCount: categories.length,
  questionCount: categories.reduce((sum, category) => sum + bank[category].length, 0),
  assetCount: items.length,
  totalBytes: items.reduce((sum, item) => sum + item.bytes, 0),
  categories,
  items: items.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
};

if (!process.argv.includes('--write')) {
  console.log(JSON.stringify({ ...manifest, items: undefined }, null, 2));
  process.exit(0);
}
const temporary = `${output}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
fs.renameSync(temporary, output);
console.log(JSON.stringify({ output, categoryCount: manifest.categoryCount,
  questionCount: manifest.questionCount, assetCount: manifest.assetCount,
  totalBytes: manifest.totalBytes }, null, 2));
