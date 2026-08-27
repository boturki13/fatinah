import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const url=`file://${path.join(root,'www/index.html')}`;
const uid='resume-player';
const snapshotKey=`fatinah_active_round_${uid}`;

function installHarness(){
  localStorage.setItem('fatinah_authUid',JSON.stringify('resume-player'));
  localStorage.setItem('fatinah_onbDone',JSON.stringify(true));
  const ok=()=>Promise.resolve({});
  window.Capacitor={
    isNativePlatform:()=>true,
    Plugins:{
      FirebaseAuthentication:{
        getCurrentUser:()=>Promise.resolve({user:{uid:'resume-player',isAnonymous:true}}),
        getIdToken:()=>Promise.resolve({token:'resume-token'}),
      },
      RevenueCatKeyStore:{get:()=>Promise.resolve({value:'appl_TEST'}),set:ok,clear:ok},
      FatinahDeviceIntegrity:{generateDeviceCheckToken:()=>Promise.resolve({token:'device-check-test-token'})},
      Purchases:{configure:ok,setAttributes:ok,setEmail:ok,setDisplayName:ok},
      FirebaseCrashlytics:{setEnabled:ok,recordException:ok,setUserId:ok},
      SplashScreen:{hide:ok},
      Preferences:{keys:()=>Promise.resolve({keys:[]}),set:ok,remove:ok},
      KeepAwake:{keepAwake:ok,allowSleep:ok},
    },
  };
}

async function waitForHome(page){
  await page.getByRole('button',{name:'🎯 يلا نلعب'}).waitFor({state:'visible',timeout:8000});
}

