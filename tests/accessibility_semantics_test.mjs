import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const indexPath=path.join(root,'www/index.html');
const html=fs.readFileSync(indexPath,'utf8');
const css=fs.readFileSync(path.join(root,'www/app.css'),'utf8');
const bridgeSwift=fs.readFileSync(path.join(root,'ios/App/App/RevenueCatKeyStorePlugin.swift'),'utf8');
const viewport=html.match(/<meta\s+name="viewport"\s+content="([^"]+)"/i)?.[1]||'';

assert.doesNotMatch(viewport,/user-scalable\s*=\s*no/i,'لا يجوز منع تكبير الصفحة على iOS.');
assert.doesNotMatch(viewport,/maximum-scale\s*=\s*1(?:\.0)?(?:,|$)/i,'لا يجوز تثبيت أقصى تكبير عند 1.');
assert.match(css,/--fatinah-text-size-adjust:100%/,'لازم يكون للويب مقدار تكبير افتراضي قابل للتحديث.');
assert.match(bridgeSwift,/preferredContentSizeCategory/,'لازم جسر iOS يستجيب لإعداد Dynamic Type.');
assert.match(bridgeSwift,/accessibilityExtraExtraExtraLarge:\s*return 180/,'لازم أكبر حجم وصول يرفع حجم نص الويب بوضوح.');

