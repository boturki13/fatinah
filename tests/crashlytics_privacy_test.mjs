/** يضمن ألا تصل رسائل الأخطاء أو البيانات الحساسة الخام إلى Crashlytics. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const url='file://'+path.resolve(__dirname,'..','www','index.html');
const appSource=readFileSync(path.resolve(__dirname,'..','www','app.js'),'utf8');

// كل سجل WebView يجب أن يمر عبر logClientEvent الذي لا يقبل كائن الخطأ؛
// لا نسمح باستدعاء console مباشر يتوسع لاحقاً ليطبع بيانات Firebase الخام.
assert.equal(
  [...appSource.matchAll(/console\.(?:log|warn|error|info|debug)\s*\(/g)].length,
  0,
);

function installHarness(){
  const ok=()=>Promise.resolve();
  window.__crashlyticsRecords=[];
  window.__crashlyticsReady=false;
  localStorage.setItem('fatinah_authUid',JSON.stringify('privacy-test-user'));
  localStorage.setItem('fatinah_authProvider',JSON.stringify('apple'));
  window.Capacitor={
    isNativePlatform:()=>true,
    Plugins:{
      FirebaseAuthentication:{
        getCurrentUser:()=>Promise.resolve({user:{uid:'privacy-test-user',isAnonymous:false}}),
        getIdToken:()=>Promise.resolve({token:'test-id-token'}),
      },
      FirebaseCrashlytics:{
        setEnabled:()=>{ window.__crashlyticsReady=true; return Promise.resolve(); },
        setUserId:ok,
        recordException:payload=>{
          window.__crashlyticsRecords.push(structuredClone(payload));
          return Promise.resolve();
        },
      },
      RevenueCatKeyStore:{get:()=>Promise.resolve({value:''}),set:ok,clear:ok},
      SplashScreen:{hide:ok},Preferences:{remove:ok},
    },
  };
}

const browser=await chromium.launch();
try{
  const page=await browser.newPage();
  const browserLogs=[];
  page.on('console',message=>browserLogs.push(message.text()));
  await page.addInitScript(installHarness);
  await page.route('**/*',route=>{
    if(route.request().url().startsWith('file://')) return route.continue();
    return route.fulfill({status:503,contentType:'application/json',body:'{}'});
  });
  await page.goto(url);
  await page.waitForFunction(()=>window.__crashlyticsReady===true);

  const sentinel='PRIVATE_SENTINEL alice@example.com +96590999731 '
    +'sk-proj-secret https://private.example/path?token=abc '
    +'{"response":"confidential"}';
  const records=await page.evaluate(value=>{
    window.__crashlyticsRecords.length=0;

    const windowError=new Error(value);
    windowError.reason=value;
    window.dispatchEvent(new ErrorEvent('error',{message:value,error:windowError}));

    const rejectionEvent=new Event('unhandledrejection');
    Object.defineProperty(rejectionEvent,'reason',{value:{message:value,reason:value}});
    window.dispatchEvent(rejectionEvent);

    // حتى المصدر والكود غير المعروفين لا يجوز تمريرهما كما هما.
    window.recordNonFatal({message:value,reason:value,code:value},value);

    const knownCodeError=new Error(value);
    knownCodeError.code='APP_ATTEST_INVALID_KEY';
    window.recordNonFatal(knownCodeError,'app-attest.enroll');
    window.logClientEvent('error',value);
    window.logClientEvent('warn','auth.apple.web',{
      message:value,email:'alice@example.com',token:'sk-proj-secret',
    });
    return structuredClone(window.__crashlyticsRecords);
  },sentinel);

  assert.deepEqual(records.map(record=>record.message),[
    'nonfatal:window.error:unspecified',
    'nonfatal:unhandledrejection:unspecified',
    'nonfatal:application.nonfatal:unspecified',
    'nonfatal:app-attest.enroll:APP_ATTEST_INVALID_KEY',
  ]);
  assert.doesNotMatch(JSON.stringify(records),/PRIVATE_SENTINEL|alice@example\.com|90999731|sk-proj-secret|private\.example|confidential/);
  assert.doesNotMatch(browserLogs.join('\n'),/PRIVATE_SENTINEL|alice@example\.com|90999731|sk-proj-secret|private\.example|confidential/);
  assert.ok(browserLogs.some(line=>line.includes('[Fatinah] application.event')));
  assert.ok(browserLogs.some(line=>line.includes('[Fatinah] auth.apple.web')));
  console.log('✓ Crashlytics وسجلات WebView لا تستقبل رسالة الخطأ أو البريد أو الهاتف أو token أو URL أو الاستجابة الخام');
}finally{
  await browser.close();
}
