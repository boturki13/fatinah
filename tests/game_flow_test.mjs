import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = `file://${path.join(root, 'www/index.html')}`;

function installNativeTestHarness() {
  localStorage.setItem('fatinah_authUid', JSON.stringify('e2e-player'));
  localStorage.setItem('fatinah_onbDone', JSON.stringify(true));
  const ok = () => Promise.resolve({});
  window.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      FirebaseAuthentication: {
        getCurrentUser: () => Promise.resolve({ user: { uid: 'e2e-player', isAnonymous: true } }),
        getIdToken: () => Promise.resolve({ token: 'e2e-token' }),
      },
      RevenueCatKeyStore: { get: () => Promise.resolve({ value: 'appl_TEST' }), set: ok, clear: ok },
      Purchases: { configure: ok, setAttributes: ok, setEmail: ok, setDisplayName: ok },
      FirebaseCrashlytics: { setEnabled: ok, recordException: ok, setUserId: ok },
      SplashScreen: { hide: ok }, Preferences: { remove: ok }, KeepAwake: { keepAwake: ok, allowSleep: ok },
    },
  };
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(installNativeTestHarness);
  await page.route('**/*', route => {
    const requestUrl = route.request().url();
    if (requestUrl.startsWith('file://')) return route.continue();
    if (requestUrl.includes('/api/subscription/status')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"active":true}' });
    }
    if (requestUrl.includes('/api/revenuecat/identity')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    return route.abort();
  });
  await page.goto(url);
  await page.getByRole('button', { name: '🎯 يلا نلعب' }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '🎯 يلا نلعب' }).click();
  await page.locator('#seg-catcount button[data-n="2"]').click();
  await page.locator('#tn-0').fill('الفريق الأول');
  await page.locator('#tn-1').fill('الفريق الثاني');
  await page.getByRole('button', { name: 'الخطوة الياية: اختار الفئات' }).click();
  await page.locator('.cat-pick').first().click();
  await page.locator('.cat-pick').nth(1).click();
  await page.getByRole('button', { name: 'يلا نبدأ!' }).click();

  assert.equal(await page.locator('#board .cell').count(), 12, 'فئتان × ستة أسئلة');
  const unnamedBoardControls = await page.locator('#s-board button').evaluateAll(elements =>
    elements.filter(element => {
      const rect = element.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(element).display !== 'none';
      const name = element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent.trim();
      return visible && !name;
    }).length
  );
  assert.equal(unnamedBoardControls, 0, 'كل عناصر اللعب الظاهرة لها اسم VoiceOver');
  const seenQuestions = new Set();
  await page.locator('#board .cell:not(.used)').first().click();
  seenQuestions.add((await page.locator('#q-text').textContent()).trim());
  await page.getByRole('button', { name: '👁️ اكشف الإجابة' }).click();
  await page.getByRole('button', { name: /✅ الفريق الأول/ }).click();
  assert.equal((await page.locator('.team-chip .cs').first().textContent()).trim(), '100');

  for (let remaining = 11; remaining > 0; remaining--) {
    await page.locator('#board .cell:not(.used)').first().click();
    const questionText = (await page.locator('#q-text').textContent()).trim();
    assert.ok(!seenQuestions.has(questionText), `تكرر السؤال داخل الجولة: ${questionText}`);
    seenQuestions.add(questionText);
    await page.getByRole('button', { name: '👁️ اكشف الإجابة' }).click();
    await page.getByRole('button', { name: '❌ محد جاوب صح' }).click();
  }
  await page.locator('#s-result.active').waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(seenQuestions.size, 12, 'يجب أن تكون أسئلة الجولة الاثنا عشر فريدة.');
  assert.match(await page.locator('#winner-line').textContent(), /الفريق الأول/);
  console.log('✓ مسار اللعب الكامل: الفرق، الفئات، 12 سؤالاً، النقاط والنتيجة');
} finally {
  await browser.close();
}
