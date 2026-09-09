import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = `file://${path.join(root, 'www/index.html')}`;
// Round restoration performs full app bootstrap and can exceed eight seconds on
// throttled hosted runners. Assertions still require the exact restored state.
const RESTORE_UI_TIMEOUT_MS = 20000;

function installNativeTestHarness() {
  localStorage.setItem('fatinah_authUid', JSON.stringify('choice-flow-player'));
  localStorage.setItem('fatinah_onbDone', JSON.stringify(true));
  const ok = () => Promise.resolve({});
  window.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      FirebaseAuthentication: {
        getCurrentUser: () => Promise.resolve({ user: { uid: 'choice-flow-player', isAnonymous: true } }),
        getIdToken: () => Promise.resolve({ token: 'choice-flow-token' }),
      },
      RevenueCatKeyStore: { get: () => Promise.resolve({ value: 'appl_TEST' }), set: ok, clear: ok },
      FatinahDeviceIntegrity: { generateDeviceCheckToken: () => Promise.resolve({ token: 'device-check-test-token' }) },
      Purchases: { configure: ok, setAttributes: ok, setEmail: ok, setDisplayName: ok },
      FirebaseCrashlytics: { setEnabled: ok, recordException: ok, setUserId: ok },
      SplashScreen: { hide: ok }, Preferences: { remove: ok }, KeepAwake: { keepAwake: ok, allowSleep: ok },
    },
  };
}

function remoteRoundPayload(categories) {
  return {
    schemaVersion: 1,
    bankVersion: 'choice-flow-test-bank',
    questions: Object.fromEntries(categories.map((category, categoryIndex) => [
      category,
      Array.from({ length: 6 }, (_, levelIndex) => [1, 2].map(variant => {
        const level = levelIndex + 1;
        const suffix = `${String(categoryIndex + 1).padStart(2, '0')}${String(level).padStart(2, '0')}${String(variant).padStart(16, '0')}`;
        const answer = `الإجابة ${categoryIndex + 1}-${level}-${variant}`;
        return {
          id: `gq-${suffix}`,
          d: level,
          q: `ما الإجابة الاختبارية للفئة ${category} في المستوى ${level} للنسخة ${variant}؟`,
          o: [answer, `الخيار ب ${suffix}`, `الخيار ج ${suffix}`, `الخيار د ${suffix}`],
          source: { title: 'مصدر اختباري', url: 'https://example.com/source' },
          review: {
            status: 'approved', reviewer: 'Fatinah test gate', reviewedAt: '2026-09-05',
          },
        };
      })).flat(),
    ])),
  };
}

