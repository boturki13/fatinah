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
      FatinahDeviceIntegrity: { generateDeviceCheckToken: () => Promise.resolve({ token: 'device-check-test-token' }) },
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
    if (requestUrl.includes('/api/v2/subscription/status')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"active":true}' });
    }
    if (requestUrl.includes('/api/v2/revenuecat/identity')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    if (requestUrl.includes('/api/v2/questions/seen')) {
      const body = route.request().method() === 'GET' ? '{"items":[]}' : '{"ok":true}';
      return route.fulfill({ status: 200, contentType: 'application/json', body });
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
  await page.locator('#s-board.active').waitFor({ state: 'visible', timeout: 12000 });

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
  const questionScreen = await page.locator('#q-wrap').evaluate(element => {
    const wrap = element.getBoundingClientRect();
    const sheet = element.querySelector('.q-sheet').getBoundingClientRect();
    const question = element.querySelector('#q-text');
    const answer = element.querySelector('#answer-box');
    return {
      wrap: { width: Math.round(wrap.width), height: Math.round(wrap.height) },
      sheet: { width: Math.round(sheet.width), height: Math.round(sheet.height) },
      questionFont: Number.parseFloat(getComputedStyle(question).fontSize),
      questionLengthClass: question.classList.contains('text-very-long')
        ? 'very-long'
        : question.classList.contains('text-long') ? 'long' : 'normal',
      questionFitsWidth: question.scrollWidth <= question.clientWidth + 1,
      questionFullyRendered: question.scrollHeight <= question.clientHeight + 1,
      answerDisplay: getComputedStyle(answer).display,
      modal: element.getAttribute('aria-modal'),
      hidden: element.getAttribute('aria-hidden'),
    };
  });
  assert.deepEqual(questionScreen.wrap, { width: 390, height: 844 }, 'صفحة السؤال تغطي شاشة iPhone كاملة');
  assert.deepEqual(questionScreen.sheet, { width: 390, height: 844 }, 'محتوى السؤال كامل الشاشة وليس ورقة سفلية');
  const minimumQuestionFont = questionScreen.questionLengthClass === 'very-long'
    ? 19
    : questionScreen.questionLengthClass === 'long' ? 23 : 28;
  assert.ok(questionScreen.questionFont >= minimumQuestionFont, 'نص السؤال واضح ومتناسب مع طوله');
  assert.ok(questionScreen.questionFitsWidth && questionScreen.questionFullyRendered, 'نص السؤال كامل وغير مقصوص');
  assert.equal(questionScreen.answerDisplay, 'none', 'الإجابة مخفية عند فتح السؤال');
  assert.equal(questionScreen.modal, 'true');
  assert.equal(questionScreen.hidden, 'false');
  await page.getByRole('button', { name: '👁️ اكشف الإجابة' }).click();
  const revealed = await page.locator('#q-wrap').evaluate(element => ({
    answerVisible: getComputedStyle(element.querySelector('#answer-box')).display !== 'none',
    answerFont: Number.parseFloat(getComputedStyle(element.querySelector('#ans-text')).fontSize),
    answerLengthClass: element.querySelector('#ans-text').classList.contains('text-very-long')
      ? 'very-long'
      : element.querySelector('#ans-text').classList.contains('text-long') ? 'long' : 'normal',
    answerFitsWidth: element.querySelector('#ans-text').scrollWidth <= element.querySelector('#ans-text').clientWidth + 1,
    answerFullyRendered: element.querySelector('#ans-text').scrollHeight <= element.querySelector('#ans-text').clientHeight + 1,
    questionVisible: getComputedStyle(element.querySelector('#q-text')).visibility !== 'hidden',
    answerHidden: element.querySelector('#answer-box').getAttribute('aria-hidden'),
  }));
  assert.equal(revealed.answerVisible, true, 'تظهر الإجابة بعد الضغط على زر الكشف');
  const minimumAnswerFont = revealed.answerLengthClass === 'very-long'
    ? 18
    : revealed.answerLengthClass === 'long' ? 22 : 28;
  assert.ok(revealed.answerFont >= minimumAnswerFont, 'نص الإجابة واضح ومتناسب مع طوله');
  assert.ok(revealed.answerFitsWidth && revealed.answerFullyRendered, 'نص الإجابة كامل وداخل خانته');
  assert.equal(revealed.questionVisible, true, 'يبقى السؤال ظاهراً مع الإجابة بعد الكشف');
  assert.equal(revealed.answerHidden, 'false');
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
