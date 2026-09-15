// تطبيق iOS يعمل من capacitor://localhost؛ لذلك يجب توجيه طلبات الخادم
// صراحةً إلى النطاق المنشور، لا إلى مصدر WebView المحلي.
const IS_NATIVE_APP=window.Capacitor?.isNativePlatform?.()===true;
// نسخة Xcode التجريبية يمكنها تحميل الواجهة من خادم LAN؛ عندها يجب أن تبقى
// طلبات API على المصدر نفسه. نسخة Release تعمل من capacitor://localhost
// وتبقى مقيدة بخادم الإنتاج.
const IS_NATIVE_LAN_TEST=IS_NATIVE_APP
  &&!['localhost','127.0.0.1','::1'].includes(window.location.hostname)
  &&/^https?:$/.test(window.location.protocol);
const API_ORIGIN = IS_NATIVE_APP
  ? (IS_NATIVE_LAN_TEST?window.location.origin:'https://ata20.com')
  : '';
// معاينة المتصفح المحلية لا تملك DeviceCheck أو App Attest الخاصة بأجهزة Apple.
// الاستثناء محصور بعناوين loopback ولا يعمل على staging العام أو production.
function isLoopbackWebHost(){
  return window.Capacitor?.isNativePlatform?.()!==true
    &&['127.0.0.1','localhost','::1'].includes(window.location.hostname);
}
function isLocalWebPreview(){
  if(window.Capacitor?.isNativePlatform?.()===true) return false;
  const automatedFileFixture=window.location.protocol==='file:'&&navigator.webdriver===true;
  return (isLoopbackWebHost()||automatedFileFixture)
    &&new URLSearchParams(window.location.search).get('preview')==='1';
}
// الإصدار 1.4 لا يستعمل العقود القديمة ضمنياً. نضع النسخة في المسار والرأس حتى
// لا يعيد وسيط شبكة أو CDN الطلب بالخطأ إلى v1 عند إسقاط أحدهما.
const API_CONTRACT_VERSION='2';
// سجلات WebView قد تظهر في Web Inspector أو سجلات الجهاز. لا نمرر إليها
// كائنات أخطاء Firebase/RevenueCat أو رسائل أو بريد أو هاتف أو token؛ نطبع
// حدثاً ثابتاً من قائمة داخلية فقط.
const CLIENT_LOG_EVENT_ALLOWLIST=new Set([
  'paywall.prices','auth.reauth.start','auth.reauth.apple',
  'auth.delete.reauthentication','auth.delete.capacitor',
  'auth.delete.web-reauthentication','auth.delete.web','auth.signout',
  'account.server-delete','auth.anonymous.disabled',
  'auth.anonymous.capacitor','auth.anonymous.web','profile.save',
  'auth.pending-link','messaging.received','messaging.opened',
  'messaging.token-received','messaging.token-ready','firebase.web-sdk',
  'auth.apple.capacitor','auth.apple.web','auth.google.capacitor',
  'auth.google.web','auth.phone.start','auth.phone.confirm',
  'auth.password-reset','auth.forgot-email','auth.email',
  'auth.native-user','auth.web-user','auth.email-verification',
  'auth.verification-refresh','revenuecat.keychain-read',
  'revenuecat.configure','revenuecat.logout','revenuecat.initialize',
  'revenuecat.status','revenuecat.offline-cache','question-bank.load',
  'account.unlink','revenuecat.deferred-startup',
]);
function logClientEvent(level,event){
  const safeEvent=CLIENT_LOG_EVENT_ALLOWLIST.has(event)?event:'application.event';
  const logger=level==='error'?console.error:level==='warn'?console.warn:console.info;
  try{ logger.call(console,`[Fatinah] ${safeEvent}`); }catch(_){ }
}
function versionedApiPath(path){
  const value=String(path||'');
  if(/^\/api\/v[12](?:\/|$)/.test(value)) return value;
  if(value==='/api') return `/api/v${API_CONTRACT_VERSION}`;
  if(value.startsWith('/api/')) return `/api/v${API_CONTRACT_VERSION}${value.slice(4)}`;
  return value;
}
function apiUrl(path){ return `${API_ORIGIN}${versionedApiPath(path)}`; }
const API_FETCH_TIMEOUT_MS=12000;
class ApiFetchTimeoutError extends Error{
  constructor(path,timeoutMs){
    super(`API request timed out after ${timeoutMs}ms`);
    this.name='ApiFetchTimeoutError';
    this.code='api/timeout';
    this.path=versionedApiPath(path);
    this.timeoutMs=timeoutMs;
  }
}
async function settleWithin(promise,timeoutMs,fallbackValue){
  let timer=0;
  const deadline=new Promise(resolve=>{ timer=setTimeout(()=>resolve(fallbackValue),timeoutMs); });
  try{ return await Promise.race([Promise.resolve(promise),deadline]); }
  finally{ clearTimeout(timer); }
}
// App Attest may need a few seconds on the first TestFlight launch while iOS
// creates/loads the key and exchanges it for a Firebase App Check token.
const APP_INTEGRITY_ATTEMPT_TIMEOUT_MS=6000;
const APP_INTEGRITY_RETRY_DELAY_MS=30000;
let _appIntegrityReady=false;
let _appIntegrityAttempt=null;
let _appIntegrityRetryAfter=0;
let _appIntegrityTokenAttempt=null;
let _appIntegrityTokenRetryAfter=0;
function getFirebaseAppCheck(){
  try{ return window.Capacitor?.Plugins?.FirebaseAppCheck || null; }
  catch(_){ return null; }
}
function initAppIntegrity(){
  if(_appIntegrityReady) return Promise.resolve(true);
  if(_appIntegrityAttempt) return _appIntegrityAttempt;
  if(Date.now()<_appIntegrityRetryAfter) return Promise.resolve(false);
  const attempt=(async()=>{
    const appCheck=getFirebaseAppCheck();
    if(!appCheck) return false;
    await appCheck.setTokenAutoRefreshEnabled({enabled:true});
    _appIntegrityReady=true;
    return true;
  })().catch(error=>{
    recordNonFatal(error,'firebase.app-check.initialize');
    _appIntegrityRetryAfter=Date.now()+APP_INTEGRITY_RETRY_DELAY_MS;
    return false;
  }).finally(()=>{
    if(_appIntegrityAttempt===attempt) _appIntegrityAttempt=null;
  });
  _appIntegrityAttempt=attempt;
  return attempt;
}
async function initAppIntegrityWithin(timeoutMs=APP_INTEGRITY_ATTEMPT_TIMEOUT_MS){
  if(_appIntegrityReady) return true;
  const attempt=initAppIntegrity();
  const timedOut=Symbol('app-integrity-timeout');
  const result=await settleWithin(attempt,timeoutMs,timedOut);
  if(result===timedOut){
    // لا نسمح لمحاولة native معلّقة بتسميم كل طلبات الجلسة. الطلب الحالي
    // يكمل بلا App Check، ثم يُسمح بمحاولة جديدة بعد مهلة ارتداد قصيرة.
    if(_appIntegrityAttempt===attempt) _appIntegrityAttempt=null;
    _appIntegrityRetryAfter=Date.now()+APP_INTEGRITY_RETRY_DELAY_MS;
    return false;
  }
  return result===true;
}
async function getAppIntegrityTokenWithin(timeoutMs=APP_INTEGRITY_ATTEMPT_TIMEOUT_MS,{forceRefresh=false}={}){
  if(!forceRefresh&&Date.now()<_appIntegrityTokenRetryAfter) return '';
  const appCheck=getFirebaseAppCheck();
  if(!appCheck?.getToken) return '';
  let attempt=forceRefresh?null:_appIntegrityTokenAttempt;
  if(!attempt){
    attempt=Promise.resolve().then(()=>appCheck.getToken({forceRefresh}));
    if(!forceRefresh){
      _appIntegrityTokenAttempt=attempt;
      void attempt.finally(()=>{
        if(_appIntegrityTokenAttempt===attempt) _appIntegrityTokenAttempt=null;
      }).catch(()=>{});
    }
  }
  const timedOut=Symbol('app-integrity-token-timeout');
  try{
    const result=await settleWithin(attempt,timeoutMs,timedOut);
    if(result===timedOut){
      if(_appIntegrityTokenAttempt===attempt) _appIntegrityTokenAttempt=null;
      _appIntegrityTokenRetryAfter=Date.now()+APP_INTEGRITY_RETRY_DELAY_MS;
      const error=new Error('Firebase App Check token timed out');
      error.code='app-check/timeout';
      recordNonFatal(error,'firebase.app-check.token');
      return '';
    }
    const token=String(result?.token||'');
    if(token) _appIntegrityTokenRetryAfter=0;
    return token;
  }catch(error){
    _appIntegrityTokenRetryAfter=Date.now()+APP_INTEGRITY_RETRY_DELAY_MS;
    recordNonFatal(error,'firebase.app-check.token');
    return '';
  }
}
function bufferApiResponse(response,body,method){
  const hasBody=method!=='HEAD'&&![204,205,304].includes(response.status);
  const buffered=new Response(hasBody?body:null,{
    status:response.status,
    statusText:response.statusText,
    headers:new Headers(response.headers),
  });
  // Response المُنشأ محلياً يفقد بيانات المصدر؛ احتفظ بها للمستدعين حتى
  // لو لم تكن واجهاتنا الحالية تعتمد عليها.
  for(const property of ['url','redirected','type']){
    try{ Object.defineProperty(buffered,property,{value:response[property],configurable:true}); }
    catch(_){ /* الخصائص وصفية فقط ولا تؤثر على قراءة JSON المخزّن */ }
  }
  return buffered;
}
async function apiFetch(path, options={}){
  const {signal:callerSignal,timeoutMs:requestedTimeout,...fetchOptions}=options;
  const timeoutMs=Number.isFinite(requestedTimeout)&&requestedTimeout>0
    ?Math.floor(requestedTimeout):API_FETCH_TIMEOUT_MS;
  const controller=new AbortController();
  let settled=false;
  let timedOut=false;
  let timer=0;
  let rejectDeadline=()=>{};
  const deadline=new Promise((_,reject)=>{ rejectDeadline=reject; });
  const callerAbort=()=>{
    if(settled) return;
    const reason=callerSignal?.reason instanceof Error
      ?callerSignal.reason:new DOMException('The operation was aborted.','AbortError');
    controller.abort(reason);
    rejectDeadline(reason);
  };
  if(callerSignal?.aborted) callerAbort();
  else callerSignal?.addEventListener('abort',callerAbort,{once:true});
  timer=setTimeout(()=>{
    if(settled) return;
    timedOut=true;
    const error=new ApiFetchTimeoutError(path,timeoutMs);
    controller.abort(error);
    rejectDeadline(error);
  },timeoutMs);
  const request=(async()=>{
    const headers=new Headers(fetchOptions.headers||{});
    headers.set('X-Fatinah-API-Version',API_CONTRACT_VERSION);
    const integrityBudget=Math.min(
      APP_INTEGRITY_ATTEMPT_TIMEOUT_MS,
      Math.max(25,Math.floor(timeoutMs/2)),
    );
    if(await initAppIntegrityWithin(integrityBudget)){
      // الخادم يبدأ بوضع المراقبة؛ فشل/تعليق App Check لا يوقف الشبكة.
      const appCheckToken=await getAppIntegrityTokenWithin(integrityBudget);
      if(appCheckToken) headers.set('X-Firebase-AppCheck',appCheckToken);
    }
    if(controller.signal.aborted) throw controller.signal.reason;
    const performFetch=async()=>{
      const response=await fetch(apiUrl(path),{...fetchOptions,headers,signal:controller.signal});
      const method=String(fetchOptions.method||'GET').toUpperCase();
      const hasBody=method!=='HEAD'&&![204,205,304].includes(response.status);
      const body=hasBody?await response.arrayBuffer():null;
      return bufferApiResponse(response,body,method);
    };
    let response=await performFetch();
    if([401,403].includes(response.status)){
      const failure=await response.clone().json().catch(()=>null);
      if(failure?.code==='app_check_failed'){
        const refreshedToken=await getAppIntegrityTokenWithin(integrityBudget,{forceRefresh:true});
        if(refreshedToken){
          headers.set('X-Firebase-AppCheck',refreshedToken);
          response=await performFetch();
        }
      }
    }
    return response;
  })();
  try{
    return await Promise.race([request,deadline]);
  }catch(error){
    if(timedOut&&!(error instanceof ApiFetchTimeoutError)){
      throw new ApiFetchTimeoutError(path,timeoutMs);
    }
    throw error;
  }finally{
    settled=true;
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort',callerAbort);
  }
}
const APP_VERSION = '1.4';
let _hasActiveSubscription=false;
let _freeRoundAvailable=false;
let _freeRoundVerificationState='unknown'; // unknown | eligible | used
let _freeRoundVerificationPending=false;
let _freeRoundVerificationAttempt=0;
let _subscriptionResolved=false;
let _subscriptionCheckFlight=null;
let _subscriptionCheckGeneration=0;
let state={roundActive:false};

// ────────── التخزين الدائم
// أولوية: Capacitor Preferences (تخزين أصلي داخل تطبيق iOS) إن توفّر، وإلا localStorage (يعمل في المتصفح وداخل WKWebView أيضاً).
// هذا يحل مشكلة فقدان كل البيانات عند إغلاق التطبيق.
const STORAGE_PREFIX='fatinah_';
// ────────── XSS sanitizer
function esc(str){ const d=document.createElement('div'); d.textContent=String(str||''); return d.innerHTML; }
function isHttpsUrl(value){
  try{ return new URL(String(value||'')).protocol==='https:'; }
  catch(_){ return false; }
}
function safeHttpsUrl(value){
  try{
    const url=new URL(String(value||''));
    if(url.protocol!=='https:'||url.username||url.password) return '';
    return url.href;
  }catch(_){ return ''; }
}
function storeGet(key, fallback){
  try{
    const raw=localStorage.getItem(STORAGE_PREFIX+key);
    if(raw!=null) return JSON.parse(raw);
  }catch(e){ /* وضع تصفّح خاص أو تخزين معطّل — نستخدم الافتراضي */ }
  return fallback;
}
function storeSet(key, value){
  try{ localStorage.setItem(STORAGE_PREFIX+key, JSON.stringify(value)); }catch(e){}
  // مزامنة اختيارية مع Capacitor Preferences الأصلي إن توفّر (لا تحجب الحفظ الفوري في localStorage)
  try{
    const P=window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences;
    if(P) P.set({key:STORAGE_PREFIX+key, value:JSON.stringify(value)});
  }catch(e){}
}
function storeRemove(key){
  try{ localStorage.removeItem(STORAGE_PREFIX+key); }catch(e){}
  try{
    const P=window.Capacitor?.Plugins?.Preferences;
    if(P) void P.remove({key:STORAGE_PREFIX+key});
  }catch(e){}
}

// ────────── استكمال الجولة النشطة
// اللقطة مربوطة بالحساب ولا تحتوي عناصر DOM أو مؤقّتات. كل Set يتحول إلى
// مصفوفة، ثم يعاد بناؤه عند الاستعادة. الكتابة المحلية كل ثانية تحفظ العداد،
// بينما Preferences الأصلي يُحدّث عند الانتقالات المهمة وعند مغادرة التطبيق.
async function routeAfterAccessCheck(uid){
  updateFreeRoundUi(); hideSplash();
  go('s-home');
}

async function hydrateNativePreferences(){
  const P=window.Capacitor?.Plugins?.Preferences;
  if(!P) return 0;
  try{
    const result=await P.keys();
    const keys=(result?.keys||[]).filter(key=>key.startsWith(STORAGE_PREFIX));
    let restored=0;
    for(const key of keys){
      if(localStorage.getItem(key)!=null) continue;
      const item=await P.get({key});
      if(item?.value==null) continue;
      // تحقق أن القيمة ما زالت JSON صالحاً قبل نسخها إلى مخزن WebView.
      JSON.parse(item.value);
      localStorage.setItem(key,item.value);
      restored++;
    }
    return restored;
  }catch(error){
    recordNonFatal(error,'preferences.hydrate');
    return 0;
  }
}

const REMOVED_QUESTION_STORAGE_PREFIXES = Object.freeze([
  'active_round',
  'family',
  'free_round_start_pending',
  'question_history',
  'question_reservation_release',
  'question_seen_outbox',
  'question_seen_seeded',
]);
function isRemovedQuestionStorageKey(key){
  const normalized=String(key||'').replace(new RegExp(`^${STORAGE_PREFIX}`),'');
  return REMOVED_QUESTION_STORAGE_PREFIXES.some(prefix=>
    normalized===prefix||normalized.startsWith(`${prefix}_`));
}
async function purgeRemovedQuestionStorage(){
  try{
    Object.keys(localStorage)
      .filter(key=>key.startsWith(STORAGE_PREFIX)&&isRemovedQuestionStorageKey(key))
      .forEach(key=>localStorage.removeItem(key));
  }catch(_){ /* التخزين المحلي قد يكون معطلاً */ }
  try{
    const P=window.Capacitor?.Plugins?.Preferences;
    if(!P) return;
    const result=await P.keys();
    await Promise.all((result?.keys||[])
      .filter(key=>key.startsWith(STORAGE_PREFIX)&&isRemovedQuestionStorageKey(key))
      .map(key=>P.remove({key})));
  }catch(error){ recordNonFatal(error,'preferences.question-content-purge'); }
}

