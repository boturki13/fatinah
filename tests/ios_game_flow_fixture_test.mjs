import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const url=`file://${path.join(root,'www/index.html')}`;

function installUITestBridge(){
  window.__FATINAH_GAME_FLOW_UI_TEST__=true;
  const categories=['من أنا؟','كرتون وأنمي'];
  const questions=Object.fromEntries(categories.map((category,categoryIndex)=>[
    category,Array.from({length:6},(_,levelIndex)=>[1,2].map(variant=>{
      const level=levelIndex+1;
      const suffix=`${String(categoryIndex+1).padStart(2,'0')}${String(level).padStart(2,'0')}${String(variant).padStart(16,'0')}`;
      const answer=`الإجابة ${categoryIndex+1}-${level}-${variant}`;
      return {id:`gq-${suffix}`,d:level,q:`ما الإجابة الاختبارية للفئة ${category} في المستوى ${level} للنسخة ${variant}؟`,
        o:[answer,`الخيار ب ${suffix}`,`الخيار ج ${suffix}`,`الخيار د ${suffix}`],
        source:{title:'مصدر اختباري',url:'https://example.com/source'},
        review:{status:'approved',reviewer:'Fatinah test gate',reviewedAt:'2026-09-05'}};
    })).flat(),
  ]));
  window.__FATINAH_GAME_FLOW_UI_TEST_FIXTURE__={
    catalog:{schemaVersion:1,questionSchemaVersion:1,releaseReady:true,bankVersion:'ui-test-bank',
      questionCount:180,categories:categories.map(name=>({name,questionCount:90,
        levels:{'1':15,'2':15,'3':15,'4':15,'5':15,'6':15}}))},
    round:{schemaVersion:1,bankVersion:'ui-test-bank',questions},
  };
  const ok=()=>Promise.resolve({});
  window.Capacitor={
    isNativePlatform:()=>true,
    Plugins:{
      Preferences:{get:()=>Promise.resolve({value:null}),set:ok,remove:ok},
      SplashScreen:{hide:ok},KeepAwake:{keepAwake:ok,allowSleep:ok},
    },
  };
}

const browser=await chromium.launch();
try{
  const page=await browser.newPage({viewport:{width:402,height:874}});
  const pageErrors=[];let catalogRequests=0;
  page.on('pageerror',error=>pageErrors.push(error.message));
  await page.addInitScript(installUITestBridge);
  await page.route('**/*',route=>{
    const requestUrl=route.request().url();
    if(requestUrl.startsWith('file://'))return route.continue();
    if(requestUrl.includes('/api/v2/questions/catalog'))catalogRequests++;
    return route.abort();
  });
  await page.goto(url);
  await page.locator('body[data-game-flow-ui-test="ready"]').waitFor({timeout:15000});

  assert.equal(catalogRequests,0,'بيانات اختبار الخادم المحقونة لا تطلب كتالوج الإنتاج');
  assert.equal(await page.locator('#board .cell').count(),12,'fixture يبني فئتين × ستة مستويات');
  assert.deepEqual(await page.locator('#cats-head .cat-h').allTextContents(),['من أنا؟','كرتون وأنمي']);

  await page.locator('#board .cell').first().click();
  await page.locator('#q-wrap.show').waitFor();
  assert.equal(await page.locator('#q-options .q-option').count(),4,'السؤال الأول يعرض أربعة خيارات');
  const firstQuestion=(await page.locator('#q-text').textContent()).trim();
  await page.locator('button[aria-label^="تغيير السؤال"]').click();
  await page.waitForFunction(previous=>document.querySelector('#q-text')?.textContent.trim()!==previous,firstQuestion);
  assert.equal(await page.locator('#q-options .q-option').count(),4,'السؤال البديل في جولة الخادم يعرض أربعة خيارات');
  assert.equal(await page.locator('#q-options .q-option[aria-label*="اختيار فريق النجوم"]').count(),4);
  assert.deepEqual(pageErrors,[]);
  console.log('✓ fixture واجهة iOS يحاكي كتالوج وجولة الخادم، من دون بنك احتياطي مشحون');
}finally{
  await browser.close();
}
