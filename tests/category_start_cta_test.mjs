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
      const denied=toggleCat('معلومات عامة');
      const afterDenied={cats:[...state.cats],owners:{...state.catOwner},picked:[...state.pickedByTeam],turn:state.pickTurn,title:document.getElementById('toast-t').textContent};
      const secondPick=toggleCat('تاريخ');
      const ownRemoval=toggleCat('تاريخ');
      return {firstPick,denied,afterDenied,secondPick,ownRemoval,cats:[...state.cats],picked:[...state.pickedByTeam],turn:state.pickTurn};
    });
    assert.equal(ownership.firstPick,true,`${name}: الفريق الأول يختار فئته.`);
    assert.equal(ownership.denied,false,`${name}: الفريق الثاني ما يقدر يلغي فئة الأول.`);
    assert.deepEqual(ownership.afterDenied.cats,['معلومات عامة'],`${name}: الفئة تبقى بعد محاولة الإلغاء المرفوضة.`);
    assert.deepEqual(ownership.afterDenied.owners,{'معلومات عامة':0},`${name}: ملكية الفئة ما تتغير.`);
    assert.deepEqual(ownership.afterDenied.picked,[1,0],`${name}: العدادات ما تتغير بعد الرفض.`);
    assert.equal(ownership.afterDenied.turn,1,`${name}: الدور يبقى للفريق الثاني.`);
    assert.match(ownership.afterDenied.title,/مو لفريقكم/,`${name}: تظهر رسالة توضح سبب الرفض.`);
    assert.equal(ownership.secondPick,true,`${name}: الفريق الثاني يختار فئته.`);
    assert.equal(ownership.ownRemoval,true,`${name}: الفريق الثاني يقدر يلغي فئته هو.`);
    assert.deepEqual(ownership.cats,['معلومات عامة'],`${name}: تنحذف فئة الفريق الثاني فقط.`);
    assert.deepEqual(ownership.picked,[1,0],`${name}: ينقص عداد الفريق المالك فقط.`);
    assert.equal(ownership.turn,1,`${name}: يرجع الاختيار للفريق المالك بعد الإلغاء.`);
    await page.close();
  }
  console.log('✓ زر يلا نبدأ يظهر ثابتاً بعد اكتمال الفئات على iPhone عمودي وأفقي');
}finally{await browser.close();}
