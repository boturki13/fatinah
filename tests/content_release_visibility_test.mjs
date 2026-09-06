import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const url=`file://${path.join(root,'www/index.html')}`;
const categories=['من أنا؟','كرتون وأنمي','تقنية وإنترنت'];
const catalog={schemaVersion:1,questionSchemaVersion:1,releaseReady:true,
  bankVersion:'visibility-test-bank',questionCount:270,
  categories:categories.map((name,index)=>({name,questionCount:90,
    group:index<2?'مجموعة جديدة':'مجموعة تقنية',groupIcon:index<2?'✨':'🧪',
    icon:index<2?'🆕':'💻',tone:index<2?'lime':'cyan',groupOrder:index<2?1:2,displayOrder:index+1,
    levels:{'1':15,'2':15,'3':15,'4':15,'5':15,'6':15}}))};

const browser=await chromium.launch();
try{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  let catalogRequests=0;
  await page.addInitScript(()=>{
    const ok=()=>Promise.resolve({});
    window.Capacitor={isNativePlatform:()=>true,Plugins:{
      Preferences:{get:()=>Promise.resolve({value:null}),set:ok,remove:ok},
      SplashScreen:{hide:ok},KeepAwake:{keepAwake:ok,allowSleep:ok},
    }};
  });
  await page.route('**/*',route=>{
    const requestUrl=route.request().url();
    if(requestUrl.startsWith('file://')) return route.continue();
    if(requestUrl.includes('/api/v2/questions/catalog')){
      catalogRequests++;
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(catalog)});
    }
    return route.abort();
  });
  await page.goto(url);
  await page.evaluate(()=>ensureQuestionBank());
  const state=await page.evaluate(()=>({categories:[...ALL_CATS],remote:[...CURATED_REMOTE_CATEGORIES],localCount:Object.keys(QUESTION_BANK).length,
    groups:runtimeCategoryGroups(),groupIcons:runtimeGroupIcons(),visual:categoryVisual('من أنا؟')}));
  assert.deepEqual(state.categories,categories,'الفئات الظاهرة يجب أن تطابق كتالوج الخادم تماماً.');
  assert.deepEqual(state.remote,categories,'كل الفئات يجب أن تكون خادمية.');
  assert.equal(state.localCount,0,'لا يجوز وجود أسئلة محلية في بنك التشغيل.');
  assert.deepEqual(state.groups,{'مجموعة جديدة':['من أنا؟','كرتون وأنمي'],'مجموعة تقنية':['تقنية وإنترنت']},
    'مجموعات الفئات وترتيبها تأتي من كتالوج الخادم.');
  assert.deepEqual(state.groupIcons,{'مجموعة جديدة':'✨','مجموعة تقنية':'🧪'},
    'أيقونات المجموعات تأتي من كتالوج الخادم.');
  assert.equal(state.visual.icon,'🆕','أيقونة الفئة تأتي من الخادم.');
  assert.equal(state.visual.accent,'#B7E65C','لون الفئة يأتي من الخادم.');
  assert.equal(catalogRequests,1,'يجب تحميل كتالوج الخادم مباشرة.');
  await context.close();

  const offline=await browser.newPage();
  await offline.addInitScript(()=>{
    const ok=()=>Promise.resolve({});
    window.Capacitor={isNativePlatform:()=>true,Plugins:{
      Preferences:{get:()=>Promise.resolve({value:null}),set:ok,remove:ok},
      SplashScreen:{hide:ok},KeepAwake:{keepAwake:ok,allowSleep:ok},
    }};
  });
  await offline.route('**/*',route=>route.request().url().startsWith('file://')?route.continue():route.abort());
  await offline.goto(url);
  const failure=await offline.evaluate(async()=>{
    try{ await ensureQuestionBank(); return ''; }catch(error){ return error.message; }
  });
  assert.match(failure,/الخادم/,'تعذر الخادم يجب أن يمنع تحميل الفئات بلا fallback.');
  assert.deepEqual(await offline.evaluate(()=>ALL_CATS),[],'لا يجوز إظهار فئات محلية عند تعذر الخادم.');

  console.log('✓ الفئات تأتي من الخادم فقط، وتعذر الخادم لا يفعّل بنكاً احتياطياً');
}finally{
  await browser.close();
}
