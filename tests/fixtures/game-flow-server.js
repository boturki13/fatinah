window.__FATINAH_GAME_FLOW_UI_TEST__=true;
{
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
}