const browser=await chromium.launch();
try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.addInitScript(installHarness);
  await page.route('**/*',route=>{
    const requestUrl=route.request().url();
    if(requestUrl.startsWith('file://')) return route.continue();
    if(requestUrl.includes('/api/v2/subscription/status')){
      return route.fulfill({status:200,contentType:'application/json',body:'{"active":true}'});
    }
    if(requestUrl.includes('/api/v2/revenuecat/identity')){
      return route.fulfill({status:200,contentType:'application/json',body:'{}'});
    }
    if(requestUrl.includes('/api/v2/questions/seen')){
      const body=route.request().method()==='GET'?'{"items":[]}':'{"ok":true}';
      return route.fulfill({status:200,contentType:'application/json',body});
    }
    return route.abort();
  });

  await page.goto(url);
  await waitForHome(page);
  await page.getByRole('button',{name:'🎯 يلا نلعب'}).click();
  await page.locator('#seg-catcount button[data-n="2"]').click();
  await page.locator('#tn-0').fill('فريق الحفظ');
  await page.locator('#tn-1').fill('فريق الاستكمال');
  await page.getByRole('button',{name:'الخطوة الياية: اختار الفئات'}).click();
  await page.locator('.cat-pick:not(.on)').first().click();
  await page.locator('.cat-pick:not(.on)').first().click();
  await page.getByRole('button',{name:'يلا نبدأ!'}).click();
  await page.locator('#s-board.active').waitFor({state:'visible'});

  await page.locator('#board .cell:not(.used)').first().click();
  await page.locator('.ll-double').click();
  await page.locator('#pause-btn').click();
  const beforeReload=await page.evaluate(key=>({
    question:document.getElementById('q-text').textContent,
    time:Number(document.getElementById('timer-num').textContent),
    points:document.getElementById('q-points').textContent,
    snapshot:JSON.parse(localStorage.getItem(key)),
  }),snapshotKey);
  assert.equal(beforeReload.snapshot.current.phase,'owner');
  assert.equal(beforeReload.snapshot.paused,true);
  assert.equal(beforeReload.snapshot.teams[0].used.includes('double'),true);

  await page.reload();
  await page.locator('#q-wrap.show').waitFor({state:'visible',timeout:8000});
  const restoredQuestion=await page.evaluate(()=>({
    question:document.getElementById('q-text').textContent,
    time:Number(document.getElementById('timer-num').textContent),
    points:document.getElementById('q-points').textContent,
    paused:state.paused,
    phase:state.cur?.phase,
    turn:state.turn,
  }));
  assert.equal(restoredQuestion.question,beforeReload.question,'يجب استعادة السؤال نفسه.');
  assert.equal(restoredQuestion.time,beforeReload.time,'العداد الموقوف يجب أن يعود بنفس الثانية.');
  assert.equal(restoredQuestion.points,beforeReload.points,'تأثير مضاعفة السؤال يجب أن يبقى.');
  assert.equal(restoredQuestion.paused,true);
  assert.equal(restoredQuestion.phase,'owner');
  assert.equal(restoredQuestion.turn,0);

  await page.locator('#pause-btn').click();
  await page.getByRole('button',{name:'👁️ اكشف الإجابة'}).click();
  await page.getByRole('button',{name:'✅ فريق الحفظ'}).click();
  assert.equal(await page.locator('#board .cell.used').count(),1);
  assert.equal((await page.locator('.team-chip .cs').first().textContent()).trim(),'200');

  await page.reload();
  await page.locator('#s-board.active').waitFor({state:'visible',timeout:8000});
  assert.equal(await page.locator('#q-wrap.show').count(),0,'بين الأسئلة يجب استعادة اللوحة بلا سؤال وهمي.');
  assert.equal(await page.locator('#board .cell.used').count(),1,'الخانة المجابة يجب أن تبقى مستخدمة.');
  assert.match(await page.locator('#turn-pill').textContent(),/فريق الاستكمال/,'يجب استعادة الدور التالي.');
  assert.equal((await page.locator('.team-chip .cs').first().textContent()).trim(),'200');

  await page.locator('#board .cell:not(.used)').first().click();
  await page.locator('.ll-pass').click();
  await page.locator('.ll-search').click();
  const searchBefore=Number((await page.locator('#search-timer').textContent()).match(/\d+/)?.[0]);
  await page.reload();
  await page.locator('#q-wrap.show').waitFor({state:'visible',timeout:8000});
  const restoredSearch=await page.evaluate(()=>({
    phase:state.cur?.phase,searching:state.cur?.searching,
    searchTimeLeft:state.searchTimeLeft,paused:state.paused,
  }));
  assert.equal(restoredSearch.phase,'steal','مرحلة السرقة يجب أن تعود كما كانت.');
  assert.equal(restoredSearch.searching,true,'مؤقت البحث يجب أن يُستكمل.');
  assert.equal(restoredSearch.paused,true);
  assert.ok(restoredSearch.searchTimeLeft<=searchBefore&&restoredSearch.searchTimeLeft>=searchBefore-2);
  await page.getByRole('button',{name:'حصلنا الإجابة، وقف البحث وكمّل السؤال'}).click();
  assert.deepEqual(await page.evaluate(()=>({searching:state.cur.searching,paused:state.paused,searchTimeLeft:state.searchTimeLeft})),{
    searching:false,paused:false,searchTimeLeft:0,
  },'بعد استعادة الجولة يقدر اللاعب ينهي البحث فوراً.');

  // نافذة السؤال تغطي زر الخروج بصرياً؛ استدعِ مسار الخروج المؤكد مباشرة
  // للتحقق من أن الخروج المقصود يمسح اللقطة حتى أثناء سؤال جارٍ.
  await page.evaluate(()=>doExit());
  await waitForHome(page);
  assert.equal(await page.evaluate(key=>localStorage.getItem(key),snapshotKey),null,'الخروج المقصود يمسح الجولة المحفوظة.');

  const deferredImageRestore=await page.evaluate(async({key,snapshot})=>{
    const imageSnapshot={...snapshot,cats:['منو هاللاعب؟'],current:null};
    localStorage.setItem(key,JSON.stringify(imageSnapshot));
    const originalPrepareCategory=window.FatinahImageAssets.prepareCategory;
    window.FatinahImageAssets.prepareCategory=async()=>new Map();
    const restored=await restoreActiveRound('resume-player');
    window.FatinahImageAssets.prepareCategory=originalPrepareCategory;
    return {
      restored,
      snapshotPreserved:localStorage.getItem(key)!==null,
      roundActive:state.roundActive,
      currentQuestion:state.cur,
      toastTitle:document.getElementById('toast-t').textContent,
      toastDescription:document.getElementById('toast-d').textContent,
    };
  },{key:snapshotKey,snapshot:beforeReload.snapshot});
  assert.equal(deferredImageRestore.restored,false,'لا يجوز استعادة جولة مصورة إذا صورها غير جاهزة.');
  assert.equal(deferredImageRestore.snapshotPreserved,true,'فشل الشبكة المؤقت لا يجوز أن يمسح الجولة المحفوظة.');
  assert.equal(deferredImageRestore.roundActive,false,'الجولة غير الجاهزة لا تبقى نشطة بالخلفية.');
  assert.equal(deferredImageRestore.currentQuestion,null,'لا يجوز فتح سؤال من جولة صورها ناقصة.');
  assert.match(deferredImageRestore.toastTitle,/صور الجولة/);
  assert.match(deferredImageRestore.toastDescription,/حفظنا جولتك/);

  const contentUpdateRestore=await page.evaluate(async({key,snapshot})=>{
    const changed=structuredClone(snapshot);
    changed.current.q.id='question-removed-after-content-update';
    changed.answered=1;
    changed.teams[0].score=300;
    const usedKey=Object.keys(changed.cells).find(cellKey=>cellKey!==changed.current.key);
    changed.cells[usedKey]={used:true};
    localStorage.setItem(key,JSON.stringify(changed));
    const restored=await restoreActiveRound('resume-player');
    const persisted=JSON.parse(localStorage.getItem(key));
    return {
      restored,
      currentQuestion:state.cur,
      usedCells:document.querySelectorAll('#board .cell.used').length,
      score:state.teams[0].score,
      answered:state.answered,
      persistedCurrent:persisted.current,
      toastTitle:document.getElementById('toast-t').textContent,
      toastDescription:document.getElementById('toast-d').textContent,
    };
  },{key:snapshotKey,snapshot:beforeReload.snapshot});
  assert.equal(contentUpdateRestore.restored,true,'تغيّر السؤال الحالي لا يجوز أن يلغي استكمال الجولة.');
  assert.equal(contentUpdateRestore.currentQuestion,null,'السؤال المحذوف لا يُفتح كسؤال وهمي.');
  assert.equal(contentUpdateRestore.usedCells,1,'الخانات السابقة تبقى محفوظة بعد تحديث المحتوى.');
  assert.equal(contentUpdateRestore.score,300,'النقاط السابقة تبقى محفوظة بعد تحديث المحتوى.');
  assert.equal(contentUpdateRestore.answered,1,'عدد الإجابات السابقة يبقى محفوظاً.');
  assert.equal(contentUpdateRestore.persistedCurrent,null,'تُحدّث اللقطة لإزالة السؤال الذي لم يعد موجوداً فقط.');
  assert.match(contentUpdateRestore.toastTitle,/حدّثنا السؤال/);
  assert.match(contentUpdateRestore.toastDescription,/حفظنا تقدمكم/);

  const nativeSaveFallback=await page.evaluate(()=>{
    const originalLocalSet=Storage.prototype.setItem;
    const preferences=window.Capacitor.Plugins.Preferences;
    const originalNativeSet=preferences.set;
    const writes=[];
    Storage.prototype.setItem=()=>{ throw new DOMException('quota test','QuotaExceededError'); };
    preferences.set=args=>{ writes.push(args); return Promise.resolve(); };
    const result=persistActiveRound(true);
    Storage.prototype.setItem=originalLocalSet;
    preferences.set=originalNativeSet;
    return {result,writes:writes.map(write=>({key:write.key,snapshot:JSON.parse(write.value)}))};
  });
  assert.equal(nativeSaveFallback.result,true,'نجاح Preferences يكفي إذا تعذر localStorage.');
  assert.equal(nativeSaveFallback.writes.length,1,'يجب محاولة الحفظ الأصلي رغم فشل localStorage.');
  assert.equal(nativeSaveFallback.writes[0].key,snapshotKey);
  assert.equal(nativeSaveFallback.writes[0].snapshot.ownerUid,uid);
  assert.equal(nativeSaveFallback.writes[0].snapshot.answered,1,'Preferences يستلم آخر حالة كاملة للجولة.');

  await page.evaluate(key=>{
    state.roundActive=false;
    localStorage.setItem(key,JSON.stringify({schemaVersion:999,ownerUid:'resume-player',savedAt:Date.now()}));
  },snapshotKey);
  await page.reload();
  await waitForHome(page);
  assert.equal(await page.evaluate(key=>localStorage.getItem(key),snapshotKey),null,'اللقطة التالفة تُرفض وتُمسح بأمان.');

  console.log('✓ استعادة الجولة: السؤال والعداد والنقاط والدور والخانات والوسائل والسرقة والبحث');
  console.log('✓ الخروج المقصود واللقطة التالفة لا يعيدان جولة قديمة');
}finally{
  await browser.close();
}
