import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = `file://${path.join(root, 'www/index.html')}`;

function installHarness(){
  localStorage.setItem('fatinah_authUid',JSON.stringify('account-a'));
  localStorage.setItem('fatinah_authProvider',JSON.stringify('apple'));
  localStorage.setItem('fatinah_onbDone',JSON.stringify(true));
  window.__firebaseUser={uid:'account-a',isAnonymous:false,providerData:[]};
  window.__deviceTokenCounter=0;
  window.__appAttestKeyId='';
  window.__appAttestGenerationCount=0;
  window.__appAttestResetCount=0;
  window.__appAttestInjectedFailure=false;
  const ok=()=>Promise.resolve({});
  window.Capacitor={
    isNativePlatform:()=>true,
    Plugins:{
      FirebaseAuthentication:{
        getCurrentUser:()=>Promise.resolve({user:window.__firebaseUser}),
        getIdToken:()=>Promise.resolve({token:`token-${window.__firebaseUser?.uid||'none'}`}),
      },
      FatinahDeviceIntegrity:{
        generateDeviceCheckToken:()=>Promise.resolve({
          token:`device-token-${++window.__deviceTokenCounter}`,
        }),
        isSupported:()=>Promise.resolve({isSupported:true}),
        generateKey:()=>{
          if(!window.__appAttestKeyId){
            window.__appAttestGenerationCount+=1;
            window.__appAttestKeyId=window.__appAttestGenerationCount===1
              ?'stale-installation-key':'installation-app-attest-key';
          }
          return Promise.resolve({keyId:window.__appAttestKeyId});
        },
        resetKey:()=>{
          window.__appAttestResetCount+=1;
          window.__appAttestKeyId='';
          return Promise.resolve({reset:true});
        },
        attestKey:()=>Promise.resolve({attestationObject:'synthetic-attestation'}),
        generateAssertion:()=>{
          if(!window.__appAttestInjectedFailure){
            window.__appAttestInjectedFailure=true;
            return Promise.reject(Object.assign(new Error('stale key'),{
              code:'APP_ATTEST_INVALID_KEY',
            }));
          }
          return Promise.resolve({assertion:'synthetic-assertion'});
        },
      },
      RevenueCatKeyStore:{get:()=>Promise.resolve({value:'appl_TEST'}),set:ok,clear:ok},
      Purchases:{
        configure:ok,
        getCustomerInfo:()=>Promise.resolve({customerInfo:{entitlements:{active:{}}}}),
      },
      FirebaseCrashlytics:{setEnabled:ok,recordException:ok,setUserId:ok},
      FatinahTelemetryIdentity:{setOwner:ok,clearOwner:ok},
      SplashScreen:{hide:ok},Preferences:{remove:ok},KeepAwake:{keepAwake:ok,allowSleep:ok},
    },
  };
}

