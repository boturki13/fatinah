import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const url=`file://${path.join(root,'www/index.html')}`;
const browser=await chromium.launch();
try{
  for(const [name,width,height] of [['iPhone portrait',390,844],['iPhone landscape',844,390]]){
    const page=await browser.newPage({viewport:{width,height}});
    await page.goto(url);
    await page.evaluate(async()=>{
      await ensureQuestionBank();
      localStorage.removeItem(questionHistoryKey());
      Math.random=()=>0;
      const playerQuestions=QUESTION_BANK['منو هاللاعب؟'].filter(question=>question.d===1);
      const question=playerQuestions[0];
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
      state.cats=['منو هاللاعب؟']; state.turn=0; state.difficulty='normal'; state.cells={'0-1':{used:false}};
      state.usedQ=new Set(); state.usedQuestionIds=new Set(); roundImageQuestionIds=new Set(playerQuestions.map(item=>item.id));
      await openQuestion(0,1,'0-1',document.createElement('button'));
    });
    await page.locator('#q-wrap.show').waitFor();
    const audit=await page.evaluate(()=>{
      const visible=id=>{const e=document.getElementById(id),r=e.getBoundingClientRect(),s=getComputedStyle(e); return !e.hidden&&s.display!=='none'&&r.width>0&&r.height>0;};
      const rect=id=>{const r=document.getElementById(id).getBoundingClientRect(); return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,width:r.width,height:r.height};};
      return {image:rect('q-image'),questionCard:rect('q-question-card'),question:rect('q-text'),controls:rect('q-controls'),lifelines:rect('lifelines'),flow:rect('q-flow'),timer:rect('countdown-timer'),answerHidden:!visible('answer-box'),overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,alt:document.getElementById('q-image').alt};
    });
    assert.ok(audit.image.width>150&&audit.image.height>90,`${name}: الصورة واضحة.`);
    assert.ok(audit.question.height>0,`${name}: السؤال ظاهر. ${JSON.stringify(audit)}`);
    assert.ok(audit.timer.height>=40,`${name}: المؤقت ظاهر.`);
    assert.ok(audit.questionCard.width>=width*.88,`${name}: خانة السؤال تستفيد من عرض الشاشة.`);
    assert.ok(Math.min(audit.lifelines.bottom,audit.flow.bottom)-Math.max(audit.lifelines.top,audit.flow.top)>20,`${name}: وسائل المساعدة بجانب زر كشف الإجابة.`);
    assert.ok(audit.lifelines.right<=audit.flow.left+1||audit.flow.right<=audit.lifelines.left+1,`${name}: التحكم موزع أفقياً بدون تداخل.`);
    assert.equal(audit.answerHidden,true,`${name}: الإجابة مخفية قبل الكشف.`);
    assert.ok(audit.overflow<=1,`${name}: لا يوجد تجاوز أفقي.`);
    assert.match(audit.alt,/لاعب برتغالي/);
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
    await page.getByRole('button',{name:'▶ كمّل'}).click();
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
    await page.waitForFunction(()=>state.cur?.q?.id==='img-v2-player-lionel-messi');
    const replacement=await page.evaluate(()=>({
      id:state.cur.q.id,
      answer:document.getElementById('ans-text').textContent,
      alt:document.getElementById('q-image').alt,
      loaded:[...window.__loadedQuestionImages],
    }));
    assert.equal(replacement.id,'img-v2-player-lionel-messi',`${name}: تم اختيار سؤال اللاعب البديل.`);
    assert.equal(replacement.answer,'ليونيل ميسي',`${name}: الإجابة تخص السؤال البديل.`);
    assert.match(replacement.alt,/لاعب أرجنتيني/,`${name}: الصورة والوصف البديل يتغيران مع السؤال.`);
    assert.deepEqual(replacement.loaded,[
      'img-v2-player-cristiano-ronaldo','img-v2-player-lionel-messi',
    ],`${name}: تم تحميل صورة السؤال البديل فعلياً.`);
    await page.getByRole('button',{name:'👁️ اكشف الإجابة'}).click();
    assert.equal(await page.locator('#answer-box').isVisible(),true,`${name}: الإجابة واضحة بعد الكشف.`);
    await page.waitForTimeout(400); // انتظر نهاية حركة ظهور صندوق الإجابة قبل قياس مناطق اللمس.
    const revealLayout=await page.evaluate(()=>{
      const sheet=document.querySelector('#q-wrap .q-sheet');
      const sr=sheet.getBoundingClientRect();
      const ar=document.getElementById('answer-box').getBoundingClientRect();
      const cr=document.getElementById('q-controls').getBoundingClientRect();
      return {
        answerFocused:document.activeElement===document.getElementById('answer-box'),
        answerVisible:ar.top>=sr.top-1&&ar.bottom<=sr.bottom+1,
        controlsVisible:cr.top>=sr.top-1&&cr.bottom<=sr.bottom+1,
        scrollTop:sheet.scrollTop,
      };
    });
    assert.equal(revealLayout.answerFocused,true,`${name}: ينتقل التركيز للإجابة الجديدة.`);
    assert.equal(revealLayout.answerVisible,true,`${name}: صندوق الإجابة كامل داخل الشاشة بعد الكشف.`);
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
      const source=document.getElementById('q-image-source-page');
      const license=document.getElementById('q-image-license');
      return {
        hidden:document.getElementById('q-image-rights').hidden&&getComputedStyle(document.getElementById('q-image-rights')).display==='none',
        sourceHidden:document.getElementById('q-source').hidden&&getComputedStyle(document.getElementById('q-source')).display==='none',
        credit:document.getElementById('q-image-credit').textContent,
        sourceHref:source.href,licenseHref:license.href,
        modifications:document.getElementById('q-image-modifications').textContent,
      };
    });
    assert.equal(rights.hidden,true,`${name}: حقوق الصورة مخفية عن اللاعب.`);
    assert.equal(rights.sourceHidden,true,`${name}: مصدر السؤال مخفي عن اللاعب.`);
    assert.match(rights.credit,/NASA Images/);
    assert.doesNotMatch(rights.credit,/Wikimedia Commons/,'صورة NASA لا تُنسب إلى Commons.');
    assert.match(rights.sourceHref,/^https:\/\/images\.nasa\.gov\/details\//);
    assert.match(rights.licenseHref,/^https:\/\/www\.nasa\.gov\//);
    assert.match(rights.modifications,/AVIF وWebP/);
    await page.close();
  }
  const racePage=await browser.newPage({viewport:{width:390,height:844}});
  await racePage.goto(url);
  const raceAudit=await racePage.evaluate(async()=>{
    await ensureQuestionBank();
    localStorage.removeItem(questionHistoryKey());
    const [firstQuestion,secondQuestion]=QUESTION_BANK['منو هاللاعب؟'].filter(question=>question.d===1);
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
    state.cats=['منو هاللاعب؟']; state.turn=0; state.difficulty='normal';
    state.cells={'0-1':{used:false},'0-2':{used:false}}; state.cur=null;
    state.usedQ=new Set(); state.usedQuestionIds=new Set();
    roundImageQuestionIds=new Set(QUESTION_BANK['منو هاللاعب؟'].map(question=>question.id));
    Math.random=()=>0;
    const firstOpen=openQuestion(0,1,'0-1',document.createElement('button'));
    const blockedOpen=openQuestion(0,2,'0-2',document.createElement('button'));
    await firstOpen;
    return {
      staleRender,
      blockedOpen,
      activeQuestionId:state.cur?.q?.id,
      activeAlt:document.getElementById('q-image').alt,
      questionVisible:document.getElementById('q-wrap').classList.contains('show'),
    };
  });
  assert.equal(raceAudit.staleRender.oldReady,false,'تحميل الصورة القديم لا يجوز أن يعتمد بعد بدء طلب أحدث.');
  assert.equal(raceAudit.staleRender.newReady,true,'طلب الصورة الأحدث يجب أن يكتمل.');
  assert.match(raceAudit.staleRender.alt,/لاعب أرجنتيني/,'الطلب القديم لا يكتب فوق وصف الصورة الأحدث.');
  assert.equal(raceAudit.blockedOpen,false,'لا يجوز فتح خانة ثانية أثناء تجهيز السؤال الأول.');
  assert.equal(raceAudit.activeQuestionId,'img-v2-player-cristiano-ronaldo','يبقى السؤال الأول هو السؤال النشط.');
  assert.match(raceAudit.activeAlt,/لاعب برتغالي/,'الصورة والوصف يطابقان السؤال النشط.');
  assert.equal(raceAudit.questionVisible,true,'يظهر سؤال واحد فقط بعد اكتمال التحميل.');
  await racePage.close();
  console.log('✓ واجهة السؤال المصوّر واضحة على iPhone عمودي وأفقي');
}finally{ await browser.close(); }