function scopedAccessKey(prefix,uid){
  const owner=String(uid||window._currentUid||storeGet('authUid','guest')||'guest')
    .replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,128);
  return `${prefix}_${owner}`;
}
function storageHas(key){
  try{ return localStorage.getItem(STORAGE_PREFIX+key)!==null; }
  catch(_){ return false; }
}
// الإصدارات السابقة خزّنت الإحصاءات بمفتاح عام للجهاز.
// ننسبها للحساب الموجود وقت الترقية مرة واحدة فقط؛ وإلا قد تُنسخ بيانات
// الحساب الأول إلى كل حساب جديد يستخدم الجهاز نفسه.
function migrateLegacyAccountData(uid){
  if(!uid) return;
  const legacyKeys=['stats'];
  const hasLegacy=legacyKeys.some(storageHas);
  let owner=storeGet('legacy_account_data_owner','');
  if(!owner&&hasLegacy){
    owner=String(uid);
    storeSet('legacy_account_data_owner',owner);
  }
  if(owner!==String(uid)) return;
  legacyKeys.forEach(key=>{
    const scopedKey=scopedAccessKey(key,uid);
    if(storageHas(scopedKey)||!storageHas(key)) return;
    storeSet(scopedKey,storeGet(key,key==='stats'?emptyStats():[]));
  });
}
function activateLocalAccount(uid){
  if(!uid){ stats=emptyStats(); return; }
  migrateLegacyAccountData(uid);
  stats=loadStats(uid);
}
function localFreeRoundCompleted(uid){
  return storeGet(scopedAccessKey('free_round_completed',uid),false)===true;
}
async function generateDeviceCheckToken(){
  const plugin=window.Capacitor?.Plugins?.FatinahDeviceIntegrity;
  if(!window.Capacitor?.isNativePlatform?.() || !plugin?.generateDeviceCheckToken){
    return '';
  }
  try{
    const result=await plugin.generateDeviceCheckToken();
    return String(result?.token||'');
  }catch(error){
    recordNonFatal(error,'device-check.token');
    return '';
  }
}
let _appAttestKeyId='';
let _appAttestEnrollment=null;
function getDeviceIntegrityPlugin(){
  try{ return window.Capacitor?.Plugins?.FatinahDeviceIntegrity||null; }
  catch(_){ return null; }
}
function appAttestErrorCode(error){
  return String(error?.code||'').trim();
}
function appAttestKeyNeedsReset(error){
  const code=appAttestErrorCode(error);
  return code==='APP_ATTEST_INVALID_KEY'||code==='APP_ATTEST_KEY_NOT_GENERATED';
}
async function resetAppAttestKeyForRecovery(plugin,error,recovery){
  if(!appAttestKeyNeedsReset(error)||recovery.resetAttempted||!plugin?.resetKey){
    return false;
  }
  recovery.resetAttempted=true;
  try{
    const result=await plugin.resetKey();
    if(result?.reset!==true) throw new Error('تعذّرت إعادة تعيين App Attest');
    _appAttestKeyId='';
    return true;
  }catch(resetError){
    recordNonFatal(resetError,'app-attest.reset');
    return false;
  }
}
function decodeBase64Bytes(value){
  const binary=atob(String(value||''));
  return Uint8Array.from(binary,char=>char.charCodeAt(0));
}
function encodeBase64Bytes(bytes){
  let binary='';
  const view=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  for(let offset=0;offset<view.length;offset+=0x8000){
    binary+=String.fromCharCode(...view.subarray(offset,offset+0x8000));
  }
  return btoa(binary);
}
async function sha256Bytes(bytes){
  if(!globalThis.crypto?.subtle) throw new Error('SHA-256 غير متاح');
  return new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
}
async function sha256Base64OfBase64(value){
  return encodeBase64Bytes(await sha256Bytes(decodeBase64Bytes(value)));
}
async function sha256HexText(value){
  const digest=await sha256Bytes(new TextEncoder().encode(String(value||'')));
  return [...digest].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
async function freeRoundRequestHash(uid,deviceCheckToken,deviceCheckUpdateToken=''){
  const canonical=JSON.stringify({
    deviceCheckTokenHash:await sha256HexText(deviceCheckToken),
    deviceCheckUpdateTokenHash:deviceCheckUpdateToken
      ?await sha256HexText(deviceCheckUpdateToken):'',
    uid:String(uid||''),
  });
  return sha256HexText(canonical);
}
async function requestAppAttestChallenge(uid,keyId,purpose,requestHash=''){
  const idToken=await getCurrentIdToken();
  if(!idToken) return null;
  const response=await apiFetch('/api/app-attest/challenge',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+idToken},
    body:JSON.stringify({uid,idToken,keyId,purpose,requestHash}),
  });
  if(!response.ok) return null;
  const data=await response.json();
  if(!data?.challengeId||!data?.clientData) return null;
  return data;
}
async function performAppAttestEnrollment(uid,plugin,recovery){
  const support=await plugin.isSupported?.();
  if(support?.isSupported!==true) return null;
  const generated=await plugin.generateKey();
  const keyId=String(generated?.keyId||'');
  if(!keyId) return null;
  const idToken=await getCurrentIdToken();
  if(!idToken) return null;
  const statusResponse=await apiFetch('/api/app-attest/status',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+idToken},
    body:JSON.stringify({uid,idToken,keyId}),
  });
  if(statusResponse.ok){
    const status=await statusResponse.json();
    if(status?.attested===true){ _appAttestKeyId=keyId; return keyId; }
  }
  const challenge=await requestAppAttestChallenge(uid,keyId,'attest');
  if(!challenge) return null;
  const clientDataHash=await sha256Base64OfBase64(challenge.clientData);
  let artifact;
  try{
    artifact=await plugin.attestKey({keyId,clientDataHash});
  }catch(error){
    if(await resetAppAttestKeyForRecovery(plugin,error,recovery)){
      return performAppAttestEnrollment(uid,plugin,recovery);
    }
    throw error;
  }
  const attestationObject=String(artifact?.attestationObject||'');
  if(!attestationObject) return null;
  const response=await apiFetch('/api/app-attest/attest',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+idToken},
    body:JSON.stringify({
      uid,idToken,keyId,challengeId:challenge.challengeId,attestationObject,
    }),
  });
  if(!response.ok) return null;
  _appAttestKeyId=keyId;
  return keyId;
}
async function ensureAppAttestEnrollment(uid,recovery={resetAttempted:false}){
  const plugin=getDeviceIntegrityPlugin();
  if(!window.Capacitor?.isNativePlatform?.()||!plugin?.generateKey||!plugin?.attestKey){
    return null;
  }
  if(_appAttestKeyId) return _appAttestKeyId;
  if(_appAttestEnrollment) return _appAttestEnrollment;
  _appAttestEnrollment=performAppAttestEnrollment(uid,plugin,recovery).catch(error=>{
    recordNonFatal(error,'app-attest.enroll');
    return null;
  }).finally(()=>{ _appAttestEnrollment=null; });
  return _appAttestEnrollment;
}
async function createAppAttestAssertion(
  uid,purpose,requestHash='',recovery={resetAttempted:false}){
  const plugin=getDeviceIntegrityPlugin();
  const keyId=await ensureAppAttestEnrollment(uid,recovery);
  if(!keyId||!plugin?.generateAssertion) return null;
  try{
    const challenge=await requestAppAttestChallenge(
      uid,keyId,purpose,requestHash);
    if(!challenge) return null;
    const clientDataHash=await sha256Base64OfBase64(challenge.clientData);
    const artifact=await plugin.generateAssertion({keyId,clientDataHash});
    const assertion=String(artifact?.assertion||'');
    if(!assertion) return null;
    return {keyId,challengeId:challenge.challengeId,assertion,requestHash};
  }catch(error){
    if(await resetAppAttestKeyForRecovery(plugin,error,recovery)){
      return createAppAttestAssertion(uid,purpose,requestHash,recovery);
    }
    recordNonFatal(error,`app-attest.assertion.${purpose}`);
    return null;
  }
}
function setFreeRoundAvailability(value){
  _freeRoundAvailable=value===true;
  _freeRoundVerificationState=value===true?'eligible':(value===false?'used':'unknown');
  updateFreeRoundUi();
}
function updateFreeRoundUi(){
  const banner=document.getElementById('free-round-banner');
  if(!banner) return;
  if(_hasActiveSubscription){ banner.hidden=true; return; }
  banner.hidden=false;
  banner.replaceChildren();
  banner.setAttribute('aria-busy',String(_freeRoundVerificationPending));
  if(_freeRoundVerificationState==='eligible'){
    banner.textContent='🎁 أول جولة عليك بالكامل — شاشة الاشتراك ما تطلع إلا عقب ما تخلّصها';
    return;
  }
  if(_freeRoundVerificationState==='used'){
    banner.textContent='✓ خلصت جولتك المجانية — اشترك عشان تفتح جولات بلا حدود';
    return;
  }
  if(_freeRoundVerificationPending){
    banner.textContent='⏳ جاري التحقق من جولتك المجانية…';
    return;
  }
  if(!navigator.onLine){
    banner.textContent='📶 ماكو اتصال بالإنترنت — بنعيد التحقق تلقائياً أول ما ترجع الشبكة';
    return;
  }
  const action=document.createElement('a');
  action.className='free-round-action';
  if(isLoopbackWebHost()){
    banner.append('🧪 حماية الجولة المجانية غير متاحة في المتصفح المحلي.');
    const previewUrl=new URL(window.location.href);
    previewUrl.searchParams.set('preview','1');
    action.href=`${previewUrl.pathname}${previewUrl.search}${previewUrl.hash}`;
    action.textContent='افتح وضع المعاينة للاختبار';
    banner.append(document.createElement('br'),action);
    return;
  }
  if(window.Capacitor?.isNativePlatform?.()!==true){
    banner.append('📱 التحقق من الجولة المجانية متاح داخل تطبيق فطنة على iPhone أو iPad.');
    action.href='/download/';
    action.textContent='نزّل التطبيق';
    banner.append(document.createElement('br'),action);
    return;
  }
  banner.append('⚠️ ما قدرنا نتحقق من جولتك المجانية حالياً.');
  const retry=document.createElement('button');
  retry.type='button'; retry.className='free-round-action';
  retry.dataset.action='retry-free-round'; retry.textContent='إعادة التحقق';
  banner.append(document.createElement('br'),retry);
}
async function syncFreeRoundCompletion(uid){
  if(!uid||!localFreeRoundCompleted(uid)) return false;
  const [idToken,deviceCheckToken,deviceCheckUpdateToken]=await Promise.all([
    getCurrentIdToken(),generateDeviceCheckToken(),generateDeviceCheckToken(),
  ]);
  if(!idToken||!deviceCheckToken||!deviceCheckUpdateToken) return false;
  const requestHash=await freeRoundRequestHash(
    uid,deviceCheckToken,deviceCheckUpdateToken);
  const appAttest=await createAppAttestAssertion(
    uid,'free_round_complete',requestHash);
  if(window.Capacitor?.isNativePlatform?.()&&!appAttest) return false;
  try{
    const response=await apiFetch('/api/free-round/complete',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+idToken},
      body:JSON.stringify({
        uid,idToken,deviceCheckToken,deviceCheckUpdateToken,
        appAttestKeyId:appAttest?.keyId||'',
        appAttestChallengeId:appAttest?.challengeId||'',
        appAttestAssertion:appAttest?.assertion||'',
        appAttestRequestHash:requestHash,
      }),
    });
    if(response.ok||response.status===409){
      storeSet(scopedAccessKey('free_round_sync_pending',uid),false);
      return response.ok;
    }
  }catch(_){ /* يبقى العلم محلياً ويُعاد عند الإقلاع القادم */ }
  return false;
}
async function freeRoundIsAvailable(uid){
  if(isLocalWebPreview()) return true;
  if(localFreeRoundCompleted(uid)){
    if(storeGet(scopedAccessKey('free_round_sync_pending',uid),false)){
      void syncFreeRoundCompletion(uid);
    }
    return false;
  }
  const [idToken,deviceCheckToken]=await Promise.all([
    getCurrentIdToken(),generateDeviceCheckToken(),
  ]);
  if(!idToken||!deviceCheckToken) return null;
  const requestHash=await freeRoundRequestHash(uid,deviceCheckToken);
  const appAttest=await createAppAttestAssertion(
    uid,'free_round_status',requestHash);
  if(window.Capacitor?.isNativePlatform?.()&&!appAttest) return null;
  try{
    const response=await apiFetch(`/api/free-round/status?uid=${encodeURIComponent(uid||'')}`,{
      headers:{
        'Authorization':'Bearer '+idToken,
        'X-DeviceCheck-Token':deviceCheckToken,
        'X-App-Attest-Key-Id':appAttest?.keyId||'',
        'X-App-Attest-Challenge-Id':appAttest?.challengeId||'',
        'X-App-Attest-Assertion':appAttest?.assertion||'',
        'X-App-Attest-Request-Hash':requestHash,
      },
    });
    if(response.ok){
      const data=await response.json();
      if(data.completed===true){
        storeSet(scopedAccessKey('free_round_completed',uid),true);
        return false;
      }
      return data.eligible===true;
    }
  }catch(_){ /* وضع دون اتصال: علم الجهاز يمنع إعادة الجولة */ }
  return null;
}
async function retryFreeRoundVerification({silent=false}={}){
  if(_freeRoundVerificationPending) return false;
  const uid=String(window._currentUid||storeGet('authUid','')||'');
  if(!uid) return false;
  const attempt=++_freeRoundVerificationAttempt;
  _freeRoundVerificationPending=true;
  updateFreeRoundUi();
  try{
    const available=await freeRoundIsAvailable(uid);
    const currentUid=String(window._currentUid||storeGet('authUid','')||'');
    if(attempt!==_freeRoundVerificationAttempt||currentUid!==uid) return false;
    setFreeRoundAvailability(available);
    if(available===null&&!silent){
      showToast('⚠️','تعذّر التحقق','تأكد من الشبكة واضغط إعادة التحقق مرة ثانية',false);
    }
    return available!==null;
  }finally{
    if(attempt===_freeRoundVerificationAttempt){
      _freeRoundVerificationPending=false;
      updateFreeRoundUi();
    }
  }
}
async function claimFreeRound(uid){
  if(_hasActiveSubscription) return false;
  if(!_freeRoundAvailable||_freeRoundVerificationState!=='eligible') return false;
  if(isLocalWebPreview()) return true;
  const [idToken,deviceCheckToken,deviceCheckUpdateToken]=await Promise.all([
    getCurrentIdToken(),generateDeviceCheckToken(),generateDeviceCheckToken(),
  ]);
  if(!idToken||!deviceCheckToken||!deviceCheckUpdateToken) return null;
  const requestHash=await freeRoundRequestHash(
    uid,deviceCheckToken,deviceCheckUpdateToken);
  const appAttest=await createAppAttestAssertion(
    uid,'free_round_complete',requestHash);
  if(window.Capacitor?.isNativePlatform?.()&&!appAttest) return null;
  try{
    const response=await apiFetch('/api/free-round/complete',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+idToken},
      body:JSON.stringify({
        uid,idToken,deviceCheckToken,deviceCheckUpdateToken,
        appAttestKeyId:appAttest?.keyId||'',
        appAttestChallengeId:appAttest?.challengeId||'',
        appAttestAssertion:appAttest?.assertion||'',
        appAttestRequestHash:requestHash,
      }),
    });
    if(response.ok){
      storeSet(scopedAccessKey('free_round_completed',uid),true);
      storeSet(scopedAccessKey('free_round_sync_pending',uid),false);
      setFreeRoundAvailability(false);
      return true;
    }
    if(response.status===409){
      storeSet(scopedAccessKey('free_round_completed',uid),true);
      storeSet(scopedAccessKey('free_round_sync_pending',uid),false);
      setFreeRoundAvailability(false);
      return false;
    }
  }catch(error){
    recordNonFatal(error,'free-round.claim');
  }
  return null;
}
function metricEventId(){
  try{ if(crypto.randomUUID) return crypto.randomUUID(); }catch(_){ }
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2,14)}`;
}
function metricOutboxKey(uid=window._currentUid||storeGet('authUid','')){
  return scopedAccessKey('metric_outbox',uid);
}
function enqueueMetricEvent(payload){
  const outbox=storeGet(metricOutboxKey(payload.uid),[]);
  if(!outbox.some(item=>item.eventId===payload.eventId)) outbox.push(payload);
  // حد محلي يمنع نمو التخزين بلا نهاية عند جهاز ظل بلا اتصال فترة طويلة.
  storeSet(metricOutboxKey(payload.uid),outbox.slice(-500));
}
let metricFlushInFlight=null;
async function flushMetricEvents(){
  const uid=window._currentUid||storeGet('authUid','');
  if(!uid) return false;
  if(metricFlushInFlight?.uid===uid) return metricFlushInFlight.promise;
  const promise=(async()=>{
    const idToken=await getCurrentIdToken();
    if(!idToken) return false;
    let delivered=false;
    for(let attempt=0;attempt<100;attempt++){
      const current=storeGet(metricOutboxKey(uid),[]);
      const item=current[0];
      if(!item) return delivered||true;
      let response;
      try{
        response=await apiFetch('/api/metrics/event',{
          method:'POST',
          headers:{'Content-Type':'application/json','Authorization':'Bearer '+idToken},
          body:JSON.stringify({...item,idToken}),
        });
      }catch(_){ return delivered; }
      // أخطاء البيانات الدائمة لا يجوز أن تسمّم الصف وتمنع الأحداث التالية.
      if(!response.ok && ![400,413,422].includes(response.status)) return delivered;
      const latest=storeGet(metricOutboxKey(uid),[]);
      storeSet(metricOutboxKey(uid),latest.filter(event=>event.eventId!==item.eventId));
      delivered=delivered||response.ok;
    }
    return delivered;
  })();
  metricFlushInFlight={uid,promise};
  try{ return await promise; }
  finally{
    if(metricFlushInFlight?.promise===promise) metricFlushInFlight=null;
  }
}
async function trackMetric(event,properties={}){
  const uid=window._currentUid||storeGet('authUid','');
  if(!uid) return false;
  const payload={uid,event,eventId:metricEventId(),appVersion:APP_VERSION,properties};
  enqueueMetricEvent(payload);
  const flushed=await flushMetricEvents();
  const remainsQueued=()=>storeGet(metricOutboxKey(uid),[])
    .some(item=>item.eventId===payload.eventId);
  // An older in-flight flush may finish successfully without observing an event
  // enqueued at its tail. Retry once only in that successful race; offline
  // failures stay queued and are reported as such without a request loop.
  if(flushed&&remainsQueued()) await flushMetricEvents();
  return !remainsQueued();
}

function loadQuestionHistory(){ return {}; }
function questionWasSeen(){ return false; }
function rememberQuestion(){}
async function syncQuestionHistory(){ return false; }

// ────────── الإحصاءات (محفوظة دائماً ومعزولة حسب الحساب)
function emptyStats(){ return {games:0, correct:0, totalQ:0, bestScore:0, wins:0, ach:{}}; }
let stats=emptyStats();
function loadStats(uid=window._currentUid||storeGet('authUid','')){
  return uid ? storeGet(scopedAccessKey('stats',uid),emptyStats()) : emptyStats();
}
function saveStats(){
  const uid=window._currentUid||storeGet('authUid','');
  if(uid) storeSet(scopedAccessKey('stats',uid),stats);
}

const ACHIEVEMENTS=[
  {id:'first', icon:'🎮', t:'أول جولة', d:'خلّصت أول جولة', chk:s=>s.games>=1},
  {id:'sharp', icon:'🎯', t:'فطنة حادة', d:'جاوبت ١٠ أسئلة صح', chk:s=>s.correct>=10},
  {id:'genius', icon:'🧠', t:'عبقري', d:'جاوبت ٥٠ سؤال صح', chk:s=>s.correct>=50},
  {id:'champ', icon:'🏆', t:'بطل', d:'فزت ٣ جولات', chk:s=>s.wins>=3},
  {id:'highroll', icon:'💎', t:'الكبار', d:'حققت ٣٠٠٠ نقطة بجولة', chk:s=>s.bestScore>=3000},
  {id:'marathon', icon:'🔥', t:'ماراثون', d:'لعبت ١٠ جولات', chk:s=>s.games>=10},
];

// ────────── الصوت والاهتزاز
let soundOn=storeGet('sound', true), actx=null;
function ac(){ if(!actx){ try{actx=new (window.AudioContext||window.webkitAudioContext)();}catch(e){} } return actx; }
function beep(freq,dur,type,vol){
  if(!soundOn) return; const c=ac(); if(!c) return;
  const o=c.createOscillator(), g=c.createGain();
  o.type=type||'sine'; o.frequency.value=freq;
  g.gain.setValueAtTime(vol||0.12,c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001,c.currentTime+(dur||0.15));
  o.connect(g); g.connect(c.destination); o.start(); o.stop(c.currentTime+(dur||0.15));
}
function sfx(kind){
  if(!soundOn) return;
  if(kind==='tap') beep(520,0.07,'sine',0.08);
  else if(kind==='start'){ beep(440,0.1,'triangle',0.1); setTimeout(()=>beep(660,0.14,'triangle',0.1),90); }
  else if(kind==='correct'){ beep(660,0.1,'sine',0.12); setTimeout(()=>beep(880,0.16,'sine',0.12),100); setTimeout(()=>beep(1100,0.2,'sine',0.1),210); }
  else if(kind==='wrong'){ beep(200,0.25,'sawtooth',0.1); }
  else if(kind==='tick') beep(700,0.05,'square',0.05);
  else if(kind==='win'){ [523,659,784,1047].forEach((f,i)=>setTimeout(()=>beep(f,0.22,'triangle',0.12),i*130)); }
  else if(kind==='ach'){ beep(880,0.1,'sine',0.1); setTimeout(()=>beep(1320,0.2,'sine',0.1),110); }
}
function vibrate(pattern){
  // أولوية Capacitor Haptics (يعمل فعلياً على iOS)، وإلا navigator.vibrate كاحتياط للمتصفح
  try{
    const H=window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
    if(H){ H.impact({style:'LIGHT'}); return; }
  }catch(e){}
  if(navigator.vibrate){ try{navigator.vibrate(pattern);}catch(e){} }
}


// ────────── منع إطفاء الشاشة أثناء السؤال
// السؤال شفهي "يُقرأ ولا يُلمس" لمدة تصل لدقيقة — يجب ألا تُطفئ iOS الشاشة أثناءه.
function keepAwakeOn(){
  try{
    const K=window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.KeepAwake;
    if(K){ K.keepAwake(); return; }
  }catch(e){}
  try{
    if(navigator.wakeLock){
      navigator.wakeLock.request('screen').then(lock=>{ state.wakeLock=lock; }).catch(()=>{});
    }
  }catch(e){}
}
function keepAwakeOff(){
  try{
    const K=window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.KeepAwake;
    if(K){ K.allowSleep(); }
  }catch(e){}
  try{ if(state.wakeLock){ state.wakeLock.release(); state.wakeLock=null; } }catch(e){}
}
function toggleSound(){
  soundOn=!soundOn; storeSet('sound', soundOn);
  document.getElementById('sound-btn').textContent=soundOn?'🔊':'🔇';
  if(soundOn) sfx('tap');
}

// ────────── تنقّل
function screenAccessibilityTitle(screen){
  if(!screen) return null;
  const onboardingTitle=screen.querySelector('.onb-card.active [data-screen-title]');
  return onboardingTitle||screen.querySelector('[data-screen-title],h1,h2,[role="heading"]');
}
function focusScreenAccessibilityTitle(screen){
  const title=screenAccessibilityTitle(screen);
  if(!title) return;
  title.setAttribute('tabindex','-1');
  try{ title.focus({preventScroll:true}); }
  catch(error){ try{ title.focus(); }catch(focusError){} }
}
function go(id){
  const focused=document.activeElement;
  if(focused && typeof focused.blur==='function') focused.blur();
  const destination=document.getElementById(id);
  if(!destination) return;
  document.querySelectorAll('.screen').forEach(screen=>{
    const active=screen===destination;
    screen.classList.toggle('active',active);
    screen.setAttribute('aria-hidden',active?'false':'true');
  });
  const resetScroll=()=>{
    window.scrollTo(0,0);
    document.documentElement.scrollTop=0;
    document.body.scrollTop=0;
    if(document.scrollingElement) document.scrollingElement.scrollTop=0;
  };
  resetScroll();
  window.requestAnimationFrame(resetScroll);
  window.setTimeout(resetScroll,0);
  window.setTimeout(resetScroll,450);
  window.requestAnimationFrame(()=>focusScreenAccessibilityTitle(destination));
  // لا تبدأ أسعار RevenueCat قبل وجود جلسة Firebase وهوية RevenueCat؛
  // هذا يسمح بعرض شاشة الاشتراك فوراً عند الإقلاع من دون طلبات فاشلة.
  if(id==='s-paywall' && typeof loadPaywallPrices==='function'){
    void trackMetric('paywall_viewed',{freeRoundCompleted:localFreeRoundCompleted()});
    // على الويب لا توجد تهيئة RevenueCat أصلاً؛ استدعِ الدالة فوراً كي تعرض
    // ملاحظة أن الدفع متاح داخل iOS بدلاً من ترك الشاشة على «جاري الجلب».
    loadPaywallPrices().catch(()=>logClientEvent('error','paywall.prices'));
  }
}

const modalFocusOrigins=new Map();
function modalFocusableElements(modal){
  return [...modal.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
    .filter(element=>element.getClientRects().length>0&&getComputedStyle(element).visibility!=='hidden'
      &&!element.closest('[aria-hidden="true"],[inert]'));
}
function trapTabWithin(event,container){
  const focusable=modalFocusableElements(container);
  if(!focusable.length){ event.preventDefault(); return; }
  const first=focusable[0],last=focusable[focusable.length-1];
  if(!container.contains(document.activeElement)){
    event.preventDefault();
    (event.shiftKey?last:first).focus();
  }else if(event.shiftKey&&document.activeElement===first){
    event.preventDefault(); last.focus();
  }else if(!event.shiftKey&&document.activeElement===last){
    event.preventDefault(); first.focus();
  }
}
function openAccessibleModal(id,preferredSelector=''){
  const modal=document.getElementById(id);
  if(!modal) return;
  if(!modal.classList.contains('show')) modalFocusOrigins.set(id,document.activeElement);
  modal.classList.add('show');
  modal.setAttribute('aria-hidden','false');
  const preferred=preferredSelector?modal.querySelector(preferredSelector):null;
  const target=preferred||modalFocusableElements(modal)[0]||modal.querySelector('.modal');
  if(target){
    if(!target.matches('button,a,input,select,textarea,[tabindex]')) target.setAttribute('tabindex','-1');
    try{ target.focus({preventScroll:true}); }catch(error){ try{ target.focus(); }catch(focusError){} }
  }
}
function closeAccessibleModal(id,{restoreFocus=true}={}){
  const modal=document.getElementById(id);
  if(!modal) return;
  modal.classList.remove('show');
  modal.setAttribute('aria-hidden','true');
  const origin=modalFocusOrigins.get(id);
  modalFocusOrigins.delete(id);
  if(restoreFocus&&origin&&origin.isConnected&&typeof origin.focus==='function'){
    const restore=()=>{
      try{ origin.focus({preventScroll:true}); }catch(error){ try{ origin.focus(); }catch(focusError){} }
    };
    restore();
    // انتقال الشاشة قد يركّز عنوانها بشكل مؤجل؛ أعد التركيز بعد إطارين
    // حتى يبقى VoiceOver عند الزر الذي فتح النافذة بثبات.
    requestAnimationFrame(()=>requestAnimationFrame(restore));
  }
}
document.addEventListener('keydown',event=>{
  const modal=document.querySelector('.modal-wrap.show[role="dialog"]');
  if(modal){
    if(event.key==='Escape'){
      const cancel=modal.querySelector('[data-modal-cancel]');
      if(cancel){ event.preventDefault(); cancel.click(); }
      return;
    }
    if(event.key==='Tab') trapTabWithin(event,modal);
    return;
  }
  const question=document.querySelector('#q-wrap.show[role="dialog"]');
  if(question&&event.key==='Tab') trapTabWithin(event,question);
});
(function initializeAccessibilityState(){
  document.querySelectorAll('.screen').forEach(screen=>{
    screen.setAttribute('aria-hidden',screen.classList.contains('active')?'false':'true');
  });
  document.querySelectorAll('.modal-wrap[role="dialog"]').forEach(modal=>{
    modal.setAttribute('aria-hidden',modal.classList.contains('show')?'false':'true');
  });
})();
function closePaywall(){
  const uid=window._currentUid||storeGet('authUid','');
  if(uid){ updateFreeRoundUi(); go('s-home'); }
  else go('s-auth');
}

// ────────── حذف الحساب (5.1.1)
function accountDeletionError(code){
  const error=new Error(code);
  error.code=code;
  return error;
}
function normalizeDeletionProvider(provider,user){
  const stored=String(provider||'').toLowerCase();
  const firebase=String(user?.providerData?.[0]?.providerId||'').toLowerCase();
  const value=stored==='firebase'&&firebase?firebase:stored;
  if(value==='apple.com') return 'apple';
  if(value==='google.com') return 'google';
  if(value==='password') return 'password';
  if(value==='phone') return 'phone';
  if(user?.isAnonymous===true||value==='anonymous') return 'anonymous';
  return value;
}
function assertDeletionUser(user,expectedUid){
  const actualUid=String(user?.uid||'');
  if(!actualUid) throw accountDeletionError('auth/no-current-user');
  if(expectedUid&&actualUid!==String(expectedUid)){
    throw accountDeletionError('auth/account-mismatch');
  }
  return user;
}

let _passwordReauthResolver=null;
let _passwordReauthVerifying=false;
function setPasswordReauthBackgroundIsolated(isolated){
  const app=document.getElementById('app');
  if(!app) return;
  app.inert=isolated;
  if(isolated) app.setAttribute('aria-hidden','true');
  else app.removeAttribute('aria-hidden');
}
function setPasswordReauthBusy(busy){
  _passwordReauthVerifying=busy;
  const form=document.getElementById('reauth-password-form');
  if(form) form.setAttribute('aria-busy',busy?'true':'false');
  ['reauth-password-input','reauth-password-cancel','reauth-password-submit'].forEach(id=>{
    const control=document.getElementById(id);
    if(control) control.disabled=busy;
  });
}
function closePasswordReauthenticationAfterAttempt(){
  const input=document.getElementById('reauth-password-input');
  const error=document.getElementById('reauth-password-error');
  const status=document.getElementById('reauth-password-status');
  if(input) input.value='';
  if(error) error.textContent='';
  if(status) status.textContent='';
  setPasswordReauthBusy(false);
  setPasswordReauthBackgroundIsolated(false);
  closeAccessibleModal('reauth-password-modal',{restoreFocus:false});
}
function finishPasswordReauthentication(password,{verifying=false}={}){
  const input=document.getElementById('reauth-password-input');
  const error=document.getElementById('reauth-password-error');
  const status=document.getElementById('reauth-password-status');
  if(input) input.value='';
  if(error) error.textContent='';
  const resolve=_passwordReauthResolver;
  _passwordReauthResolver=null;
  if(verifying){
    setPasswordReauthBusy(true);
    if(status){
      status.textContent='جاري التحقق من كلمة المرور…';
      try{ status.focus({preventScroll:true}); }catch(_){ status.focus(); }
    }
  }else{
    closePasswordReauthenticationAfterAttempt();
  }
  if(resolve) resolve(password);
}
function cancelPasswordReauthentication(){
  if(_passwordReauthVerifying) return;
  finishPasswordReauthentication(null);
}
function submitPasswordReauthentication(event){
  event.preventDefault();
  if(_passwordReauthVerifying) return;
  const input=document.getElementById('reauth-password-input');
  const password=input?.value||'';
  if(!password){
    const error=document.getElementById('reauth-password-error');
    if(error) error.textContent='اكتب كلمة المرور عشان نكمّل.';
    input?.focus();
    return;
  }
  finishPasswordReauthentication(password,{verifying:true});
}
function requestPasswordForReauthentication(email){
  if(_passwordReauthResolver) finishPasswordReauthentication(null);
  const identity=document.getElementById('reauth-password-email');
  const input=document.getElementById('reauth-password-input');
  const error=document.getElementById('reauth-password-error');
  const status=document.getElementById('reauth-password-status');
  if(identity) identity.textContent=String(email||'بريدك الإلكتروني');
  if(input) input.value='';
  if(error) error.textContent='';
  if(status) status.textContent='';
  setPasswordReauthBusy(false);
  return new Promise(resolve=>{
    _passwordReauthResolver=resolve;
    openAccessibleModal('reauth-password-modal','#reauth-password-input');
    setPasswordReauthBackgroundIsolated(true);
  });
}
document.getElementById('reauth-password-form')?.addEventListener('submit',submitPasswordReauthentication);
document.getElementById('reauth-password-cancel')?.addEventListener('click',cancelPasswordReauthentication);

// تحدث إعادة المصادقة قبل أول عملية حذف، وتتأكد أن المزوّد لم يبدّل
// الحساب أثناء تسجيل الدخول. الجلسات المجهولة/المحلية يحسمها الخادم.
async function reauthenticateAccountForDeletion(provider,expectedUid){
  logClientEvent('info','auth.reauth.start');
  const FA=window.Capacitor?.Plugins?.FirebaseAuthentication;
  if(FA){
    const current=(await FA.getCurrentUser().catch(()=>null))?.user||null;
    if(!current){
      if(provider==='local') return true;
      throw accountDeletionError('auth/no-current-user');
    }
    assertDeletionUser(current,expectedUid);
    const normalized=normalizeDeletionProvider(provider,current);
    let result=null;
    if(normalized==='google'){
      // لا نستبدل الجلسة عبر signIn fallback؛ إذا لم تتوفر إعادة المصادقة
      // يقرر الخادم حداثة auth_time من الرمز الحالي.
      if(typeof FA.reauthenticateWithGoogle!=='function') return true;
      result=await FA.reauthenticateWithGoogle();
    }else if(normalized==='apple'){
      if(typeof FA.reauthenticateWithApple!=='function') return true;
      try{
        result=await FA.reauthenticateWithApple();
      }catch(error){ logClientEvent('error','auth.reauth.apple'); throw error; }
    }else if(normalized==='password'){
      // استخدم بريد Firebase الحالي الموثوق، لا authEmail المحلي القابل للتعديل.
      // signIn بهذا البريد لا يستطيع اختيار حساب مختلف بصمت.
      const email=String(current.email||'').trim();
      const reauthenticate=typeof FA.reauthenticateWithEmailAndPassword==='function'
        ?options=>FA.reauthenticateWithEmailAndPassword(options)
        :typeof FA.signInWithEmailAndPassword==='function'
          ?options=>FA.signInWithEmailAndPassword(options):null;
      if(!email||!reauthenticate) throw accountDeletionError('auth/reauth-unavailable');
      let password=await requestPasswordForReauthentication(email);
      if(password===null) throw accountDeletionError('auth/cancelled');
      try{ result=await reauthenticate({email,password}); }
      finally{
        password='';
        closePasswordReauthenticationAfterAttempt();
      }
    }else{
      // phone لا يملك API إعادة مصادقة مباشراً، وanonymous لا يملك مزوّداً تفاعلياً.
      // نرسل token مجدداً ليقرر الخادم، من دون حذف محلي مبكر.
      return true;
    }
    if(result?.user) assertDeletionUser(result.user,expectedUid);
    const refreshed=(await FA.getCurrentUser().catch(()=>null))?.user;
    assertDeletionUser(refreshed,expectedUid);
    return true;
  }

  const wb=await getFirebaseWebAuth();
  if(!wb?.auth?.currentUser){
    if(provider==='local') return true;
    throw accountDeletionError('auth/no-current-user');
  }
  const current=assertDeletionUser(wb.auth.currentUser,expectedUid);
  const normalized=normalizeDeletionProvider(provider,current);
  if(normalized==='anonymous'||normalized==='phone') return true;
  const {reauthenticateWithPopup,reauthenticateWithCredential,EmailAuthProvider}=
    await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
  let result;
  if(normalized==='password'){
    const email=String(current.email||'').trim();
    if(!email) throw accountDeletionError('auth/reauth-unavailable');
    let password=await requestPasswordForReauthentication(email);
    if(password===null) throw accountDeletionError('auth/cancelled');
    try{
      result=await reauthenticateWithCredential(current,EmailAuthProvider.credential(email,password));
    }finally{
      password='';
      closePasswordReauthenticationAfterAttempt();
    }
  }else if(normalized==='google'||normalized==='apple'){
    const authProvider=normalized==='google'
      ?new wb.GoogleAuthProvider():new wb.OAuthProvider('apple.com');
    result=await reauthenticateWithPopup(current,authProvider);
  }else{
    return true;
  }
  assertDeletionUser(result?.user||wb.auth.currentUser,expectedUid);
  return true;
}

// حذف مستخدم Firebase فعلياً (شرط Apple 5.1.1) بعد إنهاء إعادة المصادقة مسبقاً.
async function deleteFirebaseUser(expectedUid){
  const FA=window.Capacitor?.Plugins?.FirebaseAuthentication;
  if(FA){
    try{
      const current=(await FA.getCurrentUser().catch(()=>null))?.user||null;
      if(!current) return true;
      assertDeletionUser(current,expectedUid);
      await FA.deleteUser();
      // قد تسجّل الطبقة الأصلية RuntimeError بلا رفض Promise، فنتحقق من اختفاء المستخدم.
      const remainingUser = await FA.getCurrentUser().catch(()=>null);
      if(remainingUser && remainingUser.user){
        throw new Error('Firebase user still exists after deleteUser');
      }
      return true;
    }catch(error){ logClientEvent('error','auth.delete.capacitor'); return false; }
  }
  const wb=await getFirebaseWebAuth();
  if(wb){
    const current=wb.auth.currentUser;
    if(!current) return true;
    try{
      assertDeletionUser(current,expectedUid);
      const {deleteUser}=await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
      await deleteUser(current);
      return true;
    }catch(error){ logClientEvent('error','auth.delete.web'); return false; }
  }
  return true;
}

let _accountActionPending=false;
function beginAccountAction(message){
  if(_accountActionPending) return false;
  _accountActionPending=true;
  ['sign-out-btn','delete-account-btn'].forEach(id=>{ const button=document.getElementById(id); if(button) button.disabled=true; });
  const msg=document.getElementById('account-action-msg');
  if(msg) msg.textContent=`⏳ ${message}`;
  return true;
}
function endAccountAction({focusTargetId=''}={}){
  _accountActionPending=false;
  ['sign-out-btn','delete-account-btn'].forEach(id=>{ const button=document.getElementById(id); if(button) button.disabled=false; });
  const msg=document.getElementById('account-action-msg');
  if(msg) msg.textContent='';
  const target=focusTargetId?document.getElementById(focusTargetId):null;
  if(target){
    const restore=()=>{
      if(!target.isConnected||target.disabled) return;
      try{ target.focus({preventScroll:true}); }catch(_){ target.focus(); }
    };
    restore();
    requestAnimationFrame(()=>requestAnimationFrame(restore));
  }
}

async function signOut(){
  const ok=confirm('تبي تسجّل خروج؟ بياناتك المحلية راح تظل محفوظة على هالجهاز.');
  if(!ok) return;
  if(!beginAccountAction('ثواني ونسجّل خروجك…')) return;
  let completed=false;
  try{
  await resetVerificationSession();
  // امسح توكن Firebase من Keychain (يمنع الدخول التلقائي بعد إعادة التثبيت)
  try{
    const FA=window.Capacitor?.Plugins?.FirebaseAuthentication;
    if(FA) await FA.signOut();
  }catch(e){ logClientEvent('warn','auth.signout'); }
  // افصل RevenueCat أيضاً حتى لا يرث الحساب التالي اشتراك المستخدم السابق.
  await resetRevenueCatIdentity();
  // امسح مفاتيح الهوية فقط من التخزين المحلي (ابقِ الإحصاءات والإنجازات)
  ['authUid','authProvider','authEmail','playerName','rcAppUserId','deviceId'].forEach(k=>{
    localStorage.removeItem(STORAGE_PREFIX+k);
    try{
      const P=window.Capacitor?.Plugins?.Preferences;
      if(P) P.remove({key:STORAGE_PREFIX+k});
    }catch(e){}
  });
  window._currentUid = '';
  clearIdTokenCache();
  stats=emptyStats();
  showToast('✅','تم تسجيل الخروج','تقدر تدخل بحساب ثاني',false);
  completed=true;
  setTimeout(()=>{ endAccountAction(); go('s-auth'); },1200);
  }finally{ if(!completed) endAccountAction(); }
}

async function confirmDeleteAccount(){
  const ok=confirm('راح نحذف حسابك نهائياً من فطنة مع بيانات اللعب والنقاط والإنجازات. حذف الحساب لا يلغي اشتراك App Store المتجدد؛ ألغِه من «إدارة اشتراك Apple» إذا ما تبي تستمر الفوترة. ما تقدر تتراجع. تبي تكمّل؟');
  if(!ok) return;
  if(!beginAccountAction('ثواني ونحذف الحساب والبيانات…')) return;
  let completed=false;
  try{
  const uid = storeGet('authUid','');
  const provider=storeGet('authProvider','');
  // 1) أكّد الهوية قبل أي حذف. هذا يمنع حذف بيانات الخادم ثم اكتشاف
  // requires-recent-login عند حذف هوية Firebase.
  try{
    await reauthenticateAccountForDeletion(provider,uid);
  }catch(error){
    logClientEvent('error','auth.delete.reauthentication');
    if(error?.code==='auth/cancelled'||isAuthCancellation(error)){
      showToast('❌','لغيت التحقق','ما انحذف أي شي. كمّل التحقق عشان تحذف الحساب',false);
    }else if(error?.code==='auth/account-mismatch'){
      showToast('⚠️','الحساب ما تطابق','دخلت بحساب ثاني. سجّل دخولك بالحساب اللي تبي تحذفه',false);
    }else if(error?.code==='auth/reauth-unavailable'){
      showToast('🔐','يحتاج تسجيل دخول جديد','ما انحذف أي شي. سجّل خروجك، ادخل مرة ثانية، ثم أعد المحاولة',false);
    }else{
      showToast('⚠️','ما قدرنا نتحقق','ما انحذف أي شي. تأكد من البيانات والاتصال وجرّب مرة ثانية',false);
    }
    return;
  }

  // 2) جدّد token بعد إعادة المصادقة، ثم احذف بيانات الخادم. الطلب idempotent
  // حتى يستطيع المستخد إعادة المحاولة إذا انقطع الاتصال بعد وصوله.
  if(uid){
    try{
      clearIdTokenCache();
      const idToken = await getCurrentIdToken(true);
      if(provider!=='local'&&!idToken) throw accountDeletionError('auth/no-id-token');
      const resp = await apiFetch('/api/account/delete',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({uid, idToken})
      });
      if(!resp.ok){
        let payload={};
        try{ payload=await resp.json(); }catch(error){}
        if(payload?.code==='recent_auth_required'){
          const method={phone:'برقم الهاتف',google:'بـ Google',apple:'بـ Apple',password:'بالبريد وكلمة المرور'}[
            normalizeDeletionProvider(provider)
          ]||'بنفس طريقة الدخول';
          const detail=`سجّل خروجك، ادخل مرة ثانية ${method}، ثم أعد المحاولة. ما انحذف أي شي`;
          showToast('🔐','يحتاج تسجيل دخول جديد',detail,false);
          return;
        }
        throw new Error(payload?.error||`server delete returned ${resp.status}`);
      }
    }catch(e){
      logClientEvent('warn','account.server-delete');
      showToast('⚠️','ما قدرنا نحذف الحساب','بياناتك ما انحذفت. تأكد من النت وجرّب مرة ثانية',false);
      return;
    }
  }
  // 3) احذف مستخدم Firebase بالجلسة التي حدّثناها قبل أي حذف.
  const deleted = await deleteFirebaseUser(uid);
  if(!deleted){
    showToast('⚠️','ما اكتمل حذف هوية الدخول','حذفنا بيانات فطنة، لكن Firebase ما أكمل الحذف. جرّب مرة ثانية؛ الطلب آمن للتكرار',false);
    return;
  }
  // 4) افصل RevenueCat بعد نجاح حذف هوية Firebase. إبقاء SDK على هوية
  // المستخدم المحذوف كان يعيد حالة اشتراكه عند فتح التطبيق أو دخول حساب آخر.
  await resetRevenueCatIdentity();
  try{
    const securePacks=window.Capacitor?.Plugins?.FatinahSecureGamePack;
    if(securePacks) await securePacks.clear({context:`${String(uid).slice(0,128)}|fatinah-game-packs-v1`});
  }catch(error){ recordNonFatal(error,'account-delete.game-pack-key'); }
  const rcIds=storeGet('rcAppUserIds',{}) || {};
  delete rcIds[uid];
  storeSet('rcAppUserIds',rcIds);
  storeSet('rcAppUserId','');
  await resetVerificationSession();
  // 5) امسح Keychain عبر signOut صريح
  try{
    const FA=window.Capacitor?.Plugins?.FirebaseAuthentication;
    if(FA) await FA.signOut();
  }catch(e){}
  // 6) امسح localStorage و Capacitor Preferences بالكامل
  const keys=Object.keys(localStorage).filter(k=>k.startsWith(STORAGE_PREFIX));
  keys.forEach(k=>localStorage.removeItem(k));
  try{
    const P=window.Capacitor?.Plugins?.Preferences;
    if(P) await P.clear();
  }catch(e){}
  // صفّر كل حالة بالذاكرة كانت مرتبطة بالحساب المحذوف — وإلا يبقى مرجعها حياً
  // بالجلسة الحالية رغم مسح القرص، ويمكن
  // أن يظهر لأي حساب تالٍ يسجّل الدخول بنفس الجلسة على جهاز مشترك
  window._currentUid = '';
  clearIdTokenCache();
  stats=emptyStats();
  showToast('✅','حذفنا حسابك','انحذف حساب فطنة وبياناته. اشتراك Apple يظل منفصل',false);
  completed=true;
  setTimeout(()=>{ endAccountAction(); go('s-auth'); },1500);
  }finally{ if(!completed) endAccountAction({focusTargetId:'delete-account-btn'}); }
}

// ---- نظام الهوية الموحّد ----
// كل شخص = uid واحد ثابت بغض النظر عن وسيلة الدخول. عند أول فتح للتطبيق نبدأ
// بجلسة Firebase مجهولة (anonymous) تلقائياً بلا شاشة تسجيل إجبارية، وعند
// التسجيل لاحقاً بأي مزوّد نربطه بنفس الحساب (linkWithCredential) بدل إنشاء
// حساب جديد — فلا يضيع تقدّم اللاعب أبداً.

function toggleEmailForm(){
  sfx('tap');
  const f=document.getElementById('auth-email-form');
  if(f) f.style.display = f.style.display==='none' ? 'block' : 'none';
}

function currentScreenId(){
  const el=document.querySelector('.screen.active');
  return el ? el.id : 's-home';
}

// أين نُعيد المستخدم بعد نجاح تسجيل الدخول/الربط (الشاشة التي بدأ منها)
window._authReturnScreen = 's-home';

function skipAuth(){
  sfx('tap');
  const target = window._authReturnScreen || 's-home';
  if(target==='s-stats'){ go('s-stats'); return; }
  checkSubscriptionAndRoute(storeGet('authUid',''));
}

function openAuth(fromScreen){
  window._authReturnScreen = fromScreen || currentScreenId();
  document.getElementById('auth-title').textContent = 'اربط حسابك';
  document.getElementById('auth-sub').textContent = 'سجّل بالطريقة اللي تناسبك عشان تحفظ نقاطك وإنجازاتك حتى لو بدّلت جهازك';
  document.getElementById('auth-msg').textContent = '';
  go('s-auth');
}

// جلسة مجهولة أولى: تُنشأ تلقائياً عند أول فتح للتطبيق بلا حساب محفوظ
async function ensureAnonymousSession(){
  let uid = storeGet('authUid','');
  const storedProvider = storeGet('authProvider','anonymous');
  // الإصدارات السابقة كانت تحفظ المعرف المحلي الاحتياطي على أنه anonymous.
  // بعد تفعيل Firebase Anonymous ننشئ جلسة Firebase حقيقية بدلاً من إبقاء
  // الجهاز على هوية لا تحمل ID token ولا يمكنها استخدام الاشتراكات.
  const mustRestoreAnonymousSession = storedProvider === 'anonymous';
  if(uid && storedProvider !== 'local' && !mustRestoreAnonymousSession) {
    return {uid, provider: storedProvider};
  }
  if(storedProvider === 'local' || mustRestoreAnonymousSession) uid = '';

  const FA=getFirebaseAuth();
  if(FA){
    // جلسة Firebase قد تبقى في Keychain بعد إعادة تثبيت التطبيق رغم مسح Preferences —
    // استرجعها أولاً حتى لا نستبدل حساباً حقيقياً بجلسة مجهولة أو معرّف محلي.
    try{
      const cur = await FA.getCurrentUser();
      const u = cur && cur.user;
      if(u && u.uid){
        const prov=(u.providerData && u.providerData[0] && u.providerData[0].providerId)
          || (u.isAnonymous ? 'anonymous' : 'firebase');
        storeSet('authUid', u.uid);
        storeSet('authProvider', prov);
        return {uid: u.uid, provider: prov};
      }
    }catch(e){}
    try{
      const res = await FA.signInAnonymously();
      uid = res && res.user && res.user.uid;
    }catch(e){
      const code=String(e && (e.code||e.message) || '');
      if(code.includes('admin-restricted-operation') || code.includes('restricted to administrators')){
        logClientEvent('warn','auth.anonymous.disabled');
      } else {
        logClientEvent('error','auth.anonymous.capacitor');
      }
    }
  }
  if(!uid){
    const wb=await getFirebaseWebAuth();
    if(wb){
      try{
        const cu = wb.auth && wb.auth.currentUser;
        if(cu && cu.uid){
          const prov=(cu.providerData && cu.providerData[0] && cu.providerData[0].providerId)
            || (cu.isAnonymous ? 'anonymous' : 'firebase');
          storeSet('authUid', cu.uid);
          storeSet('authProvider', prov);
          return {uid: cu.uid, provider: prov};
        }
        const { signInAnonymously } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
        const result = await signInAnonymously(wb.auth);
        uid = result.user.uid;
      }catch(e){
        if(e && e.code === 'auth/admin-restricted-operation'){
          logClientEvent('warn','auth.anonymous.disabled');
        } else {
          logClientEvent('error','auth.anonymous.web');
        }
      }
    }
  }
  let provider = 'anonymous';
  if(!uid){
    // احتياط كامل بلا اتصال/بلا Firebase config: معرّف جهاز محلي ثابت
    uid = storeGet('deviceId','');
    if(!uid){
      uid = 'anon_' + Date.now().toString(36) + Math.random().toString(36).substr(2,6);
      storeSet('deviceId', uid);
    }
    provider = 'local';
  }
  storeSet('authUid', uid);
  storeSet('authProvider', provider);
  return {uid, provider};
}

// نجاح الدخول/الربط بأي وسيلة — يوحّد كل مسارات ما بعد المصادقة
function afterAuthSuccess(name, provider, uid, email){
  sfx('start'); vibrate(20);
  const previousUid=String(window._currentUid||storeGet('authUid','')||'');
  const nextUid=String(uid||storeGet('authUid','')||'');
  // قد يعيد تسجيل الدخول حساب Firebase مختلفاً عن الحساب الذي كان RevenueCat
  // مهيأً له. صفّر الصلاحية والكاش فوراً، ثم لا تبدأ فحص الحساب الجديد قبل
  // أن ينتهي فصل هوية SDK القديمة.
  const revenueCatIdentityReset=previousUid && nextUid && previousUid!==nextUid
    ? resetRevenueCatIdentity()
    : Promise.resolve();
  if(name) storeSet('playerName', name);
  storeSet('authProvider', provider);
  if(uid) storeSet('authUid', uid);
  if(email) storeSet('authEmail', email);
  window._currentUid = uid || storeGet('authUid','');
  activateLocalAccount(window._currentUid);
  const nameEl=document.getElementById('user-name');
  if(nameEl) nameEl.textContent = storeGet('playerName','لاعب');
  const emailForm=document.getElementById('auth-email-form');
  if(emailForm) emailForm.style.display='none';
  const phoneForm=document.getElementById('auth-phone-form');
  if(phoneForm) phoneForm.style.display='none';
  showToast('✅','دخلت بنجاح','ربطنا حسابك',false);
  renderAccountLinks();
  const target = window._authReturnScreen || 's-home';
  if(target==='s-stats'){ go('s-stats'); }
  else if(!storeGet('onbDone', false)){ _onbStep=0; _onbSetStep(0); go('s-onb'); }
  else {
    void revenueCatIdentityReset.then(()=>checkSubscriptionAndRoute(window._currentUid));
  }
  void syncQuestionHistory();
  void flushMetricEvents();
}

// نشارك طلب الرمز القصير بين العمليات المتزامنة عند الإقلاع. كانت تهيئة
// RevenueCat والتحقق من الاشتراك تطلبان الرمز نفسه في الوقت نفسه من iOS.
const _idTokenCache = { token:'', validUntil:0, pending:null };
const FIREBASE_ID_TOKEN_TIMEOUT_MS=5000;
function clearIdTokenCache(){
  _idTokenCache.token='';
  _idTokenCache.validUntil=0;
  _idTokenCache.pending=null;
}

// جلب ID token للمستخدم الحالي (لإثبات الهوية للخادم)
async function getCurrentIdToken(forceRefresh=false,requestedTimeoutMs=FIREBASE_ID_TOKEN_TIMEOUT_MS){
  if(!forceRefresh && _idTokenCache.token && Date.now() < _idTokenCache.validUntil){
    return _idTokenCache.token;
  }
  if(!forceRefresh && _idTokenCache.pending) return _idTokenCache.pending;
  const timeoutMs=Number.isFinite(requestedTimeoutMs)&&requestedTimeoutMs>0
    ?Math.floor(requestedTimeoutMs):FIREBASE_ID_TOKEN_TIMEOUT_MS;
  const timedOut=Object.freeze({timedOut:true});
  const tokenAttempt=(async ()=>{
    try{
      const FA=getFirebaseAuth();
      if(FA){
        // لا تطلب رمزاً بعد تسجيل الخروج أو الحذف؛ لن ينتج رمز صالح وسيظهر
        // RuntimeError متكرر في سجل iOS.
        const current = await FA.getCurrentUser().catch(()=>null);
        if(!current || !current.user) return '';
        const r=await FA.getIdToken({forceRefresh:!!forceRefresh});
        return (r && r.token) || '';
      }
    }catch(e){}
    try{
      const wb=await getFirebaseWebAuth();
      if(wb && wb.auth.currentUser) return await wb.auth.currentUser.getIdToken(!!forceRefresh);
    }catch(e){}
    return '';
  })();
  const request=settleWithin(tokenAttempt,timeoutMs,timedOut).then(result=>{
    if(result!==timedOut) return result;
    const error=new Error('Firebase ID token request timed out');
    error.code='FIREBASE_ID_TOKEN_TIMEOUT';
    recordNonFatal(error,'firebase.auth.id-token');
    return '';
  });
  if(forceRefresh) return request;
  _idTokenCache.pending=request;
  try{
    const token=await request;
    if(token){
      _idTokenCache.token=token;
      _idTokenCache.validUntil=Date.now()+10000;
    }
    return token;
  }finally{
    _idTokenCache.pending=null;
  }
}

// حفظ اسم/بريد المستخدم بشكل دائم في قاعدة بيانات الخادم — ضروري خصوصاً
// لـ Apple التي لا ترسل هذه الحقول إلا في أول تفويض فقط
async function savePermanentProfile(uid, name, email, provider){
  if(!uid) return;
  try{
    const idToken = await getCurrentIdToken();
    await apiFetch('/api/account/profile', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({uid, name: name||'', email: email||'', provider: provider||'', idToken})
    });
  }catch(e){ logClientEvent('error','profile.save'); }
}

// ─── الربط التفاعلي: يعالج auth/account-exists-with-different-credential ───
// يعيد true إن تمت معالجة الخطأ (سواء بعرض توضيح أو ببدء مسار الربط)
async function handleAuthConflict(e, attemptedProvider, wb){
  const code = String((e && e.code) || '');
  if(!code.includes('account-exists-with-different-credential') && !code.includes('credential-already-in-use')) return false;

  let email = e && (e.email || (e.customData && e.customData.email));
  let pendingCred = null;
  if(wb && e && e.customData){
    try{
      const { OAuthProvider, GoogleAuthProvider } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
      pendingCred = attemptedProvider==='google'
        ? GoogleAuthProvider.credentialFromError(e)
        : OAuthProvider.credentialFromError(e);
    }catch(err){}
  }

  let methods = [];
  if(email){
    try{
      const wbAuth = wb || await getFirebaseWebAuth();
      if(wbAuth){
        const { fetchSignInMethodsForEmail } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
        methods = await fetchSignInMethodsForEmail(wbAuth.auth, email);
      }
    }catch(err){}
  }
  const original = methods[0] || '';
  const originalLabel = original.includes('google') ? 'Google'
    : original.includes('apple') ? 'Apple'
    : original.includes('password') ? 'البريد وكلمة المرور'
    : 'طريقتك الأساسية';

  window._pendingLinkCred    = pendingCred;
  window._pendingLinkEmail   = email || '';
  window._pendingLinkOriginal= original;

  openAuth(window._authReturnScreen || currentScreenId());
  document.getElementById('auth-title').textContent = 'عندك حساب من قبل';
  document.getElementById('auth-sub').textContent = email
    ? `البريد (${email}) مسجَّل من قبل عن طريق ${originalLabel}. سجّل دخولك بهالطريقة أول وبنربط حسابك تلقائياً.`
    : 'عندك حساب بطريقة دخول ثانية. سجّل دخولك بطريقتك الأساسية أول، وبعدها تقدر تربط الطريقة الجديدة من إعدادات الحساب.';
  if(original.includes('password') && email){
    document.getElementById('auth-email-form').style.display='block';
    document.getElementById('auth-email').value = email;
  }
  showToast('🔗','عندك حساب من قبل', originalLabel ? `سجّل عن طريق ${originalLabel} عشان تكمّل` : 'سجّل بطريقتك الأساسية', false);
  return true;
}

// بعد نجاح تسجيل الدخول بالطريقة الأصلية، إن كان هناك ربط معلّق نكمله تلقائياً
async function resolvePendingLinkWeb(wb, userAfterSignIn){
  if(!window._pendingLinkCred || !userAfterSignIn) return false;
  try{
    const { linkWithCredential } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
    await linkWithCredential(userAfterSignIn, window._pendingLinkCred);
    showToast('🔗','تم الربط بنجاح','الحين تقدر تدخل بالطريقتين',false);
    return true;
  }catch(e){ logClientEvent('error','auth.pending-link'); return false; }
  finally{
    window._pendingLinkCred=null; window._pendingLinkEmail=null; window._pendingLinkOriginal=null;
  }
}
function clearPendingLinkNative(){
  // على iOS الأصلي عبر Capacitor لا تتوفر واجهة موحّدة لاستخراج بيانات الاعتماد
  // المعلّقة من الخطأ (على عكس Web SDK)، لذا نكتفي بإكمال تسجيل الدخول بالطريقة
  // الأصلية بأمان بدل ربط تلقائي كامل. موثّق في AUTH_SETUP.md.
  window._pendingLinkCred=null; window._pendingLinkEmail=null; window._pendingLinkOriginal=null;
}

// ────────── Firebase Auth — طبقتان: Capacitor (iOS) ثم Web SDK (متصفح)

// الطبقة الأولى: مكوّن Capacitor الأصلي (يعمل داخل iOS app فقط)
function getFirebaseAuth(){
  try{ return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.FirebaseAuthentication; }
  catch(e){ return null; }
}

function getCrashlytics(){
  try{ return window.Capacitor?.Plugins?.FirebaseCrashlytics || null; }
  catch(e){ return null; }
}
// لا نرسل رسالة الخطأ الخام إلى Crashlytics؛ فقد تحتوي على بريد أو هاتف أو
// token أو URL أو استجابة خادم. التشخيص الخارجي يقتصر على موقع معروف داخل
// التطبيق وكود أصلي ثابت راجعناه مسبقاً.
const CRASH_SOURCE_ALLOWLIST=new Set([
  'firebase.app-check.initialize','firebase.app-check.token',
  'firebase.auth.id-token',
  'preferences.hydrate','device-check.token','app-attest.reset',
  'app-attest.enroll','app-attest.assertion.free_round_status',
  'app-attest.assertion.free_round_complete','free-round.claim',
  'firebase.messaging.permission','firebase.messaging.account',
  'firebase.messaging','apple.offer-code','question.report',
  'window.error','unhandledrejection','application.start',
]);
const CRASH_CODE_ALLOWLIST=new Set([
  'DEVICE_CHECK_UNSUPPORTED','DEVICE_CHECK_FAILED',
  'APP_ATTEST_INVALID_KEY_ID','APP_ATTEST_UNSUPPORTED',
  'APP_ATTEST_KEY_NOT_GENERATED','APP_ATTEST_INVALID_CLIENT_DATA_HASH',
  'APP_ATTEST_KEYCHAIN_LOCKED','APP_ATTEST_KEYCHAIN_FAILED',
  'APP_ATTEST_SERVER_UNAVAILABLE','APP_ATTEST_INVALID_KEY',
  'APP_ATTEST_INVALID_INPUT','APP_ATTEST_FAILED','APP_ATTEST_KEY_RESET',
  'FIREBASE_ID_TOKEN_TIMEOUT',
]);
function safeCrashSource(source){
  return typeof source==='string'&&CRASH_SOURCE_ALLOWLIST.has(source)
    ?source:'application.nonfatal';
}
function safeCrashCode(error){
  try{
    const code=typeof error?.code==='string'?error.code:'';
    return CRASH_CODE_ALLOWLIST.has(code)?code:'unspecified';
  }catch(_){
    return 'unspecified';
  }
}
function recordNonFatal(error, source){
  const crashlytics=getCrashlytics();
  if(!crashlytics) return;
  const message=`nonfatal:${safeCrashSource(source)}:${safeCrashCode(error)}`;
  try{
    const pending=crashlytics.recordException({message});
    if(pending?.catch) pending.catch(()=>{});
  }catch(_){ /* لا نسمح لتعطل أداة التشخيص بتعطيل التطبيق */ }
}
function initCrashReporting(){
  const crashlytics=getCrashlytics();
  if(!crashlytics) return;
  crashlytics.setEnabled({enabled:true}).catch(()=>{});
  // تقارير الأعطال تشخيصية على مستوى التطبيق وليست ملفاً للمستخدم؛ إبقاء
  // الهوية فارغة يمنع نسبة crash مؤجل إلى حساب دخل لاحقاً على الجهاز نفسه.
  crashlytics.setUserId({userId:''}).catch(()=>{});
  window.addEventListener('error', event=>recordNonFatal(event.error||event.message,'window.error'));
  window.addEventListener('unhandledrejection', event=>recordNonFatal(event.reason,'unhandledrejection'));
}

function getFirebaseMessaging(){
  try{ return window.Capacitor?.Plugins?.FirebaseMessaging || null; }
  catch(e){ return null; }
}
let _pushListenersReady=false;
function renderPushPermission(status){
  const label=document.getElementById('notification-permission-status');
  const button=document.getElementById('enable-notifications-btn');
  if(label){
    label.textContent=status==='granted'
      ? '✓ الإشعارات شغّالة على هالجهاز'
      : status==='denied'
        ? 'الإشعارات موقوفة من إعدادات الجهاز'
        : 'فعّلها عشان توصلك التنبيهات المهمة اللي تختارها';
  }
  if(button){
    button.disabled=status==='granted';
    button.textContent=status==='granted'?'✓ الإشعارات شغّالة':'🔔 فعّل الإشعارات';
  }
}
async function initPushMessaging(){
  const messaging=getFirebaseMessaging();
  if(!messaging) return false;
  if(!_pushListenersReady){
    _pushListenersReady=true;
    await messaging.addListener('notificationReceived', event=>{
      logClientEvent('info','messaging.received');
    });
    await messaging.addListener('notificationActionPerformed', event=>{
      logClientEvent('info','messaging.opened');
    });
    await messaging.addListener('tokenReceived', event=>{
      if(event && event.token) logClientEvent('info','messaging.token-received');
    });
  }
  const current=await messaging.checkPermissions();
  renderPushPermission(current.receive);
  // لا نعرض نافذة النظام عند الإقلاع. يطلبها المستخدم من شاشة الحساب بعد
  // شرح الفائدة، وهو توقيت أكثر وضوحاً واحتراماً لقراره.
  if(current.receive!=='granted') return false;
  const {token}=await messaging.getToken();
  if(token) logClientEvent('info','messaging.token-ready');
  return true;
}
async function enablePushNotifications(){
  const messaging=getFirebaseMessaging();
  if(!messaging){
    showToast('ℹ️','الإشعارات مو متوفرة هني','هالميزة موجودة داخل تطبيق iPhone',false);
    return false;
  }
  const button=document.getElementById('enable-notifications-btn');
  if(button) button.disabled=true;
  try{
    const permission=await messaging.requestPermissions();
    renderPushPermission(permission.receive);
    if(permission.receive!=='granted'){
      showToast('🔕','ما فعّلت الإشعارات','تقدر تغيّر اختيارك من إعدادات iPhone',false);
      return false;
    }
    const {token}=await messaging.getToken();
    if(!token) throw new Error('تعذّر إنشاء رمز الإشعارات');
    showToast('🔔','شغّلنا الإشعارات','راح نرسل التنبيهات المهمة بس',false);
    return true;
  }catch(error){
    recordNonFatal(error,'firebase.messaging.permission');
    showToast('⚠️','ما قدرنا نشغّل الإشعارات','جرّب من إعدادات iPhone',false);
    return false;
  }finally{
    const current=await messaging.checkPermissions().catch(()=>({receive:'prompt'}));
    renderPushPermission(current.receive);
  }
}

function isAuthCancellation(e){
  const detail = String((e && (e.code || e.message)) || '').toLowerCase();
  return detail.includes('cancel') || detail.includes('popup-closed-by-user');
}

function isAuthNetworkError(e){
  const detail = String((e && (e.code || e.message)) || '').toLowerCase();
  return detail.includes('network-request-failed') || detail.includes('network error')
    || detail.includes('not connected') || detail.includes('offline');
}
function showAuthNetworkError(){
  showToast('📡','ماكو اتصال','تأكد من النت وجرّب مرة ثانية',false);
}

let _authActionPending = false;
let _authPendingMessage = '';
function beginAuthAction(message='ثواني ونكمّل العملية…'){
  if(_authActionPending) return false;
  _authActionPending = true;
  _authPendingMessage = `⏳ ${message}`;
  const screen=document.getElementById('s-auth');
  if(screen) screen.setAttribute('aria-busy','true');
  const msg=document.getElementById('auth-msg');
  if(msg){ msg.style.color=''; msg.textContent=_authPendingMessage; }
  document.querySelectorAll('#s-auth .auth-card button').forEach(button=>{ button.disabled=true; });
  return true;
}
function endAuthAction(){
  _authActionPending = false;
  const screen=document.getElementById('s-auth');
  if(screen) screen.removeAttribute('aria-busy');
  const msg=document.getElementById('auth-msg');
  if(msg && msg.textContent===_authPendingMessage) msg.textContent='';
  _authPendingMessage='';
  document.querySelectorAll('#s-auth .auth-card button').forEach(button=>{ button.disabled=false; });
}

// الطبقة الثانية: Firebase Web SDK (يعمل في المتصفح إذا كان FIREBASE_CONFIG جاهزاً)
let _fbWebSDK = null;
async function getFirebaseWebAuth(){
  if(_fbWebSDK) return _fbWebSDK;
  if(!window.FIREBASE_CONFIGURED) return null;
  try{
    const [appMod, authMod] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js'),
    ]);
    const { initializeApp, getApps } = appMod;
    const { getAuth, signInWithPopup, signInWithRedirect, getRedirectResult, GoogleAuthProvider, OAuthProvider } = authMod;
    const app = getApps().length ? getApps()[0] : initializeApp(window.FIREBASE_CONFIG);
    _fbWebSDK = { auth: getAuth(app), signInWithPopup, signInWithRedirect, getRedirectResult, GoogleAuthProvider, OAuthProvider };
    return _fbWebSDK;
  }catch(e){ logClientEvent('error','firebase.web-sdk'); return null; }
}

async function appleSignIn(){
  if(!beginAuthAction('ثواني ونفتح تسجيل الدخول عن طريق Apple…')) return;
  try{
  sfx('tap'); vibrate(15);
  const isAnon = storeGet('authProvider','')==='anonymous';
  // محاولة 1: Capacitor (iOS app)
  const FA = getFirebaseAuth();
  if(FA){
    try{
      const res = isAnon ? await FA.linkWithApple() : await FA.signInWithApple();
      const u = res && res.user;
      if(u){
        if(u.email) storeSet('authEmail', u.email);
        // await إلزامي: بيانات Apple الحقيقية (اسم/بريد) تُرسَل مرة واحدة فقط
        // أبداً — فقدها بسبب تنقّل/إغلاق سريع قبل اكتمال الطلب لا يُسترجع
        await savePermanentProfile(u.uid, u.displayName, u.email, 'apple');
      }
      afterAuthSuccess((u && u.displayName) || storeGet('playerName','لاعب'), 'apple', u && u.uid, u && u.email);
      return;
    }catch(e){
      const code=String(e && e.code || '');
      if(isAuthCancellation(e)) return;
      if(code.includes('account-exists-with-different-credential') || code.includes('credential-already-in-use')){
        await handleAuthConflict(e, 'apple', null); return;
      }
      if(isAuthNetworkError(e)){ showAuthNetworkError(); return; }
      logClientEvent('error','auth.apple.capacitor');
    }
  }
  // محاولة 2: Firebase Web SDK (متصفح) — SDK محمّل مسبقاً فلا يُمنع الـ popup
  const wb = await getFirebaseWebAuth();
  if(wb){
    try{
      const provider = new wb.OAuthProvider('apple.com');
      provider.addScope('email'); provider.addScope('name');
      let result;
      if(isAnon && wb.auth.currentUser){
        const { linkWithPopup } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
        result = await linkWithPopup(wb.auth.currentUser, provider);
      } else {
        result = await wb.signInWithPopup(wb.auth, provider);
      }
      const u = result.user;
      if(u.email){ storeSet('authEmail', u.email); await savePermanentProfile(u.uid, u.displayName, u.email, 'apple'); }
      afterAuthSuccess(u.displayName || u.email || storeGet('playerName','لاعب'), 'apple', u.uid, u.email);
      return;
    }catch(e){
      if(isAuthCancellation(e)) return;
      if(await handleAuthConflict(e, 'apple', wb)) return;
      logClientEvent('error','auth.apple.web');
      if(isAuthNetworkError(e)) showAuthNetworkError();
      else showToast('⚠️','ما قدرنا ندخّلك','جرّب مرة ثانية',false);
      return;
    }
  }
  showToast('🍎','الإعداد ناقص','يحتاج Firebase config',false);
  }finally{ endAuthAction(); }
}

async function googleSignIn(){
  if(!beginAuthAction('ثواني ونفتح تسجيل الدخول عن طريق Google…')) return;
  try{
  sfx('tap'); vibrate(15);
  const isAnon = storeGet('authProvider','')==='anonymous';
  // محاولة 1: Capacitor (iOS app)
  const FA = getFirebaseAuth();
  if(FA){
    try{
      const res = isAnon ? await FA.linkWithGoogle() : await FA.signInWithGoogle();
      const u = res && res.user;
      if(u){
        if(u.email) storeSet('authEmail', u.email);
        await savePermanentProfile(u.uid, u.displayName, u.email, 'google');
      }
      afterAuthSuccess((u && u.displayName) || storeGet('playerName','لاعب'), 'google', u && u.uid, u && u.email);
      return;
    }catch(e){
      const code=String(e && e.code || '');
      if(isAuthCancellation(e)) return;
      if(code.includes('account-exists-with-different-credential') || code.includes('credential-already-in-use')){
        await handleAuthConflict(e, 'google', null); return;
      }
      if(isAuthNetworkError(e)){ showAuthNetworkError(); return; }
      logClientEvent('error','auth.google.capacitor');
    }
  }
  // محاولة 2: Firebase Web SDK (متصفح)
  const wb = await getFirebaseWebAuth();
  if(wb){
    try{
      const provider = new wb.GoogleAuthProvider();
      let result;
      if(isAnon && wb.auth.currentUser){
        const { linkWithPopup } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
        result = await linkWithPopup(wb.auth.currentUser, provider);
      } else {
        result = await wb.signInWithPopup(wb.auth, provider);
      }
      const u = result.user;
      if(u.email){ storeSet('authEmail', u.email); await savePermanentProfile(u.uid, u.displayName, u.email, 'google'); }
      afterAuthSuccess(u.displayName || u.email || storeGet('playerName','لاعب'), 'google', u.uid, u.email);
      return;
    }catch(e){
      if(isAuthCancellation(e)) return;
      if(await handleAuthConflict(e, 'google', wb)) return;
      logClientEvent('error','auth.google.web');
      if(isAuthNetworkError(e)) showAuthNetworkError();
      else showToast('⚠️','ما قدرنا ندخّلك','جرّب مرة ثانية',false);
      return;
    }
  }
  showToast('🔵','الإعداد ناقص','يحتاج Firebase config',false);
  }finally{ endAuthAction(); }
}

// ---- دخول برقم الهاتف ----
let _authPhoneVerificationId='';
let _authPhoneListenerHandles=[];
let _authPhoneStartPending=false;
let _authPhoneConfirmPending=false;

function setAuthMessage(text, error){
  const msg=document.getElementById('auth-msg');
  if(!msg) return;
  msg.style.color=error?'#ff8a8a':'';
  msg.textContent=text||'';
}

async function cleanupAuthPhoneListeners(){
  const handles=_authPhoneListenerHandles.splice(0);
  await Promise.all(handles.map(handle=>Promise.resolve(handle?.remove?.()).catch(()=>{})));
}

function togglePhoneSignInForm(){
  sfx('tap');
  const phoneForm=document.getElementById('auth-phone-form');
  const emailForm=document.getElementById('auth-email-form');
  if(emailForm) emailForm.style.display='none';
  if(!phoneForm) return;
  const opening=phoneForm.style.display==='none';
  phoneForm.style.display=opening?'block':'none';
  setAuthMessage('');
  if(opening) document.getElementById('auth-phone')?.focus();
}

async function finishPhoneSignIn(user){
  await cleanupAuthPhoneListeners();
  _authPhoneVerificationId='';
  const codeForm=document.getElementById('auth-phone-code-form');
  if(codeForm) codeForm.style.display='none';
  afterAuthSuccess(
    (user && (user.displayName || user.phoneNumber)) || 'لاعب',
    'phone',
    user && user.uid,
    user && user.email
  );
}

async function startPhoneSignIn(){
  sfx('tap');
  const input=document.getElementById('auth-phone');
  const phone=normalizePhoneNumber(input && input.value);
  if(!phone){ setAuthMessage('اكتب الرقم بالصيغة الدولية، مثل +96550001234.', true); return; }
  if(_authPhoneStartPending) return;
  const FA=getFirebaseAuth();
  if(!FA || typeof FA.signInWithPhoneNumber!=='function'){
    setAuthMessage('الدخول بالهاتف متوفر داخل تطبيق iPhone بس.', true);
    return;
  }
  _authPhoneStartPending=true;
  const sendButton=document.getElementById('auth-phone-send-btn');
  if(sendButton) sendButton.disabled=true;
  setAuthMessage('⏳ ثواني ونرسل رمز التحقق…');
  try{
    await cleanupAuthPhoneListeners();
    _authPhoneVerificationId='';
    _authPhoneListenerHandles.push(await FA.addListener('phoneCodeSent', event=>{
      _authPhoneVerificationId=event && event.verificationId || '';
      const codeForm=document.getElementById('auth-phone-code-form');
      if(codeForm) codeForm.style.display='block';
      if(sendButton) sendButton.textContent='إعادة إرسال الرمز';
      setAuthMessage('رسلنا الرمز. اكتبه عشان تكمّل تسجيل الدخول.');
      document.getElementById('auth-phone-code')?.focus();
    }));
    _authPhoneListenerHandles.push(await FA.addListener('phoneVerificationCompleted', event=>{
      const completedUser=event && event.result && event.result.user;
      if(completedUser) finishPhoneSignIn(completedUser);
    }));
    _authPhoneListenerHandles.push(await FA.addListener('phoneVerificationFailed', event=>{
      const eventCode=event && (event.code || event.errorCode || event.message);
      setAuthMessage(phoneAuthErrorMessage(eventCode,'ما قدرنا نرسل الرمز — جرّب مرة ثانية.'),true);
      cleanupAuthPhoneListeners();
    }));
    await FA.signInWithPhoneNumber({phoneNumber:phone});
  }catch(e){
    logClientEvent('error','auth.phone.start');
    await cleanupAuthPhoneListeners();
    setAuthMessage(phoneAuthErrorMessage(e && (e.code||e.message),'ما قدرنا نرسل الرمز — جرّب مرة ثانية.'),true);
  }finally{
    _authPhoneStartPending=false;
    if(sendButton) sendButton.disabled=false;
  }
}

async function confirmPhoneSignIn(){
  sfx('tap');
  const code=(document.getElementById('auth-phone-code')?.value||'').trim();
  if(!code){ setAuthMessage('اكتب رمز التحقق.',true); return; }
  if(_authPhoneConfirmPending) return;
  _authPhoneConfirmPending=true;
  const button=document.getElementById('auth-phone-confirm-btn');
  if(button) button.disabled=true;
  setAuthMessage('⏳ ثواني ونسجّل دخولك…');
  try{
    if(!_authPhoneVerificationId) throw new Error('verification-id-missing');
    const FA=getFirebaseAuth();
    const result=await FA.confirmVerificationCode({
      verificationId:_authPhoneVerificationId,
      verificationCode:code
    });
    await finishPhoneSignIn(result && result.user);
  }catch(e){
    logClientEvent('error','auth.phone.confirm');
    const errorCode=String(e && (e.code||e.message)||'').toLowerCase();
    if(errorCode.includes('invalid-verification-code')) setAuthMessage('رمز التحقق مو صحيح.',true);
    else if(errorCode.includes('session-expired') || errorCode.includes('verification-id-missing')) setAuthMessage('انتهت صلاحية الرمز — أرسل رمز جديد.',true);
    else setAuthMessage(phoneAuthErrorMessage(errorCode,'ما قدرنا نسجّل دخولك — جرّب مرة ثانية.'),true);
  }finally{
    _authPhoneConfirmPending=false;
    if(button) button.disabled=false;
  }
}

// ---- دخول بالبريد وكلمة المرور ----
async function forgotPassword(){
  sfx('tap');
  const emailInput=document.getElementById('auth-email');
  const email=(emailInput && emailInput.value || storeGet('authEmail','')).trim();
  const msg=document.getElementById('auth-msg');
  if(!email || !email.includes('@')){
    if(emailInput) emailInput.focus();
    msg.style.color='#f5c542';
    msg.textContent='اكتب بريدك الإلكتروني أول عشان نرسل رابط تغيير كلمة المرور';
    return;
  }
  if(!beginAuthAction('ثواني ونرسل رابط تغيير كلمة المرور…')) return;
  msg.style.color='';
  msg.textContent='ثواني ونرسل رابط تغيير كلمة المرور…';
  try{
    const FA=getFirebaseAuth();
    if(FA){
      await FA.sendPasswordResetEmail({email});
    } else {
      const wb=await getFirebaseWebAuth();
      if(!wb) throw new Error('firebase-not-configured');
      const {sendPasswordResetEmail}=await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
      await sendPasswordResetEmail(wb.auth,email);
    }
    msg.style.color='#8ee6b0';
    msg.textContent='رسلنا رابط تغيير كلمة المرور لبريدك. شيّك على الوارد والرسائل غير المرغوب فيها.';
  }catch(e){
    logClientEvent('error','auth.password-reset');
    const code=String((e && e.code)||'');
    msg.style.color='#ff8a8a';
    if(code.includes('invalid-email')) msg.textContent='صيغة البريد الإلكتروني مو صحيحة';
    else if(code.includes('user-not-found')) msg.textContent='ماكو حساب مربوط بهالبريد';
    else if(code.includes('too-many-requests')) msg.textContent='صارت محاولات وايد. جرّب بعدين.';
    else if(isAuthNetworkError(e)) msg.textContent='ماكو اتصال بالإنترنت — تأكد من الشبكة وجرّب مرة ثانية';
    else if(code.includes('firebase-not-configured')) msg.textContent='الإعداد ناقص — Firebase غير مهيأ';
    else msg.textContent='ما قدرنا نرسل الرابط — تأكد من البريد وجرّب مرة ثانية';
  }finally{ endAuthAction(); }
}

async function forgotEmail(){
  sfx('tap');
  const msg=document.getElementById('auth-msg');
  const savedEmail=String(storeGet('authEmail','')||'').trim();
  let currentEmail='';
  try{
    const user=await getCurrentFirebaseUserData(false);
    currentEmail=String((user && user.email)||'').trim();
  }catch(e){ logClientEvent('warn','auth.forgot-email'); }
  const email=currentEmail||savedEmail;
  msg.style.color=email?'#8ee6b0':'#f5c542';
  msg.textContent=email
    ? `البريد المربوط بهالجهاز: ${email}`
    : 'ماكو بريد محفوظ على هالجهاز. جرّب Apple أو Google أو رقم الهاتف عشان تدخل حسابك.';
}

async function emailAuth(mode){
  sfx('tap');
  const email    = (document.getElementById('auth-email').value||'').trim();
  const password = document.getElementById('auth-password').value||'';
  const msg = document.getElementById('auth-msg');
  msg.style.color=''; msg.textContent='';
  if(!email || !email.includes('@')){ msg.style.color='#ff8a8a'; msg.textContent='اكتب بريد إلكتروني صحيح'; return; }
  if(password.length < 6){ msg.style.color='#ff8a8a'; msg.textContent='كلمة المرور ٦ أحرف على الأقل'; return; }
  if(!beginAuthAction(mode==='signup' ? 'ثواني وننشئ حسابك…' : 'ثواني ونسجّل دخولك…')) return;
  const isAnon = storeGet('authProvider','')==='anonymous';

  try{
    const FA = getFirebaseAuth();
    if(FA){
      let res;
      if(mode==='signup'){
        res = isAnon ? await FA.linkWithEmailAndPassword({email, password})
                     : await FA.createUserWithEmailAndPassword({email, password});
      } else {
        res = await FA.signInWithEmailAndPassword({email, password});
        clearPendingLinkNative();
      }
      const u = res && res.user;
      await savePermanentProfile(u && u.uid, (u && u.displayName) || storeGet('playerName',''), email, 'password');
      if(mode==='signup') await sendEmailVerificationMessage(true);
      afterAuthSuccess(storeGet('playerName','لاعب'), 'password', u && u.uid, email);
      return;
    }
    const wb = await getFirebaseWebAuth();
    if(wb){
      const authMod = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
      const { createUserWithEmailAndPassword, signInWithEmailAndPassword, linkWithCredential, EmailAuthProvider } = authMod;
      let cred;
      if(mode==='signup'){
        if(isAnon && wb.auth.currentUser){
          const emailCred = EmailAuthProvider.credential(email, password);
          cred = await linkWithCredential(wb.auth.currentUser, emailCred);
        } else {
          cred = await createUserWithEmailAndPassword(wb.auth, email, password);
        }
      } else {
        cred = await signInWithEmailAndPassword(wb.auth, email, password);
        await resolvePendingLinkWeb(wb, cred.user);
      }
      const u = cred.user;
      await savePermanentProfile(u.uid, u.displayName || storeGet('playerName',''), email, 'password');
      if(mode==='signup') await sendEmailVerificationMessage(true);
      afterAuthSuccess(storeGet('playerName','لاعب'), 'password', u.uid, email);
      return;
    }
    msg.style.color='#ff8a8a'; msg.textContent='الإعداد ناقص — Firebase غير مهيأ';
  }catch(e){
    logClientEvent('error','auth.email');
    const code = String((e && e.code) || '');
    if(code.includes('email-already-in-use') || code.includes('credential-already-in-use')){
      msg.style.color='#f5c542';
      msg.textContent='عندك حساب بهالبريد من قبل — اضغط «تسجيل الدخول» بدل إنشاء حساب';
    } else if(code.includes('wrong-password') || code.includes('invalid-credential') || code.includes('user-not-found')){
      msg.style.color='#ff8a8a'; msg.textContent='البريد أو كلمة المرور مو صحيحة';
    } else if(code.includes('weak-password')){
      msg.style.color='#ff8a8a'; msg.textContent='كلمة المرور ضعيفة — اختار كلمة أقوى';
    } else if(isAuthNetworkError(e)){
      msg.style.color='#ff8a8a'; msg.textContent='ماكو اتصال بالإنترنت — تأكد من الشبكة وجرّب مرة ثانية';
    } else {
      msg.style.color='#ff8a8a'; msg.textContent='ما قدرنا نكمّل العملية — جرّب مرة ثانية';
    }
  }finally{ endAuthAction(); }
}

// ---------- التحقق من البريد ورقم الهاتف ----------
let _phoneVerificationId = '';
let _phoneConfirmation = null;
let _phoneListenerHandles = [];
let _phoneRecaptchaVerifier = null;

function setVerificationMessage(text, error){
  const el=document.getElementById('verification-msg');
  if(el){
    el.textContent=text||'';
    el.style.color=error?'#ff8a8a':'';
  }
}

async function getCurrentFirebaseUserData(reload=true, throwOnError=false){
  const FA=getFirebaseAuth();
  if(FA){
    try{
      if(reload && FA.reload) await FA.reload();
      const result=await FA.getCurrentUser();
      return (result && result.user) || null;
    }catch(e){
      logClientEvent('warn','auth.native-user');
      if(throwOnError) throw e;
      return null;
    }
  }
  const wb=await getFirebaseWebAuth();
  if(wb && wb.auth.currentUser){
    try{
      if(reload) await wb.auth.currentUser.reload();
    }catch(e){
      logClientEvent('warn','auth.web-user');
      if(throwOnError) throw e;
    }
    return wb.auth.currentUser;
  }
  return null;
}

async function refreshVerificationStatus(throwOnError=false){
  const status=document.getElementById('verification-status');
  const emailBtn=document.getElementById('send-email-verification-btn');
  if(!status) return;
  const user=await getCurrentFirebaseUserData(true, throwOnError);
  if(!user){
    status.textContent='سجّل دخولك بحساب Firebase عشان تفعّل التحقق.';
    if(emailBtn) emailBtn.style.display='none';
    return;
  }
  if(emailBtn) emailBtn.style.display=user.email?'block':'none';
  const emailLine=user.email
    ? `البريد: ${esc(user.email)} — ${user.emailVerified ? '✅ تم التحقق' : '⚠️ للحين ما تحققنا منه'}`
    : 'ماكو بريد إلكتروني مربوط بهالحساب.';
  const phoneLine=user.phoneNumber
    ? `الهاتف: ${esc(user.phoneNumber)} — ✅ تم التحقق`
    : 'الهاتف: للحين ما تحققنا منه';
  status.innerHTML=`<div>${emailLine}</div><div style="margin-top:5px;">${phoneLine}</div>`;
}

let _emailVerificationPending=false;
async function sendEmailVerificationMessage(silent=false){
  if(_emailVerificationPending) return false;
  _emailVerificationPending=true;
  const button=document.getElementById('send-email-verification-btn');
  if(button) button.disabled=true;
  if(!silent) setVerificationMessage('⏳ ثواني ونرسل رسالة التحقق…');
  try{
    const user=await getCurrentFirebaseUserData();
    if(!user || !user.email){
      setVerificationMessage('ضيف دخول بالبريد أول عشان نرسل رسالة التحقق.', true);
      return false;
    }
    if(user.emailVerified){
      setVerificationMessage('تحققنا من هالبريد من قبل.');
      return true;
    }
    const FA=getFirebaseAuth();
    if(FA){
      await FA.sendEmailVerification();
    }else{
      const wb=await getFirebaseWebAuth();
      if(!wb || !wb.auth.currentUser) throw new Error('Firebase غير مهيأ');
      const { sendEmailVerification } =
        await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
      await sendEmailVerification(wb.auth.currentUser);
    }
    setVerificationMessage('رسلنا رسالة التحقق. افتحها وبعدها حدّث الحالة.');
    if(!silent) showToast('✉️','رسلنا رسالة التحقق','شيّك على بريدك الإلكتروني',false);
    return true;
  }catch(e){
    logClientEvent('error','auth.email-verification');
    const code=String((e && (e.code||e.message))||'').toLowerCase();
    if(isAuthNetworkError(e)) setVerificationMessage('ماكو اتصال بالإنترنت — تأكد من الشبكة وجرّب مرة ثانية.', true);
    else if(code.includes('too-many-requests')) setVerificationMessage('انرسلت طلبات وايد — نطر شوي وجرّب مرة ثانية.', true);
    else setVerificationMessage('ما قدرنا نرسل رسالة التحقق — جرّب مرة ثانية.', true);
    return false;
  }finally{
    _emailVerificationPending=false;
    if(button) button.disabled=false;
  }
}

let _verificationRefreshPending=false;
async function refreshEmailVerificationStatus(){
  if(_verificationRefreshPending) return;
  _verificationRefreshPending=true;
  const button=document.getElementById('refresh-verification-btn');
  if(button) button.disabled=true;
  setVerificationMessage('⏳ ثواني ونحدّث حالة التحقق…');
  try{
    await refreshVerificationStatus(true);
    setVerificationMessage('حدّثنا حالة التحقق.');
  }catch(e){
    logClientEvent('error','auth.verification-refresh');
    if(isAuthNetworkError(e)) setVerificationMessage('ماكو اتصال بالإنترنت — ما قدرنا نحدّث الحالة.', true);
    else setVerificationMessage('ما قدرنا نحدّث حالة التحقق — جرّب مرة ثانية.', true);
  }finally{
    _verificationRefreshPending=false;
    if(button) button.disabled=false;
  }
}

async function cleanupPhoneListeners(){
  const handles=_phoneListenerHandles.splice(0);
  for(const handle of handles){
    try{ await handle.remove(); }catch(e){}
  }
}

async function resetVerificationSession(){
  await cleanupPhoneListeners();
  _phoneVerificationId='';
  _phoneConfirmation=null;
  if(_phoneRecaptchaVerifier){
    try{ _phoneRecaptchaVerifier.clear(); }catch(e){}
    _phoneRecaptchaVerifier=null;
  }
  _phoneStartPending=false;
  _phoneConfirmPending=false;
  _emailVerificationPending=false;
  _verificationRefreshPending=false;
  const codeInput=document.getElementById('verification-phone-code');
  if(codeInput) codeInput.value='';
  const form=document.getElementById('phone-code-form');
  if(form) form.style.display='none';
  const sendButton=document.getElementById('send-phone-code-btn');
  if(sendButton){ sendButton.disabled=false; sendButton.textContent='إرسال رمز SMS'; }
  const confirmButton=document.getElementById('confirm-phone-code-btn');
  if(confirmButton) confirmButton.disabled=false;
  const emailButton=document.getElementById('send-email-verification-btn');
  if(emailButton) emailButton.disabled=false;
  const refreshButton=document.getElementById('refresh-verification-btn');
  if(refreshButton) refreshButton.disabled=false;
  setVerificationMessage('');
}

function normalizePhoneNumber(value){
  let phone=String(value||'').trim()
    .replace(/[٠-٩]/g, digit=>String(digit.charCodeAt(0)-0x660))
    .replace(/[۰-۹]/g, digit=>String(digit.charCodeAt(0)-0x6F0))
    .replace(/[\s().-]/g,'');
  if(phone.startsWith('00')) phone='+'+phone.slice(2);
  let local=phone;
  if(phone.startsWith('+965')) local=phone.slice(4);
  else if(phone.startsWith('965')) local=phone.slice(3);
  return /^[1-9]\d{7}$/.test(local) ? `+965${local}` : '';
}

function phoneAuthErrorMessage(code, fallback){
  const errorCode=String(code||'').toLowerCase();
  if(errorCode.includes('network-request-failed') || errorCode.includes('network error') || errorCode.includes('offline')) return 'ماكو اتصال بالإنترنت — تأكد من الشبكة وجرّب مرة ثانية.';
  if(errorCode.includes('provider-disabled')) return 'الدخول برقم الهاتف مو مفعّل في Firebase.';
  if(errorCode.includes('invalid-phone-number')) return 'رقم الكويت مو صحيح. اكتب ٨ أرقام من غير صفر بالبداية.';
  if(errorCode.includes('too-many-requests')) return 'صارت محاولات وايد لإرسال SMS. نطر شوي وجرّب مرة ثانية.';
  if(errorCode.includes('credential-already-in-use')) return 'رقم الهاتف مربوط بحساب ثاني.';
  if(errorCode.includes('captcha-check-failed')) return 'ما قدرنا نكمّل التحقق الأمني. جرّب من اتصال موثوق.';
  return fallback;
}

async function finishPhoneVerification(user){
  await cleanupPhoneListeners();
  _phoneVerificationId='';
  _phoneConfirmation=null;
  const form=document.getElementById('phone-code-form');
  if(form) form.style.display='none';
  const codeInput=document.getElementById('verification-phone-code');
  if(codeInput) codeInput.value='';
  const sendButton=document.getElementById('send-phone-code-btn');
  if(sendButton) sendButton.textContent='إرسال رمز SMS';
  if(user && user.phoneNumber){
    const input=document.getElementById('verification-phone');
    if(input) input.value=user.phoneNumber;
  }
  setVerificationMessage('تحققنا من رقم الهاتف وربطناه بحسابك.');
  await refreshVerificationStatus();
  renderAccountLinks();
  showToast('📱','وثّقنا رقم الهاتف','ربطنا الرقم بحسابك بنجاح',false);
}

let _phoneStartPending=false;
async function startPhoneVerification(){
  sfx('tap');
  setVerificationMessage('');
  const input=document.getElementById('verification-phone');
  const phone=normalizePhoneNumber(input && input.value);
  if(!phone){
    setVerificationMessage('اكتب الرقم بالصيغة الدولية، مثل +96550001234.', true);
    return;
  }
  if(_phoneStartPending) return;
  _phoneStartPending=true;
  const startButton=document.getElementById('send-phone-code-btn');
  if(startButton) startButton.disabled=true;
  setVerificationMessage('⏳ ثواني ونرسل رمز SMS…');
  try{
  const user=await getCurrentFirebaseUserData(false);
  if(!user){
    setVerificationMessage('سجّل دخولك بحساب Firebase أول.', true);
    return;
  }
  if(user.phoneNumber){
    setVerificationMessage('تحققنا من رقم الهاتف من قبل.');
    return;
  }
  await cleanupPhoneListeners();
  _phoneVerificationId='';
  _phoneConfirmation=null;
    const FA=getFirebaseAuth();
    if(FA){
      _phoneListenerHandles.push(await FA.addListener('phoneCodeSent', event=>{
        _phoneVerificationId=event && event.verificationId || '';
        const form=document.getElementById('phone-code-form');
        if(form) form.style.display='block';
        if(startButton) startButton.textContent='إعادة إرسال رمز SMS';
        setVerificationMessage('رسلنا رمز SMS. اكتبه هني عشان نكمّل التحقق.');
        document.getElementById('verification-phone-code')?.focus();
      }));
      _phoneListenerHandles.push(await FA.addListener('phoneVerificationCompleted', event=>{
        const completedUser=event && event.result && event.result.user;
        if(completedUser) finishPhoneVerification(completedUser);
      }));
      _phoneListenerHandles.push(await FA.addListener('phoneVerificationFailed', event=>{
        const eventCode=event && (event.code || event.errorCode || event.message);
        setVerificationMessage(phoneAuthErrorMessage(eventCode, 'ما قدرنا نرسل رمز SMS — جرّب مرة ثانية.'), true);
        if(startButton) startButton.textContent='إرسال رمز SMS';
        cleanupPhoneListeners();
      }));
      await FA.linkWithPhoneNumber({phoneNumber:phone});
      setVerificationMessage('ثواني ونرسل رمز SMS…');
      return;
    }
    const wb=await getFirebaseWebAuth();
    if(!wb || !wb.auth.currentUser) throw new Error('Firebase غير مهيأ');
    const { linkWithPhoneNumber, RecaptchaVerifier } =
      await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
    if(!_phoneRecaptchaVerifier){
      _phoneRecaptchaVerifier=new RecaptchaVerifier(wb.auth, 'phone-recaptcha', {size:'invisible'});
    }
    _phoneConfirmation=await linkWithPhoneNumber(
      wb.auth.currentUser, phone, _phoneRecaptchaVerifier
    );
    const form=document.getElementById('phone-code-form');
    if(form) form.style.display='block';
    if(startButton) startButton.textContent='إعادة إرسال رمز SMS';
    setVerificationMessage('رسلنا رمز SMS. اكتبه هني عشان نكمّل التحقق.');
    document.getElementById('verification-phone-code')?.focus();
  }catch(e){
    logClientEvent('error','auth.phone.start');
    await cleanupPhoneListeners();
    const code=String(e && (e.code||e.message) || '');
    setVerificationMessage(phoneAuthErrorMessage(code, 'ما قدرنا نرسل رمز SMS — جرّب مرة ثانية.'), true);
    if(startButton) startButton.textContent='إرسال رمز SMS';
  }finally{
    _phoneStartPending=false;
    if(startButton) startButton.disabled=false;
  }
}

let _phoneConfirmPending=false;
async function confirmPhoneVerification(){
  sfx('tap');
  const code=(document.getElementById('verification-phone-code')?.value||'').trim();
  if(!code){
    setVerificationMessage('اكتب رمز التحقق اللي وصلك برسالة SMS.', true);
    return;
  }
  if(_phoneConfirmPending) return;
  _phoneConfirmPending=true;
  const confirmButton=document.getElementById('confirm-phone-code-btn');
  if(confirmButton) confirmButton.disabled=true;
  setVerificationMessage('⏳ ثواني ونتأكد من رمز التحقق…');
  try{
    let result=null;
    const FA=getFirebaseAuth();
    if(FA){
      if(!_phoneVerificationId) throw new Error('verification-id-missing');
      result=await FA.confirmVerificationCode({
        verificationId:_phoneVerificationId, verificationCode:code
      });
    }else if(_phoneConfirmation){
      result=await _phoneConfirmation.confirm(code);
    }else{
      throw new Error('verification-session-missing');
    }
    const user=result && result.user;
    await finishPhoneVerification(user || await getCurrentFirebaseUserData());
  }catch(e){
    logClientEvent('error','auth.phone.confirm');
    const errorCode=String(e && (e.code||e.message) || '').toLowerCase();
    if(errorCode.includes('invalid-verification-code')) setVerificationMessage('رمز التحقق مو صحيح.', true);
    else if(errorCode.includes('session-expired') || errorCode.includes('verification-session-missing') || errorCode.includes('verification-id-missing')){
      await cleanupPhoneListeners();
      _phoneVerificationId='';
      _phoneConfirmation=null;
      const form=document.getElementById('phone-code-form');
      if(form) form.style.display='none';
      const codeInput=document.getElementById('verification-phone-code');
      if(codeInput) codeInput.value='';
      const sendButton=document.getElementById('send-phone-code-btn');
      if(sendButton) sendButton.textContent='إرسال رمز جديد';
      setVerificationMessage('انتهت صلاحية الرمز — اضغط «إرسال رمز جديد».', true);
    }
    else if(isAuthNetworkError(e)) setVerificationMessage('ماكو اتصال بالإنترنت — ما قدرنا نتأكد من الرمز.', true);
    else setVerificationMessage('ما قدرنا نتأكد من الرقم — شيّك على الرمز وجرّب مرة ثانية.', true);
  }finally{
    _phoneConfirmPending=false;
    if(confirmButton) confirmButton.disabled=false;
  }
}

// ===== شاشة التعليم الأولى (onboarding) =====
let _onbStep = 0;
const _ONB_TOTAL = 3;
function _onbSetStep(step){
  // تحديث الأزرار
  document.getElementById('onb-next-btn').textContent = (step === _ONB_TOTAL - 1) ? 'يلا نلعب 🎯' : 'كمّل';
  // تحديث النقاط
  document.querySelectorAll('.onb-dot').forEach((d,i)=>{
    d.classList.toggle('active', i===step);
  });
  // تحريك البطاقات
  for(let i=0; i<_ONB_TOTAL; i++){
    const c = document.getElementById('onb-card-'+i);
    const active=i===step;
    c.classList.remove('active','out');
    if(active) c.classList.add('active');
    else if(i<step) c.classList.add('out');
    c.setAttribute('aria-hidden',active?'false':'true');
    c.inert=!active;
  }
  const screen=document.getElementById('s-onb');
  if(screen?.classList.contains('active')) requestAnimationFrame(()=>focusScreenAccessibilityTitle(screen));
}
function onbNext(){
  sfx('tap');
  if(_onbStep < _ONB_TOTAL - 1){
    _onbStep++;
    _onbSetStep(_onbStep);
  } else {
    onbFinish();
  }
}
function onbFinish(){
  sfx('tap');
  storeSet('onbDone', true);
  checkSubscriptionAndRoute(storeGet('authUid',''));
}

// ────────── RevenueCat — Apple IAP
// مفتاح RevenueCat عام، لكنه لا يبقى في localStorage/Preferences. على iOS
// تحفظه الإضافة المحلية في Keychain وتعيده عند الإقلاع التالي.
let RC_API_KEY = '';
let RC_CONFIGURED = false;
async function loadRcKey(){
  if(RC_API_KEY) return RC_API_KEY;
  const keyStore=window.Capacitor?.Plugins?.RevenueCatKeyStore;
  // الخادم هو المصدر الأساسي للمفتاح العام. قد يبقى في Keychain مفتاح مشروع
  // قديم بعد تحديث TestFlight أو حتى بعد إعادة تثبيت التطبيق، لذلك لا نعطي
  // النسخة المحفوظة أولوية على إعداد الخادم الحالي.
  try{
    const r = await apiFetch('/api/rc-config');
    if(r.ok){
      const d = await r.json();
      if(d && d.apiKey){
        RC_API_KEY = d.apiKey;
        RC_CONFIGURED = true;
        if(keyStore) await keyStore.set({value:d.apiKey});
        return RC_API_KEY;
      }
    }
  }catch(e){ logClientEvent('error','revenuecat.configure'); }
  // عند انقطاع الشبكة فقط نستخدم آخر مفتاح صالح حُفظ بنجاح.
  if(keyStore){
    try{
      const saved=await keyStore.get();
      if(saved && saved.value){
        RC_API_KEY=saved.value;
        RC_CONFIGURED=true;
      }
    }catch(e){ logClientEvent('warn','revenuecat.keychain-read'); }
  }
  return RC_API_KEY;
}
// امسح أي نسخة تركتها الإصدارات القديمة في تخزين JavaScript.
localStorage.removeItem(STORAGE_PREFIX+'rcApiKey');
window.Capacitor?.Plugins?.Preferences?.remove({key:STORAGE_PREFIX+'rcApiKey'}).catch(()=>{});
const RC_ENTITLEMENT = 'premium';
const RC_APP_USER_ID_KEY = 'rcAppUserId';
const RC_APP_USER_IDS_KEY = 'rcAppUserIds';
const RC_SUBSCRIPTION_CACHE_KEY = 'rcSubCache';
const RC_SUBSCRIPTION_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RC_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function storedRcAppUserId(uid=storeGet('authUid','')){
  uid=String(uid||'');
  const ids=storeGet(RC_APP_USER_IDS_KEY,{}) || {};
  const value=String((uid&&ids[uid])||storeGet(RC_APP_USER_ID_KEY,'')||'').toLowerCase();
  return RC_UUID_RE.test(value)?value:'';
}
function persistCanonicalRcAppUserId(uid,rcAppUserId){
  if(!uid||!RC_UUID_RE.test(rcAppUserId)) throw new Error('هوية RevenueCat الخادمية غير صالحة');
  const ids=storeGet(RC_APP_USER_IDS_KEY,{})||{};
  ids[uid]=rcAppUserId;
  storeSet(RC_APP_USER_IDS_KEY,ids);
  // هذا المفتاح من إصدارات قديمة لم تفصل الهويات حسب Firebase UID.
  storeSet(RC_APP_USER_ID_KEY,'');
}

function getRC(){
  return window.Capacitor && window.Capacitor.isNativePlatform()
    && window.Capacitor.Plugins && window.Capacitor.Plugins.Purchases
    || null;
}

let _rcReady = null;
let RC_SDK_CONFIGURED = false;
let RC_CURRENT_APP_USER_ID = '';

function clearRevenueCatSubscriptionCache(){
  localStorage.removeItem(STORAGE_PREFIX+RC_SUBSCRIPTION_CACHE_KEY);
  try{
    const P=window.Capacitor?.Plugins?.Preferences;
    if(P) Promise.resolve(P.remove({key:STORAGE_PREFIX+RC_SUBSCRIPTION_CACHE_KEY})).catch(()=>{});
  }catch(e){}
}

function clearRevenueCatAccessState(){
  clearRevenueCatSubscriptionCache();
  _hasActiveSubscription=false;
  _freeRoundAvailable=false;
  _freeRoundVerificationState='unknown';
  _freeRoundVerificationPending=false;
  _freeRoundVerificationAttempt+=1;
  _subscriptionResolved=false;
  _subscriptionCheckGeneration+=1;
  _subscriptionCheckFlight=null;
}

// لا يكفي وجود UID في localStorage لقبول اشتراك مخزّن. لا تُعد الهوية مؤكدة
// إلا عندما تتطابق جلسة التطبيق الحالية، وخريطة UID↔App User ID، وهوية SDK
// التي تم ربطها بالخادم بعد التحقق من Firebase ID token.
function confirmedRevenueCatCacheIdentity(){
  const currentUid=String(window._currentUid||'');
  const storedUid=String(storeGet('authUid','')||'');
  if(!currentUid || !storedUid || currentUid!==storedUid) return null;
  const ids=storeGet(RC_APP_USER_IDS_KEY,{}) || {};
  const expectedAppUserId=String(ids[storedUid]||'').toLowerCase();
  const sdkAppUserId=String(RC_CURRENT_APP_USER_ID||'').toLowerCase();
  if(!RC_UUID_RE.test(expectedAppUserId) || sdkAppUserId!==expectedAppUserId) return null;
  return {uid:storedUid, rcAppUserId:expectedAppUserId};
}

function sameRevenueCatIdentity(left,right){
  return !!left && !!right
    && left.uid===right.uid
    && left.rcAppUserId===right.rcAppUserId;
}

async function resetRevenueCatIdentity(){
  const RC=getRC();
  // يجب سحب الصلاحية من الذاكرة قبل أي await حتى لا يستفيد الحساب التالي من
  // نافذة زمنية قصيرة بينما RevenueCat ينفذ logOut في الخلفية.
  clearRevenueCatAccessState();
  RC_CURRENT_APP_USER_ID='';
  _rcReady=null;
  if(RC && RC_SDK_CONFIGURED && typeof RC.logOut==='function'){
    try{ await RC.logOut(); }
    catch(e){ logClientEvent('warn','revenuecat.logout'); }
  }
}

function rcReady(){
  if(!_rcReady){
    const attempt=initRevenueCat();
    _rcReady=attempt;
    // فشل الشبكة أو عدم توافق الخادم لا يسمّم الجلسة كلها. كل المتصلين
    // الحاليين يشتركون في محاولة واحدة، ثم يسمح النظام بمحاولة جديدة لاحقًا.
    void attempt.then(ready=>{
      if(!ready&&_rcReady===attempt) _rcReady=null;
    },()=>{
      if(_rcReady===attempt) _rcReady=null;
    });
  }
  return _rcReady;
}

async function initRevenueCat(){
  const RC = getRC();
  if(!RC) return false;
  await loadRcKey();
  if(!RC_CONFIGURED) return false; // لا تهيّئ إذا لم يتوفر المفتاح
  try{
    const uid = storeGet('authUid','');
    if(!uid) throw new Error('لا يمكن تهيئة RevenueCat بلا حساب Firebase');
    const legacyRcAppUserId=storedRcAppUserId(uid);
    let idToken=await getCurrentIdToken();
    const identityRequest=token=>apiFetch('/api/revenuecat/identity',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        uid,idToken:token,
        ...(legacyRcAppUserId?{legacyRcAppUserId}:{}),
      })
    });
    let identityResp=await identityRequest(idToken);
    // Firebase قد يعيد token مخزناً من جلسة سابقة؛ جدّده مرة واحدة قبل الفشل.
    if(identityResp.status===401){
      idToken=await getCurrentIdToken(true);
      identityResp=await identityRequest(idToken);
    }
    if(!identityResp.ok){
      let detail='';
      try{
        const payload=await identityResp.json();
        detail=payload && payload.error ? `: ${payload.error}` : '';
      }catch(e){}
      throw new Error(`ربط هوية RevenueCat فشل (HTTP ${identityResp.status})${detail}`);
    }
    const identityPayload=await identityResp.json().catch(()=>({}));
    const rcAppUserId=String(identityPayload?.rcAppUserId||'').toLowerCase();
    if(!RC_UUID_RE.test(rcAppUserId)){
      throw new Error('الخادم لم يعد هوية RevenueCat صالحة');
    }
    persistCanonicalRcAppUserId(uid,rcAppUserId);
    if(RC_CURRENT_APP_USER_ID&&RC_CURRENT_APP_USER_ID!==rcAppUserId){
      // تبديل مباشر للحساب: اسحب كاش السابق قبل ربط الهوية الخادمية.
      clearRevenueCatAccessState();
      RC_CURRENT_APP_USER_ID='';
    }
    if(!RC_SDK_CONFIGURED){
      await RC.configure({ apiKey: RC_API_KEY, appUserID: rcAppUserId });
      RC_SDK_CONFIGURED=true;
    }else if(RC_CURRENT_APP_USER_ID!==rcAppUserId && typeof RC.logIn==='function'){
      await RC.logIn({ appUserID: rcAppUserId });
    }
    RC_CURRENT_APP_USER_ID=rcAppUserId;
    // لا نرسل البريد أو Firebase UID كـ subscriber attribute.
    // Secure Attributes غير متاحة في هذا SDK؛ الصلاحيات تُحسم بالـwebhook.
    return true;
  }catch(e){
    logClientEvent('error','revenuecat.initialize');
    return false;
  }
}

async function rcIsActive(){
  const RC = getRC();
  if(!RC) return null; // null = غير متاح (ويب)
  // initRevenueCat يثبت Firebase UID لدى الخادم ثم يضبط App User ID داخل SDK.
  // بلا هذه الخطوة لا توجد هوية موثوقة يجوز ربط كاش الاشتراك بها.
  if(!(await rcReady())) return null;
  const identity=confirmedRevenueCatCacheIdentity();
  if(!identity) return null;
  try{
    const { customerInfo } = await RC.getCustomerInfo();
    const active = !!(customerInfo.entitlements.active &&
                      customerInfo.entitlements.active[RC_ENTITLEMENT]);
    const latestIdentity=confirmedRevenueCatCacheIdentity();
    if(!sameRevenueCatIdentity(identity,latestIdentity)) return null;
    // احفظ آخر حالة معروفة لهوية Firebase + RevenueCat المؤكدتين فقط.
    storeSet(RC_SUBSCRIPTION_CACHE_KEY, {
      uid:identity.uid,
      rcAppUserId:identity.rcAppUserId,
      active,
      ts:Date.now(),
    });
    return active;
  }catch(e){
    logClientEvent('error','revenuecat.status');
    // إذا كنا بلا إنترنت على iOS، أعد الحالة المحفوظة (صالحة 7 أيام)
    if(!navigator.onLine){
      const latestIdentity=confirmedRevenueCatCacheIdentity();
      const cache = storeGet(RC_SUBSCRIPTION_CACHE_KEY, null);
      if(sameRevenueCatIdentity(identity,latestIdentity)
        && cache
        && cache.uid===identity.uid
        && cache.rcAppUserId===identity.rcAppUserId
        && Number.isFinite(cache.ts)
        && (Date.now() - cache.ts) >= 0
        && (Date.now() - cache.ts) < RC_SUBSCRIPTION_CACHE_TTL_MS
        && typeof cache.active==='boolean'){
        logClientEvent('info','revenuecat.offline-cache');
        return cache.active;
      }
    }
    return null;
  }
}

async function rcIsActiveWithin(timeoutMs=8000){
  const check=Promise.resolve().then(()=>rcIsActive()).catch(()=>null);
  return settleWithin(check,timeoutMs,null);
}

// ────────── Paywall — أسعار حقيقية من StoreKit عبر RevenueCat (App Store Guideline 3.1.2)
// getOfferings() يرجّع PurchasesOfferings مباشرة ({all, current}) بلا مفتاح
// "offerings" يغلّفه — راجع node_modules/@revenuecat/purchases-capacitor/dist/esm/definitions.d.ts
function pickPackage(offering, plan){
  if(!offering) return null;
  const direct = plan === 'annual' ? offering.annual : offering.monthly;
  if(direct) return direct;
  const pkgs = offering.availablePackages || [];
  const type = plan === 'annual' ? 'ANNUAL' : 'MONTHLY';
  return pkgs.find(p=>p.packageType === type)
      || pkgs.find(p=>p.identifier === plan)
      || pkgs.find(p=>p.identifier === '$rc_' + plan)
      || null;
}

let _pwPkgs = null; // {monthly, annual} — كاش لنتيجة getOfferings
async function fetchPackages(force){
  if(_pwPkgs && !force) return _pwPkgs;
  const RC = getRC();
  if(!RC) throw new Error('RevenueCat مو متوفر');
  await loadRcKey();
  if(!RC_CONFIGURED) throw new Error('RevenueCat مو مجهّأ — ما قدرنا نجيب المفتاح من الخادم');
  if(!(await rcReady())) throw new Error('ما قدرنا نجهّز RevenueCat — راجع سجلّ Xcode');
  const res = await RC.getOfferings();
  const offerings = (res && res.offerings) ? res.offerings : res; // تسامح مع الشكلين
  const current = offerings && offerings.current;
  if(!current) throw new Error('ماكو عروض متوفرة — تأكد إن Offering محدد كـ Current بلوحة RevenueCat');
  _pwPkgs = {
    monthly: pickPackage(current, 'monthly') || null,
    annual:  pickPackage(current, 'annual')  || null
  };
  return _pwPkgs;
}

// يشتق "يعادل X شهرياً" من priceString نفسه حتى يبقى رمز العملة وموضعه
// كما يعرضهم المتجر بالضبط. عدد الخانات العشرية من معيار العملة (Intl)
// وليس من شكل النص، لأن فاصلة الآلاف (مثل ¥4,500) ليست فاصلة عشرية.
function perMonthFromAnnual(product){
  if(!product || typeof product.priceString !== 'string' || typeof product.price !== 'number') return '';
  const currency = product.currencyCode || 'USD';
  let fractionDigits = 2;
  try{
    fractionDigits = new Intl.NumberFormat('en-US', { style:'currency', currency })
      .resolvedOptions().minimumFractionDigits;
  }catch(e){}
  const scale = Math.pow(10, fractionDigits);
  const perMonth = Math.floor((product.price / 12) * scale) / scale;
  const perMonthStr = perMonth.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
    useGrouping: false
  });
  const numMatch = product.priceString.match(/[\d.,]*\d/);
  if(!numMatch) return '';
  const replaced = product.priceString.slice(0, numMatch.index) + perMonthStr +
                    product.priceString.slice(numMatch.index + numMatch[0].length);
  return `يعادل ${replaced} شهرياً فقط`;
}

function pwCtaSub(plan){
  if(!_pwPkgs) return '';
  const pkg = plan === 'annual' ? _pwPkgs.annual : _pwPkgs.monthly;
  const product = pkg && pkg.product;
  if(!product || !product.priceString) return '';
  const unit = plan === 'annual' ? 'سنة' : 'شهر';
  return `‏${product.priceString} / ${unit} — تُلغى في أي وقت`;
}

let _pwPlan = 'monthly';
let _pwPricesLoading = false;
async function loadPaywallPrices(force){
  if(_pwPricesLoading) return;
  const btn         = document.getElementById('paywall-btn');
  const sub         = document.getElementById('pw-cta-sub');
  const err         = document.getElementById('pw-price-error');
  const note        = document.getElementById('web-payment-note');
  const planAnnual  = document.getElementById('pw-plan-annual');
  const planMonthly = document.getElementById('pw-plan-monthly');

  // بلا Capacitor (ويب): الاشتراك غير متاح هنا، لا تعرض أي سعر
  if(!(window.Capacitor && window.Capacitor.isNativePlatform())){
    if(btn)  btn.style.display = 'none';
    if(note) note.style.display = 'block';
    if(err)  err.style.display = 'none';
    return;
  }

  _pwPricesLoading = true;
  if(btn){ btn.style.display=''; btn.disabled = true; }
  if(sub) sub.textContent = 'ثواني ونجيب الأسعار…';
  if(err)  err.style.display = 'none';
  if(note) note.style.display = 'none';

  try{
    const { monthly, annual } = await fetchPackages(force);
    const monthlyProduct = monthly && monthly.product;
    const annualProduct  = annual  && annual.product;
    if(!monthlyProduct && !annualProduct) throw new Error('ماكو أسعار متوفرة');

    if(planMonthly) planMonthly.style.display = monthlyProduct ? '' : 'none';
    if(planAnnual)  planAnnual.style.display  = annualProduct  ? '' : 'none';

    // لا تعرض سعر وهمي لخطة غائبة — حوّل الاختيار للخطة المتاحة فعلياً
    if(_pwPlan === 'monthly' && !monthlyProduct && annualProduct) _pwPlan = 'annual';
    if(_pwPlan === 'annual'  && !annualProduct  && monthlyProduct) _pwPlan = 'monthly';
    document.querySelectorAll('.pw-plan').forEach(p=>{
      p.setAttribute('aria-checked', p.dataset.plan === _pwPlan ? 'true' : 'false');
    });

    const monthlyPriceEl = document.getElementById('pw-monthly-price');
    const annualPriceEl  = document.getElementById('pw-annual-price');
    const annualSubEl    = document.getElementById('pw-annual-sub');
    const badgeEl         = document.getElementById('pw-annual-badge');
    const termsMonthlyEl = document.getElementById('terms-monthly-price');
    const termsAnnualEl  = document.getElementById('terms-annual-price');

    if(monthlyPriceEl) monthlyPriceEl.textContent = monthlyProduct ? monthlyProduct.priceString : '';
    if(annualPriceEl)  annualPriceEl.textContent  = annualProduct  ? annualProduct.priceString  : '';
    if(termsMonthlyEl) termsMonthlyEl.textContent = monthlyProduct ? `${monthlyProduct.priceString} شهرياً` : '—';
    if(termsAnnualEl)  termsAnnualEl.textContent  = annualProduct  ? `${annualProduct.priceString} سنوياً`  : '—';
    if(annualSubEl)    annualSubEl.textContent    = annualProduct  ? perMonthFromAnnual(annualProduct)     : '';

    if(badgeEl){
      let showBadge = false;
      if(monthlyProduct && annualProduct &&
         typeof monthlyProduct.price==='number' && typeof annualProduct.price==='number'){
        const pct = Math.round((1 - annualProduct.price/(monthlyProduct.price*12)) * 100);
        if(pct > 0){
          badgeEl.textContent = `الأفضل قيمة · وفّر ${pct}%`;
          showBadge = true;
        }
      }
      badgeEl.hidden = !showBadge;
      if(!showBadge) badgeEl.textContent = '';
    }

    if(sub) sub.textContent = pwCtaSub(_pwPlan);
    if(err) err.style.display = 'none';
    if(btn) btn.disabled = false;
  }catch(e){
    logClientEvent('error','paywall.prices');
    if(err) err.style.display = 'block';
    if(sub) sub.textContent = '';
    if(btn) btn.disabled = true;
  }finally{
    _pwPricesLoading = false;
  }
}

async function rcPurchase(plan){
  const RC = getRC();
  if(!RC) throw new Error('RevenueCat مو متوفر');
  const { monthly, annual } = await fetchPackages();
  const pkg = plan === 'annual' ? annual : monthly;
  if(!pkg) throw new Error('الباقة مو موجودة — تأكد من إعداد Offerings في RevenueCat');
  const { customerInfo } = await RC.purchasePackage({ aPackage: pkg });
  // إذا اكتمل الشراء بدون exception → ناجح
  // (RevenueCat قد يأخر تفعيل الـ entitlement بثوانٍ في المحاكي)
  const entActive = customerInfo.entitlements &&
                    customerInfo.entitlements.active &&
                    customerInfo.entitlements.active[RC_ENTITLEMENT];
  return entActive !== undefined ? !!entActive : true;
}

async function rcRestore(){
  const RC = getRC();
  if(!RC){ showToast('ℹ️','متوفر على iOS بس','',false); return; }
  try{
    void trackMetric('restore_started');
    if(!(await rcReady())) throw new Error('ما قدرنا نجهّز RevenueCat — راجع سجلّ Xcode');
    await RC.restorePurchases();
    await checkSubscriptionAndRoute(window._currentUid || storeGet('authUid',''));
    showToast('ℹ️','ثواني ونتأكد من الاستعادة','المحتوى يفتح عقب تأكيد الخادم',false);
  }catch(e){ showToast('⚠️','ما قدرنا نستعيد المشتريات', e.message||'', false); }
}

function subscriptionCheckIsCurrent(uid,generation){
  const currentUid=String(window._currentUid||storeGet('authUid','')||'');
  return generation===_subscriptionCheckGeneration && String(uid||'')===currentUid;
}

async function fetchServerSubscriptionStatus(uid,idToken,timeoutMs){
  const resp=await apiFetch(`/api/subscription/status?uid=${encodeURIComponent(uid||'')}`,{
    headers:{'Authorization':'Bearer '+idToken},
    timeoutMs,
  });
  if(!resp.ok) throw new Error(`subscription status HTTP ${resp.status}`);
  const data=await resp.json();
  return data.active===true;
}

async function performSubscriptionCheck(uid, generation, {
  showLoading=true,
  serverTimeoutMs=15000,
  revenueCatTimeoutMs=12000,
} = {}){
  if(showLoading && subscriptionCheckIsCurrent(uid,generation)) go('s-loading');
  // الخادم هو المصدر الأول. إن تأخر webhook بعد شراء صحيح، نستخدم
  // CustomerInfo الموقّع من RevenueCat حتى لا يبقى العميل عالقاً في paywall.
  // نبدأ المصدرين معاً: الخادم النشط يحسم فوراً، وبقية الحالات تنتظر فقط
  // أبطأ المصدرين بدلاً من جمع مهلتيهما الواحدة بعد الأخرى.
  const revenueCatCheck=rcIsActiveWithin(revenueCatTimeoutMs);
  try{
    const idToken=await getCurrentIdToken();
    if(!idToken) throw new Error('لا توجد جلسة Firebase موثّقة');
    const serverActive=await fetchServerSubscriptionStatus(uid,idToken,serverTimeoutMs);
    if(!subscriptionCheckIsCurrent(uid,generation)) return;
    if(serverActive===true || await revenueCatCheck===true){
      if(!subscriptionCheckIsCurrent(uid,generation)) return;
      _hasActiveSubscription=true; setFreeRoundAvailability(false); _subscriptionResolved=true;
      await routeAfterAccessCheck(uid); return;
    }
    if(!subscriptionCheckIsCurrent(uid,generation)) return;
    _hasActiveSubscription=false;
    setFreeRoundAvailability(await freeRoundIsAvailable(uid));
    if(!subscriptionCheckIsCurrent(uid,generation)) return;
    _subscriptionResolved=true;
    // لا نفاجئ المستخدم بشاشة الاشتراك عند كل تشغيل. بعد استهلاك الجولة
    // المجانية يبقى في الرئيسية، وتظهر شاشة الاشتراك عندما يطلب جولة جديدة.
    await routeAfterAccessCheck(uid);
  }catch(e){
    if(await revenueCatCheck===true){
      if(!subscriptionCheckIsCurrent(uid,generation)) return;
      _hasActiveSubscription=true; setFreeRoundAvailability(false); _subscriptionResolved=true;
      await routeAfterAccessCheck(uid); return;
    }
    if(!subscriptionCheckIsCurrent(uid,generation)) return;
    _hasActiveSubscription=false;
    setFreeRoundAvailability(isLocalWebPreview()
      ?true:(localFreeRoundCompleted(uid)?false:null));
    _subscriptionResolved=true;
    await routeAfterAccessCheck(uid);
  }
}

function checkSubscriptionAndRoute(uid, options={}){
  const normalizedUid=String(uid||'');
  if(_subscriptionCheckFlight?.uid===normalizedUid) return _subscriptionCheckFlight.promise;
  const generation=++_subscriptionCheckGeneration;
  const promise=performSubscriptionCheck(normalizedUid,generation,options).finally(()=>{
    if(_subscriptionCheckFlight?.promise===promise) _subscriptionCheckFlight=null;
  });
  _subscriptionCheckFlight={uid:normalizedUid,promise};
  return promise;
}

function firstActiveSubscriptionResult(checks){
  return new Promise(resolve=>{
    let remaining=checks.length;
    if(!remaining){ resolve(false); return; }
    checks.forEach(check=>Promise.resolve(check).then(active=>{
      if(active===true){ resolve(true); return; }
      remaining-=1;
      if(remaining===0) resolve(false);
    }).catch(()=>{
      remaining-=1;
      if(remaining===0) resolve(false);
    }));
  });
}

async function redeemAppleOfferCode(){
  sfx('tap');
  const RC=getRC();
  if(!window.Capacitor?.isNativePlatform?.() || !RC || typeof RC.presentCodeRedemptionSheet!=='function'){
    showToast('ℹ️','أكواد Apple داخل التطبيق بس','افتح فطنة على iPhone أو iPad عشان تستخدم كود العرض',false);
    return;
  }
  try{
    if(!(await rcReady())) throw new Error('ما قدرنا نجهّز اشتراكات Apple');
    void trackMetric('offer_code_opened');
    await RC.presentCodeRedemptionSheet();
    if(typeof RC.syncPurchases==='function') await RC.syncPurchases();
    await new Promise(resolve=>setTimeout(resolve,1200));
    await checkSubscriptionAndRoute(window._currentUid||storeGet('authUid',''),{showLoading:false});
    if(_hasActiveSubscription){
      showToast('🎉','فعّلنا العرض','اشتراك فطنة برو صار شغّال',false);
    }else{
      showToast('ℹ️','سكّرت نافذة Apple','إذا استخدمت الكود، الاشتراك يطلع عقب تأكيد Apple',false);
    }
  }catch(e){
    recordNonFatal(e,'apple.offer-code');
    showToast('⚠️','ما قدرنا نفتح كود العرض',e.message||'جرّب مرة ثانية',false);
  }
}

function hideSplash(){
  try{ window.Capacitor?.Plugins?.SplashScreen?.hide(); }catch(e){}
}

// ────────── Paywall — اختيار الخطة
document.addEventListener('DOMContentLoaded', ()=>{
  document.querySelectorAll('.pw-plan').forEach(el=>{
    const handler = ()=>{
      if(el.style.display === 'none') return; // خطة غير متاحة حالياً
      document.querySelectorAll('.pw-plan').forEach(p=>p.setAttribute('aria-checked','false'));
      el.setAttribute('aria-checked','true');
      _pwPlan = el.dataset.plan;
      const sub = document.getElementById('pw-cta-sub');
      if(sub) sub.textContent = pwCtaSub(_pwPlan);
    };
    el.addEventListener('click', handler);
    el.addEventListener('keydown', e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); handler(); } });
  });
});

let _checkoutPending=false;
async function startCheckout(){
  if(_checkoutPending) return;
  _checkoutPending=true;
  const btn     = document.getElementById('paywall-btn');
  const loading = document.getElementById('paywall-loading');
  btn.style.display     = 'none';
  loading.style.display = 'block';
  try{
    void trackMetric('purchase_started',{plan:_pwPlan});
    // iOS: Apple IAP عبر RevenueCat
    if(window.Capacitor && window.Capacitor.isNativePlatform()){
      const purchaseConfirmed = await rcPurchase(_pwPlan);
      if(!purchaseConfirmed) throw new Error('اكتمل الدفع بس الاشتراك ما ظهر للحين — استخدم استعادة المشتريات');
      const uid=window._currentUid || storeGet('authUid','');
      const serverConfirmation=(async()=>{
        const idToken=await getCurrentIdToken();
        if(!idToken) return false;
        return fetchServerSubscriptionStatus(uid,idToken,15000);
      })();
      const subscriptionConfirmed=await firstActiveSubscriptionResult([
        serverConfirmation,
        rcIsActiveWithin(12000),
      ]);
      if(subscriptionConfirmed){
        _hasActiveSubscription=true; _freeRoundAvailable=false; _subscriptionResolved=true;
        void trackMetric('purchase_completed',{plan:_pwPlan});
        go('s-home');
        showToast('🎉','هلا فيك!','فعّلنا اشتراك Apple بنجاح',false);
      } else {
        go('s-paywall');
        showToast('⏳','ثواني ونتأكد من الاشتراك','المحتوى يطلع عقب ما يوصل تأكيد Apple',false);
      }
      return;
    }
    const note = document.getElementById('web-payment-note');
    if(note) note.style.display = 'block';
    showToast('ℹ️','الاشتراك عبر Apple فقط','افتح تطبيق فطنة على iPhone أو iPad لإتمام الاشتراك',false);
    btn.style.display = 'block';
    loading.style.display = 'none';
    return;
  }catch(e){
    // تجاهل إلغاء المستخدم بصمت
    if((e.code||'').toString().includes('CANCELLED') ||
       (e.message||'').toLowerCase().includes('cancel')){ /* صامت */ }
    else{ showToast('⚠️','ما قدرنا نكمّل الدفع', e.message || 'جرّب مرة ثانية', false); }
    btn.style.display     = 'block';
    loading.style.display = 'none';
  }finally{
    _checkoutPending=false;
    btn.style.display='block';
    loading.style.display='none';
  }
}

// ---- الإحصاءات والإنجازات ----
function openStats(){ renderStats(); go('s-stats'); }
function openAccountSettings(){
  renderAccountLinks(); refreshVerificationStatus();
  void initPushMessaging().catch(error=>recordNonFatal(error,'firebase.messaging.account'));
  const inp = document.getElementById('account-name-input');
  if(inp) inp.value = storeGet('playerName','');
  const msg = document.getElementById('account-name-msg');
  if(msg) msg.textContent = '';
  go('s-account');
}

function savePlayerName(){
  const inp = document.getElementById('account-name-input');
  const name = (inp && inp.value.trim()) || '';
  if(!name){ showToast('⚠️','الاسم فاضي','اكتب اسمك أول',false); return; }
  storeSet('playerName', name);
  const nameEl = document.getElementById('user-name');
  if(nameEl) nameEl.textContent = name;
  const msg = document.getElementById('account-name-msg');
  if(msg){ msg.textContent = '✓ حفظنا الاسم'; setTimeout(()=>{ if(msg) msg.textContent=''; }, 2000); }
  sfx('correct');
}

// ---- شاشة ربط الحسابات (Proactive linking) ----
const PROVIDER_INFO = {
  'apple.com': {label:'Apple',   icon:'🍎'},
  'google.com':{label:'Google',  icon:'🔵'},
  'password':  {label:'البريد وكلمة المرور', icon:'📧'},
  'phone':    {label:'رقم الهاتف', icon:'📱'},
};
async function getCurrentProviderData(){
  const FA=getFirebaseAuth();
  if(FA){
    try{ const cur=await FA.getCurrentUser(); return (cur && cur.user && cur.user.providerData) || []; }
    catch(e){ return []; }
  }
  const wb=await getFirebaseWebAuth();
  if(wb && wb.auth.currentUser) return wb.auth.currentUser.providerData || [];
  return [];
}
async function renderAccountLinks(){
  const box=document.getElementById('account-links');
  if(!box) return;
  const linked = await getCurrentProviderData();
  const linkedIds = new Set(linked.map(p=>p.providerId));
  box.innerHTML = Object.keys(PROVIDER_INFO).map(pid=>{
    const info=PROVIDER_INFO[pid];
    const isLinked=linkedIds.has(pid);
    const status = isLinked
      ? '<span style="color:#7CFC7C;font-size:12px;">✓ مربوط</span>'
      : '<span style="color:var(--muted);font-size:12px;">مو مربوط</span>';
    const action = isLinked
      ? `<button class="btn btn-ghost" style="padding:6px 14px;font-size:13px;width:auto;" data-action="unlink-provider" data-provider="${pid}">فك الربط</button>`
      : `<button class="btn btn-primary" style="padding:6px 14px;font-size:13px;width:auto;" data-action="link-provider" data-provider="${pid}">ربط</button>`;
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06);">
      <span>${info.icon} ${info.label} ${status}</span>
      ${action}
    </div>`;
  }).join('');
}
function linkProvider(pid){
  sfx('tap');
  window._authReturnScreen = 's-stats';
  if(pid==='apple.com'){ appleSignIn(); return; }
  if(pid==='google.com'){ googleSignIn(); return; }
  if(pid==='phone'){
    const input=document.getElementById('verification-phone');
    if(input){ input.focus(); input.scrollIntoView({behavior:'smooth',block:'center'}); }
    setVerificationMessage('اكتب رقمك بصيغة دولية ثم أرسل رمز SMS.');
    return;
  }
  openAuth('s-stats');
  document.getElementById('auth-title').textContent='ضيف طريقة دخول يديدة';
  document.getElementById('auth-sub').textContent='ضيف البريد وكلمة المرور كطريقة دخول إضافية لحسابك الحالي';
  document.getElementById('auth-email-form').style.display='block';
}
async function unlinkProvider(pid){
  sfx('tap');
  const linked = await getCurrentProviderData();
  if(linked.length<=1){
    showToast('⚠️','ما نقدر نفك الربط','هذي آخر طريقة دخول لحسابك — ضيف طريقة ثانية قبل لا تفك هذي',false);
    return;
  }
  const label = (PROVIDER_INFO[pid]||{}).label || pid;
  const ok=confirm(`تبي تفك ربط الدخول عن طريق ${label}؟ راح تحتاج طريقة ثانية عشان تسجّل دخولك بعدين.`);
  if(!ok) return;
  try{
    const FA=getFirebaseAuth();
    if(FA){
      await FA.unlink({providerId: pid});
    } else {
      const wb=await getFirebaseWebAuth();
      if(wb && wb.auth.currentUser){
        const { unlink } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
        await unlink(wb.auth.currentUser, pid);
      }
    }
    if(pid==='password') storeSet('authEmail','');
    if(storeGet('authProvider','')===('apple.com'===pid?'apple':'google.com'===pid?'google':'password')){
      // إن كان المزوّد الذي فُكّ ربطه هو المسجَّل حالياً، حدِّث المخزَّن لأقرب مزوّد متبقٍ
      const remaining = await getCurrentProviderData();
      const first = remaining[0];
      if(first){
        const np = first.providerId==='apple.com'?'apple':first.providerId==='google.com'?'google':'password';
        storeSet('authProvider', np);
      }
    }
    showToast('✅','فكّينا الربط','',false);
    renderAccountLinks();
  }catch(e){ logClientEvent('error','account.unlink'); showToast('⚠️','ما قدرنا نفك الربط','',false); }
}
function renderStats(){
  const acc=stats.totalQ?Math.round((stats.correct/stats.totalQ)*100):0;
  const g=document.getElementById('stats-grid');
  g.innerHTML=[
    ['🎮',stats.games,'جولات لعبتها'],
    ['✅',stats.correct,'إجابات صحيحة'],
    ['🎯',acc+'%','نسبة الدقة'],
    ['🏆',stats.wins,'مرات فزت'],
    ['💎',stats.bestScore,'أعلى نقاط'],
    ['📚',stats.totalQ,'أسئلة جاوبتها'],
  ].map(([i,v,l])=>`<div class="stat"><div class="sv">${i} ${v}</div><div class="sl">${l}</div></div>`).join('');
  const list=document.getElementById('ach-list');
  list.innerHTML=ACHIEVEMENTS.map(a=>{
    const on=!!stats.ach[a.id];
    return `<div class="ach ${on?'unlocked':'locked'}"><div class="ai">${on?a.icon:'🔒'}</div>
      <div><div class="at">${a.t}</div><div class="ad">${a.d}</div></div></div>`;
  }).join('');
}
function checkAchievements(){
  ACHIEVEMENTS.forEach(a=>{
    if(!stats.ach[a.id]&&a.chk(stats)){
      stats.ach[a.id]=true; saveStats();
      setTimeout(()=>showToast(a.icon,'إنجاز يديد!',a.t),700);
    }
  });
}
function showToast(icon,title,desc,playAchSound){
  if(playAchSound!==false){ sfx('ach'); vibrate([20,20,40]); }
  const t=document.getElementById('toast');
  t.querySelector('.ti').textContent=icon;
  document.getElementById('toast-t').textContent=title;
  document.getElementById('toast-d').textContent=desc;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),2600);
}

