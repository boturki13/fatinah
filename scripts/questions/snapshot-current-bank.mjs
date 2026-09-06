#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const sourcePath = path.join(ROOT, 'server-assets/question-bank/v1/bank.json');
const outputDirectory = path.join(ROOT, 'server-assets/question-bank/archive');
const scopeArgument = process.argv.find(argument => argument.startsWith('--scope='));
const scope = String(scopeArgument?.slice('--scope='.length) || 'pre-release-baseline')
  .replace(/[^a-z0-9-]/giu, '-').replace(/-+/gu, '-').replace(/^-|-$/gu, '');
const shouldWrite = process.argv.includes('--write');

const bytes = fs.readFileSync(sourcePath);
const document = JSON.parse(bytes.toString('utf8'));
if (document?.schemaVersion !== 1 || !document?.bankVersion
    || !Number.isInteger(document?.questionCount) || !document?.categories) {
  throw new Error('بنك الخادم الحالي غير صالح لأخذ لقطة مرجعية.');
}
const fileSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
const version = String(document.bankVersion).replace(/[^a-z0-9-]/giu, '-');
const fileName = `${scope}-${version}-${fileSha256.slice(0, 16)}-${document.questionCount}.json`;
const outputPath = path.join(outputDirectory, fileName);
if (!path.resolve(outputPath).startsWith(`${path.resolve(outputDirectory)}${path.sep}`)) {
  throw new Error('مسار لقطة البنك غير مسموح.');
}

if (fs.existsSync(outputPath)) {
  const existing = fs.readFileSync(outputPath);
  if (!existing.equals(bytes)) throw new Error('تعارض في لقطة البنك المرجعية.');
} else if (shouldWrite) {
  fs.writeFileSync(outputPath, bytes);
}

console.log(JSON.stringify({
  mode: shouldWrite ? 'write' : 'dry-run',
  source: path.relative(ROOT, sourcePath),
  output: path.relative(ROOT, outputPath),
  fileSha256,
  bankVersion: document.bankVersion,
  questionCount: document.questionCount,
}, null, 2));
