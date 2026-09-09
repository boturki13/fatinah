/** مسار حقيقي: غير مشترك يلعب جولة كاملة، يبلّغ عن سؤال، ثم يرى الاشتراك. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const url = 'file://' + path.resolve(__dirname, '..', 'www', 'index.html');
const ASYNC_STATE_TIMEOUT_MS = 20000;

async function waitForFreeRoundBanner(page, text){
  await page.locator('#free-round-banner').filter({hasText:text}).waitFor({
    state:'visible',timeout:ASYNC_STATE_TIMEOUT_MS,
  });
}

function installHarness(){
  window.__FATINAH_LEGACY_SPOKEN_TEST__ = true;
  localStorage.setItem('fatinah_authUid', JSON.stringify('free-player'));
  localStorage.setItem('fatinah_authProvider', JSON.stringify('apple'));
  const ok=()=>Promise.resolve();
  window.Capacitor={
    isNativePlatform:()=>true,
    Plugins:{
      FirebaseAuthentication:{
        getCurrentUser:()=>Promise.resolve({user:{uid:'free-player',isAnonymous:false}}),
        getIdToken:()=>Promise.resolve({token:'free-token'}),
      },
      RevenueCatKeyStore:{get:()=>Promise.resolve({value:'appl_TEST'}),set:ok,clear:ok},
      FatinahDeviceIntegrity:{
        generateDeviceCheckToken:()=>Promise.resolve({token:'device-check-test-token'}),
        isSupported:()=>Promise.resolve({isSupported:true}),
        generateKey:()=>Promise.resolve({keyId:'app-attest-test-key'}),
        attestKey:()=>Promise.resolve({attestationObject:'synthetic-attestation'}),
        generateAssertion:()=>Promise.resolve({assertion:'synthetic-assertion'}),
      },
      Purchases:{
        configure:ok,
        getCustomerInfo:()=>Promise.resolve({customerInfo:{entitlements:{active:{}}}}),
        getOfferings:()=>Promise.reject(new Error('not needed')),
      },
      FirebaseCrashlytics:{setEnabled:ok,recordException:ok,setUserId:ok},
      SplashScreen:{hide:ok},Preferences:{remove:ok},KeepAwake:{keepAwake:ok,allowSleep:ok},
    },
  };
}

function installPreviewHarness(){
  localStorage.setItem('fatinah_authUid',JSON.stringify('preview-player'));
  localStorage.setItem('fatinah_authProvider',JSON.stringify('local'));
  localStorage.setItem('fatinah_onbDone',JSON.stringify(true));
  window.Capacitor={isNativePlatform:()=>false,Plugins:{}};
}

function remoteRoundPayload(categories){
  return {
    schemaVersion:1,
    bankVersion:'free-round-server-bank',
    questions:Object.fromEntries(categories.map((category,categoryIndex)=>[
      category,
      Array.from({length:6},(_,levelIndex)=>[1,2].map(variant=>{
        const level=levelIndex+1;
        const suffix=`${String(categoryIndex+1).padStart(2,'0')}${String(level).padStart(2,'0')}${String(variant).padStart(16,'0')}`;
        const answer=`الإجابة الصحيحة ${categoryIndex+1}-${level}-${variant}`;
        return {
          id:`gq-${suffix}`,d:level,
          q:`ما الإجابة الخادمية للفئة ${category} في المستوى ${level} والنسخة ${variant}؟`,
          o:[answer,`الخيار الثاني ${suffix}`,`الخيار الثالث ${suffix}`,`الخيار الرابع ${suffix}`],
          source:{title:'مصدر الجولة الخادمية',url:'https://example.com/free-round-source'},
          review:{status:'approved',reviewer:'Fatinah test gate',reviewedAt:'2026-09-05'},
        };
      })).flat(),
    ])),
  };
}

const browser=await chromium.launch();
try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.addInitScript(installHarness);
  let freeCompleted=false;
  let reportPayload=null;
  let metricsOnline=true;
  const metricEventIds=[];
  let appAttestEnrolled=false;
  let appAttestChallenge=0;
  let freeClaimRequests=0;
  let roundRequests=0;
  const roundRequestBodies=[];
  await page.route('**/*',route=>{
    const request=route.request();
    const requestUrl=request.url();
    if(requestUrl.startsWith('file://')) return route.continue();
    if(requestUrl.includes('/api/v2/subscription/status')){
      return route.fulfill({status:200,contentType:'application/json',body:'{"active":false}'});
    }
    if(requestUrl.includes('/api/v2/questions/catalog')){
      const categories=['من أنا؟','كرتون وأنمي'].map(name=>({
        name,questionCount:90,
        levels:{'1':15,'2':15,'3':15,'4':15,'5':15,'6':15},
        bands:{easy:30,medium:30,hard:30},
      }));
      return route.fulfill({
        status:200,contentType:'application/json',
        body:JSON.stringify({schemaVersion:1,questionSchemaVersion:1,releaseReady:true,bankVersion:'free-round-server-bank',questionCount:180,categories}),
      });
    }
    if(requestUrl.includes('/api/v2/app-attest/status')){
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({attested:appAttestEnrolled})});
    }
    if(requestUrl.includes('/api/v2/app-attest/challenge')){
      const payload=JSON.parse(request.postData()||'{}');
      return route.fulfill({
        status:201,contentType:'application/json',
        body:JSON.stringify({
          challengeId:`challenge-${++appAttestChallenge}`,
          clientData:Buffer.from(JSON.stringify({purpose:payload.purpose})).toString('base64'),
        }),
      });
    }
    if(requestUrl.includes('/api/v2/app-attest/attest')){
      appAttestEnrolled=true;
      return route.fulfill({status:201,contentType:'application/json',body:'{"attested":true}'});
    }
    if(requestUrl.includes('/api/v2/free-round/status')){
      assert.equal(request.headers()['x-app-attest-key-id'],'app-attest-test-key');
      assert.equal(request.headers()['x-app-attest-assertion'],'synthetic-assertion');
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({eligible:!freeCompleted,completed:freeCompleted})});
    }
    if(requestUrl.includes('/api/v2/free-round/complete')){
      freeClaimRequests+=1;
      const payload=JSON.parse(request.postData()||'{}');
      assert.equal(payload.appAttestKeyId,'app-attest-test-key');
      assert.equal(payload.appAttestAssertion,'synthetic-assertion');
      freeCompleted=true;
      return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true,"completed":true}'});
    }
    if(requestUrl.includes('/api/v2/questions/round')){
      roundRequests+=1;
      const payload=JSON.parse(request.postData()||'{}');
      roundRequestBodies.push(payload);
      assert.equal(freeCompleted,true,'يجب تثبيت المطالبة قبل تنزيل بنك الجولة المجانية');
      assert.equal(payload.questionsPerLevel,2);
      if(roundRequests===1) return route.abort('internetdisconnected');
      return route.fulfill({
        status:200,contentType:'application/json',
        body:JSON.stringify(remoteRoundPayload(payload.categories||[])),
      });
    }
    if(requestUrl.includes('/api/v2/questions/reveal')){
      const payload=JSON.parse(request.postData()||'{}');
      const all=Object.values(remoteRoundPayload(['كرتون وأنمي','من أنا؟']).questions).flat();
      const question=all.find(item=>item.id===payload.questionId);
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
        questionId:payload.questionId,a:0,answer:question?.o?.[0]||'',
      })});
    }
    if(requestUrl.includes('/api/v2/questions/report')){
      reportPayload=JSON.parse(request.postData()||'{}');
      return route.fulfill({status:201,contentType:'application/json',body:'{"ok":true,"emailStatus":"sent","recipient":"ata@ata20.com"}'});
    }
    if(requestUrl.includes('/api/v2/metrics/event')){
      if(!metricsOnline) return route.abort('internetdisconnected');
      metricEventIds.push(JSON.parse(request.postData()||'{}').eventId);
      return route.fulfill({status:202,contentType:'application/json',body:'{"ok":true}'});
    }
    if(requestUrl.includes('/api/v2/questions/seen')){
      return route.fulfill({status:200,contentType:'application/json',body:request.method()==='GET'?'{"items":[],"bankVersion":3}':'{"ok":true}'});
    }
    if(requestUrl.includes('/api/v2/questions/reservations/release')){
      return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true,"released":12}'});
    }
    if(requestUrl.includes('/api/v2/revenuecat/identity')){
      return route.fulfill({status:200,contentType:'application/json',body:'{"rcAppUserId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}'});
    }
    return route.abort();
  });
  await page.goto(url);
  await page.locator('#s-home.active').waitFor({state:'visible'});
  await waitForFreeRoundBanner(page,'أول جولة عليك بالكامل');
  assert.match(await page.locator('#free-round-banner').textContent(),/أول جولة عليك بالكامل/);

  await page.getByRole('button',{name:'🎯 يلا نلعب'}).click();
  await page.locator('#seg-catcount button[data-n="2"]').click();
  await page.getByRole('button',{name:'الخطوة الياية: اختار الفئات'}).click();
  await page.locator('.cat-pick[data-category="من أنا؟"]').click();
  await page.locator('.cat-pick[data-category="كرتون وأنمي"]').click();
  await page.getByRole('button',{name:'يلا نبدأ!'}).click();

  await page.locator('#toast-t').filter({hasText:'تعذّر الاتصال بخادم الجولة'}).waitFor({state:'visible'});
  await page.locator('#toast-d').filter({hasText:'جولتك محفوظة وما راح تضيع'}).waitFor({state:'visible'});
  assert.equal(freeClaimRequests,1,'لا تُستهلك المطالبة أكثر من مرة عند فشل التنزيل');
  assert.equal(roundRequests,1);
  const pendingStart=await page.evaluate(()=>freeRoundPendingStart('free-player'));
  assert.deepEqual({...pendingStart,createdAt:0},{
    schemaVersion:1,kind:'curated',categories:['من أنا؟','كرتون وأنمي'],
    claimConfirmed:true,createdAt:0,
  },'تبقى محاولة الجولة وفئاتها محفوظة لإعادة التنزيل');
  assert.ok(pendingStart.createdAt>0,'علامة الاستكمال تحمل وقت إنشاء صالحاً');

  await page.reload();
  await page.locator('#s-home.active').waitFor({state:'visible'});
  await waitForFreeRoundBanner(page,'جولتك المجانية محجوزة');
  assert.match(await page.locator('#free-round-banner').textContent(),/جولتك المجانية محجوزة/,
    'تظهر إمكانية استكمال الجولة بعد إعادة تشغيل التطبيق');
  await page.getByRole('button',{name:'🎯 يلا نلعب'}).click();
  await page.locator('#seg-catcount button[data-n="2"]').click();
  await page.getByRole('button',{name:'الخطوة الياية: اختار الفئات'}).click();
  await page.locator('.cat-pick[data-category="كرتون وأنمي"]').click();
  await page.locator('.cat-pick[data-category="من أنا؟"]').click();
  await page.getByRole('button',{name:'يلا نبدأ!'}).click();
  await page.locator('#s-board.active').waitFor({state:'visible'});
  assert.equal(freeClaimRequests,1,'إعادة التنزيل لا تعيد مطالبة DeviceCheck');
  assert.equal(roundRequests,2);
  assert.deepEqual(roundRequestBodies[1].categories,roundRequestBodies[0].categories,
    'إعادة المحاولة تعيد الترتيب المحجوز وتطلب الفئات نفسها');
  assert.equal(await page.evaluate(()=>freeRoundPendingStart('free-player')),null,
    'تمسح علامة الاستكمال فقط بعد حفظ الجولة النشطة');
  assert.equal(await page.evaluate(()=>startGame()),false,'لا يمكن بدء جولة ثانية فوق الجولة النشطة');
  assert.equal(roundRequests,2,'منع الجولة الثانية يجب أن يسبق أي طلب خادمي');

  for(let i=0;i<12;i++){
    await page.locator('#board .cell:not(.used)').first().click();
    while(await page.getByRole('button',{name:/^⏭️ اطرح على/}).count()){
      await page.getByRole('button',{name:/^⏭️ اطرح على/}).click();
    }
    await page.getByRole('button',{name:'👁️ اكشف الإجابة'}).click();
    await page.locator('#answer-box.show').waitFor({state:'visible'});
    if(i===0){
      await page.getByRole('button',{name:'⚑ الإبلاغ عن السؤال'}).click();
      await page.locator('#question-report-reason').selectOption('source');
      await page.locator('#question-report-details').fill('اختبار مسار البلاغ');
      await page.getByRole('button',{name:'إرسال البلاغ'}).click();
      await page.locator('#question-report-modal').waitFor({state:'hidden'});
    }
    await page.getByRole('button',{name:'❌ محد جاوب صح'}).click();
  }

  await page.locator('#s-result.active').waitFor({state:'visible'});
  assert.equal(freeCompleted,true,'يجب تسجيل إكمال الجولة في الخادم');
  assert.equal(reportPayload.reason,'source');
  assert.equal(reportPayload.appVersion,'1.4');
  assert.ok(reportPayload.questionId,'البلاغ يجب أن يحمل معرّف السؤال');
  assert.equal(reportPayload.sourceTitle,undefined,'الخادم يستخرج المصدر الموثوق ولا يثق بنسخة العميل');
  assert.equal(reportPayload.answer,undefined,'لا يرسل العميل الإجابة ضمن البلاغ');
  await page.getByRole('button',{name:'👑 اكتشف فطنة برو'}).click();
  await page.locator('#s-paywall.active').waitFor({state:'visible'});

  metricsOnline=false;
  assert.equal(await page.evaluate(()=>trackMetric('offer_code_opened')),false);
  assert.equal(await page.evaluate(()=>storeGet(metricOutboxKey('free-player'),[]).length),1,
    'فشل الشبكة يجب أن يبقي المؤشر في outbox محلي.');
  metricsOnline=true;
  await page.evaluate(()=>flushMetricEvents());
  assert.equal(await page.evaluate(()=>storeGet(metricOutboxKey('free-player'),[]).length),0,
    'يجب تفريغ outbox بعد عودة الشبكة.');
  assert.equal(new Set(metricEventIds).size,metricEventIds.length,'eventId يمنع إرسال الحدث نفسه بمعرفات مكررة.');

  console.log('✓ جولة مجانية كاملة ثم paywall، مع بلاغ سؤال موثّق');
}finally{
  await browser.close();
}