function shakeField(id){
  const el=document.getElementById(id); if(!el) return;
  el.style.borderColor='var(--no)'; el.classList.add('shake-x');
  vibrate([30,20,30]);
  setTimeout(()=>{ el.style.borderColor=''; el.classList.remove('shake-x'); },500);
}

// ---- إجراءات الواجهة بلا JavaScript مضمّن ----
// القائمة الصريحة تبقي data-action مجرد بيانات؛ لا eval ولا تحويل لنص
// إلى اسم دالة. التفويض يغطي أيضاً العناصر التي تُنشأ بعد بدء اللعبة.
function boundedActionInteger(element,key,minimum,maximum){
  const raw=element?.dataset?.[key];
  if(typeof raw!=='string'||!/^-?\d+$/.test(raw)) return null;
  const value=Number(raw);
  return Number.isSafeInteger(value)&&value>=minimum&&value<=maximum?value:null;
}
function navigateFromAction(element){
  const screen=String(element?.dataset?.screen||'');
  const destination=document.getElementById(screen);
  if(destination?.classList.contains('screen')) go(screen);
}
function providerFromAction(element){
  const provider=String(element?.dataset?.provider||'');
  return Object.prototype.hasOwnProperty.call(PROVIDER_INFO,provider)?provider:'';
}
const UI_CLICK_ACTIONS=new Map([
  ['apple-sign-in',()=>appleSignIn()],
  ['google-sign-in',()=>googleSignIn()],
  ['toggle-email-form',()=>toggleEmailForm()],
  ['toggle-phone-sign-in-form',()=>togglePhoneSignInForm()],
  ['start-phone-sign-in',()=>startPhoneSignIn()],
  ['confirm-phone-sign-in',()=>confirmPhoneSignIn()],
  ['email-auth',element=>{
    const mode=element.dataset.authMode;
    if(mode==='signup'||mode==='signin') return emailAuth(mode);
  }],
  ['forgot-password',()=>forgotPassword()],
  ['forgot-email',()=>forgotEmail()],
  ['skip-auth',()=>skipAuth()],
  ['close-paywall',()=>closePaywall()],
  ['start-checkout',()=>startCheckout()],
  ['redeem-apple-offer-code',()=>redeemAppleOfferCode()],
  ['restore-purchases',()=>rcRestore()],
  ['retry-free-round',()=>retryFreeRoundVerification()],
  ['navigate',element=>navigateFromAction(element)],
  ['onboarding-next',()=>onbNext()],
  ['onboarding-finish',()=>onbFinish()],
  ['open-stats',()=>openStats()],
  ['toggle-sound',()=>toggleSound()],
  ['sound-navigate',element=>{ if(element.dataset.sound==='tap') sfx('tap'); navigateFromAction(element); }],
  ['sound-open-stats',()=>{ sfx('tap'); openStats(); }],
  ['sound-open-account',()=>{ sfx('tap'); openAccountSettings(); }],
  ['save-player-name',()=>savePlayerName()],
  ['send-email-verification',()=>sendEmailVerificationMessage()],
  ['refresh-email-verification',()=>refreshEmailVerificationStatus()],
  ['start-phone-verification',()=>startPhoneVerification()],
  ['confirm-phone-verification',()=>confirmPhoneVerification()],
  ['enable-push-notifications',()=>enablePushNotifications()],
  ['sign-out',()=>signOut()],
  ['confirm-delete-account',()=>confirmDeleteAccount()],
  ['link-provider',element=>{
    const provider=providerFromAction(element);
    if(provider) linkProvider(provider);
  }],
  ['unlink-provider',element=>{
    const provider=providerFromAction(element);
    if(provider) return unlinkProvider(provider);
  }],
]);
function invokeUIAction(element,event){
  const handler=UI_CLICK_ACTIONS.get(element.dataset.action);
  if(!handler) return;
  if(element.matches('a[href]')) event.preventDefault();
  try{
    const pending=handler(element,event);
    if(pending?.catch) pending.catch(error=>recordNonFatal(error,'ui.action'));
  }catch(error){
    recordNonFatal(error,'ui.action');
  }
}
(function installDeclarativeUIActions(){
  document.addEventListener('click',event=>{
    const element=event.target?.closest?.('[data-action]');
    if(element) invokeUIAction(element,event);
  });
  document.addEventListener('submit',event=>{
    if(event.target?.dataset?.submitAction==='prevent') event.preventDefault();
  });
  document.addEventListener('keydown',event=>{
    if(event.key!=='Enter'&&event.key!==' ') return;
    const element=event.target?.closest?.('[data-key-activate][data-action]');
    if(!element) return;
    event.preventDefault();
    element.click();
  });
})();

