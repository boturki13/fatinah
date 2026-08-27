#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT,
  loadReligiousSourceRegistry,
  parseTanzilCorpus,
  sha256,
} from './religious-source-lib.mjs';

const registry = loadReligiousSourceRegistry();
const source = registry.primarySources.find(item => item.id === 'tanzil-quran-uthmani-1.1');
if (!source || source.productionUseStatus !== 'allowed_with_attribution' || source.immutable !== true) {
  throw new Error('إعداد مصدر Tanzil غير صالح أو لا يفرض النص غير القابل للتعديل.');
}
const response = await fetch(source.downloadUrl, {
  headers: { 'User-Agent': 'FatinahReligiousSourceImporter/1.0 (ata20.com)' },
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`فشل تنزيل Tanzil: HTTP ${response.status}.`);
const raw = Buffer.from(await response.arrayBuffer());
if (raw.byteLength > 2_000_000) throw new Error('ملف Tanzil أكبر من الحد الآمن 2MB.');
const text = raw.toString('utf8');
if (!text.includes('Tanzil Quran Text (Uthmani, Version 1.1)') ||
    !text.includes('License: Creative Commons Attribution 3.0') ||
    !text.includes('CHANGING IT IS NOT ALLOWED')) {
  throw new Error('تنزيل Tanzil لا يحتوي إشعار الإصدار والترخيص المطلوبين.');
}
const verses = parseTanzilCorpus(text, source.expectedVerseCount);
const metadataResponse = await fetch(source.metadataUrl, {
  headers: { 'User-Agent': 'FatinahReligiousSourceImporter/1.0 (ata20.com)' },
  signal: AbortSignal.timeout(30_000),
});
if (!metadataResponse.ok) throw new Error(`فشل تنزيل بيانات Tanzil: HTTP ${metadataResponse.status}.`);
const metadataRaw = Buffer.from(await metadataResponse.arrayBuffer());
if (metadataRaw.byteLength > 500_000 ||
    [...metadataRaw.toString('utf8').matchAll(/<sura\s+index="(\d+)"/g)].length !== 114) {
  throw new Error('بيانات أسماء السور من Tanzil ناقصة أو أكبر من الحد الآمن.');
}
const corpusPath = path.join(ROOT, source.localCorpusPath);
const manifestPath = path.join(ROOT, source.localManifestPath);
const metadataPath = path.join(ROOT, source.localMetadataPath);
fs.mkdirSync(path.dirname(corpusPath), { recursive: true });
const temporaryCorpus = `${corpusPath}.${process.pid}.tmp`;
fs.writeFileSync(temporaryCorpus, raw, { mode: 0o600 });
fs.renameSync(temporaryCorpus, corpusPath);
const temporaryMetadata = `${metadataPath}.${process.pid}.tmp`;
fs.writeFileSync(temporaryMetadata, metadataRaw, { mode: 0o600 });
fs.renameSync(temporaryMetadata, metadataPath);
const manifest = {
  schemaVersion: 1,
  sourceId: source.id,
  sourceVersion: source.version,
  downloadUrl: source.downloadUrl,
  landingUrl: source.landingUrl,
  license: source.license,
  licenseUrl: source.licenseUrl,
  immutable: true,
  retrievedAt: new Date().toISOString(),
  byteLength: raw.byteLength,
  verseCount: verses.size,
  sha256: sha256(raw),
  metadataSha256: sha256(metadataRaw),
};
const temporaryManifest = `${manifestPath}.${process.pid}.tmp`;
fs.writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporaryManifest, manifestPath);
console.log(JSON.stringify({
  corpusPath, metadataPath, manifestPath, verseCount: verses.size, sha256: manifest.sha256,
}, null, 2));