const browser=await chromium.launch();
try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.goto(`file://${indexPath}`);

  await page.evaluate(()=>go('s-teams'));
  await page.waitForFunction(()=>document.getElementById('s-teams').contains(document.activeElement));
  const transition=await page.evaluate(()=>({
    focusedText:document.activeElement?.textContent?.trim(),
    focusedTag:document.activeElement?.tagName,
    activeHidden:document.getElementById('s-teams').getAttribute('aria-hidden'),
    homeHidden:document.getElementById('s-home').getAttribute('aria-hidden'),
  }));
  assert.equal(transition.focusedText,'إعداد الفرق','بعد الانتقال لازم ينتقل تركيز VoiceOver لعنوان الشاشة.');
  assert.equal(transition.focusedTag,'H2');
  assert.equal(transition.activeHidden,'false');
  assert.equal(transition.homeHidden,'true');

  const choices=await page.evaluate(()=>{
    setTeamCount(3);
    updateCatCount(2);
    setDifficulty('hard');
    const pressed=id=>[...document.querySelectorAll(`#${id} button`)].map(button=>({
      value:button.dataset.n||button.dataset.d,
      pressed:button.getAttribute('aria-pressed'),
    }));
    return {
      teams:pressed('seg-teams'),
      categories:pressed('seg-catcount'),
      difficulty:pressed('seg-diff'),
      teamLabels:[...document.querySelectorAll('#team-names input')].map(input=>input.getAttribute('aria-label')),
    };
  });
  assert.deepEqual(choices.teams,[{value:'2',pressed:'false'},{value:'3',pressed:'true'}]);
  assert.equal(choices.categories.find(item=>item.value==='2')?.pressed,'true');
  assert.equal(choices.difficulty.find(item=>item.value==='hard')?.pressed,'true');
  assert.deepEqual(choices.teamLabels,['اسم الفريق 1','اسم الفريق 2','اسم الفريق 3']);

  const filters=await page.evaluate(async()=>{
    await ensureQuestionBank();
    state.teamCount=2;
    state.teams=[{name:'الأول',idx:0},{name:'الثاني',idx:1}];
    state.catCount=2;
    state.pickSplit=[1,1]; state.pickTurn=0; state.pickedByTeam=[0,0]; state.cats=[];
    go('s-cats');
    renderCats();
    const buttons=[...document.querySelectorAll('#filter-bar button')];
    buttons[1].click();
    return [...document.querySelectorAll('#filter-bar button')].map(button=>({
      text:button.textContent.trim(),pressed:button.getAttribute('aria-pressed'),
    }));
  });
  assert.equal(filters.filter(item=>item.pressed==='true').length,1,'فلتر واحد فقط لازم يُعلن كمختار.');
  assert.notEqual(filters.find(item=>item.pressed==='true')?.text,'🗂️ الكل');

  const categoryFocus=await page.evaluate(async()=>{
    const button=document.querySelector('#cat-grid .cat-pick');
    const category=button.dataset.category;
    button.focus();
    button.click();
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    return {
      category,
      focusedCategory:document.activeElement?.dataset?.category||'',
      focusedInsideGrid:document.getElementById('cat-grid').contains(document.activeElement),
    };
  });
  assert.equal(categoryFocus.focusedCategory,categoryFocus.category,'بعد إعادة رسم الفئات لازم يرجع التركيز لنفس زر الفئة.');
  assert.equal(categoryFocus.focusedInsideGrid,true);

  await page.evaluate(()=>{ activeFilter='الكل'; buildFilterBar(); renderCatGrid(); });
  const pointerCategory=page.locator('#cat-grid .cat-pick:not(.on)').first();
  await pointerCategory.click({position:{x:20,y:20}});
  const pointerFocus=await page.evaluate(()=>({
    focusedCategory:document.activeElement?.dataset?.category||'',
    focusedInsideGrid:document.getElementById('cat-grid').contains(document.activeElement),
    scale:window.visualViewport?.scale||1,
  }));
  assert.equal(pointerFocus.focusedCategory,'','ضغط اللمس ما يعيد تركيز بطاقة جديدة بعد إعادة رسم الشبكة.');
  assert.equal(pointerFocus.focusedInsideGrid,false);
  assert.equal(pointerFocus.scale,1,'ضغط بطاقة الفئة ما يغيّر تكبير الصفحة.');

  const onboarding=await page.evaluate(async()=>{
    go('s-onb');
    _onbStep=0; _onbSetStep(0);
    onbNext();
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    return [...document.querySelectorAll('.onb-card')].map(card=>({
      id:card.id,active:card.classList.contains('active'),hidden:card.getAttribute('aria-hidden'),inert:card.inert,
    }));
  });
  assert.deepEqual(onboarding,[
    {id:'onb-card-0',active:false,hidden:'true',inert:true},
    {id:'onb-card-1',active:true,hidden:'false',inert:false},
    {id:'onb-card-2',active:false,hidden:'true',inert:true},
  ],'VoiceOver يشوف بطاقة التعريف النشطة فقط.');

  const connectivity=await page.evaluate(async()=>{
    const bar=document.getElementById('offline-bar');
    window.dispatchEvent(new Event('offline'));
    const offline={role:bar.getAttribute('role'),live:bar.getAttribute('aria-live'),atomic:bar.getAttribute('aria-atomic'),hidden:bar.getAttribute('aria-hidden'),shown:bar.classList.contains('show'),text:bar.textContent.trim()};
    window.dispatchEvent(new Event('online'));
    const online={hidden:bar.getAttribute('aria-hidden'),shown:bar.classList.contains('show'),online:bar.classList.contains('online'),text:bar.textContent.trim()};
    await new Promise(resolve=>setTimeout(resolve,1900));
    return {offline,online,settled:{hidden:bar.getAttribute('aria-hidden'),shown:bar.classList.contains('show')}};
  });
  assert.deepEqual(connectivity.offline,{role:'status',live:'polite',atomic:'true',hidden:'false',shown:true,text:'ماكو اتصال بالإنترنت'});
  assert.deepEqual(connectivity.online,{hidden:'false',shown:true,online:true,text:'رجع الاتصال بالإنترنت'});
  assert.deepEqual(connectivity.settled,{hidden:'true',shown:false},'إشعار رجوع الاتصال يختفي بعد ما ينعلن.');

  const inputs=await page.evaluate(()=>{
    renderManualOpts();
    const ids=['auth-phone','auth-phone-code','auth-email','auth-password','account-name-input',
      'verification-phone','verification-phone-code','cat-search','fm-name','fm-q','fm-o-0'];
    return ids.map(id=>({id,label:document.getElementById(id)?.getAttribute('aria-label')||''}));
  });
  assert.deepEqual(inputs.filter(item=>!item.label),[],'كل حقل لازم يكون له اسم واضح لقارئ الشاشة.');

  const modal=await page.evaluate(()=>{
    go('s-board');
    const trigger=document.querySelector('#s-board .exit-btn');
    trigger.focus();
    confirmExit();
    const dialog=document.getElementById('exit-modal');
    return {
      role:dialog.getAttribute('role'),modal:dialog.getAttribute('aria-modal'),
      hidden:dialog.getAttribute('aria-hidden'),labelledby:dialog.getAttribute('aria-labelledby'),
      focusInside:dialog.contains(document.activeElement),
    };
  });
  assert.deepEqual(modal,{role:'dialog',modal:'true',hidden:'false',labelledby:'exit-modal-title',focusInside:true});
  await page.evaluate(async()=>{
    closeExitModal();
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  });
  const restored=await page.evaluate(()=>({
    hidden:document.getElementById('exit-modal').getAttribute('aria-hidden'),
    isTrigger:document.activeElement===document.querySelector('#s-board .exit-btn'),
  }));
  assert.deepEqual(restored,{hidden:'true',isTrigger:true},'إغلاق النافذة يرجع التركيز للزر اللي فتحها.');

  const dialogs=await page.evaluate(()=>[...document.querySelectorAll('.modal-wrap')].map(dialog=>({
    id:dialog.id,role:dialog.getAttribute('role'),modal:dialog.getAttribute('aria-modal'),
    labelledby:dialog.getAttribute('aria-labelledby'),describedby:dialog.getAttribute('aria-describedby'),
  })));
  assert.deepEqual(dialogs.filter(dialog=>!dialog.role||!dialog.modal||!dialog.labelledby||!dialog.describedby),[],
    'كل نافذة لازم تعلن عنوانها ووصفها كنافذة modal.');

  const live=await page.evaluate(()=>{
    const toast=document.getElementById('toast');
    return {role:toast.getAttribute('role'),live:toast.getAttribute('aria-live'),atomic:toast.getAttribute('aria-atomic')};
  });
  assert.deepEqual(live,{role:'status',live:'polite',atomic:'true'});

  await page.evaluate(async()=>{
    await ensureQuestionBank();
    localStorage.removeItem(questionHistoryKey());
    state.teams=[
      {name:'الأول',score:0,ll:3,used:new Set(),idx:0,bombUsed:false},
      {name:'الثاني',score:0,ll:3,used:new Set(),idx:1,bombUsed:false},
    ];
    state.teamCount=2; state.turn=0; state.difficulty='normal';
    state.cats=['معلومات عامة']; state.cells={}; state.cur=null;
    state.usedQ=new Set(); state.usedQuestionIds=new Set();
    buildBoard(); renderTeamsBar(); renderTurn(); go('s-board');
    const origin=document.querySelector('#board .cell');
    origin.focus();
    origin.click();
  });
  await page.locator('#q-wrap.show').waitFor();
  await page.waitForFunction(()=>document.getElementById('q-wrap').contains(document.activeElement));
  const questionModal=await page.evaluate(()=>{
    const wrap=document.getElementById('q-wrap');
    const app=document.getElementById('app');
    const backgroundButton=document.querySelector('#s-board .exit-btn');
    backgroundButton.focus();
    return {
      appInert:app.inert&&app.hasAttribute('inert'),
      appHidden:app.getAttribute('aria-hidden'),
      focusStayedInside:wrap.contains(document.activeElement),
      answerReportExcluded:!modalFocusableElements(wrap).includes(document.getElementById('q-report-btn')),
    };
  });
  assert.deepEqual(questionModal,{
    appInert:true,appHidden:'true',focusStayedInside:true,answerReportExcluded:true,
  },'شاشة السؤال تعزل الخلفية وتستبعد عناصر الإجابة المخفية من ترتيب التركيز.');

  const tabCycle=await page.evaluate(async()=>{
    const wrap=document.getElementById('q-wrap');
    const focusable=modalFocusableElements(wrap);
    const first=focusable[0],last=focusable[focusable.length-1];
    last.focus();
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
    const forwardWrapped=document.activeElement===first;
    first.focus();
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));
    return {forwardWrapped,backwardWrapped:document.activeElement===last,count:focusable.length};
  });
  assert.equal(tabCycle.forwardWrapped,true,'Tab من آخر عنصر يرجع لأول عنصر داخل السؤال.');
  assert.equal(tabCycle.backwardWrapped,true,'Shift+Tab من أول عنصر يرجع لآخر عنصر داخل السؤال.');
  assert.ok(tabCycle.count>2,'الاختبار يحتاج أكثر من عنصر تفاعلي حتى يكون حساساً لتسرب التركيز.');

  await page.evaluate(()=>hideQuestionScreen(true));
  await page.waitForFunction(()=>document.activeElement?.classList.contains('cell'));
  const questionClosed=await page.evaluate(()=>({
    hidden:document.getElementById('q-wrap').getAttribute('aria-hidden'),
    appInert:document.getElementById('app').inert,
    appHidden:document.getElementById('app').hasAttribute('aria-hidden'),
    focusRestored:document.activeElement===document.querySelector('#board .cell'),
  }));
  assert.deepEqual(questionClosed,{hidden:'true',appInert:false,appHidden:false,focusRestored:true},
    'إغلاق السؤال يعيد الخلفية لشجرة الوصول ويرجع التركيز للخانة الأصلية.');

  await page.close();
  console.log('✓ التكبير وVoiceOver والاختيارات والحقول والنوافذ لها دلالات وصول صحيحة');
}finally{
  await browser.close();
}