// ---- مؤشر وضع دون اتصال ----
(function initConnectivity(){
  const bar = document.getElementById('offline-bar');
  const message = document.getElementById('connectivity-message');
  if(!bar) return;
  let lastOffline=null;
  let hideTimer=0;

  function setOffline(offline){
    if(offline===lastOffline) return;
    clearTimeout(hideTimer);
    const wasOffline=lastOffline===true;
    lastOffline=offline;
    bar.classList.toggle('online',!offline);
    if(message) message.textContent=offline?'ماكو اتصال بالإنترنت':'رجع الاتصال بالإنترنت';
    if(!offline&&!wasOffline){
      bar.classList.remove('show');
      bar.setAttribute('aria-hidden','true');
      return;
    }
    bar.setAttribute('aria-hidden','false');
    bar.classList.add('show');
    if(!offline){
      if(wasOffline&&_freeRoundVerificationState==='unknown'
        &&window.Capacitor?.isNativePlatform?.()===true){
        void retryFreeRoundVerification({silent:true});
      }
      hideTimer=setTimeout(()=>{
        bar.classList.remove('show','online');
        bar.setAttribute('aria-hidden','true');
      },1800);
    }
  }

  // الحالة الأولية
  setOffline(!navigator.onLine);

  // استمع لأحداث المتصفح (تعمل داخل WKWebView أيضاً)
  window.addEventListener('online',  () => setOffline(false));
  window.addEventListener('offline', () => setOffline(true));

  // على iOS (Capacitor) — استخدم Network plugin إن توفّر للتحقق المبكّر
  const Net = window.Capacitor?.Plugins?.Network;
  if(Net){
    Net.getStatus().then(s => setOffline(!s.connected)).catch(()=>{});
    Net.addListener('networkStatusChange', s => setOffline(!s.connected));
  }
})();

