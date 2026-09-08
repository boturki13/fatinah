import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const url=`file://${path.join(root,'www/index.html')}`;
const imageDocument=JSON.parse(fs.readFileSync(
  path.join(root,'server-assets/question-images/curated-question-bank.json'),'utf8'));
const textDocument=JSON.parse(fs.readFileSync(
  path.join(root,'server-assets/question-bank/v1/bank.json'),'utf8'));
const roundSubset=questions=>[1,2,3,4,5,6].flatMap(level=>
  questions.filter(question=>question.d===level).slice(0,2));
const browser=await chromium.launch();

try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.addInitScript(bank=>{
    window.__FATINAH_GAME_FLOW_UI_TEST__=true;
    window.__FATINAH_GAME_FLOW_UI_TEST_FIXTURE__={catalog:{schemaVersion:1,questionSchemaVersion:1,
      releaseReady:true,bankVersion:'remote-audit-seed',questionCount:24,categories:[
        {name:'تعرف على الصورة',questionCount:12,levels:{'1':2,'2':2,'3':2,'4':2,'5':2,'6':2}},
        {name:'من أنا؟',questionCount:12,levels:{'1':2,'2':2,'3':2,'4':2,'5':2,'6':2}},
      ]}};
    window.__REMOTE_AUDIT_BANK__=bank;
    document.addEventListener('DOMContentLoaded',()=>{QUESTION_BANK=window.__REMOTE_AUDIT_BANK__;});
  },{
    'تعرف على الصورة':roundSubset(imageDocument.categories['تعرف على الصورة']),
    'من أنا؟':roundSubset(textDocument.categories['من أنا؟']),
  });
  await page.route('**/*',route=>{
    if(route.request().url().startsWith('file://')) return route.continue();
    return route.abort();
  });
  await page.goto(url);
  const audit=await page.evaluate(async()=>{
    await ensureQuestionBank();
    const imageCategory='صور مستقبلية';
    const textCategory='نص مستقبلي';
    const clone=value=>JSON.parse(JSON.stringify(value));
    const imageQuestions=clone(QUESTION_BANK['تعرف على الصورة']).map((question,index)=>{
      const stem=`remote-${String(index+1).padStart(2,'0')}`;
      delete question.a; delete question.answer;
      return {
        ...question,id:`img-v3-${stem}`,
        image:{...question.image,assets:question.image.assets.map(asset=>{
          const parsed=new URL(asset.url);
          const extension=parsed.pathname.split('.').pop();
          parsed.pathname=parsed.pathname
            .replace('/question-images/v1/','/question-images/v3/')
            .replace(/[^/]+\.(?:avif|webp)$/u,`${stem}.${extension}`);
          return {...asset,url:parsed.href};
        })},
      };
    });
    const textQuestions=clone(QUESTION_BANK['من أنا؟']).map(question=>{
      delete question.a; delete question.answer; return question;
    });
    const remoteBank={[imageCategory]:imageQuestions,[textCategory]:textQuestions};
    const levels=Object.fromEntries([1,2,3,4,5,6].map(level=>[level,2]));
    const catalog={
      schemaVersion:1,questionSchemaVersion:1,releaseReady:true,
      bankVersion:'combined-test-bank-v1',questionCount:24,
      categories:[
        {name:imageCategory,kind:'image',questionCount:12,levels},
        {name:textCategory,kind:'text',questionCount:12,levels},
      ],
    };
    const catalogAccepted=installRemoteQuestionCatalog(catalog);
    const remoteAccepted=validRemoteRoundBank(remoteBank,[imageCategory,textCategory]);
    const matchingPayloadAccepted=validRemoteRoundPayload({
      schemaVersion:1,bankVersion:'combined-test-bank-v1',questions:remoteBank,
    },[imageCategory,textCategory]);
    const stalePayloadAccepted=validRemoteRoundPayload({
      schemaVersion:1,bankVersion:'combined-test-bank-old',questions:remoteBank,
    },[imageCategory,textCategory]);

    const originalPrepare=window.FatinahImageAssets.prepareCategory;
    let preparedIds=[];
    window.FatinahImageAssets.prepareCategory=async questions=>{
      preparedIds=questions.map(question=>question.id);
      const ready=new Map();
      for(const question of questions){
        if(!ready.has(question.d)) ready.set(question.d,new Set());
        ready.get(question.d).add(question.id);
      }
      return ready;
    };
    roundQuestionBank=Object.assign(Object.create(null),remoteBank);
    state.cats=[imageCategory,textCategory];
    const imagesPrepared=await prepareSelectedImageCategories();
    window.FatinahImageAssets.prepareCategory=originalPrepare;

    const tamperedReview=clone(remoteBank);
    tamperedReview[imageCategory][0].review.status='pending_review';
    const tamperedAsset=clone(remoteBank);
    tamperedAsset[imageCategory][0].image.assets[0].url='https://example.com/assets/question-images/v2/fake.avif';
    const tamperedRights=clone(remoteBank);
    tamperedRights[imageCategory][0].image.rights.owner='Israel Museum';
    const tamperedChoices=clone(remoteBank);
    tamperedChoices[imageCategory][0].o[1]=tamperedChoices[imageCategory][0].o[0];
    const mismatchedId=clone(remoteBank);
    mismatchedId[imageCategory][0].id='gq-aaaaaaaaaaaaaaaaaaaa';
    const mismatchedVersion=clone(remoteBank);
    mismatchedVersion[imageCategory][0].id='img-v4-remote-mismatch';
    const permanentlyBlockedId=clone(remoteBank);
    permanentlyBlockedId[imageCategory][0].id='img-v3-treasurex-q145780';
    const unexpectedCategory=clone(remoteBank);
    unexpectedCategory.extra=textQuestions;
    const shortLevel=clone(remoteBank);
    shortLevel[imageCategory].pop();
    const weakCatalog=clone(catalog);
    weakCatalog.categories[0].levels['1']=1;
    weakCatalog.categories[0].questionCount=11;
    weakCatalog.questionCount=23;

    // يحجز الخادم كامل حمولة الجولة قبل الرد. إذا وصلت مزامنة متأخرة
    // وسجلت هذه المعرفات محلياً، تبقى حصة الجولة الحالية قابلة للعب.
    window._currentUid='reservation-race-player';
    storeSet('authUid',window._currentUid);
    saveQuestionHistory(Object.fromEntries(Object.entries(remoteBank).map(
      ([category,questions])=>[category,questions.map(question=>question.id)])));
    state.usedQ=new Set(); state.usedQuestionIds=new Set();
    reservedQuestionIds.clear();
    const reservationStockIssue=findRoundStockIssue();
    const reservationRacePick=pickQuestion(textCategory,3);
    const reservationRacePlayable=!reservationRacePick?.exhausted&&reservationRacePick?.d===3;
    releasePickedQuestion(reservationRacePick);

    activeFilter='علوم وتقنية';
    const filteredCategories=catsForFilter();
    return {
      catalogAccepted,remoteAccepted,matchingPayloadAccepted,stalePayloadAccepted,imagesPrepared,
      invalidRecords:Object.entries(remoteBank).flatMap(([category,rows])=>rows.filter(question=>!validRemoteQuestionRecord(question)).map(question=>({category,id:question.id,keys:Object.keys(question)}))),
      categories:[...ALL_CATS],remoteCategories:[...CURATED_REMOTE_CATEGORIES],
      catalogVersion:remoteQuestionCatalogVersion,
      roundImageIds:[...roundImageQuestionIds],preparedIds,
      imageQuestionCount:questionsForRoundCategory(imageCategory).length,
      textQuestionCount:questionsForRoundCategory(textCategory).length,
      reservationStockIssue,reservationRacePlayable,
      futureVisual:categoryVisual(imageCategory),filteredCategories,
      rejected:{
        review:validRemoteRoundBank(tamperedReview,[imageCategory,textCategory]),
        asset:validRemoteRoundBank(tamperedAsset,[imageCategory,textCategory]),
        rights:validRemoteRoundBank(tamperedRights,[imageCategory,textCategory]),
        choices:validRemoteRoundBank(tamperedChoices,[imageCategory,textCategory]),
        id:validRemoteRoundBank(mismatchedId,[imageCategory,textCategory]),
        version:validRemoteRoundBank(mismatchedVersion,[imageCategory,textCategory]),
        blockedId:validRemoteRoundBank(permanentlyBlockedId,[imageCategory,textCategory]),
        extra:validRemoteRoundBank(unexpectedCategory,[imageCategory,textCategory]),
        level:validRemoteRoundBank(shortLevel,[imageCategory,textCategory]),
        weakCatalog:validRemoteQuestionCatalog(weakCatalog),
      },
    };
  });

  assert.equal(audit.catalogAccepted,true,'يقبل العميل كتالوج النص والصور الديناميكي.');
  assert.equal(audit.remoteAccepted,true,`يقبل بنك جولة يجمع gq وimg-v3 دون تحديث التطبيق: ${JSON.stringify(audit.invalidRecords)}`);
  assert.equal(audit.matchingPayloadAccepted,true);
  assert.equal(audit.stalePayloadAccepted,false,
    'إصدار حمولة الجولة يجب أن يطابق إصدار الكتالوج الذي اختار منه اللاعب.');
  assert.deepEqual(audit.categories,['صور مستقبلية','نص مستقبلي'],
    'يعرض الكتالوج فئات الخادم كما هي دون hardcode محلي.');
  assert.deepEqual(audit.remoteCategories,audit.categories);
  assert.equal(audit.catalogVersion,'combined-test-bank-v1');
  assert.equal(audit.imagesPrepared,true);
  assert.equal(audit.imageQuestionCount,12);
  assert.equal(audit.textQuestionCount,12);
  assert.equal(audit.reservationStockIssue,null,
    'حجوزات الجولة المتزامنة لا تجعل لوحة الجولة الحالية تبدو نافدة.');
  assert.equal(audit.reservationRacePlayable,true,
    'يبقى سؤال 300 قابلاً للفتح حتى لو وصلت مزامنة حجز الجولة متأخرة.');
  assert.equal(audit.preparedIds.length,12,'يهيّئ أسئلة الصور من roundQuestionBank لا من البنك المحلي.');
  assert.equal(audit.roundImageIds.length,12,'يوجد سؤالان صورة جاهزان لكل مستوى.');
  assert.equal(audit.futureVisual.icon,'🧠','الفئة الخادمية الجديدة لها fallback عام ولا تظهر كأنها فئة عائلية.');
  assert.deepEqual(audit.filteredCategories,[],
    'فلتر محلي قديم لا يعيد فئات غير موجودة في الكتالوج.');
  assert.deepEqual(audit.rejected,{
    review:false,asset:false,rights:false,choices:false,id:false,version:false,blockedId:false,
    extra:false,level:false,weakCatalog:false,
  },'يرفض العميل أي تلاعب بالمراجعة أو الحقوق أو الأصول أو عقد الجولة.');

  await page.close();
  const imageCategory='تعرف على الصورة';
  const textCategory='من أنا؟';
  const concealed=questions=>questions.map(({a,answer,...question})=>question);
  const e2eQuestions={
    [imageCategory]:concealed(roundSubset(imageDocument.categories[imageCategory])),
    [textCategory]:concealed(roundSubset(textDocument.categories[textCategory])),
  };
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const e2ePage=await context.newPage();
  await e2ePage.addInitScript(()=>{
    localStorage.setItem('fatinah_authUid',JSON.stringify('remote-image-player'));
    localStorage.setItem('fatinah_authProvider',JSON.stringify('apple'));
    localStorage.setItem('fatinah_onbDone',JSON.stringify(true));
    const ok=()=>Promise.resolve({});
    window.Capacitor={
      isNativePlatform:()=>true,
      Plugins:{
        FirebaseAuthentication:{
          getCurrentUser:()=>Promise.resolve({user:{uid:'remote-image-player',isAnonymous:false}}),
          getIdToken:()=>Promise.resolve({token:'remote-image-token'}),
        },
        RevenueCatKeyStore:{get:()=>Promise.resolve({value:'appl_TEST'}),set:ok,clear:ok},
        Purchases:{configure:ok,setAttributes:ok,setEmail:ok,setDisplayName:ok},
        FirebaseCrashlytics:{setEnabled:ok,recordException:ok,setUserId:ok},
        SplashScreen:{hide:ok},Preferences:{remove:ok},KeepAwake:{keepAwake:ok,allowSleep:ok},
      },
    };
    const entries=new Map();
    Object.defineProperty(window,'caches',{configurable:true,value:{
      async open(){
        return {
          async match(key){ return entries.get(String(key))?.clone(); },
          async put(key,response){ entries.set(String(key),response.clone()); },
          async delete(key){ return entries.delete(String(key)); },
        };
      },
    }});
  });
  let roundRequests=0;
  const assetRequests=[];
  await e2ePage.route('**/*',route=>{
    const requestUrl=route.request().url();
    if(requestUrl.startsWith('file://')) return route.continue();
    if(requestUrl.includes('/api/v2/subscription/status')){
      return route.fulfill({status:200,contentType:'application/json',body:'{"active":true}'});
    }
    if(requestUrl.includes('/api/v2/revenuecat/identity')){
      return route.fulfill({status:200,contentType:'application/json',body:'{"rcAppUserId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}'});
    }
    if(requestUrl.includes('/api/v2/questions/seen')){
      return route.fulfill({status:200,contentType:'application/json',
        body:route.request().method()==='GET'?'{"items":[]}':'{"ok":true}'});
    }
    if(requestUrl.includes('/api/v2/questions/catalog')){
      const levels={'1':2,'2':2,'3':2,'4':2,'5':2,'6':2};
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
        schemaVersion:1,questionSchemaVersion:1,releaseReady:true,
        bankVersion:'remote-image-e2e-v1',questionCount:24,
        categories:[
          {name:imageCategory,kind:'image',questionCount:12,levels},
          {name:textCategory,kind:'text',questionCount:12,levels},
        ],
      })});
    }
    if(requestUrl.includes('/api/v2/questions/round')){
      roundRequests+=1;
      const body=JSON.parse(route.request().postData()||'{}');
      assert.deepEqual(body.categories,[imageCategory,textCategory]);
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
        schemaVersion:1,bankVersion:'remote-image-e2e-v1',questions:e2eQuestions,
      })});
    }
    const parsed=new URL(requestUrl);
    if(parsed.hostname==='ata20.com'&&parsed.pathname.startsWith('/assets/question-images/')){
      assetRequests.push(parsed.pathname);
      const parts=parsed.pathname.split('/');
      const file=path.join(root,'server-assets/question-images',parts.at(-2),parts.at(-1));
      const extension=path.extname(file);
      const bytes=fs.readFileSync(file);
      return route.fulfill({status:200,body:bytes,headers:{
        'Content-Type':extension==='.avif'?'image/avif':'image/webp',
        'Content-Length':String(bytes.byteLength),'Access-Control-Allow-Origin':'*',
        'Cross-Origin-Resource-Policy':'cross-origin',
      }});
    }
    return route.abort();
  });
  await e2ePage.goto(url);
  await e2ePage.getByRole('button',{name:'🎯 يلا نلعب'}).waitFor({state:'visible'});
  await e2ePage.getByRole('button',{name:'🎯 يلا نلعب'}).click();
  await e2ePage.locator('#seg-catcount button[data-n="2"]').click();
  await e2ePage.locator('#tn-0').fill('الأول');
  await e2ePage.locator('#tn-1').fill('الثاني');
  await e2ePage.getByRole('button',{name:'الخطوة الياية: اختار الفئات'}).click();
  await e2ePage.locator(`.cat-pick[data-category="${imageCategory}"]`).click();
  await e2ePage.locator(`.cat-pick[data-category="${textCategory}"]`).click();
  await e2ePage.getByRole('button',{name:'يلا نبدأ!'}).click();
  await e2ePage.locator('#s-board.active').waitFor({state:'visible',timeout:20000});
  const e2eState=await e2ePage.evaluate(category=>({
    remoteIds:(roundQuestionBank[category]||[]).map(question=>question.id),
    readyIds:[...roundImageQuestionIds],
  }),imageCategory);
  assert.deepEqual(e2eState.remoteIds,e2eQuestions[imageCategory].map(question=>question.id),
    'اللوحة تستخدم سجلات الصور الآتية من endpoint الجولة.');
  assert.equal(e2eState.readyIds.length,12);
  assert.equal(roundRequests,1);
  assert.ok(assetRequests.length>=12,'يجب تنزيل أصل موثق لكل سؤال صورة قبل الجولة.');
  await e2ePage.locator('#board .cell').first().click();
  await e2ePage.locator('#q-wrap.show').waitFor({state:'visible'});
  assert.equal(await e2ePage.locator('#q-options .q-option').count(),4);
  assert.equal(await e2ePage.locator('#q-image').getAttribute('src')?.then(value=>value.startsWith('blob:')),true,
    'الصورة المعروضة تأتي من Blob الذي اجتاز البصمة.');
  await context.close();

  console.log('✓ العميل يحمّل فئات الصور ديناميكيًا ويتحقق من كل سجل وأصل');
}finally{
  await browser.close();
}