const browser=await chromium.launch();
try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.addInitScript(installHarness);
  let deviceClaimed=false;
  let statusUnavailable=false;
  let claimPayload=null;
  const attestedAppAttestKeys=new Set();
  let appAttestChallenge=0;
  await page.route('**/*',route=>{
    const request=route.request();
    const requestUrl=request.url();
    if(requestUrl.startsWith('file://')) return route.continue();
    if(requestUrl.includes('/api/v2/subscription/status')){
      return route.fulfill({status:200,contentType:'application/json',body:'{"active":false}'});
    }
    if(requestUrl.includes('/api/v2/revenuecat/identity')){
      return route.fulfill({status:200,contentType:'application/json',body:'{}'});
    }
    if(requestUrl.includes('/api/v2/app-attest/status')){
      const payload=JSON.parse(request.postData()||'{}');
      return route.fulfill({
        status:200,contentType:'application/json',
        body:JSON.stringify({attested:attestedAppAttestKeys.has(payload.keyId)}),
      });
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
      const payload=JSON.parse(request.postData()||'{}');
      attestedAppAttestKeys.add(payload.keyId);
      return route.fulfill({status:201,contentType:'application/json',body:'{"attested":true}'});
    }
    if(requestUrl.includes('/api/v2/free-round/status')){
      if(statusUnavailable){
        return route.fulfill({status:503,contentType:'application/json',body:'{"code":"device_check_unavailable"}'});
      }
      assert.ok(request.headers()['x-devicecheck-token'],'الاستعلام يجب أن يحمل token جديداً في الرأس');
      assert.equal(request.headers()['x-app-attest-key-id'],'installation-app-attest-key');
      assert.equal(request.headers()['x-app-attest-assertion'],'synthetic-assertion');
      return route.fulfill({
        status:200,contentType:'application/json',
        body:JSON.stringify({eligible:!deviceClaimed,completed:deviceClaimed}),
      });
    }
    if(requestUrl.includes('/api/v2/free-round/complete')){
      claimPayload=JSON.parse(request.postData()||'{}');
      assert.ok(claimPayload.deviceCheckToken);
      assert.ok(claimPayload.deviceCheckUpdateToken);
      assert.notEqual(claimPayload.deviceCheckToken,claimPayload.deviceCheckUpdateToken,
        'استعلام DeviceCheck وتحديثه يجب أن يستخدما tokenين مختلفين');
      assert.equal(claimPayload.appAttestKeyId,'installation-app-attest-key');
      assert.equal(claimPayload.appAttestAssertion,'synthetic-assertion');
      deviceClaimed=true;
      return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true,"completed":true}'});
    }
    if(requestUrl.includes('/api/v2/questions/seen')){
      return route.fulfill({status:200,contentType:'application/json',body:request.method()==='GET'?'{"items":[]}':'{"ok":true}'});
    }
    if(requestUrl.includes('/api/v2/metrics/event')){
      return route.fulfill({status:202,contentType:'application/json',body:'{"ok":true}'});
    }
    return route.fulfill({status:200,contentType:'application/json',body:'{}'});
  });

  await page.goto(url);
  await page.locator('#s-home.active').waitFor({state:'visible',timeout:8000});
  assert.deepEqual(await page.evaluate(()=>({
    resets:window.__appAttestResetCount,
    generations:window.__appAttestGenerationCount,
  })),{resets:1,generations:2},
  'المفتاح غير الصالح يجب أن يُحذف ويُسجّل بديله مرة واحدة فقط');
  assert.equal(await page.evaluate(()=>_freeRoundVerificationState),'eligible');
  assert.equal(await page.evaluate(()=>claimFreeRound('account-a')),true);
  assert.equal(claimPayload.uid,'account-a');

  const accountB=await page.evaluate(async()=>{
    window.__firebaseUser={uid:'account-b',isAnonymous:true,providerData:[]};
    storeSet('authUid','account-b');
    storeSet('authProvider','anonymous');
    window._currentUid='account-b';
    clearIdTokenCache();
    setFreeRoundAvailability(await freeRoundIsAvailable('account-b'));
    return {available:_freeRoundAvailable,state:_freeRoundVerificationState};
  });
  assert.deepEqual(accountB,{available:false,state:'used'},
    'UID مجهول جديد على الجهاز نفسه لا يحصل على جولة ثانية');

  await page.evaluate(()=>{ go('s-home'); canStartRound(); });
  await page.locator('#s-paywall.active').waitFor({state:'visible'});

  statusUnavailable=true;
  const failClosed=await page.evaluate(async()=>{
    window.__firebaseUser={uid:'account-c',isAnonymous:true,providerData:[]};
    storeSet('authUid','account-c');
    window._currentUid='account-c';
    clearIdTokenCache();
    setFreeRoundAvailability(await freeRoundIsAvailable('account-c'));
    go('s-home');
    const allowed=canStartRound();
    return {
      allowed,available:_freeRoundAvailable,
      state:_freeRoundVerificationState,
      screen:document.querySelector('.screen.active')?.id,
    };
  });
  assert.deepEqual(failClosed,{
    allowed:false,available:false,state:'unknown',screen:'s-home',
  },'503 أو الأوفلاين يبقى unknown ولا يتحول إلى جولة مجانية أو paywall خاطئ');

  const attestationRecovery=await page.evaluate(async()=>{
    const plugin=window.Capacitor.Plugins.FatinahDeviceIntegrity;
    let keyId='';
    let generations=0;
    let resets=0;
    let attestCalls=0;
    plugin.generateKey=async()=>{
      if(!keyId) keyId=`attest-recovery-key-${++generations}`;
      return {keyId};
    };
    plugin.resetKey=async()=>{
      resets+=1;
      keyId='';
      return {reset:true};
    };
    plugin.attestKey=async()=>{
      attestCalls+=1;
      if(attestCalls===1){
        throw Object.assign(new Error('missing key'),{
          code:'APP_ATTEST_KEY_NOT_GENERATED',
        });
      }
      return {attestationObject:'recovered-attestation'};
    };
    _appAttestKeyId='';
    _appAttestEnrollment=null;
    const enrolledKey=await ensureAppAttestEnrollment(
      window._currentUid,{resetAttempted:false});
    return {enrolledKey,generations,resets,attestCalls};
  });
  assert.deepEqual(attestationRecovery,{
    enrolledKey:'attest-recovery-key-2',generations:2,resets:1,attestCalls:2,
  },'فشل attestKey يعيد التسجيل مرة واحدة فقط دون حلقة');

  console.log('✓ DeviceCheck يمنع تكرار الجولة بين UIDs ويفشل مغلقاً عند تعذر التحقق');
}finally{
  await browser.close();
}