async function createQuestion(browser, teamCount, networkControl = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.addInitScript(installNativeTestHarness);
  await page.route('**/*', route => {
    const requestUrl = route.request().url();
    if (requestUrl.startsWith('file://')) return route.continue();
    if (requestUrl.includes('/api/v2/subscription/status')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"active":true}' });
    }
    if (requestUrl.includes('/api/v2/revenuecat/identity')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"rcAppUserId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}' });
    }
    if (requestUrl.includes('/api/v2/questions/seen')) {
      const body = route.request().method() === 'GET' ? '{"items":[]}' : '{"ok":true}';
      return route.fulfill({ status: 200, contentType: 'application/json', body });
    }
    if(requestUrl.includes('/api/v2/questions/reservations/release')){
      return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true,"released":6}'});
    }
    if (requestUrl.includes('/api/v2/questions/catalog')) {
      const categories=['من أنا؟','كرتون وأنمي'].map(name=>({
        name,questionCount:90,
        levels:{'1':15,'2':15,'3':15,'4':15,'5':15,'6':15},
        bands:{easy:30,medium:30,hard:30},
      }));
      return route.fulfill({
        status:200,contentType:'application/json',
        body:JSON.stringify({schemaVersion:1,questionSchemaVersion:1,releaseReady:true,bankVersion:'choice-flow-test-bank',questionCount:180,categories}),
      });
    }
    if (requestUrl.includes('/api/v2/questions/round')) {
      const request = JSON.parse(route.request().postData() || '{}');
      assert.equal(request.questionsPerLevel, 2, 'يطلب العميل سؤالاً واحتياط تغيير لكل مستوى');
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(remoteRoundPayload(request.categories || [])),
      });
    }
    if (requestUrl.includes('/api/v2/questions/reveal')) {
      if (networkControl.revealUnavailable) return route.abort('internetdisconnected');
      const request = JSON.parse(route.request().postData() || '{}');
      const all = Object.values(remoteRoundPayload(['من أنا؟','كرتون وأنمي']).questions).flat();
      const question = all.find(item => item.id === request.questionId);
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
        questionId:request.questionId,a:0,answer:question?.o?.[0]||'',
      })});
    }
    return route.abort();
  });
  await page.goto(url);
  await page.getByRole('button', { name: '🎯 يلا نلعب' }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '🎯 يلا نلعب' }).click();
  if (teamCount === 3) await page.locator('#seg-teams button[data-n="3"]').click();
  await page.locator('#seg-catcount button[data-n="2"]').click();
  for (let index = 0; index < teamCount; index++) {
    await page.locator(`#tn-${index}`).fill(`الفريق ${index + 1}`);
  }
  await page.getByRole('button', { name: 'الخطوة الياية: اختار الفئات' }).click();
  await page.locator('.cat-pick').first().click();
  await page.locator('.cat-pick').nth(1).click();
  await page.getByRole('button', { name: 'يلا نبدأ!' }).click();
  await page.locator('#s-board.active').waitFor({ state: 'visible', timeout: 12000 });
  await page.locator('#board .cell:not(.used)').first().click();
  await page.locator('#q-wrap.show').waitFor({ state: 'visible' });
  return { context, page };
}

async function snapshot(page) {
  return page.evaluate(() => ({
    phase: state.cur.phase,
    activeTeam: activeAnsweringTeam(),
    answerVisible: getComputedStyle(document.getElementById('answer-box')).display !== 'none',
    values: [...document.querySelectorAll('#q-options .q-option')].map(button => button.textContent.trim()),
    accessibleLabels: [...document.querySelectorAll('#q-options .q-option')]
      .map(button => button.getAttribute('aria-label')||''),
    enabled: [...document.querySelectorAll('#q-options .q-option')].filter(button => !button.disabled).length,
    correctClasses: document.querySelectorAll('#q-options .q-option.correct').length,
    wrongClasses: document.querySelectorAll('#q-options .q-option.wrong').length,
  }));
}

