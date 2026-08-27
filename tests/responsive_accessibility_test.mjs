import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = `file://${path.join(root, 'www/index.html')}`;
const sizes = [
  ['iPhone portrait', 390, 844], ['iPhone landscape', 844, 390],
  ['iPad portrait', 820, 1180], ['iPad landscape', 1180, 820],
];
const browser = await chromium.launch();
try {
  for (const [name, width, height] of sizes) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(url);
    for (const screen of ['s-auth', 's-privacy', 's-terms']) {
      await page.evaluate(screenId => window.go(screenId), screen);
      const audit = await page.evaluate(() => {
        const visible = element => {
          const style = getComputedStyle(element), rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const undersized = [...document.querySelectorAll('button,a[href],input,select,textarea,[role="button"],[role="radio"]')]
          .filter(visible).map(element => {
            const rect = element.getBoundingClientRect();
            return { label: element.getAttribute('aria-label') || element.textContent.trim() || element.id,
                     width: Math.round(rect.width), height: Math.round(rect.height) };
          }).filter(item => item.width < 44 || item.height < 44);
        return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, undersized };
      });
      assert.ok(audit.overflow <= 1, `${name} ${screen}: horizontal overflow ${audit.overflow}px`);
      assert.deepEqual(audit.undersized, [], `${name} ${screen}: touch targets under 44×44`);
    }
    await page.close();
    console.log(`✓ ${name}: بلا تجاوز أفقي ومناطق اللمس 44×44 على الأقل في الدخول والخصوصية والشروط`);
  }
  for(const width of [375,390]){
    const page=await browser.newPage({viewport:{width,height:844},reducedMotion:'reduce'});
    await page.goto(url);
    const boardAudit=await page.evaluate(()=>{
      state.teams=[
        {name:'الفريق الأول',score:0,ll:3,used:new Set(),idx:0,bombUsed:false},
        {name:'الفريق الثاني',score:0,ll:3,used:new Set(),idx:1,bombUsed:false},
      ];
      state.teamCount=2; state.turn=0;
      state.cats=['معلومات عامة','علوم','تاريخ','جغرافيا','رياضة','دين وسيرة','أفلام عربية','اللغة العربية'];
      buildBoard(); renderTeamsBar(); renderTurn(); go('s-board');
      const scroll=document.getElementById('board-scroll');
      const grid=document.getElementById('board-grid');
      const heads=[...document.querySelectorAll('#cats-head .cat-h')];
      const cells=[...document.querySelectorAll('#board .cell')];
      const scrollRect=scroll.getBoundingClientRect();
      const gridRect=grid.getBoundingClientRect();
      const firstRow=cells.slice(0,state.cats.length);
      return {
        pageOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
        scrollable:scroll.scrollWidth>scroll.clientWidth,
        scrollInsideViewport:scrollRect.left>=-1&&scrollRect.right<=innerWidth+1,
        counts:{heads:heads.length,cells:cells.length},
        smallestCell:Math.min(...cells.map(cell=>cell.getBoundingClientRect().width)),
        contentContained:cells.every(cell=>{
          const rect=cell.getBoundingClientRect();
          return rect.left>=gridRect.left-1&&rect.right<=gridRect.right+1;
        }),
        aligned:heads.every((head,index)=>{
          const hr=head.getBoundingClientRect(),cr=firstRow[index].getBoundingClientRect();
          return Math.abs(hr.left-cr.left)<=1&&Math.abs(hr.width-cr.width)<=1;
        }),
        hint:document.getElementById('board-hint').textContent,
      };
    });
    assert.ok(boardAudit.pageOverflow<=1,`iPhone ${width}: اللوحة ما تسبب تجاوزاً أفقياً للصفحة.`);
    assert.equal(boardAudit.scrollable,true,`iPhone ${width}: ثمان فئات تحتاج تمريراً أفقياً داخل اللوحة.`);
    assert.equal(boardAudit.scrollInsideViewport,true,`iPhone ${width}: حاوية اللوحة كاملة داخل الشاشة.`);
    assert.deepEqual(boardAudit.counts,{heads:8,cells:48},`iPhone ${width}: كل الفئات والخانات موجودة.`);
    assert.ok(boardAudit.smallestCell>=44,`iPhone ${width}: أصغر خانة تحافظ على هدف لمس 44 نقطة.`);
    assert.equal(boardAudit.contentContained,true,`iPhone ${width}: ماكو خانة مقصوصة خارج محتوى اللوحة.`);
    assert.equal(boardAudit.aligned,true,`iPhone ${width}: عنوان كل فئة بمحاذاة عمودها.`);
    assert.match(boardAudit.hint,/اسحب اللوحة يمين ويسار/,`iPhone ${width}: تعليمات التمرير واضحة.`);
    await page.close();
    console.log(`✓ iPhone ${width}: ثمان فئات كاملة داخل لوحة قابلة للتمرير`);
  }
  for(const width of [375,390]){
    const page=await browser.newPage({viewport:{width,height:844},reducedMotion:'reduce'});
    await page.goto(url);
    const teamAudit=await page.evaluate(()=>{
      state.teams=[
        {name:'فريق النجوم الذهبية',score:100,ll:3,used:new Set(),idx:0,bombUsed:false},
        {name:'فريق الأبطال الكبار',score:200,ll:3,used:new Set(),idx:1,bombUsed:false},
        {name:'فريق الصقور السريعة',score:300,ll:3,used:new Set(),idx:2,bombUsed:false},
      ];
      state.teamCount=3; state.turn=0;
      renderTeamsBar(); go('s-board');
      const bar=document.getElementById('teams-bar');
      const chips=[...bar.querySelectorAll('.team-chip')];
      const buttons=[...bar.querySelectorAll('.score-adj button')];
      return {
        pageOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,
        threeTeams:bar.classList.contains('three-teams'),
        counts:{chips:chips.length,buttons:buttons.length},
        targets:buttons.map(button=>{
          const rect=button.getBoundingClientRect();
          return {width:rect.width,height:rect.height};
        }),
        contained:buttons.every(button=>{
          const rect=button.getBoundingClientRect();
          const chip=button.closest('.team-chip').getBoundingClientRect();
          return rect.left>=chip.left-1&&rect.right<=chip.right+1&&rect.top>=chip.top-1&&rect.bottom<=chip.bottom+1;
        }),
        insideViewport:chips.every(chip=>{
          const rect=chip.getBoundingClientRect();
          return rect.left>=-1&&rect.right<=innerWidth+1;
        }),
      };
    });
    assert.ok(teamAudit.pageOverflow<=1,`iPhone ${width}: شريط 3 فرق ما يسبب تجاوزاً أفقياً.`);
    assert.equal(teamAudit.threeTeams,true,`iPhone ${width}: يُفعّل تنسيق الفرق الثلاثة.`);
    assert.deepEqual(teamAudit.counts,{chips:3,buttons:6},`iPhone ${width}: كل الفرق وأزرار النقاط ظاهرة.`);
    assert.equal(teamAudit.contained,true,`iPhone ${width}: أزرار النقاط ما تنقص خارج بطاقة الفريق.`);
    assert.equal(teamAudit.insideViewport,true,`iPhone ${width}: بطاقات الفرق الثلاثة داخل الشاشة.`);
    assert.equal(teamAudit.targets.every(target=>target.width>=44&&target.height>=44),true,`iPhone ${width}: كل أزرار النقاط تحافظ على 44×44.`);
    await page.close();
    console.log(`✓ iPhone ${width}: ثلاثة فرق وأزرار نقاط كاملة داخل الشاشة`);
  }
  {
    const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
    await page.goto(url);
    const categoryVisuals=await page.evaluate(async()=>{
      await ensureQuestionBank();
      state.teamCount=2;
      state.teams=[{name:'الأول',idx:0},{name:'الثاني',idx:1}];
      state.catCount=2; state.pickSplit=[1,1]; state.pickTurn=0; state.pickedByTeam=[0,0];
      go('s-cats'); renderCats();
      const cards=[...document.querySelectorAll('#cat-grid .cat-pick')];
      const visuals=Object.entries(CAT_VISUALS).map(([category,visual])=>({category,...visual,...categoryVisual(category)}));
      const history=cards.find(card=>card.dataset.category==='تاريخ');
      const islamic=cards.find(card=>card.dataset.category==='إسلاميات');
      const hiddenIslamicSources=ISLAMIC_SOURCE_CATEGORIES.filter(category=>cards.some(card=>card.dataset.category===category));
      const iconRect=history.querySelector('.ci').getBoundingClientRect();
      cards.forEach(card=>{ card.style.fontSize='30px'; });
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const scaledTextContained=cards.every(card=>{
        const cardRect=card.getBoundingClientRect();
        const name=card.querySelector('.cat-name');
        const nameRect=name.getBoundingClientRect();
        return nameRect.left>=cardRect.left-1&&nameRect.right<=cardRect.right+1
          &&name.scrollWidth<=name.clientWidth+1&&name.scrollHeight<=name.clientHeight+1;
      });
      const homeTitle=document.querySelector('#s-home [data-screen-title]');
      homeTitle.setAttribute('tabindex','-1'); homeTitle.focus();
      return {
        defined:visuals.length,
        uniqueIcons:new Set(visuals.map(visual=>visual.icon)).size,
        invalidTones:visuals.filter(visual=>!CATEGORY_TONES[visual.tone]).map(visual=>visual.category),
        rendered:cards.length,
        selectableCount:ALL_CATS.length,
        missingStyle:cards.filter(card=>!card.dataset.icon||!card.dataset.tone||!card.style.getPropertyValue('--cat-accent')).map(card=>card.dataset.category),
        history:{icon:history.dataset.icon,tone:history.dataset.tone,accent:history.style.getPropertyValue('--cat-accent'),iconWidth:iconRect.width,iconHeight:iconRect.height},
        islamic:{exists:Boolean(islamic),icon:islamic?.dataset.icon||'',questionCount:QUESTION_BANK[ISLAMIC_CATEGORY]?.length||0,sourceCount:ISLAMIC_SOURCE_CATEGORIES.reduce((sum,category)=>sum+(QUESTION_BANK[category]?.length||0),0)},
        hiddenIslamicSources,
        cardsInsideViewport:cards.every(card=>{const rect=card.getBoundingClientRect();return rect.left>=-1&&rect.right<=innerWidth+1;}),
        scaledTextContained,
        categoryTouchAction:getComputedStyle(cards[0]).touchAction,
        viewportContent:document.querySelector('meta[name="viewport"]')?.content||'',
        titleOutline:getComputedStyle(homeTitle).outlineStyle,
      };
    });
    assert.equal(categoryVisuals.defined,47,'كل الفئات الداخلية وفئة إسلاميات المدمجة لها هوية بصرية صريحة.');
    assert.equal(categoryVisuals.uniqueIcons,categoryVisuals.defined,'كل فئة لها أيقونة مختلفة عن الثانية.');
    assert.deepEqual(categoryVisuals.invalidTones,[],'كل فئة مرتبطة بلون معتمد.');
    assert.equal(categoryVisuals.rendered,categoryVisuals.selectableCount,'كل الفئات المنشورة تظهر ببطاقاتها الملونة.');
    assert.deepEqual(categoryVisuals.missingStyle,[],'كل بطاقة معروضة تستلم أيقونتها ولونها.');
    assert.deepEqual(categoryVisuals.history,{icon:'📚',tone:'gold',accent:'#FFD24B',iconWidth:46,iconHeight:46},'التاريخ يظهر بكتب ذهبية داخل هدف بصري واضح.');
    assert.deepEqual(categoryVisuals.islamic,{exists:true,icon:'🕌',questionCount:categoryVisuals.islamic.sourceCount,sourceCount:categoryVisuals.islamic.sourceCount},'إسلاميات تظهر وحدها وتجمع كل أسئلة الفئات السبع.');
    assert.deepEqual(categoryVisuals.hiddenIslamicSources,[],'الفئات الإسلامية السبع القديمة ما تظهر منفصلة للاعب.');
    assert.equal(categoryVisuals.cardsInsideViewport,true,'كل بطاقات الفئات تبقى داخل حدود شاشة الآيفون.');
    assert.equal(categoryVisuals.scaledTextContained,true,'أسماء الفئات تبقى كاملة داخل البطاقات حتى مع تكبير الخط إلى 200٪.');
    assert.equal(categoryVisuals.categoryTouchAction,'manipulation','بطاقات الفئات تمنع تكبير الدبل تاب أثناء الضغط السريع.');
    assert.doesNotMatch(categoryVisuals.viewportContent,/user-scalable\s*=\s*no|maximum-scale\s*=\s*1/i,'يبقى pinch zoom متاحاً لإمكانية الوصول.');
    assert.equal(categoryVisuals.titleOutline,'none','عنوان فطنة ما يعرض خط التركيز البرمجي فوقه وتحته.');
    await page.close();
    console.log('✓ هوية ملونة ومختلفة لكل فئة، وعنوان فطنة بلا إطار تركيز مرئي');
  }
} finally {
  await browser.close();
}