// ---- تهيئة ----
(async function startApplication(){
const previewEnvironmentBanner=document.getElementById('preview-environment-banner');
if(previewEnvironmentBanner) previewEnvironmentBanner.hidden=!isLocalWebPreview();
const restoredPreferences=await hydrateNativePreferences();
await purgeRemovedQuestionStorage();
if(restoredPreferences>0 && sessionStorage.getItem('fatinah_preferences_hydrated')!=='1'){
  sessionStorage.setItem('fatinah_preferences_hydrated','1');
  window.location.reload();
  return;
}
(function initSoundIcon(){
  const b=document.getElementById('sound-btn');
  if(b) b.textContent = soundOn ? '🔊' : '🔇';
})();
(function initSavedName(){
  const saved=storeGet('playerName', '');
  const userNameEl=document.getElementById('user-name');
  if(saved && userNameEl) userNameEl.textContent=saved;
})();

// على iOS نستخدم مكوّن Firebase الأصلي. لا نحمّل SDK الويب من الشبكة عند
// الإقلاع لأنه ينافس طلبات المصادقة والاشتراك؛ يُحمّل فقط كاحتياط عند الحاجة.
if(!(window.Capacitor && window.Capacitor.isNativePlatform())){
  getFirebaseWebAuth();
}

// ---- إقلاع نظام الهوية الموحّد ----
// أول فتح للتطبيق: جلسة Firebase مجهولة فورية بلا شاشة تسجيل إجبارية.
// فتح لاحق: نثق بـ authUid المحفوظ (الجلسة محفوظة تلقائياً من طبقة Firebase)
// وننتقل مباشرة للرئيسية بدل إجبار المستخدم على تسجيل الدخول من جديد.
// ⚠️ SCREENSHOT MODE — يُحذف بعد أخذ اللقطات
const __SCREENSHOT_SCREEN = null; // home | teams | paywall
initCrashReporting();
if(window.__FATINAH_GAME_FLOW_UI_TEST__===true){
  hideSplash();
  document.body.dataset.gameFlowUiTest='ready';
  go('s-home');
  return;
}
// لا نترك شاشة التحميل معلّقة إذا لم تعد إضافة App Check الأصلية.
await initAppIntegrityWithin(APP_INTEGRITY_ATTEMPT_TIMEOUT_MS);
void initPushMessaging().catch(error=>recordNonFatal(error,'firebase.messaging'));
(async function bootAuth(){
  hideSplash();
  if(__SCREENSHOT_SCREEN){
    // اسم عرض ثابت لالتقاط لقطات تسويقية فقط — لا يُكتب فوق اسم المستخدم الحقيقي
    // في التشغيل العادي (كان يُكتب بلا شرط قبل هذا الإصلاح، ويمحو الاسم المحفوظ كل إقلاع)
    storeSet('playerName','مجلس فطنة');
    const nameEl=document.getElementById('user-name');
    if(nameEl) nameEl.textContent='مجلس فطنة';
  }
  if(__SCREENSHOT_SCREEN==='home'){ go('s-home'); return; }
  if(__SCREENSHOT_SCREEN==='paywall'){ go('s-paywall'); return; }
  if(__SCREENSHOT_SCREEN==='teams'){ go('s-teams'); return; }
  // لا نعرض شاشة الاشتراك قبل أن نعرف هل للمستخدم جولة مجانية أو اشتراك.
  // شاشة تحميل قصيرة تمنع وميض paywall المخالف لتجربة الجولة التعريفية.
  go('s-loading');
  void (async ()=>{
    const { uid } = await ensureAnonymousSession();
    window._currentUid = uid;
    activateLocalAccount(uid);
    void flushMetricEvents();
    // أعطِ WebKit إطارين للرسم قبل بدء اتصال الخادم، ثم أجّل StoreKit/RevenueCat
    // لأنه يوقظ عمليات Apple الثقيلة ولا يلزم لعرض شاشة البداية أو أسعارها الأساسية.
    const afterFirstPaint=(task, delay)=>{
      requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(task, delay)));
    };
    afterFirstPaint(()=>{
      void checkSubscriptionAndRoute(uid, {showLoading:false});
    }, 450);
    afterFirstPaint(()=>{
      const startupRevenueCat=rcReady();
      void startupRevenueCat.then(ready=>{
        if(ready && document.getElementById('s-paywall')?.classList.contains('active')){
          return loadPaywallPrices();
        }
      }).catch(()=>logClientEvent('warn','revenuecat.deferred-startup'));
    }, 1800);
  })();
})();
})().catch(error=>{
  recordNonFatal(error,'application.start');
  hideSplash();
  go('s-home');
  if(window.__FATINAH_GAME_FLOW_UI_TEST__===true){
    const marker=document.createElement('div');
    marker.id='ui-test-start-error';
    marker.setAttribute('role','alert');
    marker.textContent=`UI_TEST_ERROR:${String(error?.message||error||'unknown')}`;
    document.body.appendChild(marker);
  }
});

// لا نعتمد على معاملات عودة دفع قديمة أو على cache محلي لمنح الصلاحية
// نستخدم uid المحفوظ مسبقاً في localStorage فقط (لا uid من URL)
(function clearLegacyPaymentReturn(){
  const p = new URLSearchParams(window.location.search);
  if(p.has('subscribed') || p.has('canceled')){
    window.history.replaceState({},'','/');
  }
})();
