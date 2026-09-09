import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(
  root, 'server-assets/question-images/v1/fire-extinguisher.avif',
);
const fixtureBytes = fs.readFileSync(fixturePath);
const appSource = fs.readFileSync(path.join(root, 'www/app.js'), 'utf8');
const nativeBridgeSource = fs.readFileSync(
  path.join(root, 'ios/App/App/RevenueCatKeyStorePlugin.swift'), 'utf8');
const fixtureUrl = 'https://ata20.com/assets/question-images/v1/fire-extinguisher.avif';
const asset = {
  url: fixtureUrl,
  mimeType: 'image/avif',
  bytes: fixtureBytes.byteLength,
  sha256: crypto.createHash('sha256').update(fixtureBytes).digest('hex'),
};
const context = {
  window: {
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    crypto: crypto.webcrypto,
  },
  URL,
  Response,
  Headers,
  Blob,
  Uint8Array,
};
context.globalThis = context.window;
vm.runInNewContext(
  fs.readFileSync(path.join(root, 'www/image-assets.js'), 'utf8'),
  context,
);

const service = context.window.FatinahImageAssets;
let networkCalls = 0;
context.window.__FATINAH_IMAGE_FLOW_UI_TEST__ = true;
context.window.__FATINAH_IMAGE_FLOW_UI_TEST_ASSETS__ = Object.freeze({
  'image/avif': fixtureBytes.toString('base64'),
});
let response = await service.verifiedResponse(asset, async () => {
  networkCalls += 1;
  throw new Error('network must not be used by the iOS image fixture');
});
assert.equal(networkCalls, 0, 'XCUITest image fixture must be fully offline');
assert.equal(response.headers.get('X-Fatinah-SHA256'), asset.sha256);
assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixtureBytes);

context.window.__FATINAH_IMAGE_FLOW_UI_TEST_ASSETS__ = {
  'image/avif': Buffer.from('tampered fixture').toString('base64'),
};
await assert.rejects(
  service.verifiedResponse(asset, async () => {
    networkCalls += 1;
    throw new Error('network must not mask a corrupt fixture');
  }),
  /size_mismatch|hash_mismatch/,
  'The DEBUG fixture must not bypass production integrity verification',
);
assert.equal(networkCalls, 0);

delete context.window.__FATINAH_IMAGE_FLOW_UI_TEST__;
delete context.window.__FATINAH_IMAGE_FLOW_UI_TEST_ASSETS__;
response = await service.verifiedResponse(asset, async requestUrl => {
  networkCalls += 1;
  assert.equal(requestUrl, fixtureUrl);
  return new Response(fixtureBytes, {
    status: 200,
    headers: {
      'Content-Type': asset.mimeType,
      'Content-Length': String(fixtureBytes.byteLength),
    },
  });
});
assert.equal(networkCalls, 1, 'Production path must still use the trusted HTTPS asset');
assert.equal(response.headers.get('X-Fatinah-SHA256'), asset.sha256);
assert.match(appSource,
  /question-images\/v1\/ui-test-\$\{serial\}\.avif/,
  'Every image UI-test question must use an asset stem matching its unique ID');
assert.match(nativeBridgeSource, /'image\/avif': '\\\(avifFixture\)'/,
  'The DEBUG bridge must provide the deterministic AVIF fixture by MIME type');

console.log('✓ iOS image UI-test fixture is offline, immutable, and integrity-checked');