const browser = await chromium.launch();
try {
  {
    const { context, page } = await createQuestion(browser, 2);
    try {
      const first = await snapshot(page);
      assert.equal(first.phase, 'owner');
      assert.equal(first.activeTeam, 0);
      assert.equal(first.answerVisible, false, 'الإجابة مخفية قبل إجابة الفرق');
      assert.equal(first.values.length, 4, 'يظهر أربعة خيارات');
      assert.equal(new Set(first.values).size, 4, 'الخيارات الأربعة مختلفة');
      assert.ok(first.accessibleLabels.every(label=>/^[أبجد]\.\s/u.test(label)),
        'قارئ الشاشة يحتاج فاصلاً واضحاً بين حرف الخيار ونصه');
      assert.equal(first.enabled, 4);

      const correct = 0;
      const wrong = (correct + 1) % 4;
      await page.getByRole('button', { name: 'مضاعفة السؤال — فريق الفريق 1' }).click();
      const rapidDoubleTap=await page.evaluate(index=>{
        const button=document.querySelectorAll('#q-options .q-option')[index];
        button.click();
        button.click();
        return {
          phase:state.cur.phase,
          activeTeam:activeAnsweringTeam(),
          choices:{...state.cur.teamChoices},
          locked:state.cur.optionInputLocked===true,
          answerVisible:getComputedStyle(document.getElementById('answer-box')).display!=='none',
          enabled:[...document.querySelectorAll('#q-options .q-option')].filter(item=>!item.disabled).length,
        };
      },correct);
      assert.deepEqual(rapidDoubleTap,{
        phase:'steal',activeTeam:1,choices:{0:correct},locked:true,answerVisible:false,enabled:0,
      },'النقرتان السريعتان تُحتسبان مرة واحدة للفريق الأول ولا تجيبان عن الفريق الثاني.');
      await page.waitForFunction(()=>[...document.querySelectorAll('#q-options .q-option')]
        .every(button=>!button.disabled));
      const second = await snapshot(page);
      assert.equal(second.phase, 'steal');
      assert.equal(second.activeTeam, 1);
      assert.equal(second.answerVisible, false, 'لا تنكشف الإجابة بعد الفريق الأول');
      assert.equal(second.correctClasses + second.wrongClasses, 0, 'لا تظهر تلميحات الصحة مبكراً');
      assert.equal(second.enabled, 4);
      const optionBindings=await page.evaluate(()=>({
        token:state.cur.token,
        items:[...document.querySelectorAll('#q-options .q-option')].map(button=>({
          token:Number(button.dataset.questionToken),
          team:Number(button.dataset.answerTeam),
          phase:button.dataset.answerPhase,
        })),
      }));
      assert.deepEqual(optionBindings.items,
        Array(4).fill(null).map(()=>({token:optionBindings.token,team:1,phase:'steal'})),
      'بعد انتهاء القفل ترتبط كل الخيارات بمرحلة وفريق السرقة الحاليين.');

      await page.locator('#q-options .q-option').nth(wrong).click();
      await page.waitForFunction(()=>state.cur?.phase==='reveal');
      const revealed = await snapshot(page);
      assert.equal(revealed.phase, 'reveal');
      assert.equal(revealed.answerVisible, true, 'تظهر الإجابة بعد إجابة الفريقين');
      assert.match(await page.locator('#phase-pill').textContent(),/ظهرت الإجابة الصحيحة — اضغط التالي/,
        'مسار الخيارات يحتسب النقاط تلقائيًا ولا يطلب حكمًا يدويًا.');
      assert.equal(revealed.enabled, 0);
      assert.ok(revealed.correctClasses >= 1, 'يتميز الخيار الصحيح بعد الكشف');
      await page.getByRole('button', { name: 'التالي' }).click();
      assert.equal(Number((await page.locator('.team-chip .cs').nth(0).textContent()).trim()), 200);
      assert.equal(Number((await page.locator('.team-chip .cs').nth(1).textContent()).trim()), 0);

      await page.locator('#board .cell:not(.used)').first().click();
      await page.locator('#q-wrap.show').waitFor({ state: 'visible' });
      const restoredQuestion = await page.locator('#q-text').textContent();
      const restoredCorrect = 0;
      await page.locator('#q-options .q-option').nth(restoredCorrect).click();
      assert.deepEqual(await page.evaluate(() => ({
        phase: state.cur.phase,
        activeTeam: activeAnsweringTeam(),
        teamChoices: state.cur.teamChoices,
      })), {
        phase: 'steal',
        activeTeam: 0,
        teamChoices: { 1: restoredCorrect },
      });

      await page.reload();
      await page.locator('#q-wrap.show').waitFor({ state: 'visible', timeout: RESTORE_UI_TIMEOUT_MS });
      assert.equal(await page.locator('#q-text').textContent(), restoredQuestion, 'يُستعاد السؤال نفسه');
      const restored = await snapshot(page);
      assert.equal(restored.phase, 'steal', 'تُستعاد مرحلة إجابة الفريق الثاني');
      assert.equal(restored.activeTeam, 0, 'يُستعاد الفريق الذي عليه الدور');
      assert.match(await page.locator('#phase-pill').textContent(), /اختار إجابة/,
        'نص الاستعادة يبقى متوافقاً مع مسار الخيارات');
      assert.equal(restored.answerVisible, false, 'لا يُكشف الحل أثناء الاستعادة');
      assert.equal(restored.enabled, 4, 'تبقى الخيارات قابلة للاختيار بعد الاستعادة');
      assert.deepEqual(
        await page.evaluate(() => state.cur.teamChoices),
        { 1: restoredCorrect },
        'يبقى اختيار مالك السؤال محفوظاً بعد إعادة التحميل',
      );

      await page.locator('#q-options .q-option').nth((restoredCorrect + 1) % 4).click();
      await page.waitForFunction(()=>state.cur?.phase==='reveal');
      await page.getByRole('button', { name: 'التالي' }).click();
      assert.equal(Number((await page.locator('.team-chip .cs').nth(1).textContent()).trim()), 100);
      await page.reload();
      await page.locator('#s-board.active').waitFor({ state: 'visible', timeout: RESTORE_UI_TIMEOUT_MS });
      assert.deepEqual(await page.locator('.team-chip .cs').allTextContents(), ['200', '100']);
      assert.equal(await page.locator('#board .cell.used').count(), 2);
      assert.equal(await page.evaluate(() => state.turn), 0, 'يبقى الدور التالي محفوظاً بعد حسم السؤال');
    } finally {
      await context.close();
    }
  }

  {
    const { context, page } = await createQuestion(browser, 3);
    try {
      for (let team = 0; team < 3; team++) {
        const before = await snapshot(page);
        assert.equal(before.activeTeam, team, `الدور للفريق ${team + 1}`);
        assert.equal(before.answerVisible, false, 'الحل مخفي حتى يجيب آخر فريق');
        await page.locator('#q-options .q-option').nth(team % 4).click();
      }
      await page.waitForFunction(()=>state.cur?.phase==='reveal');
      const revealed = await snapshot(page);
      assert.equal(revealed.phase, 'reveal');
      assert.equal(revealed.answerVisible, true);
    } finally {
      await context.close();
    }
  }

  {
    const { context, page } = await createQuestion(browser, 2);
    try {
      assert.notEqual(await page.evaluate(() => window.__FATINAH_LEGACY_SPOKEN_TEST__), true);
      const originalQuestion = await page.evaluate(() => state.cur.q.id || state.cur.q.q);
      await page.getByRole('button', { name: 'تغيير السؤال — فريق الفريق 1' }).click();
      await page.waitForFunction(question => (state.cur.q.id || state.cur.q.q) !== question, originalQuestion);
      const replacement = await snapshot(page);
      assert.equal(replacement.phase, 'owner');
      assert.equal(replacement.activeTeam, 0);
      assert.equal(replacement.answerVisible, false);
      assert.equal(replacement.enabled, 4, 'السؤال البديل يعرض أربعة خيارات مفعّلة');
      assert.deepEqual(await page.evaluate(() => state.cur.teamChoices), {});

      const correct = 0;
      await page.locator('#q-options .q-option').nth(correct).click();
      await page.locator('#q-options .q-option').nth((correct + 1) % 4).click();
      await page.waitForFunction(()=>state.cur?.phase==='reveal');
      await page.getByRole('button', { name: 'التالي' }).click();
      assert.equal(Number((await page.locator('.team-chip .cs').nth(0).textContent()).trim()), 100);
    } finally {
      await context.close();
    }
  }

  {
    const { context, page } = await createQuestion(browser, 2);
    try {
      const originalQuestion = await page.evaluate(() => state.cur.q.id || state.cur.q.q);
      const originalCorrect = 0;
      await page.locator('#q-options .q-option').nth(originalCorrect).click();
      assert.equal((await snapshot(page)).activeTeam, 1,
        'وصل الدور للفريق الثاني قبل تغيير السؤال');

      await page.getByRole('button', { name: 'تغيير السؤال — فريق الفريق 2' }).click();
      await page.waitForFunction(question => (state.cur.q.id || state.cur.q.q) !== question, originalQuestion);
      assert.deepEqual(await page.evaluate(() => ({
        activeTeam: activeAnsweringTeam(),
        choices: state.cur.teamChoices,
        eligibleTeams: [...state.cur.eligibleTeams],
      })), {
        activeTeam: 1,
        choices: {},
        eligibleTeams: [1],
      }, 'البديل يبدأ من مستخدم الوسيلة بلا أي اختيار موروث');

      const replacementCorrect = 0;
      await page.locator('#q-options .q-option').nth(replacementCorrect).click();
      await page.waitForFunction(()=>state.cur?.phase==='reveal');
      assert.equal((await snapshot(page)).phase, 'reveal');
      await page.getByRole('button', { name: 'التالي' }).click();
      assert.deepEqual(await page.locator('.team-chip .cs').allTextContents(), ['0', '100'],
        'اختيار الفريق الأول للسؤال القديم لا يمنحه نقاط البديل');
    } finally {
      await context.close();
    }
  }

  {
    const { context, page } = await createQuestion(browser, 2);
    try {
      assert.notEqual(await page.evaluate(() => window.__FATINAH_LEGACY_SPOKEN_TEST__), true);
      const correct = 0;
      await page.getByRole('button', { name: 'مرّرها للخصم — فريق الفريق 1' }).click();
      const passed = await snapshot(page);
      assert.equal(passed.phase, 'steal');
      assert.equal(passed.activeTeam, 1, 'التمرير ينقل الاختيار مباشرة إلى الخصم');
      assert.equal(passed.answerVisible, false);
      assert.deepEqual(await page.evaluate(() => [...state.cur.eligibleTeams]), [1]);

      await page.locator('#q-options .q-option').nth(correct).click();
      await page.waitForFunction(()=>state.cur?.phase==='reveal');
      assert.equal((await snapshot(page)).phase, 'reveal');
      await page.getByRole('button', { name: 'التالي' }).click();
      assert.deepEqual(await page.locator('.team-chip .cs').allTextContents(), ['0', '100']);
    } finally {
      await context.close();
    }
  }

  {
    const networkControl = { revealUnavailable: true };
    const { context, page } = await createQuestion(browser, 2, networkControl);
    try {
      await page.locator('#q-options .q-option').nth(0).click();
      await page.waitForFunction(()=>[...document.querySelectorAll('#q-options .q-option')]
        .every(button=>!button.disabled));
      await context.setOffline(true);
      await page.locator('#offline-bar.show').waitFor({ state: 'visible', timeout: 3000 });
      assert.match(await page.locator('#offline-bar').textContent(), /ماكو اتصال بالإنترنت/);
      await page.locator('#q-options .q-option').nth(1).click();
      await page.getByRole('button', { name: '🔄 إعادة محاولة كشف الإجابة' })
        .waitFor({ state: 'visible', timeout: 35000 });
      assert.equal((await snapshot(page)).answerVisible, false,
        'لا تظهر الإجابة عند تعذر اتصال الكشف');
      assert.deepEqual(await page.evaluate(() => state.cur.teamChoices), { 0: 0, 1: 1 },
        'تبقى اختيارات الفريقين محفوظة أثناء الانقطاع');
      assert.equal((await snapshot(page)).enabled, 0,
        'لا يستطيع أي فريق تغيير اختياره بعد انتهاء الأدوار');

      await context.setOffline(false);
      networkControl.revealUnavailable = false;
      await page.getByRole('button', { name: '🔄 إعادة محاولة كشف الإجابة' }).click();
      await page.waitForFunction(()=>state.cur?.phase==='reveal');
      assert.equal((await snapshot(page)).answerVisible, true,
        'تظهر الإجابة بعد عودة الاتصال وإعادة المحاولة');
    } finally {
      await context.setOffline(false);
      await context.close();
    }
  }

  console.log('✓ مسار الخيارات الافتراضي: التعاقب، النقاط، الاستعادة، التغيير، التمرير، واستعادة كشف الإجابة بعد انقطاع الشبكة');
} finally {
  await browser.close();
}
