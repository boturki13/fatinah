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
    // انتظر اكتمال توجيه الإقلاع قبل تركيب حالة اختبار التخطيط؛
    // وإلا قد يعيد checkSubscriptionAndRoute المتأخر الانتقال وسط القياس.
    await page.waitForFunction(()=>document.querySelector('.screen.active')?.id!=='s-loading');
    const before=await page.evaluate(()=>{
      go('s-cats');
      state.teamCount=2;
      state.teams=[{name:'الأول',idx:0},{name:'الثاني',idx:1}];
      state.catCount=2; state.pickSplit=[1,1]; state.pickTurn=0;
      state.pickedByTeam=[0,0]; state.cats=[];
      updatePickTurn();
      const button=document.getElementById('start-btn');
      return {hidden:button.getAttribute('aria-hidden'),visible:getComputedStyle(button).visibility};
    });
    assert.equal(before.hidden,'true',`${name}: الزر يكون مخفياً قبل اكتمال الاختيار.`);
    assert.equal(before.visible,'hidden');

    const ready=await page.evaluate(()=>{
      state.cats=['معلومات عامة','تاريخ']; state.pickedByTeam=[1,1];
      updatePickTurn();
      return true;
    });
    assert.equal(ready,true);
    await page.waitForTimeout(350);
    const readyLayout=await page.evaluate(()=>{
      const button=document.getElementById('start-btn');
      const rect=button.getBoundingClientRect();
      return {
        text:button.textContent,hidden:button.getAttribute('aria-hidden'),disabled:button.disabled,
        position:getComputedStyle(button).position,rect:{top:rect.top,bottom:rect.bottom,left:rect.left,right:rect.right},
        viewport:{width:innerWidth,height:innerHeight},screenReady:document.getElementById('s-cats').classList.contains('start-ready'),
      };
    });
    assert.equal(readyLayout.hidden,'false');
    assert.equal(readyLayout.disabled,false);
    assert.equal(readyLayout.position,'fixed');
    assert.equal(readyLayout.screenReady,true);
    assert.equal(readyLayout.text,'يلا نبدأ — فئتين');
    assert.ok(readyLayout.rect.top>=0&&readyLayout.rect.bottom<=readyLayout.viewport.height,`${name}: الزر لازم يبقى داخل الشاشة.`);
    assert.ok(readyLayout.rect.left>=0&&readyLayout.rect.right<=readyLayout.viewport.width,`${name}: الزر لازم ما يتجاوز عرض الشاشة.`);
    assert.ok(readyLayout.rect.bottom>readyLayout.viewport.height/2,`${name}: الزر لازم يظهر بأسفل الشاشة.`);

    const removed=await page.evaluate(()=>{
      state.cats.pop(); state.pickedByTeam=[1,0]; updatePickTurn();
      const button=document.getElementById('start-btn');
      return {hidden:button.getAttribute('aria-hidden'),ready:document.getElementById('s-cats').classList.contains('start-ready')};
    });
    assert.equal(removed.hidden,'true',`${name}: إذا انشالت فئة يختفي الزر.`);
    assert.equal(removed.ready,false);

    const ownership=await page.evaluate(()=>{
      state.teamCount=2;
      state.teams=[{name:'الأول',idx:0},{name:'الثاني',idx:1}];
      state.catCount=2; state.pickSplit=[1,1]; state.pickTurn=0;
      state.pickedByTeam=[0,0]; state.cats=[]; state.catOwner={};
      const firstPick=toggleCat('معلومات عامة');
      const previousTeamRemoval=toggleCat('معلومات عامة');
      const afterRemoval={cats:[...state.cats],owners:{...state.catOwner},picked:[...state.pickedByTeam],turn:state.pickTurn};
      const firstRepick=toggleCat('معلومات عامة');
      const secondPick=toggleCat('تاريخ');
      const ownRemoval=toggleCat('تاريخ');
      return {firstPick,previousTeamRemoval,afterRemoval,firstRepick,secondPick,ownRemoval,cats:[...state.cats],picked:[...state.pickedByTeam],turn:state.pickTurn};
    });
    assert.equal(ownership.firstPick,true,`${name}: الفريق الأول يختار فئته.`);
    assert.equal(ownership.previousTeamRemoval,true,`${name}: الضغط على فئة سابقة يلغيها.`);
    assert.deepEqual(ownership.afterRemoval.cats,[],`${name}: تنحذف الفئة السابقة.`);
    assert.deepEqual(ownership.afterRemoval.owners,{},`${name}: تنحذف ملكية الفئة الملغاة.`);
    assert.deepEqual(ownership.afterRemoval.picked,[0,0],`${name}: ينقص عداد مالك الفئة.`);
    assert.equal(ownership.afterRemoval.turn,0,`${name}: يرجع الدور إلى مالك الفئة.`);
    assert.equal(ownership.firstRepick,true,`${name}: يقدر الفريق الأول يعيد اختياره.`);
    assert.equal(ownership.secondPick,true,`${name}: الفريق الثاني يختار فئته.`);
    assert.equal(ownership.ownRemoval,true,`${name}: الفريق الثاني يقدر يلغي فئته هو.`);
    assert.deepEqual(ownership.cats,['معلومات عامة'],`${name}: تنحذف فئة الفريق الثاني فقط.`);
    assert.deepEqual(ownership.picked,[1,0],`${name}: ينقص عداد الفريق المالك فقط.`);
    assert.equal(ownership.turn,1,`${name}: يرجع الاختيار للفريق المالك بعد الإلغاء.`);

    const threeTeams=await page.evaluate(()=>{
      state.teamCount=3;
      state.teams=[{name:'الأول',idx:0},{name:'الثاني',idx:1},{name:'الثالث',idx:2}];
      state.catCount=3; state.pickSplit=[1,1,1]; state.pickTurn=0;
      state.pickedByTeam=[0,0,0]; state.cats=[]; state.catOwner={};
      toggleCat('معلومات عامة');
      toggleCat('تاريخ');
      const before={cats:[...state.cats],picked:[...state.pickedByTeam],turn:state.pickTurn};
      const removed=toggleCat('معلومات عامة');
      return {before,removed,cats:[...state.cats],picked:[...state.pickedByTeam],turn:state.pickTurn};
    });
    assert.deepEqual(threeTeams.before,{cats:['معلومات عامة','تاريخ'],picked:[1,1,0],turn:2},
      `${name}: تناوب ثلاثة فرق صحيح قبل التراجع.`);
    assert.equal(threeTeams.removed,true,`${name}: يمكن التراجع عن اختيار الفريق الأول بعد وصول الدور للثالث.`);
    assert.deepEqual(threeTeams.cats,['تاريخ'],`${name}: لا تُحذف اختيارات الفرق الأخرى.`);
    assert.deepEqual(threeTeams.picked,[0,1,0],`${name}: عدادات الفرق الثلاثة تبقى صحيحة.`);
    assert.equal(threeTeams.turn,0,`${name}: يرجع الدور إلى مالك الفئة الملغاة.`);
    await page.close();
  }
  console.log('✓ زر يلا نبدأ يظهر ثابتاً بعد اكتمال الفئات على iPhone عمودي وأفقي');
}finally{await browser.close();}
