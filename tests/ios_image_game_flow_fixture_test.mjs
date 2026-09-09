import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = `file://${path.join(root, 'www/index.html')}`;
const fixtures = {
  avif: fs.readFileSync(
    path.join(root, 'server-assets/question-images/v2/flagx-q235.avif'),
  ).toString('base64'),
  webp: fs.readFileSync(
    path.join(root, 'server-assets/question-images/v2/spacex-q13176.webp'),
  ).toString('base64'),
};

function installImageUITestBridge(encoded) {
  Object.defineProperty(window, '__FATINAH_GAME_FLOW_UI_TEST__', { value: true });
  Object.defineProperty(window, '__FATINAH_IMAGE_FLOW_UI_TEST__', { value: true });
  Object.defineProperty(window, '__FATINAH_IMAGE_FLOW_UI_TEST_ASSETS__', {
    value: Object.freeze({
      'image/avif': encoded.avif,
      'image/webp': encoded.webp,
    }),
    writable: false,
    configurable: false,
  });
  const ok = () => Promise.resolve({});
  window.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      Preferences: { get: () => Promise.resolve({ value: null }), set: ok, remove: ok },
      SplashScreen: { hide: ok },
      KeepAwake: { keepAwake: ok, allowSleep: ok },
    },
  };
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 402, height: 874 } });
  const pageErrors = [];
  const remoteRequests = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(installImageUITestBridge, fixtures);
  await page.route('**/*', route => {
    const requestUrl = route.request().url();
    if (requestUrl.startsWith('file://')) return route.continue();
    remoteRequests.push(requestUrl);
    return route.abort();
  });
  await page.goto(url);
  try {
    await page.locator('body[data-game-flow-ui-test="ready"]').waitFor({ timeout: 15_000 });
  } catch (error) {
    const marker = await page.locator('#ui-test-start-error').textContent().catch(() => null);
    const fixtureDiagnostics = await page.evaluate(() => {
      const fixture = defaultGameFlowUITestFixture({ image: true });
      return Object.values(fixture.round.questions).flat().map(question => {
        try {
          window.FatinahImageAssets.validateQuestion(question);
          return { id: question.id, valid: true };
        } catch (validationError) {
          return { id: question.id, valid: false, error: validationError.message };
        }
      }).filter(result => !result.valid).slice(0, 3);
    }).catch(diagnosticError => [{ error: diagnosticError.message }]);
    throw new Error(`Image UI fixture did not start: ${marker || pageErrors.join('; ') || error.message}; diagnostics=${JSON.stringify(fixtureDiagnostics)}`);
  }
  await page.locator('#q-wrap.show').waitFor({ timeout: 5_000 });
  await page.locator('#q-image[src]').waitFor({ state: 'visible', timeout: 5_000 });

  assert.equal(await page.locator('#q-options .q-option').count(), 4);
  assert.ok(await page.locator('#q-image').evaluate(image => image.naturalWidth > 0));
  assert.equal(await page.locator('#q-image-fallback:not([hidden])').count(), 0);
  assert.equal(remoteRequests.filter(request => request.includes('/question-images/')).length, 0,
    'The native image UI fixture must not access production image hosting');
  assert.deepEqual(pageErrors, []);
  console.log('✓ image UI-test flow opens a verified image question fully offline');
} finally {
  await browser.close();
}
