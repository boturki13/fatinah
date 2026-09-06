import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const url=`file://${path.join(root,'www/index.html')}`;
const uid='timeout-routing-user';
const rcAppUserId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function installHarness(){
  window.__FATINAH_GAME_FLOW_UI_TEST__=true;
  const user={uid:'timeout-routing-user',isAnonymous:false,providerData:[{providerId:'password'}]};
  const ok=()=>Promise.resolve({});
  window.Capacitor={
    isNativePlatform:()=>true,
    Plugins:{
      FirebaseAuthentication:{
        getCurrentUser:()=>Promise.resolve({user}),
        getIdToken:()=>Promise.resolve({token:'timeout-routing-token'}),
      },
      RevenueCatKeyStore:{get:()=>Promise.resolve({value:'appl_TIMEOUT_TEST'}),set:ok,clear:ok},
      FirebaseCrashlytics:{setEnabled:ok,recordException:ok,setUserId:ok},
      SplashScreen:{hide:ok},
      Preferences:{keys:()=>Promise.resolve({keys:[]}),get:()=>Promise.resolve({value:null}),set:ok,remove:ok},
    },
  };
}

const browser=await chromium.launch();
try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.addInitScript({path:path.join(root,'tests/fixtures/game-flow-server.js')});
  await page.addInitScript(installHarness);
  await page.route('**/*',route=>{
    const requestUrl=route.request().url();
    if(requestUrl.startsWith('file://')) return route.continue();
    if(requestUrl.includes('/api/v2/subscription/status')){
      return route.fulfill({status:503,contentType:'application/json',body:'{"error":"temporary"}'});
    }
    if(requestUrl.includes('/api/v2/revenuecat/identity')){
      return route.fulfill({
        status:200,contentType:'application/json',body:JSON.stringify({rcAppUserId}),
      });
    }
    return route.fulfill({status:200,contentType:'application/json',body:'{}'});
  });
  await page.goto(url);
  await page.waitForFunction(()=>document.body.dataset.gameFlowUiTest==='ready');

  const timeoutAudit=await page.evaluate(async()=>{
    const originalFetch=window.fetch;
    window.fetch=(_url,options={})=>new Promise((resolve,reject)=>{
      const signal=options.signal;
      const rejectAbort=()=>reject(signal?.reason||new DOMException('Aborted','AbortError'));
      if(signal?.aborted) rejectAbort();
      else signal?.addEventListener('abort',rejectAbort,{once:true});
    });
    try{
      let timeoutError=null;
      try{ await apiFetch('/api/never',{timeoutMs:25}); }
      catch(error){ timeoutError={name:error.name,code:error.code,path:error.path,timeoutMs:error.timeoutMs}; }

      const caller=new AbortController();
      const originalAdd=AbortSignal.prototype.addEventListener;
      const originalRemove=AbortSignal.prototype.removeEventListener;
      let added=0,removed=0;
      AbortSignal.prototype.addEventListener=function(type,...args){
        if(this===caller.signal&&type==='abort') added++;
        return originalAdd.call(this,type,...args);
      };
      AbortSignal.prototype.removeEventListener=function(type,...args){
        if(this===caller.signal&&type==='abort') removed++;
        return originalRemove.call(this,type,...args);
      };
      let callerError='';
      try{
        const pending=apiFetch('/api/caller-abort',{signal:caller.signal,timeoutMs:1000});
        setTimeout(()=>caller.abort(),10);
        await pending;
      }catch(error){ callerError=error.name; }
      finally{
        AbortSignal.prototype.addEventListener=originalAdd;
        AbortSignal.prototype.removeEventListener=originalRemove;
      }
      return {timeoutError,callerError,added,removed};
    }finally{
      window.fetch=originalFetch;
    }
  });
  assert.deepEqual(timeoutAudit.timeoutError,{
    name:'ApiFetchTimeoutError',code:'api/timeout',path:'/api/v2/never',timeoutMs:25,
  });
  assert.equal(timeoutAudit.callerError,'AbortError','إلغاء المستدعي يبقى AbortError ولا يُصنّف timeout.');
  assert.deepEqual({added:timeoutAudit.added,removed:timeoutAudit.removed},{added:1,removed:1},
    'مستمع AbortSignal المستدعي يُزال بعد اكتمال الطلب.');
  console.log('✓ apiFetch يصنّف timeout، يدمج AbortSignal، ويزيل المستمع');

  const bodyAudit=await page.evaluate(async()=>{
    const originalFetch=window.fetch;
    try{
      window.fetch=async()=>new Response(new ReadableStream({
        start(controller){ controller.enqueue(new TextEncoder().encode('{"partial":'));
        },
      }),{status:200,statusText:'OK',headers:{'Content-Type':'application/json'}});
      let timeoutError=null;
      try{ await apiFetch('/api/stalled-body',{timeoutMs:35}); }
      catch(error){ timeoutError={name:error.name,code:error.code,path:error.path}; }

      window.fetch=async requestUrl=>{
        if(String(requestUrl).includes('no-content')){
          return new Response(null,{status:204,statusText:'No Content',headers:{'X-Probe':'empty'}});
        }
        const response=new Response('{"ok":true}',{
          status:201,statusText:'Created',headers:{'Content-Type':'application/json','X-Probe':'buffered'},
        });
        Object.defineProperty(response,'url',{value:'https://api.example.invalid/original',configurable:true});
        return response;
      };
      const buffered=await apiFetch('/api/buffered',{timeoutMs:300});
      const bufferedMeta={
        status:buffered.status,statusText:buffered.statusText,
        header:buffered.headers.get('X-Probe'),url:buffered.url,payload:await buffered.json(),
      };
      const empty=await apiFetch('/api/no-content',{timeoutMs:300});
      const emptyMeta={
        status:empty.status,statusText:empty.statusText,
        header:empty.headers.get('X-Probe'),text:await empty.text(),
      };
      return {timeoutError,bufferedMeta,emptyMeta};
    }finally{ window.fetch=originalFetch; }
  });
  assert.deepEqual(bodyAudit.timeoutError,{
    name:'ApiFetchTimeoutError',code:'api/timeout',path:'/api/v2/stalled-body',
  },'المهلة تشمل قراءة body بعد وصول headers.');
  assert.deepEqual(bodyAudit.bufferedMeta,{
    status:201,statusText:'Created',header:'buffered',
    url:'https://api.example.invalid/original',payload:{ok:true},
  });
  assert.deepEqual(bodyAudit.emptyMeta,{status:204,statusText:'No Content',header:'empty',text:''});
  console.log('✓ apiFetch يشمل body في المهلة ويحفظ metadata وحالات 204');

  const appCheckAudit=await page.evaluate(async()=>{
    const resetIntegrity=()=>{
      _appIntegrityReady=false;
      _appIntegrityAttempt=null;
      _appIntegrityRetryAfter=0;
      _appIntegrityTokenAttempt=null;
      _appIntegrityTokenRetryAfter=0;
    };
    let initCalls=0,tokenCalls=0;
    resetIntegrity();
    window.Capacitor.Plugins.FirebaseAppCheck={
      setTokenAutoRefreshEnabled:()=>{ initCalls++; return new Promise(()=>{}); },
      getToken:()=>{ tokenCalls++; return Promise.resolve({token:'unused'}); },
    };
    const initStarted=performance.now();
    const initResponse=await apiFetch('/api/app-check-init-probe',{timeoutMs:600});
    const initElapsed=performance.now()-initStarted;

    resetIntegrity();
    window.Capacitor.Plugins.FirebaseAppCheck={
      setTokenAutoRefreshEnabled:()=>{ initCalls++; return Promise.resolve(); },
      getToken:()=>{ tokenCalls++; return new Promise(()=>{}); },
    };
    const tokenStarted=performance.now();
    const tokenResponse=await apiFetch('/api/app-check-token-probe',{timeoutMs:600});
    const tokenElapsed=performance.now()-tokenStarted;
    const retryStarted=performance.now();
    const retryResponse=await apiFetch('/api/app-check-backoff-probe',{timeoutMs:600});
    const retryElapsed=performance.now()-retryStarted;
    delete window.Capacitor.Plugins.FirebaseAppCheck;
    resetIntegrity();
    return {
      initOk:initResponse.ok,tokenOk:tokenResponse.ok,retryOk:retryResponse.ok,
      initElapsed,tokenElapsed,retryElapsed,initCalls,tokenCalls,
    };
  });
  assert.equal(appCheckAudit.initOk,true);
  assert.equal(appCheckAudit.tokenOk,true);
  assert.equal(appCheckAudit.retryOk,true);
  assert.equal(appCheckAudit.tokenCalls,1,'تعلّق getToken يفعّل backoff ولا يتكرر في الطلب التالي.');
  assert.ok(appCheckAudit.initElapsed<600&&appCheckAudit.tokenElapsed<600&&appCheckAudit.retryElapsed<300,
    `App Check المعلّق لا يسمّم الشبكة: ${JSON.stringify(appCheckAudit)}`);
  console.log('✓ تعلّق تهيئة/App Check token لا يمنع apiFetch من الوصول للشبكة');

  // حاكِ RevenueCat SDK لا يعود أبداً. قرار الإقلاع يجب أن يحسم fallback ولا يترك loading.
  const routing=await page.evaluate(async({uid})=>{
    window._currentUid=uid;
    storeSet('authUid',uid);
    storeSet('authProvider','password');
    clearIdTokenCache();
    RC_API_KEY='appl_TIMEOUT_TEST';
    RC_CONFIGURED=true;
    RC_SDK_CONFIGURED=false;
    RC_CURRENT_APP_USER_ID='';
    _rcReady=null;
    window.Capacitor.Plugins.Purchases={
      configure:()=>Promise.resolve(),
      getCustomerInfo:()=>new Promise(()=>{}),
    };
    const started=performance.now();
    await checkSubscriptionAndRoute(uid,{showLoading:true,revenueCatTimeoutMs:35});
    return {
      elapsed:performance.now()-started,
      screen:document.querySelector('.screen.active')?.id||'',
      resolved:_subscriptionResolved,
      active:_hasActiveSubscription,
    };
  },{uid});
  assert.equal(routing.screen,'s-home');
  assert.equal(routing.resolved,true);
  assert.equal(routing.active,false);
  assert.ok(routing.elapsed<1000,`مسار fallback لازم ينتهي بسرعة في الاختبار؛ ${routing.elapsed.toFixed(0)}ms.`);
  console.log('✓ مسار الإقلاع يغادر شاشة التحميل إلى fallback حتى إذا تعلّق RevenueCat');

  await page.close();
}finally{
  await browser.close();
}
