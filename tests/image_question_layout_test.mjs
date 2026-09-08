import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const url=`file://${path.join(root,'www/index.html')}`;
const imageDocument=JSON.parse(fs.readFileSync(path.join(root,'server-assets/question-images/curated-question-bank.json'),'utf8'));
const flagQuestions=[1,2,3,4,5,6].flatMap(level=>
  imageDocument.categories['أعلام منو؟'].filter(question=>question.d===level).slice(0,2))
  .map(({a,answer,...question})=>question);
async function installLegacyImageFixtures(page){
  await page.addInitScript(bank=>{
    window.__FATINAH_IMAGE_TEST_BANK__=bank;
    window.__FATINAH_GAME_FLOW_UI_TEST__=true;
    const categories=Object.entries(bank).map(([name,questions])=>({name,questionCount:questions.length,
      levels:Object.fromEntries([1,2,3,4,5,6].map(level=>[level,questions.filter(question=>question.d===level).length]))}));
    window.__FATINAH_GAME_FLOW_UI_TEST_FIXTURE__={catalog:{schemaVersion:1,questionSchemaVersion:1,
      releaseReady:true,bankVersion:'legacy-image-layout-bank',questionCount:categories.reduce((sum,item)=>sum+item.questionCount,0),categories}};
    document.addEventListener('DOMContentLoaded',()=>{
      QUESTION_BANK=window.__FATINAH_IMAGE_TEST_BANK__;
      roundQuestionBank=Object.assign(Object.create(null),window.__FATINAH_IMAGE_TEST_BANK__);
    });
  },imageDocument.categories);
}
const browser=await chromium.launch();
try{
  for(const [name,width,height] of [['iPhone portrait',390,844],['iPhone landscape',844,390]]){
    const page=await browser.newPage({viewport:{width,height}});
    await installLegacyImageFixtures(page);
    await page.addInitScript(({questions,imageBank})=>{
      window.__FATINAH_GAME_FLOW_UI_TEST__=true;
      window.Capacitor={isNativePlatform:()=>true,Plugins:{FirebaseAuthentication:{
        getCurrentUser:()=>Promise.resolve({user:{uid:'image-layout-player'}}),
        getIdToken:()=>Promise.resolve({token:'image-layout-token'}),
      }}};
      window.__FATINAH_GAME_FLOW_UI_TEST_FIXTURE__={
        catalog:{schemaVersion:1,questionSchemaVersion:1,releaseReady:true,bankVersion:'image-layout-test',
          questionCount:questions.length,categories:[{name:'أعلام منو؟',questionCount:questions.length,
            levels:{'1':2,'2':2,'3':2,'4':2,'5':2,'6':2}}]},
        round:{schemaVersion:1,bankVersion:'image-layout-test',questions:{'أعلام منو؟':questions}},
      };
      window.__FATINAH_IMAGE_TEST_BANK__=imageBank;
    },{questions:flagQuestions,imageBank:imageDocument.categories});
    await page.route('**/*',route=>{
      const requestUrl=route.request().url();
      if(requestUrl.startsWith('file://')) return route.continue();
      if(requestUrl.includes('/api/v2/questions/reveal')){
        const request=JSON.parse(route.request().postData()||'{}');
        const question=imageDocument.categories['أعلام منو؟'].find(item=>item.id===request.questionId);
        return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
          questionId:request.questionId,a:question?.a,answer:question?.answer,
        })});
      }
      return route.abort();
    });
    await page.goto(url);
    await page.evaluate(async()=>{
      window.__FATINAH_LEGACY_SPOKEN_TEST__=true;
      await ensureQuestionBank();
      QUESTION_BANK=window.__FATINAH_IMAGE_TEST_BANK__;
      window._currentUid='image-layout-player';
      storeSet('authUid','image-layout-player');
      getCurrentIdToken=async()=> 'image-layout-token';
      roundQuestionBank=Object.assign(Object.create(null),window.__FATINAH_GAME_FLOW_UI_TEST_FIXTURE__.round.questions);
      localStorage.removeItem(questionHistoryKey());
      Math.random=()=>0;
      const imageQuestions=roundQuestionBank['أعلام منو؟'].filter(question=>question.d===1);
      const question=imageQuestions[0];
      const svg='<svg xmlns="http://www.w3.org/2000/svg" width="854" height="1280"><rect width="100%" height="100%" fill="#392069"/><circle cx="427" cy="400" r="240" fill="#ff3b3b"/></svg>';
      window.__loadedQuestionImages=[];
      window.FatinahImageAssets.loadInto=async(loadedQuestion,image)=>{
        window.__loadedQuestionImages.push(loadedQuestion.id);
        const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));
        image.src=url;
        await image.decode();
        return url;
      };
      state.teams=[{name:'الأول',score:0,ll:3,used:new Set(),idx:0,bombUsed:false},{name:'الثاني',score:0,ll:3,used:new Set(),idx:1,bombUsed:false}];
      state.cats=['أعلام منو؟']; state.turn=0; state.difficulty='normal'; state.cells={'0-1':{used:false}};
      state.usedQ=new Set(); state.usedQuestionIds=new Set(); roundImageQuestionIds=new Set(imageQuestions.map(item=>item.id));
      await openQuestion(0,1,'0-1',document.createElement('button'));
    });
    await page.locator('#q-wrap.show').waitFor();
    const audit=await page.evaluate(()=>{
      const visible=id=>{const e=document.getElementById(id),r=e.getBoundingClientRect(),s=getComputedStyle(e); return !e.hidden&&s.display!=='none'&&r.width>0&&r.height>0;};
      const rect=id=>{const r=document.getElementById(id).getBoundingClientRect(); return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height};};
      return {image:rect('q-image'),questionCard:rect('q-question-card'),question:rect('q-text'),controls:rect('q-controls'),lifelines:rect('lifelines'),flow:rect('q-flow'),timer:rect('countdown-timer'),answerHidden:!visible('answer-box'),sourceHidden:!visible('q-source'),rightsHidden:!visible('q-image-rights'),overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,alt:document.getElementById('q-image').alt};
    });
    assert.ok(audit.image.width>150&&audit.image.height>90,`${name}: الصورة واضحة.`);
    assert.ok(audit.question.height>0,`${name}: السؤال ظاهر. ${JSON.stringify(audit)}`);
    assert.ok(audit.timer.height>=40,`${name}: المؤقت ظاهر.`);
    assert.ok(audit.questionCard.width>=width*.88,`${name}: خانة السؤال تستفيد من عرض الشاشة.`);
    assert.ok(Math.min(audit.lifelines.bottom,audit.flow.bottom)-Math.max(audit.lifelines.top,audit.flow.top)>20,`${name}: وسائل المساعدة بجانب زر كشف الإجابة.`);
    assert.ok(audit.lifelines.right<=audit.flow.left+1||audit.flow.right<=audit.lifelines.left+1,`${name}: التحكم موزع أفقياً بدون تداخل.`);
    assert.equal(audit.answerHidden,true,`${name}: الإجابة مخفية قبل الكشف.`);
    assert.equal(audit.sourceHidden,true,`${name}: مصدر السؤال لا يظهر قبل الكشف.`);
    assert.equal(audit.rightsHidden,true,`${name}: حقوق الصورة لا تظهر قبل الكشف.`);
    assert.ok(audit.overflow<=1,`${name}: لا يوجد تجاوز أفقي.`);
    assert.match(audit.alt,/علم بأشرطة أفقية/);
    await page.getByRole('button',{name:'وقّف العداد مؤقتًا'}).click();
    const pausedQuestion=await page.evaluate(()=>({
      imageHidden:document.getElementById('q-image-wrap').hidden,
      imageAriaHidden:document.getElementById('q-image-wrap').getAttribute('aria-hidden'),
      textAriaHidden:document.getElementById('q-text').getAttribute('aria-hidden'),
      pauseVisible:document.getElementById('q-paused').classList.contains('show'),
      pauseAriaHidden:document.getElementById('q-paused').getAttribute('aria-hidden'),
      dialogLabelledBy:document.getElementById('q-wrap').getAttribute('aria-labelledby'),
    }));
    assert.deepEqual(pausedQuestion,{
      imageHidden:true,imageAriaHidden:'true',textAriaHidden:'true',pauseVisible:true,
      pauseAriaHidden:'false',dialogLabelledBy:'q-paused-title',
    },`${name}: الإيقاف يخفي نص وصورة السؤال بصرياً وعن VoiceOver.`);
    await page.getByRole('button',{name:'كمّل العداد وأظهر السؤال'}).click();
    const resumedQuestion=await page.evaluate(()=>({
      imageHidden:document.getElementById('q-image-wrap').hidden,
      imageAriaHidden:document.getElementById('q-image-wrap').getAttribute('aria-hidden'),
      textAriaHidden:document.getElementById('q-text').getAttribute('aria-hidden'),
      dialogLabelledBy:document.getElementById('q-wrap').getAttribute('aria-labelledby'),
      alt:document.getElementById('q-image').alt,
    }));
    assert.deepEqual(resumedQuestion,{
      imageHidden:false,imageAriaHidden:'false',textAriaHidden:'false',dialogLabelledBy:'q-text',
      alt:audit.alt,
    },`${name}: الاستمرار يرجع نص وصورة ووصف السؤال بالكامل.`);
    await page.getByRole('button',{name:'تغيير السؤال — فريق الأول'}).click();
    await page.waitForFunction(()=>state.cur?.q?.id==='img-v2-flag-japan');
    const replacement=await page.evaluate(()=>({
      id:state.cur.q.id,
      answer:document.getElementById('ans-text').textContent,
      alt:document.getElementById('q-image').alt,
      loaded:[...window.__loadedQuestionImages],
    }));
    assert.equal(replacement.id,'img-v2-flag-japan',`${name}: تم اختيار سؤال الصورة البديل.`);
    assert.equal(replacement.answer,'',`${name}: الإجابة البديلة لا تصل للجهاز قبل انتهاء دوري الفريقين.`);
    assert.match(replacement.alt,/دائرة حمراء/,`${name}: الصورة والوصف البديل يتغيران مع السؤال.`);
    assert.deepEqual(replacement.loaded,[
      'img-v2-flag-kuwait','img-v2-flag-japan',
    ],`${name}: تم تحميل صورة السؤال البديل فعلياً.`);
    while(await page.getByRole('button',{name:/^⏭️ اطرح على/}).count()){
      await page.getByRole('button',{name:/^⏭️ اطرح على/}).click();
    }
    await page.getByRole('button',{name:'👁️ اكشف الإجابة'}).click();
    await page.locator('#answer-box.show').waitFor({state:'visible'});
    assert.equal(await page.locator('#answer-box').isVisible(),true,`${name}: الإجابة واضحة بعد الكشف.`);
    await page.waitForTimeout(400); // انتظر نهاية حركة ظهور صندوق الإجابة قبل قياس مناطق اللمس.
    const revealLayout=await page.evaluate(()=>{
      const sheet=document.querySelector('#q-wrap .q-sheet');
      const sr=sheet.getBoundingClientRect();
      const ar=document.getElementById('answer-box').getBoundingClientRect();
      const cr=document.getElementById('q-controls').getBoundingClientRect();
      const attribution=document.getElementById('q-attribution');
      const rights=document.getElementById('q-image-rights');
      const ansText=document.getElementById('ans-text');
      const childRect=element=>{const rect=element.getBoundingClientRect(); return {
        top:rect.top,bottom:rect.bottom,width:rect.width,height:rect.height,
        display:getComputedStyle(element).display,
      };};
      return {
        answerFocused:document.activeElement===document.getElementById('answer-box'),
        answerVisible:ar.top>=sr.top-1&&ar.bottom<=sr.bottom+1,
        controlsVisible:cr.top>=sr.top-1&&cr.bottom<=sr.bottom+1,
        scrollTop:sheet.scrollTop,
        sheet:{top:sr.top,bottom:sr.bottom,height:sr.height,clientHeight:sheet.clientHeight,scrollHeight:sheet.scrollHeight},
        answer:{top:ar.top,bottom:ar.bottom,height:ar.height},
        controls:{top:cr.top,bottom:cr.bottom,height:cr.height},
        answerChildren:{text:childRect(ansText),attribution:childRect(attribution),rights:childRect(rights)},
        gridRows:getComputedStyle(document.querySelector('.q-content')).gridTemplateRows,
      };
    });
    assert.equal(revealLayout.answerFocused,true,`${name}: ينتقل التركيز للإجابة الجديدة.`);
    assert.equal(revealLayout.answerVisible,true,`${name}: صندوق الإجابة كامل داخل الشاشة بعد الكشف. ${JSON.stringify(revealLayout)}`);
    assert.equal(revealLayout.controlsVisible,true,`${name}: أزرار الحكم كاملة داخل الشاشة بعد الكشف.`);
    if(name==='iPhone landscape') assert.ok(revealLayout.scrollTop>0,`${name}: يتم تمرير الورقة تلقائياً للمحتوى المكشوف.`);
    const copyLayout=await page.evaluate(()=>{
      const q='هذا سؤال تجريبي طويل جداً للتأكد من أن الجملة كاملة تظهر داخل مساحة السؤال بدون قص أو إخفاء أو خروج عن حدود الشاشة، حتى لو احتوت على تفاصيل كثيرة يحتاج اللاعب إلى قراءتها بوضوح قبل الإجابة. هل يظهر بالكامل؟';
      const a='هذه إجابة تجريبية طويلة جداً للتأكد من بقائها كاملة داخل خانة الإجابة وعدم تجاوزها لأي حد أفقي في الشاشة.';
      setAdaptiveCopy(document.getElementById('q-text'),q);
      setAdaptiveCopy(document.getElementById('ans-text'),a);
      const inside=id=>{const e=document.getElementById(id),p=e.parentElement,r=e.getBoundingClientRect(),pr=p.getBoundingClientRect(); return {inside:r.left>=pr.left-1&&r.right<=pr.right+1,scroll:e.scrollWidth<=e.clientWidth+1,text:e.textContent};};
      return {question:inside('q-text'),answer:inside('ans-text')};
    });
    assert.ok(copyLayout.question.inside&&copyLayout.question.scroll,`${name}: السؤال الطويل كامل داخل الخانة.`);
    assert.ok(copyLayout.answer.inside&&copyLayout.answer.scroll,`${name}: الإجابة الطويلة كاملة داخل الخانة.`);
    const rights=await page.evaluate(()=>{
      const nasaQuestion=QUESTION_BANK['شنو بالفضاء؟'].find(question=>question.id==='img-v2-space-earth');
      setQuestionAnswer(nasaQuestion);
      setAnswerRevealed(true);
      const questionSource=document.getElementById('q-source');
      const rightsBox=document.getElementById('q-image-rights');
      const source=document.getElementById('q-image-source-page');
      const license=document.getElementById('q-image-license');
      return {
        visible:!rightsBox.hidden&&getComputedStyle(rightsBox).display!=='none',
        sourceVisible:!questionSource.hidden&&getComputedStyle(questionSource).display!=='none',
        ariaHidden:rightsBox.getAttribute('aria-hidden'),
        credit:document.getElementById('q-image-credit').textContent,
        questionSourceText:questionSource.textContent,
        questionSourceHref:questionSource.href,sourceHref:source.href,licenseHref:license.href,
        sourceTapHeight:source.getBoundingClientRect().height,
        licenseTapHeight:license.getBoundingClientRect().height,
        modifications:document.getElementById('q-image-modifications').textContent,
        overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
      };
    });
    assert.equal(rights.visible,false,`${name}: حقوق الصورة لا تظهر داخل شاشة الحل.`);
    assert.equal(rights.sourceVisible,false,`${name}: مصدر الإجابة يبقى داخلياً ولا يظهر للاعب.`);
    assert.equal(rights.ariaHidden,'true',`${name}: حقوق الصورة مخفية عن قارئ الشاشة بعد الكشف.`);
    assert.match(rights.credit,/NASA Images/);
    assert.match(rights.credit,/NASA GSFC/);
    assert.doesNotMatch(rights.credit,/Wikimedia Commons/,'صورة NASA لا تُنسب إلى Commons.');
    assert.equal(rights.questionSourceText,'');
    assert.equal(rights.questionSourceHref,'');
    assert.match(rights.sourceHref,/^https:\/\/images\.nasa\.gov\/details\//);
    assert.match(rights.licenseHref,/^https:\/\/www\.nasa\.gov\//);
    assert.match(rights.modifications,/AVIF وWebP/);
    assert.equal(rights.sourceTapHeight,0,`${name}: رابط مصدر الصورة لا يشغل مساحة في الحل.`);
    assert.equal(rights.licenseTapHeight,0,`${name}: رابط رخصة الصورة لا يشغل مساحة في الحل.`);
    assert.ok(rights.overflow<=1,`${name}: نسب الصورة لا تسبب تجاوزاً أفقياً.`);
    await page.close();
  }

  const attributionPage=await browser.newPage({viewport:{width:390,height:844}});
  await installLegacyImageFixtures(attributionPage);
  await attributionPage.goto(url);
  const attributionSetup=await attributionPage.evaluate(async()=>{
    await ensureQuestionBank();
    const category='شنو بالفضاء؟';
    const question=QUESTION_BANK[category].find(item=>item.id==='img-v2-space-earth');
    saveQuestionHistory({}); reservedQuestionIds.clear();
    state.teams=[
      {name:'الأول',score:0,ll:3,used:new Set(),idx:0,bombUsed:false},
      {name:'الثاني',score:0,ll:3,used:new Set(),idx:1,bombUsed:false},
    ];
    state.cats=[category]; state.turn=0; state.difficulty='normal';
    state.cells={'0-1':{used:false}}; state.cur=null;
    state.usedQ=new Set(); state.usedQuestionIds=new Set();
    roundQuestionBank=Object.assign(Object.create(null),{[category]:[question]});
    roundImageQuestionIds=new Set([question.id]);
    Math.random=()=>0;
    window.FatinahImageAssets.loadInto=async(_item,image)=>{
      const svg='<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#2468a0"/></svg>';
      const source=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));
      image.src=source; await image.decode(); return source;
    };
    const unsafe=structuredClone(question);
    unsafe.source.url='javascript:alert(1)';
    unsafe.image.rights.sourcePage='http://example.com/not-secure';
    unsafe.image.rights.licenseUrl='https://name:secret@example.com/license';
    setQuestionAnswer(unsafe);
    const unsafeSanitized={
      source:document.getElementById('q-source').hasAttribute('href'),
      sourcePage:document.getElementById('q-image-source-page').hasAttribute('href'),
      license:document.getElementById('q-image-license').hasAttribute('href'),
    };
    const opened=await openQuestion(0,1,'0-1',document.createElement('button'));
    const visible=id=>{const element=document.getElementById(id); return !element.hidden&&getComputedStyle(element).display!=='none';};
    return {
      opened,correct:question.a,unsafeSanitized,
      phase:state.cur.phase,sourceVisible:visible('q-source'),rightsVisible:visible('q-image-rights'),
      sourceAria:document.getElementById('q-source').getAttribute('aria-hidden'),
      rightsAria:document.getElementById('q-image-rights').getAttribute('aria-hidden'),
    };
  });
  assert.equal(attributionSetup.opened,true);
  assert.deepEqual(attributionSetup.unsafeSanitized,{source:false,sourcePage:false,license:false},
    'روابط النسب غير HTTPS أو التي تحتوي بيانات دخول تُزال بالكامل.');
  assert.deepEqual({
    phase:attributionSetup.phase,sourceVisible:attributionSetup.sourceVisible,
    rightsVisible:attributionSetup.rightsVisible,sourceAria:attributionSetup.sourceAria,
    rightsAria:attributionSetup.rightsAria,
  },{phase:'owner',sourceVisible:false,rightsVisible:false,sourceAria:'true',rightsAria:'true'},
  'المصدر وحقوق الصورة مخفيان بصرياً وعن قارئ الشاشة قبل إجابة الفريق الأول.');
  await attributionPage.locator('#q-options .q-option').nth(attributionSetup.correct).click();
  const afterOwnerAnswer=await attributionPage.evaluate(()=>({
    phase:state.cur.phase,
    sourceHidden:document.getElementById('q-source').hidden,
    rightsHidden:document.getElementById('q-image-rights').hidden,
    answerHidden:!document.getElementById('answer-box').classList.contains('show'),
  }));
  assert.deepEqual(afterOwnerAnswer,{phase:'steal',sourceHidden:true,rightsHidden:true,answerHidden:true},
    'بعد إجابة الفريق الأول تبقى الإجابة ونسب الصورة مخفية.');
  await attributionPage.waitForFunction(()=>[...document.querySelectorAll('#q-options .q-option')]
    .every(button=>!button.disabled));
  await attributionPage.locator('#q-options .q-option').nth((attributionSetup.correct+1)%4).click();
  await attributionPage.waitForTimeout(400); // قياس مناطق اللمس بعد انتهاء animation: pop.
  const afterBothTeams=await attributionPage.evaluate(()=>{
    const source=document.getElementById('q-source');
    const rights=document.getElementById('q-image-rights');
    const sourcePage=document.getElementById('q-image-source-page');
    const license=document.getElementById('q-image-license');
    return {
      phase:state.cur.phase,
      answerVisible:document.getElementById('answer-box').classList.contains('show'),
      sourceVisible:!source.hidden&&getComputedStyle(source).display!=='none',
      rightsVisible:!rights.hidden&&getComputedStyle(rights).display!=='none',
      sourceAria:source.getAttribute('aria-hidden'),rightsAria:rights.getAttribute('aria-hidden'),
      sourceHref:source.href,sourcePageHref:sourcePage.href,licenseHref:license.href,
      credit:document.getElementById('q-image-credit').textContent,
      modifications:document.getElementById('q-image-modifications').textContent,
      sourceTapHeight:sourcePage.getBoundingClientRect().height,
      licenseTapHeight:license.getBoundingClientRect().height,
      overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
    };
  });
  assert.equal(afterBothTeams.phase,'reveal');
  assert.equal(afterBothTeams.answerVisible,true);
  assert.equal(afterBothTeams.sourceVisible,false,'مصدر الإجابة لا يظهر للاعب حتى بعد الكشف.');
  assert.equal(afterBothTeams.rightsVisible,false,'حقوق الصورة لا تظهر داخل إجابة اللاعب.');
  assert.equal(afterBothTeams.sourceAria,'true');
  assert.equal(afterBothTeams.rightsAria,'true');
  assert.equal(afterBothTeams.sourceHref,'');
  assert.match(afterBothTeams.sourcePageHref,/^https:\/\/images\.nasa\.gov\/details\//);
  assert.match(afterBothTeams.licenseHref,/^https:\/\/www\.nasa\.gov\//);
  assert.match(afterBothTeams.credit,/NASA GSFC.*NASA Images/);
  assert.match(afterBothTeams.modifications,/معالجة الصورة:.*AVIF وWebP/);
  assert.equal(afterBothTeams.sourceTapHeight,0,
    `رابط مصدر الصورة لا يشغل مساحة على iPhone. ${JSON.stringify(afterBothTeams)}`);
  assert.equal(afterBothTeams.licenseTapHeight,0,
    `رابط رخصة الصورة لا يشغل مساحة على iPhone. ${JSON.stringify(afterBothTeams)}`);
  assert.ok(afterBothTeams.overflow<=1,'نسب الصورة لا تسبب تجاوزاً أفقياً على iPhone.');
  await attributionPage.close();

  const racePage=await browser.newPage({viewport:{width:390,height:844}});
  await installLegacyImageFixtures(racePage);
  await racePage.goto(url);
  const raceAudit=await racePage.evaluate(async()=>{
    await ensureQuestionBank();
    localStorage.removeItem(questionHistoryKey());
    const [firstQuestion,secondQuestion]=QUESTION_BANK['أعلام منو؟'].filter(question=>question.d===1);
    const svgFor=colour=>`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="${colour}"/></svg>`;
    const loads=[];
    window.FatinahImageAssets.loadInto=async(question,image)=>{
      loads.push(question.id);
      await new Promise(resolve=>setTimeout(resolve,question.id===firstQuestion.id?60:5));
      const svg=svgFor(question.id===firstQuestion.id?'red':'blue');
      const loadedUrl=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));
      image.src=loadedUrl;
      await image.decode();
      return loadedUrl;
    };

    const oldRender=renderQuestionImage(firstQuestion);
    const newRender=renderQuestionImage(secondQuestion);
    const [oldReady,newReady]=await Promise.all([oldRender,newRender]);
    const staleRender={oldReady,newReady,alt:document.getElementById('q-image').alt,loads:[...loads]};

    state.teams=[{name:'الأول',score:0,ll:3,used:new Set(),idx:0,bombUsed:false},{name:'الثاني',score:0,ll:3,used:new Set(),idx:1,bombUsed:false}];
    state.cats=['أعلام منو؟']; state.turn=0; state.difficulty='normal';
    state.cells={'0-1':{used:false},'0-2':{used:false}}; state.cur=null;
    state.usedQ=new Set(); state.usedQuestionIds=new Set();
    roundImageQuestionIds=new Set(QUESTION_BANK['أعلام منو؟'].map(question=>question.id));
    Math.random=()=>0;
    const firstOpen=openQuestion(0,1,'0-1',document.createElement('button'));
    const blockedOpen=openQuestion(0,2,'0-2',document.createElement('button'));
    await firstOpen;
    const originalRevoke=URL.revokeObjectURL.bind(URL);
    const revoked=[];
    URL.revokeObjectURL=url=>{ revoked.push(url); originalRevoke(url); };
    let failedUrl='';
    window.FatinahImageAssets.loadInto=async()=>{
      failedUrl=URL.createObjectURL(new Blob(['not-an-image'],{type:'image/png'}));
      return failedUrl;
    };
    const failedRender=await renderQuestionImage(firstQuestion);
    window.FatinahImageAssets.loadInto=async(_question,image)=>{
      const loadedUrl=URL.createObjectURL(new Blob([svgFor('green')],{type:'image/svg+xml'}));
      image.src=loadedUrl; await image.decode(); return loadedUrl;
    };
    const successfulRender=await renderQuestionImage(firstQuestion);
    const successfulUrl=activeQuestionImageUrl;
    clearActiveQuestionImage();
    URL.revokeObjectURL=originalRevoke;
    return {
      staleRender,
      blockedOpen,
      activeQuestionId:state.cur?.q?.id,
      activeAlt:document.getElementById('q-image').alt,
      questionVisible:document.getElementById('q-wrap').classList.contains('show'),
      cleanup:{
        failedRender,failedRevoked:revoked.includes(failedUrl),successfulRender,
        closeRevoked:revoked.includes(successfulUrl),srcRemoved:!document.getElementById('q-image').hasAttribute('src'),
      },
    };
  });
  assert.equal(raceAudit.staleRender.oldReady,false,'تحميل الصورة القديم لا يجوز أن يعتمد بعد بدء طلب أحدث.');
  assert.equal(raceAudit.staleRender.newReady,true,'طلب الصورة الأحدث يجب أن يكتمل.');
  assert.match(raceAudit.staleRender.alt,/دائرة حمراء/,'الطلب القديم لا يكتب فوق وصف الصورة الأحدث.');
  assert.equal(raceAudit.blockedOpen,false,'لا يجوز فتح خانة ثانية أثناء تجهيز السؤال الأول.');
  assert.equal(raceAudit.activeQuestionId,'img-v2-flag-kuwait','يبقى السؤال الأول هو السؤال النشط.');
  assert.match(raceAudit.activeAlt,/علم بأشرطة أفقية/,'الصورة والوصف يطابقان السؤال النشط.');
  assert.equal(raceAudit.questionVisible,true,'يظهر سؤال واحد فقط بعد اكتمال التحميل.');
  assert.deepEqual(raceAudit.cleanup,{
    failedRender:false,failedRevoked:true,successfulRender:true,closeRevoked:true,srcRemoved:true,
  },'يجب تحرير رابط الصورة عند فشل فك DOM وعند إغلاق السؤال.');
  await racePage.close();

  const reservationPage=await browser.newPage({viewport:{width:390,height:844}});
  await installLegacyImageFixtures(reservationPage);
  await reservationPage.goto(url);
  const reservationAudit=await reservationPage.evaluate(async()=>{
    await ensureQuestionBank();
    const category='أعلام منو؟';
    const [firstQuestion,secondQuestion]=QUESTION_BANK[category].filter(question=>question.d===1);
    saveQuestionHistory({});
    storeRemove(questionSeenOutboxKey());
    reservedQuestionIds.clear();
    state.teams=[
      {name:'الأول',score:0,ll:3,used:new Set(),idx:0,bombUsed:false},
      {name:'الثاني',score:0,ll:3,used:new Set(),idx:1,bombUsed:false},
    ];
    state.cats=[category]; state.turn=0; state.difficulty='normal';
    state.cells={'0-1':{used:false}}; state.cur=null;
    state.usedQ=new Set(); state.usedQuestionIds=new Set();
    roundImageQuestionIds=new Set(QUESTION_BANK[category].map(question=>question.id));
    Math.random=()=>0;

    window.FatinahImageAssets.loadInto=async()=>{ throw new Error('simulated image failure'); };
    const firstFailed=await openQuestion(0,1,'0-1',document.createElement('button'));
    const afterInitialFailure={
      firstFailed,
      history:loadQuestionHistory()[category]||[],
      outbox:storeGet(questionSeenOutboxKey(),[]),
      usedIds:[...state.usedQuestionIds],usedQuestions:[...state.usedQ],
      reserved:[...reservedQuestionIds],current:state.cur,
    };

    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="green"/></svg>';
    const loadSvg=async(_question,image)=>{
      const loadedUrl=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));
      image.src=loadedUrl; await image.decode(); return loadedUrl;
    };
    window.FatinahImageAssets.loadInto=loadSvg;
    const retryReady=await openQuestion(0,1,'0-1',document.createElement('button'));
    const afterRetry={
      retryReady,currentId:state.cur?.q?.id,
      history:loadQuestionHistory()[category]||[],
      outbox:storeGet(questionSeenOutboxKey(),[]),
      usedIds:[...state.usedQuestionIds],reserved:[...reservedQuestionIds],
    };

    let rejectReplacementImage=null;
    window.FatinahImageAssets.loadInto=async(question,image)=>{
      if(question.id===secondQuestion.id){
        return new Promise((resolve,reject)=>{ rejectReplacementImage=reject; });
      }
      return loadSvg(question,image);
    };
    const phaseBeforeSkip=state.cur.phase;
    const teamBeforeSkip=activeAnsweringTeam(state.cur);
    const timeBeforeSkip=state.timeLeft;
    const skipped=useLifeline('skip',0);
    const pendingToken=state.cur.token;
    timeUp(pendingToken);
    const duringReplacement={
      phase:state.cur.phase,team:activeAnsweringTeam(state.cur),timeLeft:state.timeLeft,
      timerStopped:state.timer===null,replacing:state.cur.replacingQuestion===true,
      flow:document.getElementById('q-flow').textContent,
      lifelines:state.teams[0].ll,skipConsumed:state.teams[0].used.has('skip'),
    };
    rejectReplacementImage(new Error('simulated replacement failure'));
    const deadline=Date.now()+1000;
    while(state.cur?.replacingQuestion===true&&Date.now()<deadline){
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    await new Promise(resolve=>setTimeout(resolve,25));
    const reservedBeforeRetry=[...reservedQuestionIds];
    const replacementRetry=pickQuestion(category,1);
    const afterReplacementFailure={
      skippedId:skipped?.id,currentId:state.cur?.q?.id,
      history:loadQuestionHistory()[category]||[],
      outbox:storeGet(questionSeenOutboxKey(),[]),
      usedIds:[...state.usedQuestionIds],usedQuestions:[...state.usedQ],
      reservedBeforeRetry,retryId:replacementRetry?.id,
      lifelines:state.teams[0].ll,skipConsumed:state.teams[0].used.has('skip'),
      phase:state.cur.phase,team:activeAnsweringTeam(state.cur),timeLeft:state.timeLeft,
      timerRestored:state.timer!==null,
    };
    releasePickedQuestion(replacementRetry);
    const originalPrepareCategory=window.FatinahImageAssets.prepareCategory;
    const prepareCalls=[];
    state.cats=['أعلام منو؟','شنو بالفضاء؟'];
    window.FatinahImageAssets.prepareCategory=async(questions,options)=>{
      prepareCalls.push({options,signal:options.signal});
      const ready=new Map();
      for(const question of questions){
        if(!ready.has(question.d)) ready.set(question.d,new Set());
        ready.get(question.d).add(question.id);
      }
      return ready;
    };
    const selectedImagesPrepared=await prepareSelectedImageCategories();
    window.FatinahImageAssets.prepareCategory=originalPrepareCategory;
    const deadlineAudit={
      selectedImagesPrepared,calls:prepareCalls.length,
      sameDeadline:prepareCalls.length===2&&prepareCalls[0].options.deadlineAt===prepareCalls[1].options.deadlineAt,
      sameSignal:prepareCalls.length===2&&prepareCalls[0].signal===prepareCalls[1].signal,
      signalAborted:prepareCalls.length===2&&prepareCalls.every(call=>call.signal?.aborted===true),
    };
    clearInterval(state.timer); clearInterval(questionSeenFlushTimer);
    return {
      firstId:firstQuestion.id,secondId:secondQuestion.id,
      phaseBeforeSkip,teamBeforeSkip,timeBeforeSkip,duringReplacement,
      afterInitialFailure,afterRetry,afterReplacementFailure,deadlineAudit,
    };
  });
  assert.deepEqual(reservationAudit.afterInitialFailure,{
    firstFailed:false,history:[],outbox:[],usedIds:[],usedQuestions:[],reserved:[],current:null,
  },'فشل صورة السؤال الأول لا يسجله كمشاهد ولا يفقده من الجولة.');
  assert.equal(reservationAudit.afterRetry.retryReady,true,'يمكن إعادة اختيار السؤال نفسه بعد نجاح صورته.');
  assert.equal(reservationAudit.afterRetry.currentId,reservationAudit.firstId,'المحاولة التالية تعرض السؤال الذي فشل سابقاً.');
  assert.deepEqual(reservationAudit.afterRetry.history,[reservationAudit.firstId],'يسجل السؤال بعد نجاح عرضه فقط.');
  assert.deepEqual(reservationAudit.afterRetry.usedIds,[reservationAudit.firstId],'تثبت هوية السؤال بعد نجاح العرض.');
  assert.deepEqual(reservationAudit.afterRetry.reserved,[],'لا يبقى السؤال محجوزاً بعد اعتماده.');
  assert.equal(reservationAudit.afterReplacementFailure.skippedId,reservationAudit.secondId,'وسيلة التغيير تختار السؤال البديل المتوقع.');
  assert.equal(reservationAudit.afterReplacementFailure.currentId,reservationAudit.firstId,'فشل صورة البديل يبقي السؤال الحالي.');
  assert.deepEqual(reservationAudit.afterReplacementFailure.history,[reservationAudit.firstId],'السؤال البديل الفاشل لا يدخل سجل المشاهدة.');
  assert.deepEqual(reservationAudit.afterReplacementFailure.usedIds,[reservationAudit.firstId],'السؤال البديل الفاشل لا يستهلك من جلسة اللعب.');
  assert.deepEqual(reservationAudit.afterReplacementFailure.reservedBeforeRetry,[],'يحرر حجز السؤال البديل عند فشل الصورة.');
  assert.equal(reservationAudit.afterReplacementFailure.retryId,reservationAudit.secondId,'يبقى السؤال البديل متاحاً لمحاولة لاحقة.');
  assert.equal(reservationAudit.afterReplacementFailure.lifelines,3,'تسترجع وسيلة التغيير بعد فشل صورة البديل.');
  assert.equal(reservationAudit.afterReplacementFailure.skipConsumed,false,'لا تسجل وسيلة التغيير كمستهلكة عند فشل البديل.');
  assert.equal(reservationAudit.afterReplacementFailure.outbox.some(item=>item.id===reservationAudit.secondId),false,'لا يرسل السؤال غير المعروض إلى سجل الخادم.');
  assert.deepEqual(reservationAudit.duringReplacement,{
    phase:reservationAudit.phaseBeforeSkip,team:reservationAudit.teamBeforeSkip,
    timeLeft:reservationAudit.timeBeforeSkip,timerStopped:true,replacing:true,
    flow:'جاري تجهيز السؤال البديل…',lifelines:3,skipConsumed:false,
  },'أثناء تجهيز صورة البديل تتجمد المرحلة والمؤقت ولا يغير timeUp الفريق أو يستهلك الوسيلة.');
  assert.equal(reservationAudit.afterReplacementFailure.phase,reservationAudit.phaseBeforeSkip,
    'فشل صورة البديل يعيد المرحلة الأصلية.');
  assert.equal(reservationAudit.afterReplacementFailure.team,reservationAudit.teamBeforeSkip,
    'فشل صورة البديل يعيد الفريق الأصلي.');
  assert.equal(reservationAudit.afterReplacementFailure.timeLeft,reservationAudit.timeBeforeSkip,
    'فشل صورة البديل يعيد الوقت المتبقي بلا خسارة.');
  assert.equal(reservationAudit.afterReplacementFailure.timerRestored,true,
    'بعد استعادة صورة السؤال الأصلي فقط يعود المؤقت للعمل.');
  assert.deepEqual(reservationAudit.deadlineAudit,{
    selectedImagesPrepared:true,calls:2,sameDeadline:true,sameSignal:true,signalAborted:true,
  },'كل فئات صور الجولة تشترك في مهلة وإشارة إلغاء واحدة ولا تتراكم مهل مستقلة.');
  await reservationPage.close();

  const hangingPage=await browser.newPage({viewport:{width:390,height:844}});
  await installLegacyImageFixtures(hangingPage);
  await hangingPage.goto(url);
  const hangingAudit=await hangingPage.evaluate(async()=>{
    await ensureQuestionBank();
    const category='أعلام منو؟';
    const question=QUESTION_BANK[category].find(item=>item.d===1);
    saveQuestionHistory({});
    storeRemove(questionSeenOutboxKey());
    reservedQuestionIds.clear();
    state.teams=[
      {name:'الأول',score:0,ll:3,used:new Set(),idx:0,bombUsed:false},
      {name:'الثاني',score:0,ll:3,used:new Set(),idx:1,bombUsed:false},
    ];
    state.cats=[category]; state.turn=0; state.difficulty='normal';
    state.cells={'0-1':{used:false}}; state.cur=null;
    state.usedQ=new Set(); state.usedQuestionIds=new Set();
    roundImageQuestionIds=new Set(QUESTION_BANK[category].map(item=>item.id));
    Math.random=()=>0;
    const nativeSetTimeout=window.setTimeout.bind(window);
    const nativeRevoke=URL.revokeObjectURL.bind(URL);
    const revoked=[];
    let renderTimeoutDelay=100;
    window.setTimeout=(callback,delay,...args)=>nativeSetTimeout(
      callback,delay===QUESTION_IMAGE_RENDER_TIMEOUT_MS?renderTimeoutDelay:delay,...args,
    );
    URL.revokeObjectURL=url=>{ revoked.push(url); nativeRevoke(url); };
    try{
      window.FatinahImageAssets.loadInto=async(_question,_image,{signal}={})=>new Promise((resolve,reject)=>{
        signal?.addEventListener('abort',()=>reject(new Error('simulated load abort')),{once:true});
      });
      const loadStarted=performance.now();
      const loadResult=await openQuestion(0,1,'0-1',document.createElement('button'));
      const loadElapsed=performance.now()-loadStarted;
      const afterLoadHang={
        result:loadResult,elapsed:loadElapsed,pending:questionOpenPending,current:state.cur,
        history:loadQuestionHistory()[category]||[],usedIds:[...state.usedQuestionIds],
        reserved:[...reservedQuestionIds],
      };

      let finalUrl='';
      window.FatinahImageAssets.loadInto=async()=>{
        finalUrl=URL.createObjectURL(new Blob([
          '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="purple"/></svg>',
        ],{type:'image/svg+xml'}));
        return finalUrl;
      };
      const finalImage=document.getElementById('q-image');
      const nativeImageAdd=finalImage.addEventListener.bind(finalImage);
      const nativeImageRemove=finalImage.removeEventListener.bind(finalImage);
      finalImage.addEventListener=(type,listener,options)=>{
        if(type==='load'||type==='error') return;
        return nativeImageAdd(type,listener,options);
      };
      finalImage.removeEventListener=(type,listener,options)=>{
        if(type==='load'||type==='error') return;
        return nativeImageRemove(type,listener,options);
      };
      Object.defineProperty(finalImage,'complete',{configurable:true,get:()=>false});
      Object.defineProperty(finalImage,'naturalWidth',{configurable:true,get:()=>0});
      const decodeStarted=performance.now();
      const decodeResult=await openQuestion(0,1,'0-1',document.createElement('button'));
      const decodeElapsed=performance.now()-decodeStarted;
      const afterDomLoadHang={
        result:decodeResult,elapsed:decodeElapsed,pending:questionOpenPending,current:state.cur,
        history:loadQuestionHistory()[category]||[],usedIds:[...state.usedQuestionIds],
        reserved:[...reservedQuestionIds],urlRevoked:revoked.includes(finalUrl),
      };
      delete finalImage.addEventListener;
      delete finalImage.removeEventListener;
      delete finalImage.complete;
      delete finalImage.naturalWidth;
      // لا نجعل نجاح تحميل صورة حقيقية رهين مهلة المحاكاة الشديدة (100ms)،
      // خصوصاً عند تشغيل حزمة Playwright كاملة تحت ضغط؛ يبقى الفشل محدوداً بثانية.
      renderTimeoutDelay=1000;

      let displayableUrl='';
      window.FatinahImageAssets.loadInto=async()=>{
        displayableUrl=URL.createObjectURL(new Blob([
          '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90"><rect width="120" height="90" fill="green"/></svg>',
        ],{type:'image/svg+xml'}));
        return displayableUrl;
      };
      // محاكاة WKWebView: decode() يرفض، لكن load على عنصر DOM ينجح
      // والصورة لها أبعاد فعلية. المسار الصحيح لا يحتاج فكاً ثانياً زائداً.
      finalImage.decode=()=>Promise.reject(new Error('redundant DOM decode rejected'));
      const displayableResult=await openQuestion(0,1,'0-1',document.createElement('button'));
      const decodeRejectedButDisplayable={
        result:displayableResult,pending:questionOpenPending,currentId:state.cur?.q?.id,
        naturalWidth:finalImage.naturalWidth,naturalHeight:finalImage.naturalHeight,
        history:loadQuestionHistory()[category]||[],usedIds:[...state.usedQuestionIds],
        options:document.querySelectorAll('#q-options .q-option').length,
        urlRevoked:revoked.includes(displayableUrl),
      };
      return {questionId:question.id,afterLoadHang,afterDomLoadHang,decodeRejectedButDisplayable};
    }finally{
      clearActiveQuestionImage();
      window.setTimeout=nativeSetTimeout;
      URL.revokeObjectURL=nativeRevoke;
      clearInterval(state.timer); clearInterval(questionSeenFlushTimer);
    }
  });
  for(const [name,audit] of Object.entries({
    afterLoadHang:hangingAudit.afterLoadHang,
    afterDomLoadHang:hangingAudit.afterDomLoadHang,
  })){
    assert.equal(audit.result,false,`${name}: تعليق فك الصورة يجب أن يفشل فتح السؤال بأمان.`);
    assert.ok(audit.elapsed<500,`${name}: فتح السؤال لا يجوز أن يبقى معلقاً.`);
    assert.equal(audit.pending,false,`${name}: حارس فتح السؤال يجب أن يتحرر بعد المهلة.`);
    assert.equal(audit.current,null,`${name}: لا يبقى سؤال ناقص نشطاً.`);
    assert.deepEqual(audit.history,[],`${name}: السؤال الذي لم يظهر لا يدخل سجل المشاهدة.`);
    assert.deepEqual(audit.usedIds,[],`${name}: السؤال الذي لم يظهر لا يُستهلك من الجولة.`);
    assert.deepEqual(audit.reserved,[],`${name}: حجز السؤال يتحرر بعد المهلة.`);
  }
  assert.equal(hangingAudit.afterDomLoadHang.urlRevoked,true,'مهلة تحميل عنصر DOM تحرر رابط الصورة المحمّلة.');
  assert.equal(hangingAudit.decodeRejectedButDisplayable.result,true,
    'رفض decode الزائد لا يمنع صورة نجح load ولها أبعاد فعلية.');
  assert.equal(hangingAudit.decodeRejectedButDisplayable.currentId,hangingAudit.questionId);
  assert.ok(hangingAudit.decodeRejectedButDisplayable.naturalWidth>0&&hangingAudit.decodeRejectedButDisplayable.naturalHeight>0,
    'الصورة المعتمدة يجب أن تكون مرئية فعلياً داخل عنصر DOM.');
  assert.deepEqual(hangingAudit.decodeRejectedButDisplayable.history,[hangingAudit.questionId]);
  assert.deepEqual(hangingAudit.decodeRejectedButDisplayable.usedIds,[hangingAudit.questionId]);
  assert.equal(hangingAudit.decodeRejectedButDisplayable.options,4);
  assert.equal(hangingAudit.decodeRejectedButDisplayable.urlRevoked,false,
    'رابط الصورة الظاهرة يبقى نشطاً إلى أن يغلق السؤال.');
  await hangingPage.close();
  console.log('✓ واجهة السؤال المصوّر واضحة على iPhone عمودي وأفقي');
}finally{ await browser.close(); }
