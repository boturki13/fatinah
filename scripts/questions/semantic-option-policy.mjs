// عائلات دلالية محافظة لسجلات الكويت في ويكي بيانات.
// نستخدم قائمة صريحة بدل التخمين من نص الاسم، ونتجاهل أي نوع غير معروف.
const KUWAIT_KIND_FAMILIES={
  'sports-organization':[
    'اتحاد كرة قدم','اللجنة الأولمبية الوطنية','منتخب كرة قدم في كأس العالم 1982',
    'نادي كرة قدم','فريق وطني لهوكي الجليد','فريق قاري','منتخب كرة قدم',
    'مجلس إداري رياضي','منتخب كرة طائرة وطني','فريق نادي الدراجات',
  ],
  'sports-event':[
    'موسم رياضي','حدث رياضي متكرر','نسخة حدث رياضي متكرر','دورة رياضية',
    'بلد في رياضة بارالمبية','بلد في منافسة رياضية','الكويت في كأس العالم',
  ],
  locality:[
    'قائمة محافظات الكويت','منطقة كويتية','قائمة مناطق الكويت','ضاحية','جزيرة','حي',
    'مستوطنة','مدينة','مقاطعة','مدينة قديمة','مدن الميناء',
  ],
};

const familyByKind=new Map(
  Object.entries(KUWAIT_KIND_FAMILIES).flatMap(([family,kinds])=>kinds.map(kind=>[kind,family])),
);

export function kuwaitKindSemanticFamily(kind){
  return familyByKind.get(String(kind||'').trim())||null;
}

export function kuwaitSemanticIndex(rows){
  const byItem=new Map(),byLabel=new Map();
  for(const row of rows){
    const kind=String(row?.kindLabel||'').trim(),family=kuwaitKindSemanticFamily(kind);
    if(!family)continue;
    if(!byItem.has(row.item))byItem.set(row.item,{kinds:new Set(),families:new Set()});
    byItem.get(row.item).kinds.add(kind);byItem.get(row.item).families.add(family);
    if(!byLabel.has(row.itemLabel))byLabel.set(row.itemLabel,{kinds:new Set(),families:new Set()});
    byLabel.get(row.itemLabel).kinds.add(kind);byLabel.get(row.itemLabel).families.add(family);
  }
  return {byItem,byLabel};
}

export function kuwaitSemanticKindDistractors(rows,target,index=kuwaitSemanticIndex(rows)){
  const targetKind=String(target?.kindLabel||'').trim(),targetFamily=kuwaitKindSemanticFamily(targetKind);
  if(!targetFamily)return [];
  const targetKinds=index.byItem.get(target.item)?.kinds||new Set([targetKind]);
  // نعرض تصنيفات من العائلة نفسها، ونستبعد كل تصنيفات الكيان نفسه لكي لا نصنع إجابتين صحيحتين.
  return rows.map(row=>String(row.kindLabel||'').trim()).filter(kind=>
    kuwaitKindSemanticFamily(kind)===targetFamily&&!targetKinds.has(kind),
  );
}
