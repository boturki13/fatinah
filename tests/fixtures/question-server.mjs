export const testCategories=['من أنا؟','كرتون وأنمي'];

export function testCatalog(bankVersion='test-bank'){
  return {schemaVersion:1,questionSchemaVersion:1,releaseReady:true,bankVersion,questionCount:180,
    categories:testCategories.map(name=>({name,questionCount:90,
      levels:{'1':15,'2':15,'3':15,'4':15,'5':15,'6':15}}))};
}

export function testRound(categories,bankVersion='test-bank'){
  return {schemaVersion:1,bankVersion,questions:Object.fromEntries(categories.map((category,categoryIndex)=>[
    category,Array.from({length:6},(_,levelIndex)=>[1,2].map(variant=>{
      const level=levelIndex+1;
      const suffix=`${String(categoryIndex+1).padStart(2,'0')}${String(level).padStart(2,'0')}${String(variant).padStart(16,'0')}`;
      const answer=`الإجابة ${categoryIndex+1}-${level}-${variant}`;
      return {id:`gq-${suffix}`,d:level,q:`ما الإجابة الاختبارية للفئة ${category} في المستوى ${level} للنسخة ${variant}؟`,
        o:[answer,`الخيار ب ${suffix}`,`الخيار ج ${suffix}`,`الخيار د ${suffix}`],
        source:{title:'مصدر اختباري',url:'https://example.com/source'},
        review:{status:'approved',reviewer:'Fatinah test gate',reviewedAt:'2026-09-05'}};
    })).flat(),
  ]))};
}

export function testReveal(questionId,categories=testCategories){
  const question=Object.values(testRound(categories).questions).flat().find(item=>item.id===questionId);
  return {questionId,a:0,answer:question?.o?.[0]||''};
}
