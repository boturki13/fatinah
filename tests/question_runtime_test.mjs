import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = `file://${path.join(root, 'www/index.html')}`;
const religious = ['دين وسيرة','السيرة النبوية','القرآن الكريم','فتوحات المسلمين','الصحابة','الخلفاء الراشدون','الأنبياء والرسل'];
const v13Categories = ['ألعاب الفيديو','اللغة العربية','كتب وروايات','اختراعات واكتشافات','مطابخ العالم','وش الرابط؟'];
const publishedCount = JSON.parse(fs.readFileSync(path.join(root, 'content/questions/published.json'), 'utf8')).length;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('fatinah_authUid', JSON.stringify('question-audit-user'));
    localStorage.setItem('fatinah_onbDone', JSON.stringify(true));
    const ok = () => Promise.resolve({});
    window.Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        FirebaseAuthentication: {
          getCurrentUser: () => Promise.resolve({ user: { uid: 'question-audit-user', isAnonymous: true } }),
          getIdToken: () => Promise.resolve({ token: 'question-audit-token' }),
        },
        RevenueCatKeyStore: { get: () => Promise.resolve({ value: 'appl_TEST' }), set: ok, clear: ok },
        Purchases: { configure: ok, setAttributes: ok, setEmail: ok, setDisplayName: ok },
        FirebaseCrashlytics: { setEnabled: ok, recordException: ok, setUserId: ok },
        SplashScreen: { hide: ok }, Preferences: { set: ok, remove: ok }, KeepAwake: { keepAwake: ok, allowSleep: ok },
      },
    };
  });
  await page.route('**/*', route => {
    if (route.request().url().startsWith('file://')) return route.continue();
    return route.abort();
  });
  await page.goto(url);
  const audit = await page.evaluate(async religiousCategories => {
    await ensureQuestionBank();
    const questions = Object.values(QUESTION_BANK).flat();
    const categoryCounts = Object.fromEntries(Object.entries(QUESTION_BANK).map(([cat, qs]) => [cat, qs.length]));
    const levelCounts = Object.fromEntries(Object.keys(QUESTION_BANK).map(cat => [cat,
      Object.fromEntries([1,2,3,4,5,6].map(level => [level, QUESTION_BANK[cat].filter(q => q.d === level).length]))
    ]));

    localStorage.removeItem('fatinah_question_history_question-audit-user');
    const rounds=[];
    for(let round=0;round<2;round++){
      state.familyRound=null; state.usedQ=new Set(); state.usedQuestionIds=new Set();
      rounds.push([1,2,3,4,5,6].map(level=>pickQuestion('القرآن الكريم',level).id));
    }
    return {
      total: questions.length,
      categories: Object.keys(QUESTION_BANK).length,
      categoryCounts,
      levelCounts,
      ids: questions.map(q=>q.id),
      duplicateTexts: Object.entries(QUESTION_BANK).flatMap(([cat, qs]) => {
        const seen=new Set();
        return qs.filter(q=>seen.has(q.q.trim())||!seen.add(q.q.trim())).map(q=>`${cat}: ${q.q}`);
      }),
      invalidSources: questions.filter(q=>!q.source||!/^https:\/\//.test(q.source.url||'')).map(q=>q.q),
      unreviewed: questions.filter(q=>q.review?.status!=='approved'||!Number.isInteger(q.review?.bankVersion)||q.review.bankVersion<2).map(q=>q.q),
      volatile: questions.filter(q=>/2026|حالياً|حتى الآن|بحلول/.test(q.q+' '+q.answer)).map(q=>q.q),
      rounds,
    };
  }, religious);

  assert.equal(audit.categories, 32 + v13Categories.length);
  assert.equal(audit.total, 234 + publishedCount, 'البنك الأساسي مع جميع الأسئلة الجديدة المعتمدة.');
  assert.equal(new Set(audit.ids).size, audit.ids.length, 'كل سؤال يحتاج معرفاً فريداً.');
  assert.deepEqual(audit.duplicateTexts, [], `يوجد نص سؤال مكرر داخل الفئة: ${audit.duplicateTexts.join(' | ')}`);
  assert.deepEqual(audit.invalidSources, [], 'كل سؤال يحتاج رابط مصدر HTTPS.');
  assert.deepEqual(audit.unreviewed, [], 'كل سؤال ظاهر للمستخدم يجب أن يكون معتمداً في بنك مراجع.');
  assert.deepEqual(audit.volatile, [], `وجدت أسئلة سريعة التقادم: ${audit.volatile.join(' | ')}`);
  for(const category of religious){
    assert.equal(audit.categoryCounts[category], 12, `${category}: يجب أن تحتوي 12 سؤالاً.`);
    for(let level=1;level<=6;level++) assert.equal(audit.levelCounts[category][level],2, `${category}: المستوى ${level} يحتاج سؤالين.`);
  }
  for(const category of v13Categories){
    assert.equal(audit.categoryCounts[category], 24, `${category}: يجب أن تحتوي 24 سؤالاً.`);
    for(let level=1;level<=6;level++) assert.equal(audit.levelCounts[category]?.[level] ?? 0,4, `${category}: المستوى ${level} يحتاج أربعة أسئلة.`);
  }
  assert.equal(new Set([...audit.rounds[0],...audit.rounds[1]]).size,12,'يجب ألا تتكرر أسئلة القرآن في جولتين متتاليتين قبل استهلاك البدائل.');
  console.log(`✓ البنك الفعلي: ${234 + publishedCount} سؤالاً، ${32 + v13Categories.length} فئة، وكل سؤال له معرّف ومصدر ومراجعة`);
  console.log('✓ الفئات الدينية: سؤالان لكل مستوى ولا تكرار في جولتين متتاليتين');
} finally {
  await browser.close();
}
