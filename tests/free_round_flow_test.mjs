/** مسار حقيقي: غير مشترك يلعب جولة كاملة، يبلّغ عن سؤال، ثم يرى الاشتراك. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const url = 'file://' + path.resolve(__dirname, '..', 'www', 'index.html');

function installHarness(){
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
  await page.route('**/*',route=>{
    const request=route.request();
    const requestUrl=request.url();
    if(requestUrl.startsWith('file://')) return route.continue();
    if(requestUrl.includes('/api/v2/subscription/status')){
      return route.fulfill({status:200,contentType:'application/json',body:'{"active":false}'});
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
      const payload=JSON.parse(request.postData()||'{}');
      assert.equal(payload.appAttestKeyId,'app-attest-test-key');
      assert.equal(payload.appAttestAssertion,'synthetic-assertion');
      freeCompleted=true;
      return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true,"completed":true}'});
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
    if(requestUrl.includes('/api/v2/revenuecat/identity')){
      return route.fulfill({status:200,contentType:'application/json',body:'{}'});
    }
    return route.abort();
  });
  await page.goto(url);
  await page.locator('#s-home.active').waitFor({state:'visible'});
  assert.match(await page.locator('#free-round-banner').textContent(),/أول جولة عليك بالكامل/);

  await page.getByRole('button',{name:'🎯 يلا نلعب'}).click();
  await page.locator('#seg-catcount button[data-n="2"]').click();
  await page.getByRole('button',{name:'الخطوة الياية: اختار الفئات'}).click();
  await page.locator('.cat-pick').first().click();
  await page.locator('.cat-pick').nth(1).click();
  await page.getByRole('button',{name:'يلا نبدأ!'}).click();

  for(let i=0;i<12;i++){
    await page.locator('#board .cell:not(.used)').first().click();
    await page.getByRole('button',{name:'👁️ اكشف الإجابة'}).click();
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
  assert.equal(reportPayload.appVersion,'1.3');
  assert.ok(reportPayload.questionId,'البلاغ يجب أن يحمل معرّف السؤال');
  assert.ok(reportPayload.sourceTitle,'البلاغ يجب أن يحمل عنوان مصدر السؤال');
  assert.match(reportPayload.sourceUrl,/^https:\/\//,'البلاغ يجب أن يحمل رابط المصدر الموثوق');
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
