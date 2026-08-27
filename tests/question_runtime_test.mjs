import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { loadImageQuestionBank, loadRuntimeQuestionBank } from '../scripts/questions/lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = `file://${path.join(root, 'www/index.html')}`;
const religious = ['دين وسيرة','السيرة النبوية','القرآن الكريم','فتوحات المسلمين','الصحابة','الخلفاء الراشدون','الأنبياء والرسل'];
const v13Categories = ['ألعاب الفيديو','اللغة العربية','كتب وروايات','اختراعات واكتشافات','مطابخ العالم','وش الرابط؟'];
const expectedV13Groups = {
  'اختراعات واكتشافات':'معرفة وعلوم',
  'مطابخ العالم':'ثقافة وتراث',
  'وش الرابط؟':'ألغاز وذكاء',
  'ألعاب الفيديو':'فنون وأدب',
  'اللغة العربية':'فنون وأدب',
  'كتب وروايات':'فنون وأدب',
};
const imageQuestions = Object.values(loadImageQuestionBank()).flat();
const approvedImageCount = imageQuestions.filter(question => question.review?.status === 'approved').length;
const blockedImageCount = imageQuestions.length - approvedImageCount;
const runtimeTextQuestions = Object.values(loadRuntimeQuestionBank().bank).flat();
const appSource = fs.readFileSync(path.join(root, 'www/app.js'), 'utf8');
assert.match(
  appSource,
  /async function startGame\(\)[\s\S]*?await syncQuestionHistory\(\)/,
  'بدء الجولة يجب أن ينتظر مزامنة سجل الحساب قبل اختيار الأسئلة.',
);
assert.match(
  appSource,
  /async function startGame\(\)[\s\S]*?await prepareSelectedImageCategories\(\)[\s\S]*?findRoundStockIssue\(\)[\s\S]*?claimFreeRound\(/,
  'بدء الجولة يجب أن يفحص مخزون كل مستوى بعد تجهيز الصور وقبل استهلاك الجولة المجانية.',
);
assert.match(
  appSource,
  /const stockIssue=findRoundStockIssue\(\);[\s\S]*?if\(stockIssue\)[\s\S]*?renderCats\(\);[\s\S]*?go\('s-cats'\);/,
  'فشل فحص المخزون يجب أن يرجع اللاعب لاختيار فئات جديدة.',
);

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
        FatinahDeviceIntegrity: { generateDeviceCheckToken: () => Promise.resolve({ token: 'device-check-test-token' }) },
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
  const audit = await page.evaluate(async ({religiousCategories,newCategories}) => {
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

    // استهلك مستوى واحداً بالكامل مع إبقاء بقية مستويات الفئة متاحة. يجب أن
    // يرجع الاختيار حالة نفاد، لا سؤالاً أسهل أو أصعب من صف اللوحة المطلوب.
    const exhaustedCategory='ألعاب الفيديو';
    const exhaustedLevel=3;
    const levelQuestions=QUESTION_BANK[exhaustedCategory].filter(question=>question.d===exhaustedLevel);
    const otherLevelQuestionCount=QUESTION_BANK[exhaustedCategory].length-levelQuestions.length;
    localStorage.removeItem('fatinah_question_history_question-audit-user');
    const selectedQuestions=[];
    for(let attempt=0;attempt<levelQuestions.length;attempt++){
      state.familyRound=null; state.usedQ=new Set(); state.usedQuestionIds=new Set();
      const question=pickQuestion(exhaustedCategory,exhaustedLevel);
      if(question.exhausted) break;
      selectedQuestions.push({id:question.id,d:question.d});
    }
    const historyBeforeExhaustion=loadQuestionHistory();
    state.usedQ=new Set(); state.usedQuestionIds=new Set();
    const exhaustedResult=pickQuestion(exhaustedCategory,exhaustedLevel);
    const historyAfterExhaustion=loadQuestionHistory();
    const exhaustedKey=`0-${exhaustedLevel}`;
    state.cats=[exhaustedCategory]; state.cells={[exhaustedKey]:{used:false}}; state.cur=null;
    const exhaustedCell=document.createElement('button');
    const exhaustedOpenResult=openQuestion(0,exhaustedLevel,exhaustedKey,exhaustedCell);
    const exhaustionSnapshot={
      leftCellAvailable:state.cells[exhaustedKey].used===false&&!exhaustedCell.classList.contains('used'),
      leftQuestionClosed:state.cur===null&&!document.getElementById('q-wrap').classList.contains('show'),
      toastTitle:document.getElementById('toast-t').textContent,
      toastDescription:document.getElementById('toast-d').textContent,
    };

    // لا تبدأ الجولة من الأساس إذا كان أحد مستويات الفئة المختارة مستهلكاً؛
    // ومن شاشة النتيجة نرجع اللاعب لاختيار فئات جديدة بدل إعادة جولة معلّقة.
    _hasActiveSubscription=true;
    _subscriptionResolved=true;
    _freeRoundAvailable=false;
    _startGamePending=false;
    storeSet('authProvider','local');
    state.teamCount=2;
    state.teams=[
      {name:'فريق 1',score:0,ll:3,used:new Set(),idx:0,bombUsed:false},
      {name:'فريق 2',score:0,ll:3,used:new Set(),idx:1,bombUsed:false},
    ];
    state.catCount=1;
    state.cats=[exhaustedCategory];
    state.cells={};
    go('s-result');
    const stockIssue=findRoundStockIssue();
    const exhaustedStartResult=await startGame();
    const roundPreflight={
      issue:stockIssue,
      startResult:exhaustedStartResult,
      boardCellCount:Object.keys(state.cells).length,
      selectedCategoryCount:state.cats.length,
      toastTitle:document.getElementById('toast-t').textContent,
      toastDescription:document.getElementById('toast-d').textContent,
    };

    // سجل 1.2 كان يحفظ معرّفاً مشتقاً من النص. بعد اعتماد معرّف 1.3
    // الثابت تحريرياً يجب أن يبقى الاسم السابق حاجزاً للتكرار.
    const migratedQuestion=QUESTION_BANK['معلومات عامة'].find(question=>question.d===1);
    localStorage.setItem('fatinah_question_history_question-audit-user',JSON.stringify({
      'معلومات عامة':[migratedQuestion.previousIds[0]],
    }));
    state.familyRound=null; state.usedQ=new Set(); state.usedQuestionIds=new Set();
    const migratedHistoryResult=pickQuestion('معلومات عامة',1);

    return {
      total: questions.length,
      categories: Object.keys(QUESTION_BANK).length,
      categoryCounts,
      levelCounts,
      ids: questions.map(q=>q.id),
      duplicateTexts: Object.entries(QUESTION_BANK).flatMap(([cat, qs]) => {
        const seen=new Set();
        return qs.filter(q=>!q.image).filter(q=>seen.has(q.q.trim())||!seen.add(q.q.trim())).map(q=>`${cat}: ${q.q}`);
      }),
      invalidSources: questions.filter(q=>!q.source||!/^https:\/\//.test(q.source.url||'')).map(q=>q.q),
      approved: questions.filter(q=>q.review?.status==='approved').length,
      pending: questions.filter(q=>['pending_review','pending_religious_review'].includes(q.review?.status)).length,
      invalidApprovals: questions.filter(q=>q.review?.status==='approved'&&(!q.review?.reviewer||!q.review?.reviewedAt)).map(q=>q.q),
      invalidReligiousApprovals: Object.entries(QUESTION_BANK).flatMap(([category,rows])=>
        religiousCategories.includes(category)
          ? rows.filter(q=>q.review?.status!=='approved'||q.review?.religiousSourceAndIsnadConfirmed!==true).map(q=>`${category}: ${q.q}`)
          : []),
      categoryFallback: questions.filter(q=>q.source?.scope==='category_fallback').length,
      volatile: questions.filter(q=>/2026|حالياً|حتى الآن|بحلول/.test(q.q+' '+q.answer)).map(q=>q.q),
      rounds,
      categoryPresentation:Object.fromEntries(newCategories.map(category=>[category,{
        icon:CAT_ICONS[category]||'',
        groups:Object.entries(CAT_GROUPS).filter(([,categories])=>categories.includes(category)).map(([group])=>group),
      }])),
      idMigration:{
        id:migratedQuestion.id,
        previousIds:migratedQuestion.previousIds,
        result:migratedHistoryResult,
      },
      roundPreflight,
      exhaustion:{
        category:exhaustedCategory,
        level:exhaustedLevel,
        levelQuestionCount:levelQuestions.length,
        otherLevelQuestionCount,
        selectedQuestions,
        result:exhaustedResult,
        openResult:exhaustedOpenResult,
        leftCellAvailable:exhaustionSnapshot.leftCellAvailable,
        leftQuestionClosed:exhaustionSnapshot.leftQuestionClosed,
        historyBeforeExhaustion:historyBeforeExhaustion[exhaustedCategory]||[],
        historyAfterExhaustion:historyAfterExhaustion[exhaustedCategory]||[],
        toastTitle:exhaustionSnapshot.toastTitle,
        toastDescription:exhaustionSnapshot.toastDescription,
      },
    };
  }, {religiousCategories:religious,newCategories:v13Categories});

  assert.equal(audit.categories, 40 + v13Categories.length);
  assert.equal(audit.total, runtimeTextQuestions.length + imageQuestions.length,
    'بنك التشغيل المحلي يجب أن يضم النصوص المنشورة وكل أسئلة الصور المجهزة.');
  assert.equal(new Set(audit.ids).size, audit.ids.length, 'كل سؤال يحتاج معرفاً فريداً.');
  assert.match(audit.idMigration.id,/^q3-/,'أسئلة البنك القديم تحتاج معرّف 1.3 ثابتاً لا يعتمد على النص.');
  assert.match(audit.idMigration.previousIds[0],/^q2-/,'يجب الاحتفاظ بمعرّف 1.2 لترحيل سجل المشاهدة.');
  assert.notEqual(audit.idMigration.result.id,audit.idMigration.id,
    'السؤال المشاهد بمعرّف 1.2 لا يجوز أن يظهر مجدداً في 1.3.');
  assert.notEqual(audit.idMigration.result.exhausted,true,
    'وجود أسئلة جديدة في المستوى يسمح بالمتابعة بدل اعتباره مستنفداً بالكامل.');
  assert.deepEqual(audit.duplicateTexts, [], `يوجد نص سؤال مكرر داخل الفئة: ${audit.duplicateTexts.join(' | ')}`);
  assert.deepEqual(audit.invalidSources, [], 'كل سؤال يحتاج رابط مصدر HTTPS.');
  assert.equal(audit.approved,runtimeTextQuestions.length+approvedImageCount,
    'الأسئلة النصية والصور غير المحجوبة يجب أن تحمل اعتماداً فردياً قابلاً للتدقيق.');
  assert.equal(audit.pending,blockedImageCount,
    'المعلّق الوحيد المسموح هو فئة اللاعبين المحجوبة إلى اعتماد حق الاسم والصورة التجارية.');
  assert.deepEqual(audit.invalidApprovals, [], 'كل اعتماد صريح يحتاج اسم مراجع وتاريخ مراجعة.');
  assert.deepEqual(audit.invalidReligiousApprovals, [], 'كل سؤال ديني معتمد يحتاج تأكيد المصدر والإسناد.');
  assert.equal(audit.categoryFallback,0,'كل سؤال يحتاج مرجعاً خاصاً به، لا رابط فئة عاماً.');
  assert.deepEqual(audit.volatile, [], `وجدت أسئلة سريعة التقادم: ${audit.volatile.join(' | ')}`);
  for(const category of religious){
    assert.equal(audit.categoryCounts[category], 12, `${category}: يجب أن تحتوي 12 سؤالاً.`);
    for(let level=1;level<=6;level++) assert.equal(audit.levelCounts[category][level],2, `${category}: المستوى ${level} يحتاج سؤالين.`);
  }
  for(const category of v13Categories){
    assert.equal(audit.categoryCounts[category], 24, `${category}: يجب أن تحتوي 24 سؤالاً.`);
    for(let level=1;level<=6;level++) assert.equal(audit.levelCounts[category]?.[level] ?? 0,4, `${category}: المستوى ${level} يحتاج أربعة أسئلة.`);
    assert.ok(audit.categoryPresentation[category].icon, `${category}: تحتاج أيقونة مستقلة.`);
    assert.notEqual(audit.categoryPresentation[category].icon, '❓', `${category}: يجب ألا تستخدم أيقونة الاحتياط.`);
    assert.ok(
      audit.categoryPresentation[category].groups.includes(expectedV13Groups[category]),
      `${category}: يجب أن تظهر في فلتر ${expectedV13Groups[category]}.`,
    );
  }
  assert.equal(new Set([...audit.rounds[0],...audit.rounds[1]]).size,12,'يجب ألا تتكرر أسئلة القرآن في جولتين متتاليتين قبل استهلاك البدائل.');
  assert.equal(
    new Set(audit.exhaustion.selectedQuestions.map(question=>question.id)).size,
    audit.exhaustion.levelQuestionCount,
    'يجب عرض أسئلة المستوى المطلوب مرة واحدة بلا تكرار قبل إعلان النفاد.',
  );
  assert.deepEqual(
    [...new Set(audit.exhaustion.selectedQuestions.map(question=>question.d))],
    [audit.exhaustion.level],
    'لا يجوز خلط مستويات الصعوبة أثناء اختيار بدائل الصف نفسه.',
  );
  assert.ok(audit.exhaustion.otherLevelQuestionCount>0, 'يجب أن يبقى الاختبار حساساً لوجود أسئلة من مستويات أخرى.');
  assert.equal(audit.exhaustion.result.exhausted, true, 'عند نفاد المستوى يجب إرجاع حالة نفاد صريحة.');
  assert.equal(audit.exhaustion.result.code, 'question_pool_exhausted');
  assert.equal(audit.exhaustion.result.category, audit.exhaustion.category);
  assert.equal(audit.exhaustion.result.difficulty, audit.exhaustion.level);
  assert.equal(audit.exhaustion.openResult.exhausted, true, 'فتح الخانة يجب أن يعيد حالة النفاد للواجهة.');
  assert.equal(audit.exhaustion.leftCellAvailable, true, 'الخانة المنهكة تبقى متاحة ولا تُحسب كسؤال مجاب.');
  assert.equal(audit.exhaustion.leftQuestionClosed, true, 'لا يجوز فتح شاشة سؤال وهمي عند النفاد.');
  assert.deepEqual(
    audit.exhaustion.historyAfterExhaustion,
    audit.exhaustion.historyBeforeExhaustion,
    'لا يجوز مسح سجل المستخدم أو إعادة تدويره عند نفاد الأسئلة.',
  );
  assert.match(audit.exhaustion.toastTitle, /خلصت الأسئلة/);
  assert.match(audit.exhaustion.toastDescription, /ماكو سؤال ما شفته من قبل/);
  assert.deepEqual(audit.roundPreflight.issue,{
    category:audit.exhaustion.category,
    difficulty:audit.exhaustion.level,
  },'فحص ما قبل الجولة يجب أن يحدد الفئة والمستوى المنهك بدقة.');
  assert.equal(audit.roundPreflight.startResult,false,'لا يجوز بدء جولة نعرف مسبقاً أنها لن تكتمل.');
  assert.equal(audit.roundPreflight.boardCellCount,0,'لا يجوز بناء لوحة ناقصة بعد فشل فحص المخزون.');
  assert.equal(audit.roundPreflight.selectedCategoryCount,0,'اختيار الجولة السابقة المنهك يجب أن يُمسح قبل الاختيار الجديد.');
  assert.match(audit.roundPreflight.toastTitle,/اختار فئة ثانية/);
  assert.match(audit.roundPreflight.toastDescription,/عشان نضمن إن الجولة تكتمل/);
  console.log(`✓ البنك المحمّل للاختبار: ${audit.total} سؤالاً؛ المعتمد ${audit.approved} والمحجوب بحقوق اللاعبين ${audit.pending}`);
  console.log('✓ الفئات الدينية: سؤالان لكل مستوى، وكل مصدر وإسناد مؤكد، ولا تكرار في جولتين');
  console.log('✓ فئات 1.3 لها أيقونات وفلاتر، ونفاد الأسئلة لا يمسح سجل المستخدم أو يكرر سؤالاً');
} finally {
  await browser.close();
}
