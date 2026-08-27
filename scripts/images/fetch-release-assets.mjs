#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = path.join(root, 'server-assets/question-images/release-manifest.json');
const verifyOnly = process.argv.includes('--verify-only');
const assetArgument = process.argv.find(argument => argument.startsWith('--asset='));
const requestedAsset = assetArgument?.slice('--asset='.length);
const concurrencyArgument = process.argv.find(argument => argument.startsWith('--concurrency='));
const concurrency = Math.max(1, Math.min(16, Number(concurrencyArgument?.split('=')[1] || 8)));
const allowedHosts = new Set(['ata20.com']);
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

if (!Array.isArray(manifest.items) || manifest.items.length === 0) {
  throw new Error('release_manifest_empty');
}

const items = requestedAsset
  ? manifest.items.filter(item => item.relativePath === requestedAsset)
  : manifest.items;
if (requestedAsset && items.length !== 1) {
  throw new Error(`release_asset_not_unique:${requestedAsset}:${items.length}`);
}

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function destinationFor(item) {
  if (!item.relativePath || path.isAbsolute(item.relativePath) || item.relativePath.includes('..')) {
    throw new Error(`unsafe_relative_path:${item.relativePath}`);
  }
  const url = new URL(item.url);
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)) {
    throw new Error(`untrusted_asset_url:${item.url}`);
  }
  return path.join(root, 'server-assets/question-images', item.relativePath);
}

async function validLocalAsset(item, destination) {
  try {
    const bytes = await fs.readFile(destination);
    return bytes.byteLength === item.bytes && digest(bytes) === item.sha256;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function fetchAndVerify(item, destination) {
  const response = await fetch(item.url, { redirect: 'error' });
  if (!response.ok) throw new Error(`asset_fetch_failed:${response.status}:${item.relativePath}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength !== item.bytes) throw new Error(`asset_size_mismatch:${item.relativePath}`);
  if (digest(bytes) !== item.sha256) throw new Error(`asset_hash_mismatch:${item.relativePath}`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.writeFile(temporary, bytes, { mode: 0o644 });
  await fs.rename(temporary, destination);
}

let cursor = 0;
let verified = 0;
let downloaded = 0;
const missing = [];

async function worker() {
  while (cursor < items.length) {
    const item = items[cursor++];
    const destination = destinationFor(item);
    if (await validLocalAsset(item, destination)) {
      verified++;
      continue;
    }
    if (verifyOnly) {
      missing.push(item.relativePath);
      continue;
    }
    await fetchAndVerify(item, destination);
    downloaded++;
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

if (missing.length) {
  console.error(JSON.stringify({ ready: false, missingOrInvalid: missing.length, sample: missing.slice(0, 20) }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ready: true,
  manifestStatus: manifest.status,
  assetCount: manifest.items.length,
  processedAssetCount: items.length,
  verified,
  downloaded,
}, null, 2));
