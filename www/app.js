let QUESTION_BANK = null;
let ALL_CATS = [];
let _questionBankReady = null;
const ISLAMIC_CATEGORY='إسلاميات';
const ISLAMIC_SOURCE_CATEGORIES=[
  'السيرة النبوية','فتوحات المسلمين','القرآن الكريم','الصحابة',
  'الخلفاء الراشدون','دين وسيرة','الأنبياء والرسل',
];
function installMergedRuntimeCategory(bank){
  const questions=ISLAMIC_SOURCE_CATEGORIES.flatMap(originCategory=>(bank[originCategory]||[])
    .map(question=>({...question,originCategory})));
  // غير قابلة للتعداد عمداً: أدوات التدقيق تراجع السجلات الأصلية مرة واحدة،
  // بينما اللعبة تقدر تطلب الفئة المدمجة مباشرة من غير مضاعفة العد أو المعرّفات.
  Object.defineProperty(bank,ISLAMIC_CATEGORY,{value:questions,enumerable:false,configurable:false});
  return bank;
}
function selectableRuntimeCategories(categories){
  const hidden=new Set(ISLAMIC_SOURCE_CATEGORIES);
  const visible=[];
  let inserted=false;
  categories.forEach(category=>{
    if(hidden.has(category)){
      if(!inserted){ visible.push(ISLAMIC_CATEGORY); inserted=true; }
      return;
    }
    visible.push(category);
  });
  if(!inserted&&ISLAMIC_SOURCE_CATEGORIES.some(category=>QUESTION_BANK?.[category])) visible.push(ISLAMIC_CATEGORY);
  return visible;
}
function ensureQuestionBank(){
  if(QUESTION_BANK) return Promise.resolve(QUESTION_BANK);
  if(_questionBankReady) return _questionBankReady;
  _questionBankReady=new Promise((resolve,reject)=>{
    const script=document.createElement('script');
    script.src='question-bank.js';
    script.async=true;
    script.onload=()=>{
      const bank=window.__QUESTION_BANK_DATA__;
      if(!bank || typeof bank!=='object'){
        reject(new Error('تعذر قراءة بنك الأسئلة'));
        return;
      }
      // لا يدخل هذا البنك إلا من مسار النشر الإداري بعد التحقق والمراجعة.
      // ملفه مستقل حتى يبقى البنك الأصلي متاحاً بالكامل عند عدم وجود اتصال.
      const approved=window.__APPROVED_QUESTION_BANK_DATA__||{};
      const imageBank=window.__IMAGE_QUESTION_BANK_DATA__||{};
      const combined={};
      new Set([...Object.keys(bank),...Object.keys(approved),...Object.keys(imageBank)]).forEach(category=>{
        combined[category]=[
          ...(Array.isArray(bank[category])?bank[category]:[]),
          ...(Array.isArray(approved[category])?approved[category]:[]),
          ...(Array.isArray(imageBank[category])?imageBank[category]:[]),
        ];
      });
      QUESTION_BANK=installMergedRuntimeCategory(normalizeQuestionBank(combined));
      const releasedImages=new Set(window.__RELEASED_IMAGE_CATEGORIES__||[]);
      ALL_CATS=selectableRuntimeCategories(Object.keys(combined))
        .filter(category=>!(QUESTION_BANK[category]||[]).some(question=>question.image)||releasedImages.has(category));
      delete window.__QUESTION_BANK_DATA__;
      delete window.__APPROVED_QUESTION_BANK_DATA__;
      resolve(QUESTION_BANK);
    };
    script.onerror=()=>reject(new Error('تعذر تحميل بنك الأسئلة'));
    document.head.appendChild(script);
  }).catch(error=>{
    _questionBankReady=null;
    throw error;
  });
  return _questionBankReady;
}
// تطبيق iOS يعمل من capacitor://localhost؛ لذلك يجب توجيه طلبات الخادم
// صراحةً إلى النطاق المنشور، لا إلى مصدر WebView المحلي.
const API_ORIGIN = window.Capacitor?.isNativePlatform?.() === true
  ? 'https://ata20.com'
  : '';
// الإصدار 1.3 لا يستعمل عقد 1.2 الضمني. نضع النسخة في المسار والرأس حتى
// لا يعيد وسيط شبكة أو CDN الطلب بالخطأ إلى v1 عند إسقاط أحدهما.
const API_CONTRACT_VERSION='2';
// سجلات WebView قد تظهر في Web Inspector أو سجلات الجهاز. لا نمرر إليها
// كائنات أخطاء Firebase/RevenueCat أو رسائل أو بريد أو هاتف أو token؛ نطبع
// حدثاً ثابتاً من قائمة داخلية فقط.
const CLIENT_LOG_EVENT_ALLOWLIST=new Set([
  'paywall.prices','auth.reauth.start','auth.reauth.apple',
  'auth.delete.reauthentication','auth.delete.capacitor',
  'auth.delete.web-reauthentication','auth.delete.web','auth.signout',
  'account.server-delete','auth.anonymous.disabled',
  'auth.anonymous.capacitor','auth.anonymous.web','profile.save',
  'auth.pending-link','messaging.received','messaging.opened',
  'messaging.token-received','messaging.token-ready','firebase.web-sdk',
  'auth.apple.capacitor','auth.apple.web','auth.google.capacitor',
  'auth.google.web','auth.phone.start','auth.phone.confirm',
  'auth.password-reset','auth.forgot-email','auth.email',
  'auth.native-user','auth.web-user','auth.email-verification',
  'auth.verification-refresh','revenuecat.keychain-read',
  'revenuecat.configure','revenuecat.logout','revenuecat.initialize',
  'revenuecat.status','revenuecat.offline-cache','question-bank.load',
  'account.unlink','revenuecat.deferred-startup',
]);
function logClientEvent(level,event){
  const safeEvent=CLIENT_LOG_EVENT_ALLOWLIST.has(event)?event:'application.event';
  const logger=level==='error'?console.error:level==='warn'?console.warn:console.info;
  try{ logger.call(console,`[Fatinah] ${safeEvent}`); }catch(_){ }
}
function versionedApiPath(path){
  const value=String(path||'');
  if(/^\/api\/v[12](?:\/|$)/.test(value)) return value;
  if(value==='/api') return `/api/v${API_CONTRACT_VERSION}`;
  if(value.startsWith('/api/')) return `/api/v${API_CONTRACT_VERSION}${value.slice(4)}`;
  return value;
}
function apiUrl(path){ return `${API_ORIGIN}${versionedApiPath(path)}`; }
let _appIntegrityReady=null;
function getFirebaseAppCheck(){
  try{ return window.Capacitor?.Plugins?.FirebaseAppCheck || null; }
  catch(_){ return null; }
}
async function initAppIntegrity(){
  if(_appIntegrityReady) return _appIntegrityReady;
  _appIntegrityReady=(async()=>{
    const appCheck=getFirebaseAppCheck();
    if(!appCheck) return false;
    await appCheck.setTokenAutoRefreshEnabled({enabled:true});
    return true;
  })().catch(error=>{
    recordNonFatal(error,'firebase.app-check.initialize');
    return false;
  });
  return _appIntegrityReady;
}
async function apiFetch(path, options={}){
  const headers=new Headers(options.headers||{});
  headers.set('X-Fatinah-API-Version',API_CONTRACT_VERSION);
  if(await initAppIntegrity()){
    try{
      const result=await getFirebaseAppCheck().getToken({forceRefresh:false});
      if(result?.token) headers.set('X-Firebase-AppCheck',result.token);
    }catch(error){
      // الخادم يبدأ بوضع المراقبة، لذا لا نوقف تسجيل الدخول أو اللعب أثناء
      // طرح App Attest التدريجي؛ يُسجّل الخطأ في Crashlytics للمراجعة.
      recordNonFatal(error,'firebase.app-check.token');
    }
  }
  return fetch(apiUrl(path),{...options,headers});
}
const APP_VERSION = '1.3';
let _hasActiveSubscription=false;
let _freeRoundAvailable=false;
let _freeRoundVerificationState='unknown'; // unknown | eligible | used
let _subscriptionResolved=false;
const TEAM_STYLES=[
  {name:"النجوم", color:"var(--t1)", bg:"var(--t1b)", dot:"#B794FF", solid:"#7C3AED"},
  {name:"الصقور", color:"var(--t2)", bg:"var(--t2b)", dot:"#4FE3C4", solid:"#10B9A4"},
  {name:"الفرسان", color:"var(--t3)", bg:"var(--t3b)", dot:"#FFB067", solid:"#FF6B35"},
];
const FIRE=[null,
  {bg:"linear-gradient(145deg,#FFDD6B,#FFC24B)", tx:"var(--fire1t)"},
  {bg:"linear-gradient(145deg,#FFBE5C,#FF9E2C)", tx:"var(--fire2t)"},
  {bg:"linear-gradient(145deg,#FF9159,#FF6B35)", tx:"#fff"},
  {bg:"linear-gradient(145deg,#FF6B82,#FF4D6A)", tx:"#fff"},
  {bg:"linear-gradient(145deg,#FF4D93,#F42B7C)", tx:"#fff"},
  {bg:"linear-gradient(145deg,#D63BC4,#C026A8)", tx:"#fff"},
];
const POINTS=[0,100,200,300,400,500,600];
const CATEGORY_TONES={
  gold:{accent:'#FFD24B',tint:'rgba(255,210,75,.15)',border:'rgba(255,210,75,.42)'},
  orange:{accent:'#FF9E4A',tint:'rgba(255,158,74,.15)',border:'rgba(255,158,74,.42)'},
  coral:{accent:'#FF756B',tint:'rgba(255,117,107,.15)',border:'rgba(255,117,107,.42)'},
  pink:{accent:'#FF5C93',tint:'rgba(255,92,147,.15)',border:'rgba(255,92,147,.42)'},
  purple:{accent:'#B794FF',tint:'rgba(183,148,255,.15)',border:'rgba(183,148,255,.42)'},
  indigo:{accent:'#8AA4FF',tint:'rgba(138,164,255,.15)',border:'rgba(138,164,255,.42)'},
  blue:{accent:'#54B8FF',tint:'rgba(84,184,255,.15)',border:'rgba(84,184,255,.42)'},
  cyan:{accent:'#4FE3E3',tint:'rgba(79,227,227,.15)',border:'rgba(79,227,227,.42)'},
  teal:{accent:'#4FE3C4',tint:'rgba(79,227,196,.15)',border:'rgba(79,227,196,.42)'},
  green:{accent:'#75E68A',tint:'rgba(117,230,138,.15)',border:'rgba(117,230,138,.42)'},
  lime:{accent:'#B7E65C',tint:'rgba(183,230,92,.15)',border:'rgba(183,230,92,.42)'},
  sand:{accent:'#E8BD82',tint:'rgba(232,189,130,.15)',border:'rgba(232,189,130,.42)'},
};
const CAT_VISUALS={
  "إسلاميات":{icon:"🕌",tone:"teal"},
  "معلومات عامة":{icon:"💡",tone:"gold"},"رياضة":{icon:"⚽",tone:"green"},
  "تاريخ":{icon:"📚",tone:"gold"},"جغرافيا":{icon:"🌍",tone:"blue"},
  "أمثال":{icon:"🗣️",tone:"purple"},"ثقافة خليجية":{icon:"🐪",tone:"sand"},
  "دين وسيرة":{icon:"🕋",tone:"teal"},"علوم وتقنية":{icon:"🧪",tone:"cyan"},
  "محرّكات ومركبات":{icon:"🚗",tone:"coral"},"السيرة النبوية":{icon:"🌙",tone:"teal"},
  "القرآن الكريم":{icon:"📖",tone:"green"},"فتوحات المسلمين":{icon:"🛡️",tone:"sand"},
  "ألغاز وتحدّي ذكاء":{icon:"🧩",tone:"purple"},"الصحابة":{icon:"🤝",tone:"teal"},
  "الشعر العربي":{icon:"🪶",tone:"sand"},"الفضاء والكون":{icon:"🪐",tone:"indigo"},
  "حيوانات وطبيعة":{icon:"🦁",tone:"green"},"حضارات قديمة":{icon:"🏺",tone:"orange"},
  "جسم الإنسان":{icon:"🫀",tone:"pink"},"كأس العالم":{icon:"🏆",tone:"gold"},
  "أعلام الدول":{icon:"🌐",tone:"blue"},"خرائط دول":{icon:"🧭",tone:"cyan"},
  "إجابة سريعة":{icon:"⚡",tone:"lime"},"دوري أبطال أوروبا":{icon:"⭐",tone:"indigo"},
  "أنمي":{icon:"🦸",tone:"pink"},"كأس الخليج":{icon:"🥇",tone:"orange"},
  "مسلسلات خليجية":{icon:"📺",tone:"purple"},"أفلام عربية":{icon:"🎬",tone:"coral"},
  "الألعاب الأولمبية":{icon:"🔥",tone:"orange"},"أغاني خليجية":{icon:"🎤",tone:"pink"},
  "الخلفاء الراشدون":{icon:"☪️",tone:"teal"},"الأنبياء والرسل":{icon:"🕊️",tone:"cyan"},
  "اختراعات واكتشافات":{icon:"⚙️",tone:"gold"},"ألعاب الفيديو":{icon:"🎮",tone:"indigo"},
  "اللغة العربية":{icon:"🔤",tone:"purple"},"كتب وروايات":{icon:"📕",tone:"coral"},
  "مطابخ العالم":{icon:"🍲",tone:"orange"},"وش الرابط؟":{icon:"🔗",tone:"lime"},
  "تعرف على الصورة":{icon:"🖼️",tone:"pink"},"أعلام منو؟":{icon:"🚩",tone:"blue"},
  "وين هالمعلم؟":{icon:"📍",tone:"coral"},"شنو هالحيوان؟":{icon:"🐾",tone:"green"},
  "شنو بالفضاء؟":{icon:"🔭",tone:"indigo"},"شنو هالشي؟":{icon:"🔎",tone:"cyan"},
  "كنوز الحضارات":{icon:"🗿",tone:"sand"},"منو هاللاعب؟":{icon:"👟",tone:"lime"},
};
const CAT_ICONS=Object.fromEntries(Object.entries(CAT_VISUALS).map(([category,visual])=>[category,visual.icon]));
function categoryVisual(category){
  const visual=CAT_VISUALS[category]||{icon:'👨‍👩‍👧‍👦',tone:'purple'};
  return {...visual,...(CATEGORY_TONES[visual.tone]||CATEGORY_TONES.purple)};
}
// تصنيف الفئات إلى مجموعات للفلترة
const CAT_GROUPS={
  "إسلاميات":[ISLAMIC_CATEGORY],
  "معرفة وعلوم":["معلومات عامة","علوم وتقنية","الفضاء والكون","جسم الإنسان","اختراعات واكتشافات","تعرف على الصورة","شنو بالفضاء؟","شنو هالشي؟"],
  "تاريخ وجغرافيا":["تاريخ","جغرافيا","حضارات قديمة","أعلام الدول","خرائط دول","أعلام منو؟","وين هالمعلم؟","كنوز الحضارات"],
  "رياضة":["رياضة","كأس العالم","دوري أبطال أوروبا","كأس الخليج","الألعاب الأولمبية","منو هاللاعب؟"],
  "محرّكات":["محرّكات ومركبات"],
  "ثقافة وتراث":["ثقافة خليجية","أمثال","مسلسلات خليجية","أغاني خليجية","مطابخ العالم"],
  "ألغاز وذكاء":["ألغاز وتحدّي ذكاء","إجابة سريعة","وش الرابط؟"],
  "فنون وأدب":["الشعر العربي","أنمي","أفلام عربية","ألعاب الفيديو","اللغة العربية","كتب وروايات"],
  "طبيعة وحيوانات":["حيوانات وطبيعة","شنو هالحيوان؟"],
};
const GROUP_ICONS={"إسلاميات":"🕌","معرفة وعلوم":"🧠","تاريخ وجغرافيا":"🏛️","رياضة":"⚽","محرّكات":"🏎️","ثقافة وتراث":"🐪","ألغاز وذكاء":"🧩","فنون وأدب":"📜","طبيعة وحيوانات":"🦁"};

// هوية العرض الكويتية: تبقى مفاتيح البنك والنصوص المراجَعة كما هي، وتتغير
// الصياغة عند العرض فقط. هذا يحافظ على معرّفات الأسئلة والمصادر وسجل المراجعة،
// كما يترك أسئلة العائلة التي كتبها المستخدم من دون أي تعديل.
function displayCategoryName(name){
  return name==='وش الرابط؟' ? 'شنو الرابط؟' : String(name||'');
}
function toKuwaitiQuestionText(text){
  let result=String(text||'').trim();
  const prefixes=[
    [/^وش\s+/u,'شنو '],
    [/^مين\s+/u,'منو '],
    [/^(?:إيش|أيش|ايش)\s+/u,'شنو '],
    [/^ما هو\s+/u,'شنو '],
    [/^ما هي\s+/u,'شنو '],
    [/^ما اسم\s+/u,'شنو اسم '],
    [/^ما الذي\s+/u,'شنو اللي '],
    [/^ما التي\s+/u,'شنو اللي '],
    [/^ماذا\s+/u,'شنو '],
    [/^ما\s+/u,'شنو '],
    [/^من هو\s+/u,'منو '],
    [/^من هي\s+/u,'منو '],
    [/^من الذي\s+/u,'منو اللي '],
    [/^من التي\s+/u,'منو اللي '],
    [/^من\s+/u,'منو '],
    [/^أين\s+/u,'وين '],
    [/^كيف\s+/u,'شلون '],
    [/^لماذا\s+/u,'ليش '],
    [/^كم\s+/u,'جم '],
    [/^أكمل\s+/u,'كمّل '],
    [/^اذكر\s+/u,'قول '],
  ];
  for(const [pattern,replacement] of prefixes){
    if(pattern.test(result)){
      result=result.replace(pattern,replacement);
      break;
    }
  }
  const words=[
    [/(^|\s)وش(?=\s|[؟?!،,.])/gu,'$1شنو'],
    [/(^|\s)مين(?=\s|[؟?!،,.])/gu,'$1منو'],
    [/(^|\s)(?:إيش|أيش|ايش)(?=\s|[؟?!،,.])/gu,'$1شنو'],
    [/(^|\s)أين(?=\s|[؟?!،,.])/gu,'$1وين'],
    [/(^|\s)كيف(?=\s|[؟?!،,.])/gu,'$1شلون'],
    [/(^|\s)لماذا(?=\s|[؟?!،,.])/gu,'$1ليش'],
    [/(^|\s)كم(?=\s|[؟?!،,.])/gu,'$1جم'],
    [/(^|\s)اختر(?=\s|[؟?!،,.])/gu,'$1اختار'],
  ];
  for(const [pattern,replacement] of words) result=result.replace(pattern,replacement);
  return result;
}
function displayQuestionText(question){
  if(!question) return '';
  return question.id ? toKuwaitiQuestionText(question.q) : String(question.q||'');
}

let state={teamCount:2, catCount:6, difficulty:'normal', teams:[], cats:[], turn:0, cells:{}, answered:0, cur:null,
  timer:null, timeLeft:60, paused:false, searchTimer:null, searchTimeLeft:0, answering:true, roundActive:false};

// ────────── التخزين الدائم
// أولوية: Capacitor Preferences (تخزين أصلي داخل تطبيق iOS) إن توفّر، وإلا localStorage (يعمل في المتصفح وداخل WKWebView أيضاً).
// هذا يحل مشكلة فقدان كل البيانات عند إغلاق التطبيق.
const STORAGE_PREFIX='fatinah_';
// ────────── XSS sanitizer
function esc(str){ const d=document.createElement('div'); d.textContent=String(str||''); return d.innerHTML; }
function isHttpsUrl(value){
  try{ return new URL(String(value||'')).protocol==='https:'; }
  catch(_){ return false; }
}
function storeGet(key, fallback){
  try{
    const raw=localStorage.getItem(STORAGE_PREFIX+key);
    if(raw!=null) return JSON.parse(raw);
  }catch(e){ /* وضع تصفّح خاص أو تخزين معطّل — نستخدم الافتراضي */ }
  return fallback;
}
function storeSet(key, value){
  try{ localStorage.setItem(STORAGE_PREFIX+key, JSON.stringify(value)); }catch(e){}
  // مزامنة اختيارية مع Capacitor Preferences الأصلي إن توفّر (لا تحجب الحفظ الفوري في localStorage)
  try{
    const P=window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences;
    if(P) P.set({key:STORAGE_PREFIX+key, value:JSON.stringify(value)});
  }catch(e){}
}
function storeRemove(key){
  try{ localStorage.removeItem(STORAGE_PREFIX+key); }catch(e){}
  try{
    const P=window.Capacitor?.Plugins?.Preferences;
    if(P) void P.remove({key:STORAGE_PREFIX+key});
  }catch(e){}
}

// ────────── استكمال الجولة النشطة
// اللقطة مربوطة بالحساب ولا تحتوي عناصر DOM أو مؤقّتات. كل Set يتحول إلى
// مصفوفة، ثم يعاد بناؤه عند الاستعادة. الكتابة المحلية كل ثانية تحفظ العداد،
// بينما Preferences الأصلي يُحدّث عند الانتقالات المهمة وعند مغادرة التطبيق.
const ACTIVE_ROUND_SCHEMA_VERSION=1;
const ACTIVE_ROUND_MAX_AGE_MS=30*24*60*60*1000;
function activeRoundStorageKey(uid=window._currentUid||storeGet('authUid','')){
  return scopedAccessKey('active_round',uid);
}
function serializableCurrentQuestion(){
  const c=state.cur;
  if(!c||!c.q) return null;
  return {
    col:c.col,r:c.r,key:c.key,cat:c.cat,d:c.d,q:c.q,points:c.points,
    isBomb:Boolean(c.isBomb),bombThrower:c.bombThrower??null,bombTarget:c.bombTarget??null,
    phase:c.phase||'owner',doubledForTeam:c.doubledForTeam??null,
    searchedForTeam:c.searchedForTeam??null,owner:c.owner??null,
    stealQueue:Array.isArray(c.stealQueue)?c.stealQueue:[],stealPos:Number.isInteger(c.stealPos)?c.stealPos:-1,
    eligibleTeams:[...(c.eligibleTeams||[])],passedToOpp:Boolean(c.passedToOpp),
    revealed:Boolean(c.revealed),searching:Boolean(c.searching),resolved:Boolean(c.resolved),
  };
}
function activeRoundSnapshot(){
  const uid=String(window._currentUid||storeGet('authUid','')||'');
  if(!uid||!state.roundActive||!state.startedAt||!state.teams.length||!state.cats.length) return null;
  return {
    schemaVersion:ACTIVE_ROUND_SCHEMA_VERSION,appVersion:APP_VERSION,ownerUid:uid,savedAt:Date.now(),
    elapsedSeconds:Math.max(0,Math.round((Date.now()-state.startedAt)/1000)),
    teamCount:state.teamCount,catCount:state.catCount,difficulty:state.difficulty,
    teams:state.teams.map(team=>({
      name:team.name,score:team.score,ll:team.ll,used:[...(team.used||[])],idx:team.idx,bombUsed:Boolean(team.bombUsed),
    })),
    cats:[...state.cats],familyRoundName:state.familyRound?.name||null,
    turn:state.turn,cells:Object.fromEntries(Object.entries(state.cells).map(([key,value])=>[key,{used:Boolean(value?.used)}])),
    answered:state.answered,totalQuestions:state.totalQuestions,
    roundCorrect:state.roundCorrect||0,roundIncorrect:state.roundIncorrect||0,
    isFreeRound:Boolean(state.isFreeRound),completedFreeRound:Boolean(state.completedFreeRound),
    usedQuestions:[...(state.usedQ||[])],usedQuestionIds:[...(state.usedQuestionIds||[])],
    roundQuestionBank:Object.fromEntries(Object.entries(roundQuestionBank).map(([category,questions])=>[category,questions])),
    current:serializableCurrentQuestion(),timeLeft:state.timeLeft,maxTime:state.maxTime,
    paused:Boolean(state.paused),searchTimeLeft:state.searchTimeLeft||0,
  };
}
function persistActiveRound(syncNative=true){
  const snapshot=activeRoundSnapshot();
  if(!snapshot) return false;
  const key=activeRoundStorageKey(snapshot.ownerUid);
  const serialized=JSON.stringify(snapshot);
  let saved=false;
  try{
    localStorage.setItem(STORAGE_PREFIX+key,serialized);
    saved=true;
  }catch(error){ recordNonFatal(error,'game.persist.local'); }
  if(syncNative){
    try{
      const P=window.Capacitor?.Plugins?.Preferences;
      if(P){
        const write=P.set({key:STORAGE_PREFIX+key,value:serialized});
        saved=true;
        if(write?.catch) void write.catch(error=>recordNonFatal(error,'game.persist.native'));
      }
    }catch(error){ recordNonFatal(error,'game.persist.native'); }
  }
  return saved;
}
function clearActiveRound(uid=window._currentUid||storeGet('authUid','')){
  if(uid) storeRemove(activeRoundStorageKey(uid));
}
function validSavedRound(snapshot,uid){
  if(!snapshot||snapshot.schemaVersion!==ACTIVE_ROUND_SCHEMA_VERSION||snapshot.ownerUid!==String(uid||'')) return false;
  const age=Date.now()-Number(snapshot.savedAt);
  if(!Number.isFinite(age)||age< -5*60*1000||age>ACTIVE_ROUND_MAX_AGE_MS) return false;
  if(!['easy','normal','hard'].includes(snapshot.difficulty)) return false;
  if(!Array.isArray(snapshot.teams)||snapshot.teams.length<2||snapshot.teams.length>3) return false;
  if(!Array.isArray(snapshot.cats)||snapshot.cats.length<1||snapshot.cats.length>8) return false;
  if(!Number.isInteger(snapshot.turn)||snapshot.turn<0||snapshot.turn>=snapshot.teams.length) return false;
  if(!Number.isInteger(snapshot.answered)||snapshot.answered<0) return false;
  return snapshot.teams.every(team=>typeof team?.name==='string'&&Number.isFinite(team.score)
    &&Number.isInteger(team.ll)&&team.ll>=0&&Array.isArray(team.used)&&Number.isInteger(team.idx));
}
function findRestoredQuestion(current){
  if(!current?.q) return null;
  if(current.q.id){
    return questionsForRoundCategory(current.cat).find(question=>question.id===current.q.id)||null;
  }
  const family=state.familyRound||(familyCats||[]).find(category=>category.name===current.cat);
  return family?.questions?.find(question=>question.q===current.q.q)||null;
}
function applySavedBoardCells(savedCells){
  const buttons=[...document.querySelectorAll('#board .cell')];
  Object.entries(savedCells||{}).forEach(([key,value])=>{
    if(!state.cells[key]||value?.used!==true) return;
    const [col,level]=key.split('-').map(Number);
    const button=buttons[(level-1)*state.cats.length+col];
    if(button) markBoardCellUsed(button,key);
  });
}
async function renderRestoredQuestion(snapshot){
  const c=state.cur;
  const badge=document.getElementById('q-badge');
  if(c.isBomb){
    badge.textContent='💣 '+(isFamilyCat(c.cat)?c.cat:displayCategoryName(c.cat));
    badge.style.background='#8b1a3d'; badge.style.color='#fff';
    document.getElementById('q-points').textContent='±1200 نقطة';
  }else{
    badge.textContent=isFamilyCat(c.cat)?c.cat:displayCategoryName(c.cat);
    badge.style.background=FIRE[c.r].bg; badge.style.color=FIRE[c.r].tx;
  }
  setQuestionPrompt(c.q);
  await renderQuestionImage(c.q,{allowFallback:true});
  setQuestionAnswer(c.q);
  setAnswerRevealed(c.phase==='reveal');
  document.getElementById('search-timer').classList.remove('show');
  const pauseButton=document.getElementById('pause-btn');
  pauseButton.disabled=false; pauseButton.style.opacity='1';
  if(c.isBomb){
    setPhasePill(c.phase==='reveal'?-1:c.bombTarget,c.phase==='reveal'?'شنو النتيجة؟':'💣 قنبلة! دور فريق '+state.teams[c.bombTarget].name+' — يجاوب شفهياً');
  }else if(c.phase==='owner'){
    setPhasePill(c.owner,'دور فريق '+state.teams[c.owner].name+' — يجاوب شفهياً');
    updateQuestionPoints(c.owner);
  }else if(c.phase==='steal'){
    const teamIndex=c.stealQueue[c.stealPos];
    setPhasePill(teamIndex,'سرقة! دور فريق '+state.teams[teamIndex].name+' — '+Math.max(1,Number(snapshot.timeLeft)||1)+' ثانية');
    updateQuestionPoints(teamIndex);
  }else{
    setPhasePill(-1,'منو جاوب صح؟ اختار الفريق');
  }
  setQuestionPhaseLayout(c.phase);
  renderFlow(); renderLifelines(); keepAwakeOn(); showQuestionScreen();
  if(c.phase==='reveal'){
    clearInterval(state.timer); state.paused=false; setQuestionHidden(false); focusRevealedAnswer();
  }else{
    showTimer(Math.max(1,Number(snapshot.timeLeft)||1),{
      maxTime:Math.max(1,Number(snapshot.maxTime)||Number(snapshot.timeLeft)||1),
      paused:Boolean(snapshot.paused),
    });
    if(c.searching) startSearchCountdown(Math.max(1,Number(snapshot.searchTimeLeft)||1));
    else setQuestionHidden(Boolean(snapshot.paused));
  }
}
async function restoreActiveRound(uid){
  const key=activeRoundStorageKey(uid);
  const snapshot=storeGet(key,null);
  if(!validSavedRound(snapshot,uid)){
    if(snapshot) clearActiveRound(uid);
    return false;
  }
  let skippedMissingQuestion=false;
  try{
    await ensureQuestionBank();
    const familyRound=snapshot.familyRoundName
      ? (familyCats||[]).find(category=>category.name===snapshot.familyRoundName)
      : null;
    if(snapshot.familyRoundName&&!familyRound) throw new Error('saved family category is missing');
    if(snapshot.cats.some(category=>!QUESTION_BANK?.[category]&&!(familyCats||[]).some(item=>item.name===category))){
      throw new Error('saved category is missing');
    }
    state.teamCount=snapshot.teams.length;
    state.catCount=snapshot.cats.length;
    state.difficulty=snapshot.difficulty;
    state.teams=snapshot.teams.map(team=>({...team,used:new Set(team.used)}));
    state.cats=[...snapshot.cats]; state.familyRound=familyRound||null;
    state.turn=snapshot.turn; state.answered=snapshot.answered;
    state.startedAt=Date.now()-Math.max(0,Number(snapshot.elapsedSeconds)||0)*1000;
    state.roundCorrect=Number(snapshot.roundCorrect)||0; state.roundIncorrect=Number(snapshot.roundIncorrect)||0;
    state.isFreeRound=Boolean(snapshot.isFreeRound); state.completedFreeRound=Boolean(snapshot.completedFreeRound);
    state.usedQ=new Set(snapshot.usedQuestions||[]); state.usedQuestionIds=new Set(snapshot.usedQuestionIds||[]);
    const savedRemoteBank=snapshot.roundQuestionBank;
    const savedRemoteCategories=savedRemoteBank&&typeof savedRemoteBank==='object'&&!Array.isArray(savedRemoteBank)
      ?Object.keys(savedRemoteBank):[];
    if(savedRemoteCategories.length&&!validRemoteRoundBank(savedRemoteBank,savedRemoteCategories)){
      throw new Error('saved remote question bank is invalid');
    }
    roundQuestionBank=Object.assign(Object.create(null),savedRemoteBank||{});
    state.cur=null; state.cells={}; state.roundActive=true;
    if(!(await prepareSelectedImageCategories())){
      const error=new Error('saved round images are unavailable');
      error.code='saved_round_images_unavailable';
      throw error;
    }
    buildBoard(); applySavedBoardCells(snapshot.cells); renderTeamsBar(); renderTurn(); go('s-board');
    if(snapshot.current){
      const question=findRestoredQuestion(snapshot.current);
      if(!state.cells[snapshot.current.key]||state.cells[snapshot.current.key].used){
        throw new Error('saved question no longer matches the board');
      }
      if(!question){
        skippedMissingQuestion=true;
        state.cur=null;
      }else{
        const [col,level]=snapshot.current.key.split('-').map(Number);
        const cell=document.querySelectorAll('#board .cell')[(level-1)*state.cats.length+col];
        state.cur={...snapshot.current,q:question,cell,eligibleTeams:new Set(snapshot.current.eligibleTeams||[]),token:0,resolved:false};
        state.timeLeft=Math.max(1,Number(snapshot.timeLeft)||1);
        state.maxTime=Math.max(1,Number(snapshot.maxTime)||state.timeLeft);
        state.paused=Boolean(snapshot.paused); state.searchTimeLeft=Math.max(0,Number(snapshot.searchTimeLeft)||0);
        await renderRestoredQuestion(snapshot);
      }
    }
    persistActiveRound(true);
    void trackMetric('game_resumed',{questionsAnswered:state.answered,questionOpen:Boolean(state.cur),freeRound:state.isFreeRound});
    showToast('↩️',skippedMissingQuestion?'حدّثنا السؤال':'رجّعنا جولتك',
      skippedMissingQuestion?'رجّعناك للوحة وحفظنا تقدمكم. اختاروا خانة وكملوا الجولة.':'كمّلوا من نفس المكان',false);
    return true;
  }catch(error){
    clearInterval(state.timer); clearInterval(state.searchTimer);
    state.roundActive=false; state.cur=null;
    if(error?.code==='saved_round_images_unavailable'){
      showToast('🖼️','ما قدرنا نرجّع صور الجولة','اتصل بالإنترنت وجرّب تفتح التطبيق مرة ثانية. حفظنا جولتك وما راح تضيع.',false);
    }else{
      clearActiveRound(uid);
      recordNonFatal(error,'game.restore');
    }
    return false;
  }
}
async function routeAfterAccessCheck(uid){
  updateFreeRoundUi(); hideSplash();
  if(await restoreActiveRound(uid)) return;
  go('s-home');
}

document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='hidden') persistActiveRound(true);
});
window.addEventListener('pagehide',()=>persistActiveRound(true));

async function hydrateNativePreferences(){
  const P=window.Capacitor?.Plugins?.Preferences;
  if(!P) return 0;
  try{
    const result=await P.keys();
    const keys=(result?.keys||[]).filter(key=>key.startsWith(STORAGE_PREFIX));
    let restored=0;
    for(const key of keys){
      if(localStorage.getItem(key)!=null) continue;
      const item=await P.get({key});
      if(item?.value==null) continue;
      // تحقق أن القيمة ما زالت JSON صالحاً قبل نسخها إلى مخزن WebView.
      JSON.parse(item.value);
      localStorage.setItem(key,item.value);
      restored++;
    }
    return restored;
  }catch(error){
    recordNonFatal(error,'preferences.hydrate');
    return 0;
  }
}

function scopedAccessKey(prefix,uid){
  const owner=String(uid||window._currentUid||storeGet('authUid','guest')||'guest')
    .replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,128);
  return `${prefix}_${owner}`;
}
function storageHas(key){
  try{ return localStorage.getItem(STORAGE_PREFIX+key)!==null; }
  catch(_){ return false; }
}
// الإصدارات السابقة خزّنت الإحصاءات والفئات العائلية بمفاتيح عامة للجهاز.
// ننسبها للحساب الموجود وقت الترقية مرة واحدة فقط؛ وإلا قد تُنسخ بيانات
// الحساب الأول إلى كل حساب جديد يستخدم الجهاز نفسه.
function migrateLegacyAccountData(uid){
  if(!uid) return;
  const legacyKeys=['stats','family'];
  const hasLegacy=legacyKeys.some(storageHas);
  let owner=storeGet('legacy_account_data_owner','');
  if(!owner&&hasLegacy){
    owner=String(uid);
    storeSet('legacy_account_data_owner',owner);
  }
  if(owner!==String(uid)) return;
  legacyKeys.forEach(key=>{
    const scopedKey=scopedAccessKey(key,uid);
    if(storageHas(scopedKey)||!storageHas(key)) return;
    storeSet(scopedKey,storeGet(key,key==='stats'?emptyStats():[]));
  });
}
function activateLocalAccount(uid){
  if(!uid){ stats=emptyStats(); familyCats=[]; return; }
  migrateLegacyAccountData(uid);
  stats=loadStats(uid);
  familyCats=loadFamily(uid);
}
function localFreeRoundCompleted(uid){
  return storeGet(scopedAccessKey('free_round_completed',uid),false)===true;
}
async function generateDeviceCheckToken(){
  const plugin=window.Capacitor?.Plugins?.FatinahDeviceIntegrity;
  if(!window.Capacitor?.isNativePlatform?.() || !plugin?.generateDeviceCheckToken){
    return '';
  }
  try{
    const result=await plugin.generateDeviceCheckToken();
    return String(result?.token||'');
  }catch(error){
    recordNonFatal(error,'device-check.token');
    return '';
  }
}
let _appAttestKeyId='';
let _appAttestEnrollment=null;
function getDeviceIntegrityPlugin(){
  try{ return window.Capacitor?.Plugins?.FatinahDeviceIntegrity||null; }
  catch(_){ return null; }
}
function appAttestErrorCode(error){
  return String(error?.code||'').trim();
}
function appAttestKeyNeedsReset(error){
  const code=appAttestErrorCode(error);
  return code==='APP_ATTEST_INVALID_KEY'||code==='APP_ATTEST_KEY_NOT_GENERATED';
}
async function resetAppAttestKeyForRecovery(plugin,error,recovery){
  if(!appAttestKeyNeedsReset(error)||recovery.resetAttempted||!plugin?.resetKey){
    return false;
  }
  recovery.resetAttempted=true;
  try{
    const result=await plugin.resetKey();
    if(result?.reset!==true) throw new Error('تعذّرت إعادة تعيين App Attest');
    _appAttestKeyId='';
    return true;
  }catch(resetError){
    recordNonFatal(resetError,'app-attest.reset');
    return false;
  }
}
function decodeBase64Bytes(value){
  const binary=atob(String(value||''));
  return Uint8Array.from(binary,char=>char.charCodeAt(0));
}
function encodeBase64Bytes(bytes){
  let binary='';
  const view=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  for(let offset=0;offset<view.length;offset+=0x8000){
    binary+=String.fromCharCode(...view.subarray(offset,offset+0x8000));
  }
  return btoa(binary);
}
async function sha256Bytes(bytes){
  if(!globalThis.crypto?.subtle) throw new Error('SHA-256 غير متاح');
  return new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
}
async function sha256Base64OfBase64(value){
  return encodeBase64Bytes(await sha256Bytes(decodeBase64Bytes(value)));
}
async function sha256HexText(value){
  const digest=await sha256Bytes(new TextEncoder().encode(String(value||'')));
  return [...digest].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
async function freeRoundRequestHash(uid,deviceCheckToken,deviceCheckUpdateToken=''){
  const canonical=JSON.stringify({
    deviceCheckTokenHash:await sha256HexText(deviceCheckToken),
    deviceCheckUpdateTokenHash:deviceCheckUpdateToken
      ?await sha256HexText(deviceCheckUpdateToken):'',
    uid:String(uid||''),
  });
  return sha256HexText(canonical);
}
async function requestAppAttestChallenge(uid,keyId,purpose,requestHash=''){
  const idToken=await getCurrentIdToken();
  if(!idToken) return null;
  const response=await apiFetch('/api/app-attest/challenge',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+idToken},
    body:JSON.stringify({uid,idToken,keyId,purpose,requestHash}),
  });
  if(!response.ok) return null;
  const data=await response.json();
  if(!data?.challengeId||!data?.clientData) return null;
  return data;
}
async function performAppAttestEnrollment(uid,plugin,recovery){
  const support=await plugin.isSupported?.();
  if(support?.isSupported!==true) return null;
  const generated=await plugin.generateKey();
  const keyId=String(generated?.keyId||'');
  if(!keyId) return null;
  const idToken=await getCurrentIdToken();
  if(!idToken) return null;
  const statusResponse=await apiFetch('/api/app-attest/status',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+idToken},
    body:JSON.stringify({uid,idToken,keyId}),
  });
  if(statusResponse.ok){
    const status=await statusResponse.json();
    if(status?.attested===true){ _appAttestKeyId=keyId; return keyId; }
  }
  const challenge=await requestAppAttestChallenge(uid,keyId,'attest');
  if(!challenge) return null;
  const clientDataHash=await sha256Base64OfBase64(challenge.clientData);
  let artifact;
  try{
    artifact=await plugin.attestKey({keyId,clientDataHash});
  }catch(error){
    if(await resetAppAttestKeyForRecovery(plugin,error,recovery)){
      return performAppAttestEnrollment(uid,plugin,recovery);
    }
    throw error;
  }
  const attestationObject=String(artifact?.attestationObject||'');
  if(!attestationObject) return null;
  const response=await apiFetch('/api/app-attest/attest',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+idToken},
    body:JSON.stringify({
      uid,idToken,keyId,challengeId:challenge.challengeId,attestationObject,
    }),
  });
  if(!response.ok) return null;
  _appAttestKeyId=keyId;
  return keyId;
}
async function ensureAppAttestEnrollment(uid,recovery={resetAttempted:false}){
  const plugin=getDeviceIntegrityPlugin();
  if(!window.Capacitor?.isNativePlatform?.()||!plugin?.generateKey||!plugin?.attestKey){
    return null;
  }
  if(_appAttestKeyId) return _appAttestKeyId;
  if(_appAttestEnrollment) return _appAttestEnrollment;
  _appAttestEnrollment=performAppAttestEnrollment(uid,plugin,recovery).catch(error=>{
    recordNonFatal(error,'app-attest.enroll');
    return null;
  }).finally(()=>{ _appAttestEnrollment=null; });
  return _appAttestEnrollment;
}
async function createAppAttestAssertion(
  uid,purpose,requestHash='',recovery={resetAttempted:false}){
  const plugin=getDeviceIntegrityPlugin();
  const keyId=await ensureAppAttestEnrollment(uid,recovery);
  if(!keyId||!plugin?.generateAssertion) return null;
  try{
    const challenge=await requestAppAttestChallenge(
      uid,keyId,purpose,requestHash);
    if(!challenge) return null;
    const clientDataHash=await sha256Base64OfBase64(challenge.clientData);
    const artifact=await plugin.generateAssertion({keyId,clientDataHash});
    const assertion=String(artifact?.assertion||'');
    if(!assertion) return null;
    return {keyId,challengeId:challenge.challengeId,assertion,requestHash};
  }catch(error){
    if(await resetAppAttestKeyForRecovery(plugin,error,recovery)){
      return createAppAttestAssertion(uid,purpose,requestHash,recovery);
    }
    recordNonFatal(error,`app-attest.assertion.${purpose}`);
    return null;
  }
}
function setFreeRoundAvailability(value){
  _freeRoundAvailable=value===true;
  _freeRoundVerificationState=value===true?'eligible':(value===false?'used':'unknown');
  updateFreeRoundUi();
}
function updateFreeRoundUi(){
  const banner=document.getElementById('free-round-banner');
  if(!banner) return;
  if(_hasActiveSubscription){ banner.hidden=true; return; }
  banner.hidden=false;
  banner.textContent=_freeRoundVerificationState==='eligible'
    ? '🎁 أول جولة عليك بالكامل — شاشة الاشتراك ما تطلع إلا عقب ما تخلّصها'
    : (_freeRoundVerificationState==='used'
      ? '✓ خلصت جولتك المجانية — اشترك عشان تفتح جولات بلا حدود'
      : '⏳ نحتاج اتصال بالإنترنت عشان نتحقق من جولتك المجانية');
}
async function syncFreeRoundCompletion(uid){
  if(!uid||!localFreeRoundCompleted(uid)) return false;
  const [idToken,deviceCheckToken,deviceCheckUpdateToken]=await Promise.all([
    getCurrentIdToken(),generateDeviceCheckToken(),generateDeviceCheckToken(),
  ]);
  if(!idToken||!deviceCheckToken||!deviceCheckUpdateToken) return false;
  const requestHash=await freeRoundRequestHash(
    uid,deviceCheckToken,deviceCheckUpdateToken);
  const appAttest=await createAppAttestAssertion(
    uid,'free_round_complete',requestHash);
  if(window.Capacitor?.isNativePlatform?.()&&!appAttest) return false;
  try{
    const response=await apiFetch('/api/free-round/complete',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+idToken},
      body:JSON.stringify({
        uid,idToken,deviceCheckToken,deviceCheckUpdateToken,
        appAttestKeyId:appAttest?.keyId||'',
        appAttestChallengeId:appAttest?.challengeId||'',
        appAttestAssertion:appAttest?.assertion||'',
        appAttestRequestHash:requestHash,
      }),
    });
    if(response.ok||response.status===409){
      storeSet(scopedAccessKey('free_round_sync_pending',uid),false);
      return response.ok;
    }
  }catch(_){ /* يبقى العلم محلياً ويُعاد عند الإقلاع القادم */ }
  return false;
}
async function freeRoundIsAvailable(uid){
  if(localFreeRoundCompleted(uid)){
    if(storeGet(scopedAccessKey('free_round_sync_pending',uid),false)){
      void syncFreeRoundCompletion(uid);
    }
    return false;
  }
  const [idToken,deviceCheckToken]=await Promise.all([
    getCurrentIdToken(),generateDeviceCheckToken(),
  ]);
  if(!idToken||!deviceCheckToken) return null;
  const requestHash=await freeRoundRequestHash(uid,deviceCheckToken);
  const appAttest=await createAppAttestAssertion(
    uid,'free_round_status',requestHash);
  if(window.Capacitor?.isNativePlatform?.()&&!appAttest) return null;
  try{
    const response=await apiFetch(`/api/free-round/status?uid=${encodeURIComponent(uid||'')}`,{
      headers:{
        'Authorization':'Bearer '+idToken,
        'X-DeviceCheck-Token':deviceCheckToken,
        'X-App-Attest-Key-Id':appAttest?.keyId||'',
        'X-App-Attest-Challenge-Id':appAttest?.challengeId||'',
        'X-App-Attest-Assertion':appAttest?.assertion||'',
        'X-App-Attest-Request-Hash':requestHash,
      },
    });
    if(response.ok){
      const data=await response.json();
      if(data.completed===true){
        storeSet(scopedAccessKey('free_round_completed',uid),true);
        return false;
      }
      return data.eligible===true;
    }
  }catch(_){ /* وضع دون اتصال: علم الجهاز يمنع إعادة الجولة */ }
  return null;
}
async function claimFreeRound(uid){
  if(_hasActiveSubscription) return false;
  if(!_freeRoundAvailable||_freeRoundVerificationState!=='eligible') return false;
  const [idToken,deviceCheckToken,deviceCheckUpdateToken]=await Promise.all([
    getCurrentIdToken(),generateDeviceCheckToken(),generateDeviceCheckToken(),
  ]);
  if(!idToken||!deviceCheckToken||!deviceCheckUpdateToken) return null;
  const requestHash=await freeRoundRequestHash(
    uid,deviceCheckToken,deviceCheckUpdateToken);
  const appAttest=await createAppAttestAssertion(
    uid,'free_round_complete',requestHash);
  if(window.Capacitor?.isNativePlatform?.()&&!appAttest) return null;
  try{
    const response=await apiFetch('/api/free-round/complete',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+idToken},
      body:JSON.stringify({
        uid,idToken,deviceCheckToken,deviceCheckUpdateToken,
        appAttestKeyId:appAttest?.keyId||'',
        appAttestChallengeId:appAttest?.challengeId||'',
        appAttestAssertion:appAttest?.assertion||'',
        appAttestRequestHash:requestHash,
      }),
    });
    if(response.ok){
      storeSet(scopedAccessKey('free_round_completed',uid),true);
      storeSet(scopedAccessKey('free_round_sync_pending',uid),false);
      setFreeRoundAvailability(false);
      return true;
    }
    if(response.status===409){
      storeSet(scopedAccessKey('free_round_completed',uid),true);
      storeSet(scopedAccessKey('free_round_sync_pending',uid),false);
      setFreeRoundAvailability(false);
      return false;
    }
  }catch(error){
    recordNonFatal(error,'free-round.claim');
  }
  return null;
}
async function completeFreeRound(){
  if(_hasActiveSubscription||!state.isFreeRound||state.completedFreeRound) return;
  state.completedFreeRound=true;
  setFreeRoundAvailability(false);
  updateFreeRoundUi();
  void trackMetric('free_round_completed',{questions:state.answered||0});
}
function metricEventId(){
  try{ if(crypto.randomUUID) return crypto.randomUUID(); }catch(_){ }
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2,14)}`;
}
function metricOutboxKey(uid=window._currentUid||storeGet('authUid','')){
  return scopedAccessKey('metric_outbox',uid);
}
function enqueueMetricEvent(payload){
  const outbox=storeGet(metricOutboxKey(payload.uid),[]);
  if(!outbox.some(item=>item.eventId===payload.eventId)) outbox.push(payload);
  // حد محلي يمنع نمو التخزين بلا نهاية عند جهاز ظل بلا اتصال فترة طويلة.
  storeSet(metricOutboxKey(payload.uid),outbox.slice(-500));
}
let metricFlushInFlight=null;
async function flushMetricEvents(){
  const uid=window._currentUid||storeGet('authUid','');
  if(!uid) return false;
  if(metricFlushInFlight?.uid===uid) return metricFlushInFlight.promise;
  const promise=(async()=>{
    const idToken=await getCurrentIdToken();
    if(!idToken) return false;
    let delivered=false;
    for(let attempt=0;attempt<100;attempt++){
      const current=storeGet(metricOutboxKey(uid),[]);
      const item=current[0];
      if(!item) return delivered||true;
      let response;
      try{
        response=await apiFetch('/api/metrics/event',{
          method:'POST',
          headers:{'Content-Type':'application/json','Authorization':'Bearer '+idToken},
          body:JSON.stringify({...item,idToken}),
        });
      }catch(_){ return delivered; }
      // أخطاء البيانات الدائمة لا يجوز أن تسمّم الصف وتمنع الأحداث التالية.
      if(!response.ok && ![400,413,422].includes(response.status)) return delivered;
      const latest=storeGet(metricOutboxKey(uid),[]);
      storeSet(metricOutboxKey(uid),latest.filter(event=>event.eventId!==item.eventId));
      delivered=delivered||response.ok;
    }
    return delivered;
  })();
  metricFlushInFlight={uid,promise};
  try{ return await promise; }
  finally{
    if(metricFlushInFlight?.promise===promise) metricFlushInFlight=null;
  }
}
async function trackMetric(event,properties={}){
  const uid=window._currentUid||storeGet('authUid','');
  if(!uid) return false;
  enqueueMetricEvent({uid,event,eventId:metricEventId(),appVersion:APP_VERSION,properties});
  return flushMetricEvents();
}

// ────────── هوية الأسئلة ومصادرها وسجل عدم التكرار
// كل سؤال يملك معرّفاً ثابتاً حتى نستطيع تدوير البنك للمستخدم نفسه من دون
// الاعتماد على نص السؤال، الذي قد يخضع لاحقاً لتصحيح لغوي بسيط.
const QUESTION_SOURCE_BY_CATEGORY={
  'معلومات عامة':{title:'الموسوعة البريطانية',url:'https://www.britannica.com/'},
  'رياضة':{title:'الاتحاد الدولي لكرة القدم FIFA',url:'https://www.fifa.com/'},
  'تاريخ':{title:'الموسوعة البريطانية — علم التاريخ',url:'https://www.britannica.com/topic/history'},
  'جغرافيا':{title:'الموسوعة البريطانية — الجغرافيا',url:'https://www.britannica.com/browse/Geography-Travel'},
  'أمثال':{title:'المعاني — الأمثال العربية',url:'https://www.almaany.com/ar/dict/ar-ar/'},
  'ثقافة خليجية':{title:'اليونسكو — التراث الثقافي',url:'https://ich.unesco.org/'},
  'دين وسيرة':{title:'الموسوعة الحديثية — الدرر السنية',url:'https://dorar.net/hadith'},
  'علوم وتقنية':{title:'الموسوعة البريطانية — العلوم',url:'https://www.britannica.com/browse/Science'},
  'محرّكات ومركبات':{title:'الموسوعة البريطانية — السيارة',url:'https://www.britannica.com/technology/automobile'},
  'السيرة النبوية':{title:'تاريخ الطبري — السيرة النبوية',url:'https://shamela.ws/book/9783'},
  'القرآن الكريم':{title:'القرآن الكريم — تفسير ابن كثير',url:'https://quran.ksu.edu.sa/tafseer/katheer/'},
  'فتوحات المسلمين':{title:'تاريخ الرسل والملوك للطبري',url:'https://shamela.ws/book/9783'},
  'ألغاز وتحدّي ذكاء':{title:'الموسوعة البريطانية — المنطق',url:'https://www.britannica.com/topic/logic'},
  'الصحابة':{title:'صحيح البخاري — الموسوعة الحديثية',url:'https://dorar.net/hadith'},
  'الشعر العربي':{title:'الموسوعة البريطانية — الأدب العربي',url:'https://www.britannica.com/art/Arabic-literature'},
  'الفضاء والكون':{title:'وكالة ناسا',url:'https://science.nasa.gov/'},
  'حيوانات وطبيعة':{title:'موسوعة سميثسونيان',url:'https://www.si.edu/spotlight/buginfo/encyclopedia'},
  'حضارات قديمة':{title:'الموسوعة البريطانية — بلاد ما بين النهرين',url:'https://www.britannica.com/place/Mesopotamia-historical-region-Asia'},
  'جسم الإنسان':{title:'منظمة الصحة العالمية',url:'https://www.who.int/'},
  'كأس العالم':{title:'الاتحاد الدولي لكرة القدم FIFA',url:'https://www.fifa.com/tournaments/mens/worldcup'},
  'أعلام الدول':{title:'الأمم المتحدة — الدول الأعضاء',url:'https://www.un.org/en/about-us/member-states'},
  'خرائط دول':{title:'الأمم المتحدة — الخرائط',url:'https://www.un.org/geospatial/mapsgeo'},
  'إجابة سريعة':{title:'الموسوعة البريطانية — الحساب',url:'https://www.britannica.com/science/arithmetic'},
  'دوري أبطال أوروبا':{title:'الاتحاد الأوروبي لكرة القدم UEFA',url:'https://www.uefa.com/uefachampionsleague/history/'},
  'أنمي':{title:'الموسوعة البريطانية — الرسوم المتحركة',url:'https://www.britannica.com/art/animation'},
  'كأس الخليج':{title:'اتحاد كأس الخليج العربي لكرة القدم',url:'https://agcff.com/%D8%AF%D9%88%D8%B1%D8%A9-%D9%83%D8%A3%D8%B3-%D8%A7%D9%84%D8%AE%D9%84%D9%8A%D8%AC/'},
  'مسلسلات خليجية':{title:'جريدة الجريدة الكويتية — درب الزلق',url:'https://www.aljarida.com/articles/1526486221951299700/'},
  'أفلام عربية':{title:'مهرجان البحر الأحمر السينمائي',url:'https://redseafilmfest.com/'},
  'الألعاب الأولمبية':{title:'اللجنة الأولمبية الدولية',url:'https://olympics.com/en/olympic-games'},
  'أغاني خليجية':{title:'مركز الشيخ جابر الأحمد الثقافي',url:'https://www.jacc-kw.com/'},
  'الخلفاء الراشدون':{title:'صحيح البخاري وتاريخ الطبري',url:'https://shamela.ws/book/9783'},
  'الأنبياء والرسل':{title:'القرآن الكريم وتفسير ابن كثير',url:'https://quran.ksu.edu.sa/tafseer/katheer/'},
};
// تصحيحات المحتوى المراجَع في إصدار البنك 2. المفاتيح هي مستوى الصعوبة.
// للمحتوى الديني نضع رابط النص أو المرجع الأقرب للسؤال بدلاً من رابط عام.
const QUESTION_OVERRIDES={
  'تاريخ':{
    1:{q:'أي حضارة بنت أهرامات الجيزة في مصر القديمة؟',answer:'الحضارة المصرية القديمة',source:{title:'اليونسكو — ممفيس ومنطقة الأهرامات',url:'https://whc.unesco.org/en/list/86/'}},
  },
  'رياضة':{
    2:{source:{title:'اللجنة الأولمبية الدولية — دورة الألعاب كل أربع سنوات',url:'https://library.olympics.com/default/digitalCollection/DigitalCollectionAttachmentDownloadHandler.ashx?documentId=172362&parentDocumentId=172359&skipCopyright=true&skipWatermark=true'}},
    4:{q:'أي منتخب فاز بكأس العالم عام 2010؟',answer:'إسبانيا',source:{title:'FIFA — كأس العالم 2010',url:'https://www.fifa.com/tournaments/mens/worldcup/2010south-africa'}},
    5:{q:'من سجّل هدف إسبانيا في نهائي كأس العالم 2010؟',answer:'أندريس إنييستا',source:{title:'FIFA — نهائي 2010',url:'https://www.fifa.com/tournaments/mens/worldcup/2010south-africa'}},
    6:{q:'أي منتخب فاز بكأس العالم خمس مرات حتى نسخة 2022؟',answer:'البرازيل',source:{title:'FIFA — تاريخ كأس العالم',url:'https://www.fifa.com/tournaments/mens/worldcup'}},
  },
  'علوم وتقنية':{
    2:{q:'من نال براءة الاختراع الأمريكية للهاتف عام 1876؟',answer:'ألكسندر غراهام بيل',source:{title:'مكتب براءات الاختراع الأمريكي — براءة هاتف بيل',url:'https://www.uspto.gov/about-us/events/alexander-graham-bells-telephone-patent-150-years-world-connection'}},
    4:{q:'ما الشبكة التي طوّرها باحثون في الولايات المتحدة وكانت أساساً مبكراً للإنترنت؟',answer:'أربانت (ARPANET)',source:{title:'الموسوعة البريطانية — ARPANET',url:'https://www.britannica.com/topic/ARPANET'}},
  },
  'جغرافيا':{
    1:{q:'وفق نموذج القارات السبع، كم عدد قارات العالم؟',answer:'سبع قارات',source:{title:'ناشيونال جيوغرافيك — القارة',url:'https://education.nationalgeographic.org/resource/Continent/'}},
    4:{q:'ما اسم ناطحة السحاب في دبي التي يبلغ ارتفاعها 828 متراً؟',answer:'برج خليفة',source:{title:'برج خليفة — حقائق وأرقام',url:'https://www.burjkhalifa.ae/en/the-tower/facts-figures/'}},
    5:{q:'ما المدينة البوليفية التي تضم مقر الحكومة وتقع على ارتفاع شاهق؟',answer:'لاباز',source:{title:'الموسوعة البريطانية — لاباز',url:'https://www.britannica.com/place/La-Paz-Bolivia'}},
  },
  'ثقافة خليجية':{
    1:{q:'ما اسم طبق خليجي يُطهى من الأرز المتبّل مع اللحم أو الدجاج؟',answer:'الكبسة',source:{title:'سعوديبيديا — الكبسة السعودية',url:'https://saudipedia.com/الكبسة-السعودية'}},
    3:{q:'كم إمارة تضم دولة الإمارات العربية المتحدة اليوم؟',answer:'سبع إمارات',source:{title:'المنصة الرسمية لحكومة الإمارات — الإمارات السبع',url:'https://u.ae/ar/about-the-uae/the-seven-emirates'}},
  },
  'محرّكات ومركبات':{
    2:{q:'ما الوقود السائل الشائع في السيارات التقليدية ذات محركات الاحتراق الشراري؟',answer:'البنزين',source:{title:'الموسوعة البريطانية — محرك البنزين',url:'https://www.britannica.com/technology/gasoline-engine'}},
    5:{q:'ما اسم الطائرة الأسرع من الصوت التي شغّلتها الخطوط البريطانية والفرنسية؟',answer:'كونكورد',source:{title:'الموسوعة البريطانية — كونكورد',url:'https://www.britannica.com/technology/Concorde'}},
    6:{q:'من حصل على براءة اختراع سيارة بمحرك بنزين عام 1886؟',answer:'كارل بنز',source:{title:'الموسوعة البريطانية — كارل بنز',url:'https://www.britannica.com/biography/Karl-Benz'}},
  },
  'الفضاء والكون':{
    4:{q:'أي كوكب يشتهر بنظام حلقاته الواسع والواضح؟',answer:'زحل',source:{title:'ناسا — زحل',url:'https://science.nasa.gov/saturn/'}},
    5:{q:'ما أكبر كوكب في المجموعة الشمسية؟',answer:'المشتري',source:{title:'ناسا — المشتري',url:'https://science.nasa.gov/jupiter/'}},
    6:{q:'أي قمر للمشتري تشير الأدلة إلى وجود محيط مالح تحت سطحه الجليدي؟',answer:'أوروبا',source:{title:'ناسا — أوروبا',url:'https://science.nasa.gov/jupiter/moons/europa/'}},
  },
  'حيوانات وطبيعة':{
    1:{q:'ما أكبر حيوان بري حي من حيث الكتلة؟',answer:'الفيل',source:{title:'الموسوعة البريطانية — الفيل',url:'https://www.britannica.com/animal/elephant-mammal'}},
    2:{q:'ما أطول حيوان بري حي؟',answer:'الزرافة',source:{title:'الموسوعة البريطانية — الزرافة',url:'https://www.britannica.com/animal/giraffe'}},
    3:{q:'ما أسرع حيوان بري؟',answer:'الفهد',source:{title:'سميثسونيان — الفهد',url:'https://nationalzoo.si.edu/animals/cheetah'}},
    4:{q:'ما الحيوان الأسترالي الذي تحمل الأنثى صغيرها في جراب؟',answer:'الكنغر',source:{title:'الموسوعة البريطانية — الكنغر',url:'https://www.britannica.com/animal/kangaroo'}},
    5:{q:'ما أكبر السنوريات البرية الحية من حيث الحجم؟',answer:'الببر (ويُسمّى النمر في بعض الاستعمالات)',source:{title:'الموسوعة البريطانية — الببر',url:'https://www.britannica.com/animal/tiger'}},
    6:{q:'ما الحيوان البحري اللافقاري الذي يملك ثلاثة قلوب ودماً أزرق؟',answer:'الأخطبوط',source:{title:'سميثسونيان للمحيطات — الأخطبوط',url:'https://ocean.si.edu/ocean-life/invertebrates/octopus'}},
  },
  'حضارات قديمة':{
    1:{q:'أي حضارة بنت مدرج الكولوسيوم في روما؟',answer:'الحضارة الرومانية',source:{title:'اليونسكو — المركز التاريخي لروما',url:'https://whc.unesco.org/en/list/91/'}},
    2:{q:'ما اسم نظام الكتابة المصوّرة الذي استخدمه قدماء المصريين؟',answer:'الكتابة الهيروغليفية',source:{title:'متحف المتروبوليتان — الكتابة المصرية القديمة',url:'https://www.metmuseum.org/essays/ancient-egyptian-writing'}},
    3:{q:'أي حضارة حكمت وسط المكسيك واتخذت تينوتشتيتلان عاصمةً لها؟',answer:'حضارة الأزتك',source:{title:'الموسوعة البريطانية — الأزتك',url:'https://www.britannica.com/topic/Aztec'}},
    4:{q:'ما اسم الوادي المصري الذي يضم مقابر كثير من ملوك الدولة الحديثة؟',answer:'وادي الملوك',source:{title:'اليونسكو — طيبة القديمة ومقابرها',url:'https://whc.unesco.org/en/list/87/'}},
    5:{q:'ما المدينة الرومانية القديمة التي دفنها ثوران جبل فيزوف سنة 79م؟',answer:'بومبي',source:{title:'الموسوعة البريطانية — بومبي',url:'https://www.britannica.com/place/Pompeii'}},
    6:{q:'ما اسم النظام الذي استخدمته حضارة المايا لتنظيم دورات الزمن والأيام؟',answer:'تقويم المايا',source:{title:'الموسوعة البريطانية — تقويم المايا',url:'https://www.britannica.com/topic/Mayan-calendar'}},
  },
  'جسم الإنسان':{
    1:{q:'كم عدد حجرات القلب البشري؟',answer:'أربع حجرات',source:{title:'المعهد الوطني للقلب — القلب',url:'https://www.nhlbi.nih.gov/health/heart'}},
    2:{q:'ما العضو الذي يضخ الدم إلى أنحاء الجسم؟',answer:'القلب',source:{title:'المعهد الوطني للقلب',url:'https://www.nhlbi.nih.gov/health/heart'}},
    4:{q:'ما اسم خلايا الجهاز العصبي المتخصصة في إرسال الإشارات واستقبالها؟',answer:'الخلايا العصبية (العصبونات)',source:{title:'المعهد الوطني للاضطرابات العصبية — الخلايا العصبية',url:'https://www.ninds.nih.gov/es/node/8172'}},
  },
  'الشعر العربي':{
    2:{q:'شنو جنسية الشاعر العربي «سليم بركات» حسب السجل؟',answer:'سوريا',source:{title:'Wikidata — سليم بركات',url:'https://www.wikidata.org/wiki/Q621086'}},
    4:{q:'شنو جنسية الشاعر العربي «سركون بولص» حسب السجل؟',answer:'العراق',source:{title:'Wikidata — سركون بولص',url:'https://www.wikidata.org/wiki/Q954315'}},
    5:{q:'من الشاعر العباسي صاحب البيت «واحر قلباه ممن قلبه شبم»؟',answer:'المتنبي',source:{title:'مؤسسة هنداوي — ديوان المتنبي',url:'https://www.hindawi.org/books/85919750/'}},
  },
  'خرائط دول':{
    5:{q:'أي دولة آسيوية جنوب شرقية تتكوّن من أكثر من سبعة آلاف جزيرة؟',answer:'الفلبين',source:{title:'الموسوعة البريطانية — الفلبين',url:'https://www.britannica.com/place/Philippines'}},
  },
  'كأس العالم':{
    5:{q:'حتى نهاية كأس العالم 2022، من صاحب أسرع هدف في تاريخ البطولة بعد نحو 11 ثانية؟',answer:'هاكان شوكور (تركيا)',source:{title:'FIFA — أسرع أهداف كأس العالم',url:'https://www.fifa.com/tournaments/mens/worldcup'}},
    6:{q:'حتى نهاية كأس العالم 2022، أي منتخبين يملكان أربعة ألقاب لكل منهما؟',answer:'ألمانيا وإيطاليا',source:{title:'FIFA — سجل أبطال كأس العالم',url:'https://www.fifa.com/tournaments/mens/worldcup'}},
  },
  'كأس الخليج':{
    6:{q:'كم هدفاً سُجّل في مباريات كأس الخليج السابعة عام 1984؟',answer:'51 هدفاً',source:{title:'اتحاد كأس الخليج — إحصاءات خليجي 7',url:'https://agcff.com/en/1551/'}},
  },
  'دوري أبطال أوروبا':{
    2:{q:'حتى نهاية موسم 2024-2025، من صاحب ثاني أكبر عدد من الأهداف في تاريخ دوري أبطال أوروبا؟',answer:'ليونيل ميسي',source:{title:'UEFA — هدافو دوري أبطال أوروبا عبر التاريخ',url:'https://www.uefa.com/uefachampionsleague/history/rankings/players/goals_scored/'}},
    4:{q:'في أي موسم بدأ نظام مرحلة الدوري بمشاركة 36 فريقاً في دوري أبطال أوروبا؟',answer:'موسم 2024-2025',source:{title:'UEFA — شرح النظام الجديد',url:'https://www.uefa.com/uefachampionsleague/news/0290-1bae124dbd1a-4a9fc08cd25c-1000/'}},
    6:{q:'أي نادٍ فاز بأول خمس نسخ من كأس أوروبا من 1956 إلى 1960؟',answer:'ريال مدريد',source:{title:'UEFA — تاريخ البطولة',url:'https://www.uefa.com/uefachampionsleague/history/'}},
  },
  'الألعاب الأولمبية':{
    3:{q:'من السباح الأمريكي الذي فاز بـ23 ميدالية ذهبية أولمبية خلال مسيرته؟',answer:'مايكل فيلبس',source:{title:'الاتحاد الدولي للألعاب المائية — ميداليات مايكل فيلبس',url:'https://www.worldaquatics.com/athletes/1001621/michael-phelps/medals'}},
    4:{q:'أي مدينة استضافت الألعاب الأولمبية الصيفية عام 2012؟',answer:'لندن',source:{title:'الألعاب الأولمبية — لندن 2012',url:'https://olympics.com/en/olympic-games/london-2012'}},
    5:{q:'أي مدينة استضافت الألعاب الأولمبية الصيفية عام 2016؟',answer:'ريو دي جانيرو',source:{title:'الألعاب الأولمبية — ريو 2016',url:'https://olympics.com/en/olympic-games/rio-2016'}},
  },
  'أنمي':{
    1:{q:'في أي دولة ظهر فن الأنمي بصورته الحديثة؟',answer:'اليابان',source:{title:'Web Japan — تطور الأنمي في اليابان',url:'https://web-japan.org/nipponia/nipponia27/en/feature/index.html'}},
    6:{q:'ما الاسم الذي كانت فاكهة لوفي في «ون بيس» تُعرف به قبل كشف اسمها الحقيقي؟',answer:'غومو غومو نو مي (فاكهة المطاط)',source:{title:'الموقع الرسمي لـONE PIECE — لوفي',url:'https://one-piece.com/character/luffy/index.html'}},
  },
  'مسلسلات خليجية':{
    1:{q:'ما اسم المسلسل الكويتي الذي ظهرت فيه شخصيتا حسين وسعد بن عاقول؟',answer:'درب الزلق',source:{title:'جريدة الجريدة الكويتية — درب الزلق',url:'https://www.aljarida.com/articles/1526486221951299700/'}},
    2:{q:'ما سبب ثراء حسين وسعد في بداية أحداث مسلسل درب الزلق؟',answer:'تثمين الحكومة لمنزلهما',source:{title:'جريدة الأنباء الكويتية — تجارة أبناء العاقول',url:'https://www.alanba.com.kw/1006172/'}},
    3:{q:'من جسّد شخصية سعد بن عاقول في مسلسل درب الزلق؟',answer:'سعد الفرج',source:{title:'جريدة الجريدة الكويتية — درب الزلق',url:'https://www.aljarida.com/articles/1526486221951299700/'}},
    4:{q:'في أي دولة بدأ عرض مسلسل «شباب البومب»؟',answer:'السعودية',source:{title:'سعوديبيديا — مسلسل شباب البومب',url:'https://saudipedia.com/%D9%85%D8%B3%D9%84%D8%B3%D9%84-%D8%B4%D8%A8%D8%A7%D8%A8-%D8%A7%D9%84%D8%A8%D9%88%D9%85%D8%A8'}},
    5:{q:'من جسّد شخصية «قحطة» في مسلسل درب الزلق؟',answer:'علي المفيدي',source:{title:'جريدة الجريدة الكويتية — شخصيات درب الزلق',url:'https://www.aljarida.com/articles/1526486221951299700/'}},
    6:{q:'من جسّد شخصية «حسين بن عاقول» في مسلسل درب الزلق؟',answer:'عبدالحسين عبدالرضا',source:{title:'جريدة الجريدة الكويتية — شخصيات درب الزلق',url:'https://www.aljarida.com/articles/1526486221951299700/'}},
  },
  'أفلام عربية':{
    1:{q:'في أي دولة تدور أحداث فيلم «وجدة»؟',answer:'السعودية',source:{title:'أكاديمية فنون وعلوم الصور المتحركة — وجدة',url:'https://www.oscars.org/news/76-countries-competition-2013-foreign-language-film-oscarr'}},
    2:{q:'من أخرجت فيلم «وجدة» عام 2012؟',answer:'هيفاء المنصور',source:{title:'مهرجان كان — هيفاء المنصور',url:'https://www.festival-cannes.com/en/p/haifaa-al-mansour/'}},
    3:{q:'ما أول فيلم مثّل السعودية في مسابقة الفيلم الأجنبي بالأوسكار؟',answer:'وجدة',source:{title:'أكاديمية فنون وعلوم الصور المتحركة — مشاركات 2013',url:'https://www.oscars.org/news/76-countries-competition-2013-foreign-language-film-oscarr'}},
    4:{q:'من أدّت دور أم وجدة في فيلم «وجدة»؟',answer:'ريم عبدالله',source:{title:'أكاديمية فنون وعلوم الصور المتحركة — قائمة ممثلي وجدة',url:'https://digitalcollections.oscars.org/digital/api/collection/p15759coll9/id/6867/download'}},
    5:{q:'من أخرج فيلم «بركة يقابل بركة»؟',answer:'محمود صباغ',source:{title:'سعوديبيديا — بركة يقابل بركة',url:'https://saudipedia.com/en/barakah-meets-barakah-film'}},
    6:{q:'ما أول فيلم روائي طويل صُوّر بالكامل داخل السعودية؟',answer:'وجدة',source:{title:'أكاديمية فنون وعلوم الصور المتحركة — هيفاء المنصور',url:'https://www.oscars.org/awards/working-above-line-panel-biographies'}},
  },
  'أغاني خليجية':{
    2:{q:'أي مطربة عربية غنّت من كلمات الشاعر الكويتي أحمد مشاري العدواني؟',answer:'أم كلثوم',source:{title:'مركز الشيخ جابر الثقافي — أغنيات أحمد العدواني',url:'https://tickets.jacc-kw.com/event/info/songs-of-the-poet-ahmad-al-adwani/159'}},
    4:{q:'من الملحّن الكويتي الذي لحّن النشيد الوطني لدولة الكويت؟',answer:'إبراهيم الصولة',source:{title:'ديوان ولي العهد — النشيد الوطني',url:'https://www.cpd.gov.kw/anthem'}},
    5:{q:'من كتب كلمات النشيد الوطني لدولة الكويت؟',answer:'أحمد مشاري العدواني',source:{title:'ديوان ولي العهد — النشيد الوطني',url:'https://www.cpd.gov.kw/anthem'}},
    6:{q:'في أي عام بدأ استخدام النشيد الوطني الكويتي الحالي؟',answer:'عام 1978',source:{title:'ديوان ولي العهد — النشيد الوطني',url:'https://www.cpd.gov.kw/anthem'}},
  },
  'دين وسيرة':{
    1:{source:{title:'صحيح البخاري — بُني الإسلام على خمس',url:'https://dorar.net/hadith/sharh/75059'}},
    2:{source:{title:'صحيح البخاري — فرض الصلاة',url:'https://dorar.net/hadith/search?q=%D9%81%D8%B1%D8%B6%D8%AA+%D8%A7%D9%84%D8%B5%D9%84%D8%A7%D8%A9+%D8%B1%D9%83%D8%B9%D8%AA%D9%8A%D9%86'}},
    3:{q:'في اليوم المعتاد من غير صلاة الجمعة، كم مجموع ركعات الصلوات الخمس المفروضة؟',answer:'17 ركعة',source:{title:'الموسوعة الحديثية — الصلوات الخمس المفروضة',url:'https://dorar.net/hadith/search?q=%D8%A7%D9%84%D8%B5%D9%84%D9%88%D8%A7%D8%AA+%D8%A7%D9%84%D8%AE%D9%85%D8%B3'}},
    4:{q:'إلى أي بيت يتجه المسلمون في صلاتهم؟',answer:'الكعبة المشرفة',source:{title:'القرآن الكريم — البقرة 144',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura2-aya144.html'}},
    5:{source:{title:'حديث «الحج عرفة»',url:'https://dorar.net/hadith/sharh/85664'}},
    6:{q:'كم عدد أيام التشريق؟',answer:'ثلاثة أيام',source:{title:'تفسير ابن كثير — البقرة 203',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura2-aya203.html'}},
  },
  'السيرة النبوية':{
    1:{source:{title:'تاريخ الطبري — ذكر مولد رسول الله ﷺ',url:'https://shamela.ws/book/9783'}},
    2:{source:{title:'تاريخ الطبري — زواج النبي ﷺ بخديجة',url:'https://shamela.ws/book/9783'}},
    3:{source:{title:'تاريخ الطبري — وقعة بدر الكبرى',url:'https://shamela.ws/book/9783'}},
    4:{source:{title:'تاريخ الطبري — فتح مكة',url:'https://shamela.ws/book/9783'}},
    5:{source:{title:'البداية والنهاية لابن كثير — غزوة بدر',url:'https://shamela.ws/book/4445'}},
    6:{source:{title:'تاريخ الطبري — السيرة النبوية',url:'https://shamela.ws/book/9783'}},
  },
  'القرآن الكريم':{
    1:{q:'ما أول سورة في ترتيب المصحف؟',answer:'سورة الفاتحة',source:{title:'تفسير ابن كثير — سورة الفاتحة',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura1.html'}},
    2:{source:{title:'القرآن الكريم — فهرس السور',url:'https://quran.ksu.edu.sa/'}},
    3:{q:'ما السورة التي عدد آياتها ثلاث وتبدأ بقوله تعالى «إنا أعطيناك الكوثر»؟',answer:'سورة الكوثر',source:{title:'تفسير ابن كثير — سورة الكوثر',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura108.html'}},
    4:{q:'ما أطول سورة في القرآن الكريم؟',answer:'سورة البقرة',source:{title:'تفسير ابن كثير — سورة البقرة',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura2.html'}},
    5:{source:{title:'صحيح البخاري — بدء الوحي',url:'https://dorar.net/hadith/sharh/6299'}},
    6:{q:'في أي سورة ورد قوله تعالى «محمد رسول الله»؟',answer:'سورة الفتح',source:{title:'تفسير ابن كثير — الفتح 29',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura48-aya29.html'}},
  },
  'فتوحات المسلمين':{
    1:{q:'في عهد أي خليفة وقعت معركة القادسية؟',answer:'عمر بن الخطاب',source:{title:'تاريخ الطبري — وقعة القادسية في خلافة عمر',url:'https://shamela.ws/book/9783'}},
    2:{source:{title:'تاريخ الطبري — القادسية',url:'https://shamela.ws/book/9783'}},
    3:{q:'في عهد أي خليفة فُتحت دمشق؟',answer:'عمر بن الخطاب',source:{title:'تاريخ الطبري — فتوح الشام',url:'https://shamela.ws/book/9783'}},
    4:{q:'ما المدينة التي تسلّم الخليفة عمر بن الخطاب مفاتيحها خلال فتوح الشام؟',answer:'بيت المقدس',source:{title:'تاريخ الطبري — فتح بيت المقدس',url:'https://shamela.ws/book/9783'}},
    5:{q:'ما المعركة التي عُرفت في المصادر الإسلامية بفتح الفتوح في بلاد فارس؟',answer:'معركة نهاوند',source:{title:'تاريخ الطبري — نهاوند',url:'https://shamela.ws/book/9783'}},
    6:{source:{title:'تاريخ الطبري — يزدجرد الثالث',url:'https://shamela.ws/book/9783'}},
  },
  'الصحابة':{
    1:{source:{title:'تاريخ الطبري — خلافة أبي بكر',url:'https://shamela.ws/book/9783'}},
    2:{source:{title:'صحيح البخاري — فضائل عائشة',url:'https://dorar.net/hadith/search?q=%D9%81%D8%B6%D9%84+%D8%B9%D8%A7%D8%A6%D8%B4%D8%A9'}},
    3:{source:{title:'صحيح البخاري — حواري الرسول ﷺ',url:'https://dorar.net/hadith/sharh/7399'}},
    4:{source:{title:'تاريخ الطبري — وفاة أبي بكر',url:'https://shamela.ws/book/9783'}},
    5:{q:'من الصحابي المقصود بصاحب النبي ﷺ في الغار في قوله تعالى «إذ يقول لصاحبه لا تحزن»؟',answer:'أبو بكر الصديق',source:{title:'تفسير ابن كثير — التوبة 40',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura9-aya40.html'}},
    6:{source:{title:'القرآن الكريم — التوبة 40',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura9-aya40.html'}},
  },
  'الخلفاء الراشدون':{
    1:{q:'من الخليفة الراشد الذي أمر زيد بن ثابت بجمع القرآن بعد وقعة اليمامة؟',answer:'أبو بكر الصديق',source:{title:'صحيح البخاري — جمع القرآن في عهد أبي بكر',url:'https://dorar.net/hadith/sharh/3840'}},
    2:{source:{title:'تاريخ الطبري — وفاة أبي بكر',url:'https://shamela.ws/book/9783'}},
    3:{source:{title:'تاريخ الطبري — وضع التاريخ الهجري',url:'https://shamela.ws/book/9783'}},
    4:{source:{title:'صحيح البخاري — جمع القرآن',url:'https://dorar.net/hadith/sharh/3840'}},
    5:{source:{title:'تاريخ الطبري — نسب أبي بكر',url:'https://shamela.ws/book/9783'}},
    6:{q:'في عهد أي خليفة وقعت معركة ذات الصواري البحرية؟',answer:'عثمان بن عفان',source:{title:'البداية والنهاية لابن كثير — خلافة عثمان',url:'https://shamela.ws/book/4445'}},
  },
  'الأنبياء والرسل':{
    1:{q:'من أبو البشر الذي خلقه الله من تراب؟',answer:'آدم عليه السلام',source:{title:'تفسير ابن كثير — آل عمران 59',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura3-aya59.html'}},
    2:{source:{title:'تفسير ابن كثير — مريم وعيسى',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura19.html'}},
    3:{q:'من النبي الذي قال الله تعالى إنه كلّمه تكليماً؟',answer:'موسى عليه السلام',source:{title:'تفسير ابن كثير — النساء 164',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura4-aya164.html'}},
    4:{source:{title:'تفسير ابن كثير — أولو العزم من الرسل',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura46-aya35.html'}},
    5:{q:'أي نبي أُلقي في النار فجعلها الله عليه برداً وسلاماً؟',answer:'إبراهيم عليه السلام',source:{title:'تفسير ابن كثير — الأنبياء 69',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura21-aya69.html'}},
    6:{source:{title:'تفسير ابن كثير — الأنبياء 87',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura21-aya87.html'}},
  },
};
// دفعة المحتوى الديني المراجع: سؤال ثانٍ لكل مستوى حتى لا تعيد الجولة التالية
// الأسئلة نفسها مباشرة. لا تُقبل هنا رواية بلا نص قرآني أو حديث صحيح أو
// مرجع تاريخي معروف، وتبقى المسائل الخلافية خارج اللعبة.
const QUESTION_ADDITIONS={
  'دين وسيرة':[
    {d:1,q:'كم عدد أركان الإيمان المذكورة في حديث جبريل؟',answer:'ستة أركان',source:{title:'حديث جبريل — أصول الإيمان والإحسان',url:'https://dorar.net/hadith/sharh/141932'}},
    {d:2,q:'ما الشهر الذي فرض الله صيامه على المسلمين؟',answer:'شهر رمضان',source:{title:'تفسير ابن كثير — البقرة 185',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura2-aya185.html'}},
    {d:3,q:'كم صنفاً ذكر القرآن لمصارف الزكاة في آية الصدقات؟',answer:'ثمانية أصناف',source:{title:'تفسير ابن كثير — التوبة 60',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura9-aya60.html'}},
    {d:4,q:'ما القبلة الأولى التي صلى إليها المسلمون قبل الكعبة؟',answer:'بيت المقدس',source:{title:'صحيح البخاري — تحويل القبلة',url:'https://dorar.net/hadith/search?q=%D8%A7%D9%84%D9%82%D8%A8%D9%84%D8%A9+%D8%A8%D9%8A%D8%AA+%D8%A7%D9%84%D9%85%D9%82%D8%AF%D8%B3'}},
    {d:5,q:'ما الليلة التي وصفها القرآن بأنها خير من ألف شهر؟',answer:'ليلة القدر',source:{title:'تفسير ابن كثير — سورة القدر',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura97.html'}},
    {d:6,q:'أكمل معنى الإحسان في حديث جبريل: أن تعبد الله كأنك...؟',answer:'تراه، فإن لم تكن تراه فإنه يراك',source:{title:'حديث جبريل — معنى الإحسان',url:'https://dorar.net/hadith/sharh/141932'}},
  ],
  'السيرة النبوية':[
    {d:1,q:'ما اسم جد النبي محمد ﷺ الذي كفله بعد وفاة أمه؟',answer:'عبد المطلب',source:{title:'البداية والنهاية لابن كثير — السيرة النبوية',url:'https://shamela.ws/book/4445'}},
    {d:2,q:'كم كان عمر النبي ﷺ عندما نزل عليه الوحي أول مرة؟',answer:'أربعون سنة',source:{title:'البداية والنهاية لابن كثير — مبعث الرسول ﷺ',url:'https://shamela.ws/book/4445'}},
    {d:3,q:'من كان مع النبي ﷺ في الغار أثناء الهجرة؟',answer:'أبو بكر الصديق',source:{title:'تفسير ابن كثير — التوبة 40',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura9-aya40.html'}},
    {d:4,q:'ما اسم الصلح الذي عقده النبي ﷺ مع قريش في السنة السادسة للهجرة؟',answer:'صلح الحديبية',source:{title:'تاريخ الطبري — السنة السادسة للهجرة',url:'https://shamela.ws/book/9783'}},
    {d:5,q:'أي مسجد كان النبي ﷺ يأتيه كل سبت ماشياً وراكباً؟',answer:'مسجد قباء',source:{title:'صحيح البخاري ومسلم — إتيان مسجد قباء',url:'https://dorar.net/hadith/sharh/142339'}},
    {d:6,q:'من كتب وثيقة صلح الحديبية بأمر النبي ﷺ؟',answer:'علي بن أبي طالب',source:{title:'صحيح البخاري — صلح الحديبية',url:'https://dorar.net/hadith/search?q=%D9%83%D8%AA%D8%A8+%D8%B9%D9%84%D9%8A+%D8%B5%D9%84%D8%AD+%D8%A7%D9%84%D8%AD%D8%AF%D9%8A%D8%A8%D9%8A%D8%A9'}},
  ],
  'القرآن الكريم':[
    {d:1,q:'ما آخر سورة في ترتيب المصحف؟',answer:'سورة الناس',source:{title:'تفسير ابن كثير — سورة الناس',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura114.html'}},
    {d:2,q:'ما السورة التي لا تبدأ بالبسملة في المصحف؟',answer:'سورة التوبة',source:{title:'تفسير ابن كثير — سورة التوبة',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura9.html'}},
    {d:3,q:'في أي سورة توجد آية الكرسي؟',answer:'سورة البقرة',source:{title:'تفسير ابن كثير — البقرة 255',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura2-aya255.html'}},
    {d:4,q:'ما السورة التي تحمل اسم أم عيسى عليه السلام؟',answer:'سورة مريم',source:{title:'تفسير ابن كثير — سورة مريم',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura19.html'}},
    {d:5,q:'ما السورة التي وردت فيها البسملة مرتين؟',answer:'سورة النمل',source:{title:'تفسير ابن كثير — النمل 30',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura27-aya30.html'}},
    {d:6,q:'في أي سورة توجد أطول آية في القرآن، وهي آية الدَّين؟',answer:'سورة البقرة',source:{title:'تفسير ابن كثير — البقرة 282',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura2-aya282.html'}},
  ],
  'فتوحات المسلمين':[
    {d:1,q:'في عهد أي خليفة بدأت حروب الردة؟',answer:'أبو بكر الصديق',source:{title:'تاريخ الطبري — حوادث السنة الحادية عشرة',url:'https://shamela.ws/book/9783'}},
    {d:2,q:'ما المعركة الكبرى التي وقعت بين المسلمين والروم في بلاد الشام سنة 15 هـ؟',answer:'معركة اليرموك',source:{title:'تاريخ الطبري — اليرموك',url:'https://shamela.ws/book/9783'}},
    {d:3,q:'في أي بلد وقعت معركة القادسية؟',answer:'العراق',source:{title:'تاريخ الطبري — القادسية',url:'https://shamela.ws/book/9783'}},
    {d:4,q:'من القائد الذي ارتبط بفتح مصر في عهد عمر بن الخطاب؟',answer:'عمرو بن العاص',source:{title:'البداية والنهاية لابن كثير — فتح مصر',url:'https://shamela.ws/book/4445'}},
    {d:5,q:'في عهد أي خليفة وقعت معركة نهاوند؟',answer:'عمر بن الخطاب',source:{title:'تاريخ الطبري — نهاوند',url:'https://shamela.ws/book/9783'}},
    {d:6,q:'ما اسم المعركة البحرية الكبرى التي وقعت في عهد عثمان بن عفان؟',answer:'معركة ذات الصواري',source:{title:'البداية والنهاية لابن كثير — خلافة عثمان',url:'https://shamela.ws/book/4445'}},
  ],
  'الصحابة':[
    {d:1,q:'من الصحابي الذي رآه أبو جحيفة يؤذّن ويدور بوجهه أثناء الأذان؟',answer:'بلال بن رباح',source:{title:'صحيح البخاري — أذان بلال',url:'https://dorar.net/hadith/sharh/130394'}},
    {d:2,q:'من الصحابي الملقب بذي النورين؟',answer:'عثمان بن عفان',source:{title:'الموسوعة التاريخية — عثمان بن عفان',url:'https://dorar.net/history'}},
    {d:3,q:'من الصحابي الذي دعا له النبي ﷺ أن يفقهه الله في الدين ويعلمه التأويل؟',answer:'عبدالله بن عباس',source:{title:'حديث دعاء النبي ﷺ لابن عباس',url:'https://dorar.net/hadith/sharh/63103'}},
    {d:4,q:'من الصحابي الذي كُلّف بجمع القرآن في خلافة أبي بكر؟',answer:'زيد بن ثابت',source:{title:'صحيح البخاري — جمع القرآن',url:'https://dorar.net/hadith/sharh/3840'}},
    {d:5,q:'من الصحابي الذي أخبر النبي ﷺ أن عرش الرحمن اهتز لموته؟',answer:'سعد بن معاذ',source:{title:'صحيح البخاري — سعد بن معاذ',url:'https://dorar.net/h/1uVuOqBw?osoul=1'}},
    {d:6,q:'من الصحابي الوحيد الذي ورد اسمه صريحاً في القرآن الكريم؟',answer:'زيد بن حارثة',source:{title:'تفسير ابن كثير — الأحزاب 37',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura33-aya37.html'}},
  ],
  'الخلفاء الراشدون':[
    {d:1,q:'من ثاني الخلفاء الراشدين؟',answer:'عمر بن الخطاب',source:{title:'تاريخ الطبري — خلافة عمر',url:'https://shamela.ws/book/9783'}},
    {d:2,q:'من ثالث الخلفاء الراشدين؟',answer:'عثمان بن عفان',source:{title:'تاريخ الطبري — خلافة عثمان',url:'https://shamela.ws/book/9783'}},
    {d:3,q:'من رابع الخلفاء الراشدين؟',answer:'علي بن أبي طالب',source:{title:'تاريخ الطبري — خلافة علي',url:'https://shamela.ws/book/9783'}},
    {d:4,q:'من أول من اشتهر بلقب أمير المؤمنين من الخلفاء الراشدين؟',answer:'عمر بن الخطاب',source:{title:'البداية والنهاية لابن كثير — خلافة عمر',url:'https://shamela.ws/book/4445'}},
    {d:5,q:'من الخليفة الذي نُسخت في عهده المصاحف وأُرسلت إلى الأمصار؟',answer:'عثمان بن عفان',source:{title:'صحيح البخاري — نسخ المصاحف',url:'https://dorar.net/hadith/sharh/8135'}},
    {d:6,q:'إلى أي مدينة نقل علي بن أبي طالب مركز الخلافة؟',answer:'الكوفة',source:{title:'تاريخ الطبري — خلافة علي',url:'https://shamela.ws/book/9783'}},
  ],
  'الأنبياء والرسل':[
    {d:1,q:'من النبي الذي صنع السفينة بأمر الله؟',answer:'نوح عليه السلام',source:{title:'تفسير ابن كثير — هود 37',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura11-aya37.html'}},
    {d:2,q:'من النبي الذي التقمه الحوت؟',answer:'يونس عليه السلام',source:{title:'تفسير ابن كثير — الصافات 142',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura37-aya142.html'}},
    {d:3,q:'من النبي الذي تكلم في المهد؟',answer:'عيسى عليه السلام',source:{title:'تفسير ابن كثير — مريم 29-30',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura19-aya30.html'}},
    {d:4,q:'من النبي الذي آتاه الله الزبور؟',answer:'داود عليه السلام',source:{title:'تفسير ابن كثير — النساء 163',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura4-aya163.html'}},
    {d:5,q:'من والد يوسف عليه السلام؟',answer:'يعقوب عليه السلام',source:{title:'تفسير ابن كثير — سورة يوسف',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura12.html'}},
    {d:6,q:'من النبي الملك الذي علّمه الله منطق الطير؟',answer:'سليمان عليه السلام',source:{title:'تفسير ابن كثير — النمل 16',url:'https://quran.ksu.edu.sa/tafseer/katheer/sura27-aya16.html'}},
  ],
};
function hashQuestion(value){
  let hash=2166136261;
  for(let i=0;i<value.length;i++){
    hash^=value.charCodeAt(i);
    hash=Math.imul(hash,16777619);
  }
  return (hash>>>0).toString(36);
}
function normalizeQuestionBank(bank){
  const normalized={};
  Object.entries(bank).forEach(([cat,questions])=>{
    const originals=Array.isArray(questions)?questions:[];
    const merged=[...originals,...(QUESTION_ADDITIONS[cat]||[])];
    normalized[cat]=merged.map((question,index)=>{
      // التصحيح يخص السؤال القديم فقط. سؤال الإضافة في المستوى نفسه مستقل
      // ولا يجوز أن يرث نص التصحيح، وإلا ظهر سؤالان متطابقان في البنك.
      const isPublishedQuestion=question.review?.status==='approved';
      const override=index<originals.length&&!isPublishedQuestion&&QUESTION_OVERRIDES[cat]&&QUESTION_OVERRIDES[cat][question.d];
      const q={...question,...(override||{})};
      const reviewedSource=window.__REVIEWED_QUESTION_SOURCES__?.[cat]?.[question.d];
      if(index<originals.length&&!isPublishedQuestion&&reviewedSource) q.source={...reviewedSource};
      // بعض الأسئلة القديمة كانت اختياراً من متعدد. عند استبدال نص السؤال
      // وإجابته نحذف خياراته القديمة حتى لا تصبح بياناتها مخالفة للإجابة الجديدة.
      if(override&&override.q){ delete q.o; delete q.a; }
      // المعرّف الدائم يعتمد على موضع السجل داخل مصدره، لا على نص السؤال.
      // بذلك لا يحوّل التصحيح اللغوي السؤال نفسه إلى سؤال «جديد» للمستخدم.
      // نحتفظ بمعرّف 1.2 النصي كاسم سابق حتى تُحترم السجلات الموجودة فعلاً.
      const legacyId=String(q.id||`q2-${hashQuestion(`${cat}|${q.d}|${q.q}|${index}`)}`);
      const sourceKind=index<originals.length?'bank':'addition';
      const sourceIndex=index<originals.length?index:index-originals.length;
      q.id=String(q.id||`q3-${hashQuestion(`${cat}|${sourceKind}|${sourceIndex}|${q.d}`)}`);
      q.previousIds=q.id===legacyId?[]:[legacyId];
      const fallbackSource=QUESTION_SOURCE_BY_CATEGORY[cat]||null;
      q.source=q.source||(fallbackSource?{...fallbackSource,scope:'category_fallback'}:null);
      const auditedReview=window.__LEGACY_QUESTION_REVIEWS__?.[q.id];
      if(auditedReview) q.review={...auditedReview};
      const religious=['دين وسيرة','السيرة النبوية','القرآن الكريم','فتوحات المسلمين','الصحابة','الخلفاء الراشدون','الأنبياء والرسل'].includes(cat);
      const hasExplicitApproval=q.review?.status==='approved'
        &&typeof q.review.reviewer==='string'&&q.review.reviewer.trim()
        &&typeof q.review.reviewedAt==='string'&&q.review.reviewedAt.trim()
        &&(!religious||q.review.religiousSourceAndIsnadConfirmed===true);
      q.review=hasExplicitApproval
        ? {...q.review}
        : {
            status:religious?'pending_religious_review':'pending_review',
            bankVersion:3,
            reviewer:null,
            reviewedAt:null,
            religiousSourceAndIsnadConfirmed:false,
          };
      return q;
    });
  });
  return normalized;
}
function questionHistoryOwner(){
  return String(window._currentUid||storeGet('authUid','guest')||'guest').replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,128);
}
function questionHistoryKey(){ return `question_history_${questionHistoryOwner()}`; }
function loadQuestionHistory(){ return storeGet(questionHistoryKey(),{}); }
function saveQuestionHistory(history){ storeSet(questionHistoryKey(),history); }
function questionWasSeen(history,cat,question){
  if(!question) return false;
  const seen=[
    ...(history[cat]||[]),
    ...(question.originCategory&&question.originCategory!==cat?(history[question.originCategory]||[]):[]),
  ];
  return [question.id,...(question.previousIds||[])].some(id=>id&&seen.includes(id));
}
function questionSeenOutboxKey(){ return `question_seen_outbox_${questionHistoryOwner()}`; }
function questionSeenSeededKey(){ return `question_seen_seeded_${questionHistoryOwner()}`; }
let questionSeenFlushTimer=null;
let questionHistorySyncedOwner='';
let questionHistorySyncInFlight=null;
function enqueueQuestionSeen(category,questionId){
  if(!questionId||!category) return;
  const outbox=storeGet(questionSeenOutboxKey(),[]);
  if(!outbox.some(item=>item.id===questionId)){
    outbox.push({id:questionId,category});
    storeSet(questionSeenOutboxKey(),outbox.slice(-10000));
  }
}
function scheduleQuestionSeenFlush(){
  clearTimeout(questionSeenFlushTimer);
  questionSeenFlushTimer=setTimeout(()=>{ void flushQuestionSeen(); },1200);
}
async function flushQuestionSeen(){
  const uid=window._currentUid||storeGet('authUid','');
  if(!uid) return false;
  const idToken=await getCurrentIdToken();
  if(!idToken) return false;
  let sentAny=false;
  for(let batchNumber=0;batchNumber<100;batchNumber++){
    const current=storeGet(questionSeenOutboxKey(),[]);
    const batch=current.slice(0,100);
    if(!batch.length) break;
    let response;
    try{
      response=await apiFetch('/api/questions/seen',{
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+idToken},
        body:JSON.stringify({uid,idToken,items:batch}),
      });
    }catch(_){ return sentAny; }
    if(!response.ok) return sentAny;
    sentAny=true;
    const sentIds=new Set(batch.map(item=>item.id));
    const latest=storeGet(questionSeenOutboxKey(),[]);
    storeSet(questionSeenOutboxKey(),latest.filter(item=>!sentIds.has(item.id)));
  }
  return sentAny;
}
async function syncQuestionHistory(){
  const uid=window._currentUid||storeGet('authUid','');
  if(!uid) return false;
  if(questionHistorySyncedOwner===uid){
    void flushQuestionSeen();
    return true;
  }
  if(questionHistorySyncInFlight?.uid===uid) return questionHistorySyncInFlight.promise;
  const promise=(async()=>{
    const idToken=await getCurrentIdToken();
    if(!idToken) return false;
    try{
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),8000);
      let response;
      try{
        response=await apiFetch(`/api/questions/seen?uid=${encodeURIComponent(uid)}`,{
          headers:{'Authorization':'Bearer '+idToken},signal:controller.signal,
        });
      }finally{ clearTimeout(timer); }
      if(!response.ok) return false;
      const payload=await response.json();
      const history=loadQuestionHistory();
      (payload.items||[]).forEach(item=>{
        if(!item||!item.id||!item.category) return;
        const ids=history[item.category]||[];
        if(!ids.includes(item.id)) ids.push(item.id);
        history[item.category]=ids.slice(-2000);
      });
      saveQuestionHistory(history);
    }catch(_){ return false; }

    // ترحيل سجل الجهاز الموجود قبل إضافة المزامنة مرة واحدة فقط.
    if(!storeGet(questionSeenSeededKey(),false)){
      const history=loadQuestionHistory();
      Object.entries(history).forEach(([category,ids])=>{
        (ids||[]).forEach(id=>enqueueQuestionSeen(category,id));
      });
    }
    await flushQuestionSeen();
    if(!storeGet(questionSeenOutboxKey(),[]).length){
      storeSet(questionSeenSeededKey(),true);
    }
    questionHistorySyncedOwner=uid;
    return true;
  })();
  questionHistorySyncInFlight={uid,promise};
  try{ return await promise; }
  finally{
    if(questionHistorySyncInFlight?.promise===promise) questionHistorySyncInFlight=null;
  }
}
function rememberQuestion(cat,question){
  if(!question||!question.id||state.familyRound) return;
  const history=loadQuestionHistory();
  const ids=history[cat]||[];
  if(!ids.includes(question.id)) ids.push(question.id);
  history[cat]=ids.slice(-2000);
  saveQuestionHistory(history);
  enqueueQuestionSeen(cat,question.id);
  scheduleQuestionSeenFlush();
}

// ────────── الإحصاءات (محفوظة دائماً ومعزولة حسب الحساب)
function emptyStats(){ return {games:0, correct:0, totalQ:0, bestScore:0, wins:0, ach:{}}; }
let stats=emptyStats();
function loadStats(uid=window._currentUid||storeGet('authUid','')){
  return uid ? storeGet(scopedAccessKey('stats',uid),emptyStats()) : emptyStats();
}
function saveStats(){
  const uid=window._currentUid||storeGet('authUid','');
  if(uid) storeSet(scopedAccessKey('stats',uid),stats);
}

const ACHIEVEMENTS=[
  {id:'first', icon:'🎮', t:'أول جولة', d:'خلّصت أول جولة', chk:s=>s.games>=1},
  {id:'sharp', icon:'🎯', t:'فطنة حادة', d:'جاوبت ١٠ أسئلة صح', chk:s=>s.correct>=10},
  {id:'genius', icon:'🧠', t:'عبقري', d:'جاوبت ٥٠ سؤال صح', chk:s=>s.correct>=50},
  {id:'champ', icon:'🏆', t:'بطل', d:'فزت ٣ جولات', chk:s=>s.wins>=3},
  {id:'highroll', icon:'💎', t:'الكبار', d:'حققت ٣٠٠٠ نقطة بجولة', chk:s=>s.bestScore>=3000},
  {id:'marathon', icon:'🔥', t:'ماراثون', d:'لعبت ١٠ جولات', chk:s=>s.games>=10},
];

// ────────── الصوت والاهتزاز
let soundOn=storeGet('sound', true), actx=null;
function ac(){ if(!actx){ try{actx=new (window.AudioContext||window.webkitAudioContext)();}catch(e){} } return actx; }
function beep(freq,dur,type,vol){
  if(!soundOn) return; const c=ac(); if(!c) return;
  const o=c.createOscillator(), g=c.createGain();
  o.type=type||'sine'; o.frequency.value=freq;
  g.gain.setValueAtTime(vol||0.12,c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001,c.currentTime+(dur||0.15));
  o.connect(g); g.connect(c.destination); o.start(); o.stop(c.currentTime+(dur||0.15));
}
function sfx(kind){
  if(!soundOn) return;
  if(kind==='tap') beep(520,0.07,'sine',0.08);
  else if(kind==='start'){ beep(440,0.1,'triangle',0.1); setTimeout(()=>beep(660,0.14,'triangle',0.1),90); }
  else if(kind==='correct'){ beep(660,0.1,'sine',0.12); setTimeout(()=>beep(880,0.16,'sine',0.12),100); setTimeout(()=>beep(1100,0.2,'sine',0.1),210); }
  else if(kind==='wrong'){ beep(200,0.25,'sawtooth',0.1); }
  else if(kind==='tick') beep(700,0.05,'square',0.05);
  else if(kind==='win'){ [523,659,784,1047].forEach((f,i)=>setTimeout(()=>beep(f,0.22,'triangle',0.12),i*130)); }
  else if(kind==='ach'){ beep(880,0.1,'sine',0.1); setTimeout(()=>beep(1320,0.2,'sine',0.1),110); }
}
function vibrate(pattern){
  // أولوية Capacitor Haptics (يعمل فعلياً على iOS)، وإلا navigator.vibrate كاحتياط للمتصفح
  try{
    const H=window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
    if(H){ H.impact({style:'LIGHT'}); return; }
  }catch(e){}
  if(navigator.vibrate){ try{navigator.vibrate(pattern);}catch(e){} }
}


// ────────── منع إطفاء الشاشة أثناء السؤال
// السؤال شفهي "يُقرأ ولا يُلمس" لمدة تصل لدقيقة — يجب ألا تُطفئ iOS الشاشة أثناءه.
function keepAwakeOn(){
  try{
    const K=window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.KeepAwake;
    if(K){ K.keepAwake(); return; }
  }catch(e){}
  try{
    if(navigator.wakeLock){
      navigator.wakeLock.request('screen').then(lock=>{ state.wakeLock=lock; }).catch(()=>{});
    }
  }catch(e){}
}
function keepAwakeOff(){
  try{
    const K=window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.KeepAwake;
    if(K){ K.allowSleep(); }
  }catch(e){}
  try{ if(state.wakeLock){ state.wakeLock.release(); state.wakeLock=null; } }catch(e){}
}
function toggleSound(){
  soundOn=!soundOn; storeSet('sound', soundOn);
  document.getElementById('sound-btn').textContent=soundOn?'🔊':'🔇';
  if(soundOn) sfx('tap');
}

// ────────── تنقّل
function screenAccessibilityTitle(screen){
  if(!screen) return null;
  const onboardingTitle=screen.querySelector('.onb-card.active [data-screen-title]');
  return onboardingTitle||screen.querySelector('[data-screen-title],h1,h2,[role="heading"]');
}
function focusScreenAccessibilityTitle(screen){
  const title=screenAccessibilityTitle(screen);
  if(!title) return;
  title.setAttribute('tabindex','-1');
  try{ title.focus({preventScroll:true}); }
  catch(error){ try{ title.focus(); }catch(focusError){} }
}
function go(id){
  const focused=document.activeElement;
  if(focused && typeof focused.blur==='function') focused.blur();
  const destination=document.getElementById(id);
  if(!destination) return;
  document.querySelectorAll('.screen').forEach(screen=>{
    const active=screen===destination;
    screen.classList.toggle('active',active);
    screen.setAttribute('aria-hidden',active?'false':'true');
  });
  const resetScroll=()=>{
    window.scrollTo(0,0);
    document.documentElement.scrollTop=0;
    document.body.scrollTop=0;
    if(document.scrollingElement) document.scrollingElement.scrollTop=0;
  };
  resetScroll();
  window.requestAnimationFrame(resetScroll);
  window.setTimeout(resetScroll,0);
  window.setTimeout(resetScroll,450);
  window.requestAnimationFrame(()=>focusScreenAccessibilityTitle(destination));
  // لا تبدأ أسعار RevenueCat قبل وجود جلسة Firebase وهوية RevenueCat؛
  // هذا يسمح بعرض شاشة الاشتراك فوراً عند الإقلاع من دون طلبات فاشلة.
  if(id==='s-paywall' && typeof loadPaywallPrices==='function'){
    void trackMetric('paywall_viewed',{freeRoundCompleted:localFreeRoundCompleted()});
    // على الويب لا توجد تهيئة RevenueCat أصلاً؛ استدعِ الدالة فوراً كي تعرض
    // ملاحظة أن الدفع متاح داخل iOS بدلاً من ترك الشاشة على «جاري الجلب».
    loadPaywallPrices().catch(()=>logClientEvent('error','paywall.prices'));
  }
}

const modalFocusOrigins=new Map();
function modalFocusableElements(modal){
  return [...modal.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
    .filter(element=>element.getClientRects().length>0&&getComputedStyle(element).visibility!=='hidden'
      &&!element.closest('[aria-hidden="true"],[inert]'));
}
function trapTabWithin(event,container){
  const focusable=modalFocusableElements(container);
  if(!focusable.length){ event.preventDefault(); return; }
  const first=focusable[0],last=focusable[focusable.length-1];
  if(!container.contains(document.activeElement)){
    event.preventDefault();
    (event.shiftKey?last:first).focus();
  }else if(event.shiftKey&&document.activeElement===first){
    event.preventDefault(); last.focus();
  }else if(!event.shiftKey&&document.activeElement===last){
    event.preventDefault(); first.focus();
  }
}
function openAccessibleModal(id,preferredSelector=''){
  const modal=document.getElementById(id);
  if(!modal) return;
  if(!modal.classList.contains('show')) modalFocusOrigins.set(id,document.activeElement);
  modal.classList.add('show');
  modal.setAttribute('aria-hidden','false');
  const preferred=preferredSelector?modal.querySelector(preferredSelector):null;
  const target=preferred||modalFocusableElements(modal)[0]||modal.querySelector('.modal');
  if(target){
    if(!target.matches('button,a,input,select,textarea,[tabindex]')) target.setAttribute('tabindex','-1');
    try{ target.focus({preventScroll:true}); }catch(error){ try{ target.focus(); }catch(focusError){} }
  }
}
function closeAccessibleModal(id,{restoreFocus=true}={}){
  const modal=document.getElementById(id);
  if(!modal) return;
  modal.classList.remove('show');
  modal.setAttribute('aria-hidden','true');
  const origin=modalFocusOrigins.get(id);
  modalFocusOrigins.delete(id);
  if(restoreFocus&&origin&&origin.isConnected&&typeof origin.focus==='function'){
    const restore=()=>{
      try{ origin.focus({preventScroll:true}); }catch(error){ try{ origin.focus(); }catch(focusError){} }
    };
    restore();
    // انتقال الشاشة قد يركّز عنوانها بشكل مؤجل؛ أعد التركيز بعد إطارين
    // حتى يبقى VoiceOver عند الزر الذي فتح النافذة بثبات.
    requestAnimationFrame(()=>requestAnimationFrame(restore));
  }
}
document.addEventListener('keydown',event=>{
  const modal=document.querySelector('.modal-wrap.show[role="dialog"]');
  if(modal){
    if(event.key==='Escape'){
      const cancel=modal.querySelector('[data-modal-cancel]');
      if(cancel){ event.preventDefault(); cancel.click(); }
      return;
    }
    if(event.key==='Tab') trapTabWithin(event,modal);
    return;
  }
  const question=document.querySelector('#q-wrap.show[role="dialog"]');
  if(question&&event.key==='Tab') trapTabWithin(event,question);
});
(function initializeAccessibilityState(){
  document.querySelectorAll('.screen').forEach(screen=>{
    screen.setAttribute('aria-hidden',screen.classList.contains('active')?'false':'true');
  });
  document.querySelectorAll('.modal-wrap[role="dialog"]').forEach(modal=>{
    modal.setAttribute('aria-hidden',modal.classList.contains('show')?'false':'true');
  });
})();
function closePaywall(){
  const uid=window._currentUid||storeGet('authUid','');
  if(uid){ updateFreeRoundUi(); go('s-home'); }
  else go('s-auth');
}

// ────────── الخروج من الجولة
function confirmExit(){
  sfx('tap'); vibrate(15);
  openAccessibleModal('exit-modal');
}
function closeExitModal(){
  sfx('tap');
  closeAccessibleModal('exit-modal');
}
function doExit(){
  sfx('tap'); vibrate(20);
  // أوقف أي مؤقّتات جارية وأغلق السؤال إن كان مفتوحاً
  clearInterval(state.timer); clearInterval(state.searchTimer);
  keepAwakeOff();
  hideQuestionScreen(false);
  state.roundActive=false; state.cur=null;
  clearActiveRound();
  closeAccessibleModal('exit-modal',{restoreFocus:false});
  go('s-home');
}

// ────────── حذف الحساب (5.1.1)
// إعادة المصادقة عند requires-recent-login حسب مزوّد الدخول المخزَّن
async function reauthThen(provider, fn){
  // Normalize Firebase providerId format (stored as 'apple.com'/'google.com' in old sessions)
  if(provider==='apple.com') provider='apple';
  if(provider==='google.com') provider='google';
  logClientEvent('info','auth.reauth.start');
  const FA=window.Capacitor?.Plugins?.FirebaseAuthentication;
  if(FA){
    if(provider==='google'){
      if(typeof FA.reauthenticateWithGoogle==='function') await FA.reauthenticateWithGoogle();
      else await FA.signInWithGoogle();
    } else if(provider==='apple'){
      const hasReauth = typeof FA.reauthenticateWithApple==='function';
      try{
        if(hasReauth) await FA.reauthenticateWithApple();
        else await FA.signInWithApple();
      }catch(appleErr){
        logClientEvent('error','auth.reauth.apple');
        throw appleErr;
      }
    } else if(provider==='password'){
      const email = storeGet('authEmail','');
      const password = prompt('عشان نأكد الحذف، اكتب كلمة مرور حساب ' + email + ':');
      if(!password) throw new Error('cancelled');
      await FA.signInWithEmailAndPassword({email, password});
    } else {
      // anonymous — لا توجد طريقة لإعادة المصادقة، الجلسة عادةً حديثة أصلاً
      throw new Error('no-reauth-anonymous');
    }
    return fn();
  }
  const wb=await getFirebaseWebAuth();
  if(wb && wb.auth.currentUser){
    const { reauthenticateWithPopup, reauthenticateWithCredential, EmailAuthProvider } =
      await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
    if(provider==='password'){
      const email = storeGet('authEmail','');
      const password = prompt('عشان نأكد الحذف، اكتب كلمة مرور حساب ' + email + ':');
      if(!password) throw new Error('cancelled');
      await reauthenticateWithCredential(wb.auth.currentUser, EmailAuthProvider.credential(email, password));
    } else if(provider==='google' || provider==='apple'){
      const p = provider==='google' ? new wb.GoogleAuthProvider() : new wb.OAuthProvider('apple.com');
      await reauthenticateWithPopup(wb.auth.currentUser, p);
    } else {
      throw new Error('no-reauth-anonymous');
    }
    return fn();
  }
  throw new Error('no-auth-layer');
}

// حذف مستخدم Firebase فعلياً (شرط Apple 5.1.1) — وليس تسجيل خروج فقط
async function deleteFirebaseUser(){
  const provider = storeGet('authProvider','');
  // الطبقة الأولى: مكوّن Capacitor الأصلي (iOS)
  const FA=window.Capacitor?.Plugins?.FirebaseAuthentication;
  if(FA){
    try{
      const cur = await FA.getCurrentUser().catch(()=>null);
      if(!cur || !cur.user) return true; // لا يوجد مستخدم Firebase — دخول بالاسم فقط
      await FA.deleteUser();
      // قد تسجّل الطبقة الأصلية RuntimeError من دون رفض الـ Promise في
      // JavaScript. لا نعرض نجاح الحذف قبل التأكد أن المستخدم اختفى فعلياً.
      const remainingUser = await FA.getCurrentUser().catch(()=>null);
      if(remainingUser && remainingUser.user){
        throw new Error('Firebase user still exists after deleteUser');
      }
      return true;
    }catch(e){
      const msg = String(e?.code||e?.message||e);
      if(msg.includes('requires-recent-login')){
        try{ await reauthThen(provider, ()=>FA.deleteUser()); return true; }
        catch(e2){
          logClientEvent('error','auth.delete.reauthentication');
          const isEmptyObject=typeof e2==='object' && e2!==null
            && Object.keys(e2).length===0;
          const isCancelled = !e2 || isEmptyObject ||
            (e2?.code||'').includes('CANCEL') || (e2?.message||'').toLowerCase().includes('cancel') ||
            e2?.code==='1001'; // ASAuthorizationError.canceled
          if(isCancelled) showToast('❌','لغيت التحقق','عشان تحذف الحساب، كمّل التحقق عن طريق Apple',false);
          return false;
        }
      }
      logClientEvent('error','auth.delete.capacitor');
      return false;
    }
  }
  // الطبقة الثانية: Firebase Web SDK (متصفح)
  const wb=await getFirebaseWebAuth();
  if(wb){
    const user = wb.auth.currentUser;
    if(!user) return true; // لا يوجد مستخدم Firebase مسجَّل
    try{
      const { deleteUser } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
      await deleteUser(user);
      return true;
    }catch(e){
      if(e && e.code==='auth/requires-recent-login'){
        try{
          const { deleteUser } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
          await reauthThen(provider, ()=>deleteUser(wb.auth.currentUser));
          return true;
        }catch(e2){ logClientEvent('error','auth.delete.web-reauthentication'); return false; }
      }
      logClientEvent('error','auth.delete.web');
      return false;
    }
  }
  return true; // لا توجد طبقة Firebase أصلاً (دخول بالاسم)
}

let _accountActionPending=false;
function beginAccountAction(message){
  if(_accountActionPending) return false;
  _accountActionPending=true;
  ['sign-out-btn','delete-account-btn'].forEach(id=>{ const button=document.getElementById(id); if(button) button.disabled=true; });
  const msg=document.getElementById('account-action-msg');
  if(msg) msg.textContent=`⏳ ${message}`;
  return true;
}
function endAccountAction(){
  _accountActionPending=false;
  ['sign-out-btn','delete-account-btn'].forEach(id=>{ const button=document.getElementById(id); if(button) button.disabled=false; });
  const msg=document.getElementById('account-action-msg');
  if(msg) msg.textContent='';
}

async function signOut(){
  const ok=confirm('تبي تسجّل خروج؟ بياناتك المحلية راح تظل محفوظة على هالجهاز.');
  if(!ok) return;
  if(!beginAccountAction('ثواني ونسجّل خروجك…')) return;
  let completed=false;
  try{
  await resetVerificationSession();
  // امسح توكن Firebase من Keychain (يمنع الدخول التلقائي بعد إعادة التثبيت)
  try{
    const FA=window.Capacitor?.Plugins?.FirebaseAuthentication;
    if(FA) await FA.signOut();
  }catch(e){ logClientEvent('warn','auth.signout'); }
  // افصل RevenueCat أيضاً حتى لا يرث الحساب التالي اشتراك المستخدم السابق.
  await resetRevenueCatIdentity();
  // امسح مفاتيح الهوية فقط من التخزين المحلي (ابقِ الإحصاءات والإنجازات)
  ['authUid','authProvider','authEmail','playerName','rcAppUserId','deviceId'].forEach(k=>{
    localStorage.removeItem(STORAGE_PREFIX+k);
    try{
      const P=window.Capacitor?.Plugins?.Preferences;
      if(P) P.remove({key:STORAGE_PREFIX+k});
    }catch(e){}
  });
  window._currentUid = '';
  clearIdTokenCache();
  stats=emptyStats();
  familyCats=[];
  showToast('✅','تم تسجيل الخروج','تقدر تدخل بحساب ثاني',false);
  completed=true;
  setTimeout(()=>{ endAccountAction(); go('s-auth'); },1200);
  }finally{ if(!completed) endAccountAction(); }
}

async function confirmDeleteAccount(){
  const ok=confirm('راح نحذف حسابك نهائياً من فطنة مع النقاط والإنجازات والفئات العائلية. حذف الحساب لا يلغي اشتراك App Store المتجدد؛ ألغِه من «إدارة اشتراك Apple» إذا ما تبي تستمر الفوترة. ما تقدر تتراجع. تبي تكمّل؟');
  if(!ok) return;
  if(!beginAccountAction('ثواني ونحذف الحساب والبيانات…')) return;
  let completed=false;
  try{
  const uid = storeGet('authUid','');
  // 1) احذف بيانات الخادم أولاً. لا يجوز حذف هوية Firebase ثم
  // ترك البيانات الخادمية دون طريقة للمستخدم لإعادة المحاولة.
  if(uid){
    try{
      const idToken = await getCurrentIdToken(true);
      const resp = await apiFetch('/api/account/delete',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({uid, idToken})
      });
      if(!resp.ok){
        let detail='';
        try{ detail=(await resp.json())?.error||''; }catch(e){}
        throw new Error(detail || `server delete returned ${resp.status}`);
      }
    }catch(e){
      logClientEvent('warn','account.server-delete');
      showToast('⚠️','ما قدرنا نحذف الحساب','بياناتك ما انحذفت. تأكد من النت وجرّب مرة ثانية',false);
      return;
    }
  }
  // 2) احذف مستخدم Firebase فعلياً (مع معالجة requires-recent-login)
  const deleted = await deleteFirebaseUser();
  if(!deleted){
    showToast('⚠️','ما اكتمل حذف الحساب','سجّل دخولك من جديد وجرّب مرة ثانية',false);
    return;
  }
  // 3) افصل RevenueCat بعد نجاح حذف هوية Firebase. إبقاء SDK على هوية
  // المستخدم المحذوف كان يعيد حالة اشتراكه عند فتح التطبيق أو دخول حساب آخر.
  await resetRevenueCatIdentity();
  const rcIds=storeGet('rcAppUserIds',{}) || {};
  delete rcIds[uid];
  storeSet('rcAppUserIds',rcIds);
  storeSet('rcAppUserId','');
  await resetVerificationSession();
  // 4) امسح Keychain عبر signOut صريح
  try{
    const FA=window.Capacitor?.Plugins?.FirebaseAuthentication;
    if(FA) await FA.signOut();
  }catch(e){}
  // 5) امسح localStorage و Capacitor Preferences بالكامل
  const keys=Object.keys(localStorage).filter(k=>k.startsWith(STORAGE_PREFIX));
  keys.forEach(k=>localStorage.removeItem(k));
  try{
    const P=window.Capacitor?.Plugins?.Preferences;
    if(P) await P.clear();
  }catch(e){}
  // صفّر كل حالة بالذاكرة كانت مرتبطة بالحساب المحذوف — وإلا يبقى مرجعها حياً
  // بالجلسة الحالية (window._currentUid، الفئات العائلية) رغم مسح القرص، ويمكن
  // أن يظهر لأي حساب تالٍ يسجّل الدخول بنفس الجلسة على جهاز مشترك
  window._currentUid = '';
  clearIdTokenCache();
  familyCats = [];
  stats=emptyStats();
  showToast('✅','حذفنا حسابك','انحذف حساب فطنة وبياناته. اشتراك Apple يظل منفصل',false);
  completed=true;
  setTimeout(()=>{ endAccountAction(); go('s-auth'); },1500);
  }finally{ if(!completed) endAccountAction(); }
}

// ---- نظام الهوية الموحّد ----
// كل شخص = uid واحد ثابت بغض النظر عن وسيلة الدخول. عند أول فتح للتطبيق نبدأ
// بجلسة Firebase مجهولة (anonymous) تلقائياً بلا شاشة تسجيل إجبارية، وعند
// التسجيل لاحقاً بأي مزوّد نربطه بنفس الحساب (linkWithCredential) بدل إنشاء
// حساب جديد — فلا يضيع تقدّم اللاعب أبداً.

function toggleEmailForm(){
  sfx('tap');
  const f=document.getElementById('auth-email-form');
  if(f) f.style.display = f.style.display==='none' ? 'block' : 'none';
}

function currentScreenId(){
  const el=document.querySelector('.screen.active');
  return el ? el.id : 's-home';
}

// أين نُعيد المستخدم بعد نجاح تسجيل الدخول/الربط (الشاشة التي بدأ منها)
window._authReturnScreen = 's-home';

function skipAuth(){
  sfx('tap');
  const target = window._authReturnScreen || 's-home';
  if(target==='s-stats'){ go('s-stats'); return; }
  checkSubscriptionAndRoute(storeGet('authUid',''));
}

function openAuth(fromScreen){
  window._authReturnScreen = fromScreen || currentScreenId();
  document.getElementById('auth-title').textContent = 'اربط حسابك';
  document.getElementById('auth-sub').textContent = 'سجّل بالطريقة اللي تناسبك عشان تحفظ نقاطك وإنجازاتك حتى لو بدّلت جهازك';
  document.getElementById('auth-msg').textContent = '';
  go('s-auth');
}

// جلسة مجهولة أولى: تُنشأ تلقائياً عند أول فتح للتطبيق بلا حساب محفوظ
async function ensureAnonymousSession(){
  let uid = storeGet('authUid','');
  const storedProvider = storeGet('authProvider','anonymous');
  // الإصدارات السابقة كانت تحفظ المعرف المحلي الاحتياطي على أنه anonymous.
  // بعد تفعيل Firebase Anonymous ننشئ جلسة Firebase حقيقية بدلاً من إبقاء
  // الجهاز على هوية لا تحمل ID token ولا يمكنها استخدام الاشتراكات.
  const mustRestoreAnonymousSession = storedProvider === 'anonymous';
  if(uid && storedProvider !== 'local' && !mustRestoreAnonymousSession) {
    return {uid, provider: storedProvider};
  }
  if(storedProvider === 'local' || mustRestoreAnonymousSession) uid = '';

  const FA=getFirebaseAuth();
  if(FA){
    // جلسة Firebase قد تبقى في Keychain بعد إعادة تثبيت التطبيق رغم مسح Preferences —
    // استرجعها أولاً حتى لا نستبدل حساباً حقيقياً بجلسة مجهولة أو معرّف محلي.
    try{
      const cur = await FA.getCurrentUser();
      const u = cur && cur.user;
      if(u && u.uid){
        const prov=(u.providerData && u.providerData[0] && u.providerData[0].providerId)
          || (u.isAnonymous ? 'anonymous' : 'firebase');
        storeSet('authUid', u.uid);
        storeSet('authProvider', prov);
        return {uid: u.uid, provider: prov};
      }
    }catch(e){}
    try{
      const res = await FA.signInAnonymously();
      uid = res && res.user && res.user.uid;
    }catch(e){
      const code=String(e && (e.code||e.message) || '');
      if(code.includes('admin-restricted-operation') || code.includes('restricted to administrators')){
        logClientEvent('warn','auth.anonymous.disabled');
      } else {
        logClientEvent('error','auth.anonymous.capacitor');
      }
    }
  }
  if(!uid){
    const wb=await getFirebaseWebAuth();
    if(wb){
      try{
        const cu = wb.auth && wb.auth.currentUser;
        if(cu && cu.uid){
          const prov=(cu.providerData && cu.providerData[0] && cu.providerData[0].providerId)
            || (cu.isAnonymous ? 'anonymous' : 'firebase');
          storeSet('authUid', cu.uid);
          storeSet('authProvider', prov);
          return {uid: cu.uid, provider: prov};
        }
        const { signInAnonymously } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
        const result = await signInAnonymously(wb.auth);
        uid = result.user.uid;
      }catch(e){
        if(e && e.code === 'auth/admin-restricted-operation'){
          logClientEvent('warn','auth.anonymous.disabled');
        } else {
          logClientEvent('error','auth.anonymous.web');
        }
      }
    }
  }
  let provider = 'anonymous';
  if(!uid){
    // احتياط كامل بلا اتصال/بلا Firebase config: معرّف جهاز محلي ثابت
    uid = storeGet('deviceId','');
    if(!uid){
      uid = 'anon_' + Date.now().toString(36) + Math.random().toString(36).substr(2,6);
      storeSet('deviceId', uid);
    }
    provider = 'local';
  }
  storeSet('authUid', uid);
  storeSet('authProvider', provider);
  return {uid, provider};
}

// نجاح الدخول/الربط بأي وسيلة — يوحّد كل مسارات ما بعد المصادقة
function afterAuthSuccess(name, provider, uid, email){
  sfx('start'); vibrate(20);
  const previousUid=String(window._currentUid||storeGet('authUid','')||'');
  const nextUid=String(uid||storeGet('authUid','')||'');
  // قد يعيد تسجيل الدخول حساب Firebase مختلفاً عن الحساب الذي كان RevenueCat
  // مهيأً له. صفّر الصلاحية والكاش فوراً، ثم لا تبدأ فحص الحساب الجديد قبل
  // أن ينتهي فصل هوية SDK القديمة.
  const revenueCatIdentityReset=previousUid && nextUid && previousUid!==nextUid
    ? resetRevenueCatIdentity()
    : Promise.resolve();
  if(name) storeSet('playerName', name);
  storeSet('authProvider', provider);
  if(uid) storeSet('authUid', uid);
  if(email) storeSet('authEmail', email);
  window._currentUid = uid || storeGet('authUid','');
  activateLocalAccount(window._currentUid);
  const nameEl=document.getElementById('user-name');
  if(nameEl) nameEl.textContent = storeGet('playerName','لاعب');
  const emailForm=document.getElementById('auth-email-form');
  if(emailForm) emailForm.style.display='none';
  const phoneForm=document.getElementById('auth-phone-form');
  if(phoneForm) phoneForm.style.display='none';
  showToast('✅','دخلت بنجاح','ربطنا حسابك',false);
  renderAccountLinks();
  const target = window._authReturnScreen || 's-home';
  if(target==='s-stats'){ go('s-stats'); }
  else if(!storeGet('onbDone', false)){ _onbStep=0; _onbSetStep(0); go('s-onb'); }
  else {
    void revenueCatIdentityReset.then(()=>checkSubscriptionAndRoute(window._currentUid));
  }
  void syncQuestionHistory();
  void flushMetricEvents();
}

// نشارك طلب الرمز القصير بين العمليات المتزامنة عند الإقلاع. كانت تهيئة
// RevenueCat والتحقق من الاشتراك تطلبان الرمز نفسه في الوقت نفسه من iOS.
const _idTokenCache = { token:'', validUntil:0, pending:null };
function clearIdTokenCache(){
  _idTokenCache.token='';
  _idTokenCache.validUntil=0;
  _idTokenCache.pending=null;
}

// جلب ID token للمستخدم الحالي (لإثبات الهوية للخادم)
async function getCurrentIdToken(forceRefresh=false){
  if(!forceRefresh && _idTokenCache.token && Date.now() < _idTokenCache.validUntil){
    return _idTokenCache.token;
  }
  if(!forceRefresh && _idTokenCache.pending) return _idTokenCache.pending;
  const request = (async ()=>{
    try{
      const FA=getFirebaseAuth();
      if(FA){
        // لا تطلب رمزاً بعد تسجيل الخروج أو الحذف؛ لن ينتج رمز صالح وسيظهر
        // RuntimeError متكرر في سجل iOS.
        const current = await FA.getCurrentUser().catch(()=>null);
        if(!current || !current.user) return '';
        const r=await FA.getIdToken({forceRefresh:!!forceRefresh});
        return (r && r.token) || '';
      }
    }catch(e){}
    try{
      const wb=await getFirebaseWebAuth();
      if(wb && wb.auth.currentUser) return await wb.auth.currentUser.getIdToken(!!forceRefresh);
    }catch(e){}
    return '';
  })();
  if(forceRefresh) return request;
  _idTokenCache.pending=request;
  try{
    const token=await request;
    if(token){
      _idTokenCache.token=token;
      _idTokenCache.validUntil=Date.now()+10000;
    }
    return token;
  }finally{
    _idTokenCache.pending=null;
  }
}

// حفظ اسم/بريد المستخدم بشكل دائم في قاعدة بيانات الخادم — ضروري خصوصاً
// لـ Apple التي لا ترسل هذه الحقول إلا في أول تفويض فقط
async function savePermanentProfile(uid, name, email, provider){
  if(!uid) return;
  try{
    const idToken = await getCurrentIdToken();
    await apiFetch('/api/account/profile', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({uid, name: name||'', email: email||'', provider: provider||'', idToken})
    });
  }catch(e){ logClientEvent('error','profile.save'); }
}

// ─── الربط التفاعلي: يعالج auth/account-exists-with-different-credential ───
// يعيد true إن تمت معالجة الخطأ (سواء بعرض توضيح أو ببدء مسار الربط)
async function handleAuthConflict(e, attemptedProvider, wb){
  const code = String((e && e.code) || '');
  if(!code.includes('account-exists-with-different-credential') && !code.includes('credential-already-in-use')) return false;

  let email = e && (e.email || (e.customData && e.customData.email));
  let pendingCred = null;
  if(wb && e && e.customData){
    try{
      const { OAuthProvider, GoogleAuthProvider } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
      pendingCred = attemptedProvider==='google'
        ? GoogleAuthProvider.credentialFromError(e)
        : OAuthProvider.credentialFromError(e);
    }catch(err){}
  }

  let methods = [];
  if(email){
    try{
      const wbAuth = wb || await getFirebaseWebAuth();
      if(wbAuth){
        const { fetchSignInMethodsForEmail } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
        methods = await fetchSignInMethodsForEmail(wbAuth.auth, email);
      }
    }catch(err){}
  }
  const original = methods[0] || '';
  const originalLabel = original.includes('google') ? 'Google'
    : original.includes('apple') ? 'Apple'
    : original.includes('password') ? 'البريد وكلمة المرور'
    : 'طريقتك الأساسية';

  window._pendingLinkCred    = pendingCred;
  window._pendingLinkEmail   = email || '';
  window._pendingLinkOriginal= original;

  openAuth(window._authReturnScreen || currentScreenId());
  document.getElementById('auth-title').textContent = 'عندك حساب من قبل';
  document.getElementById('auth-sub').textContent = email
    ? `البريد (${email}) مسجَّل من قبل عن طريق ${originalLabel}. سجّل دخولك بهالطريقة أول وبنربط حسابك تلقائياً.`
    : 'عندك حساب بطريقة دخول ثانية. سجّل دخولك بطريقتك الأساسية أول، وبعدها تقدر تربط الطريقة الجديدة من إعدادات الحساب.';
  if(original.includes('password') && email){
    document.getElementById('auth-email-form').style.display='block';
    document.getElementById('auth-email').value = email;
  }
  showToast('🔗','عندك حساب من قبل', originalLabel ? `سجّل عن طريق ${originalLabel} عشان تكمّل` : 'سجّل بطريقتك الأساسية', false);
  return true;
}

// بعد نجاح تسجيل الدخول بالطريقة الأصلية، إن كان هناك ربط معلّق نكمله تلقائياً
async function resolvePendingLinkWeb(wb, userAfterSignIn){
  if(!window._pendingLinkCred || !userAfterSignIn) return false;
  try{
    const { linkWithCredential } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
    await linkWithCredential(userAfterSignIn, window._pendingLinkCred);
    showToast('🔗','تم الربط بنجاح','الحين تقدر تدخل بالطريقتين',false);
    return true;
  }catch(e){ logClientEvent('error','auth.pending-link'); return false; }
  finally{
    window._pendingLinkCred=null; window._pendingLinkEmail=null; window._pendingLinkOriginal=null;
  }
}
function clearPendingLinkNative(){
  // على iOS الأصلي عبر Capacitor لا تتوفر واجهة موحّدة لاستخراج بيانات الاعتماد
  // المعلّقة من الخطأ (على عكس Web SDK)، لذا نكتفي بإكمال تسجيل الدخول بالطريقة
  // الأصلية بأمان بدل ربط تلقائي كامل. موثّق في AUTH_SETUP.md.
  window._pendingLinkCred=null; window._pendingLinkEmail=null; window._pendingLinkOriginal=null;
}

// ────────── Firebase Auth — طبقتان: Capacitor (iOS) ثم Web SDK (متصفح)

// الطبقة الأولى: مكوّن Capacitor الأصلي (يعمل داخل iOS app فقط)
function getFirebaseAuth(){
  try{ return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.FirebaseAuthentication; }
  catch(e){ return null; }
}

function getCrashlytics(){
  try{ return window.Capacitor?.Plugins?.FirebaseCrashlytics || null; }
  catch(e){ return null; }
}
// لا نرسل رسالة الخطأ الخام إلى Crashlytics؛ فقد تحتوي على بريد أو هاتف أو
// token أو URL أو استجابة خادم. التشخيص الخارجي يقتصر على موقع معروف داخل
// التطبيق وكود أصلي ثابت راجعناه مسبقاً.
const CRASH_SOURCE_ALLOWLIST=new Set([
  'firebase.app-check.initialize','firebase.app-check.token',
  'preferences.hydrate','device-check.token','app-attest.reset',
  'app-attest.enroll','app-attest.assertion.free_round_status',
  'app-attest.assertion.free_round_complete','free-round.claim',
  'firebase.messaging.permission','firebase.messaging.account',
  'firebase.messaging','apple.offer-code','question.report',
  'window.error','unhandledrejection','application.start',
]);
const CRASH_CODE_ALLOWLIST=new Set([
  'DEVICE_CHECK_UNSUPPORTED','DEVICE_CHECK_FAILED',
  'APP_ATTEST_INVALID_KEY_ID','APP_ATTEST_UNSUPPORTED',
  'APP_ATTEST_KEY_NOT_GENERATED','APP_ATTEST_INVALID_CLIENT_DATA_HASH',
  'APP_ATTEST_KEYCHAIN_LOCKED','APP_ATTEST_KEYCHAIN_FAILED',
  'APP_ATTEST_SERVER_UNAVAILABLE','APP_ATTEST_INVALID_KEY',
  'APP_ATTEST_INVALID_INPUT','APP_ATTEST_FAILED','APP_ATTEST_KEY_RESET',
]);
function safeCrashSource(source){
  return typeof source==='string'&&CRASH_SOURCE_ALLOWLIST.has(source)
    ?source:'application.nonfatal';
}
function safeCrashCode(error){
  try{
    const code=typeof error?.code==='string'?error.code:'';
    return CRASH_CODE_ALLOWLIST.has(code)?code:'unspecified';
  }catch(_){
    return 'unspecified';
  }
}
function recordNonFatal(error, source){
  const crashlytics=getCrashlytics();
  if(!crashlytics) return;
  const message=`nonfatal:${safeCrashSource(source)}:${safeCrashCode(error)}`;
  try{
    const pending=crashlytics.recordException({message});
    if(pending?.catch) pending.catch(()=>{});
  }catch(_){ /* لا نسمح لتعطل أداة التشخيص بتعطيل التطبيق */ }
}
function initCrashReporting(){
  const crashlytics=getCrashlytics();
  if(!crashlytics) return;
  crashlytics.setEnabled({enabled:true}).catch(()=>{});
  // تقارير الأعطال تشخيصية على مستوى التطبيق وليست ملفاً للمستخدم؛ إبقاء
  // الهوية فارغة يمنع نسبة crash مؤجل إلى حساب دخل لاحقاً على الجهاز نفسه.
  crashlytics.setUserId({userId:''}).catch(()=>{});
  window.addEventListener('error', event=>recordNonFatal(event.error||event.message,'window.error'));
  window.addEventListener('unhandledrejection', event=>recordNonFatal(event.reason,'unhandledrejection'));
}

function getFirebaseMessaging(){
  try{ return window.Capacitor?.Plugins?.FirebaseMessaging || null; }
  catch(e){ return null; }
}
let _pushListenersReady=false;
function renderPushPermission(status){
  const label=document.getElementById('notification-permission-status');
  const button=document.getElementById('enable-notifications-btn');
  if(label){
    label.textContent=status==='granted'
      ? '✓ الإشعارات شغّالة على هالجهاز'
      : status==='denied'
        ? 'الإشعارات موقوفة من إعدادات الجهاز'
        : 'فعّلها عشان توصلك التنبيهات المهمة اللي تختارها';
  }
  if(button){
    button.disabled=status==='granted';
    button.textContent=status==='granted'?'✓ الإشعارات شغّالة':'🔔 فعّل الإشعارات';
  }
}
async function initPushMessaging(){
  const messaging=getFirebaseMessaging();
  if(!messaging) return false;
  if(!_pushListenersReady){
    _pushListenersReady=true;
    await messaging.addListener('notificationReceived', event=>{
      logClientEvent('info','messaging.received');
    });
    await messaging.addListener('notificationActionPerformed', event=>{
      logClientEvent('info','messaging.opened');
    });
    await messaging.addListener('tokenReceived', event=>{
      if(event && event.token) logClientEvent('info','messaging.token-received');
    });
  }
  const current=await messaging.checkPermissions();
  renderPushPermission(current.receive);
  // لا نعرض نافذة النظام عند الإقلاع. يطلبها المستخدم من شاشة الحساب بعد
  // شرح الفائدة، وهو توقيت أكثر وضوحاً واحتراماً لقراره.
  if(current.receive!=='granted') return false;
  const {token}=await messaging.getToken();
  if(token) logClientEvent('info','messaging.token-ready');
  return true;
}
async function enablePushNotifications(){
  const messaging=getFirebaseMessaging();
  if(!messaging){
    showToast('ℹ️','الإشعارات مو متوفرة هني','هالميزة موجودة داخل تطبيق iPhone',false);
    return false;
  }
  const button=document.getElementById('enable-notifications-btn');
  if(button) button.disabled=true;
  try{
    const permission=await messaging.requestPermissions();
    renderPushPermission(permission.receive);
    if(permission.receive!=='granted'){
      showToast('🔕','ما فعّلت الإشعارات','تقدر تغيّر اختيارك من إعدادات iPhone',false);
      return false;
    }
    const {token}=await messaging.getToken();
    if(!token) throw new Error('تعذّر إنشاء رمز الإشعارات');
    showToast('🔔','شغّلنا الإشعارات','راح نرسل التنبيهات المهمة بس',false);
    return true;
  }catch(error){
    recordNonFatal(error,'firebase.messaging.permission');
    showToast('⚠️','ما قدرنا نشغّل الإشعارات','جرّب من إعدادات iPhone',false);
    return false;
  }finally{
    const current=await messaging.checkPermissions().catch(()=>({receive:'prompt'}));
    renderPushPermission(current.receive);
  }
}

function isAuthCancellation(e){
  const detail = String((e && (e.code || e.message)) || '').toLowerCase();
  return detail.includes('cancel') || detail.includes('popup-closed-by-user');
}

function isAuthNetworkError(e){
  const detail = String((e && (e.code || e.message)) || '').toLowerCase();
  return detail.includes('network-request-failed') || detail.includes('network error')
    || detail.includes('not connected') || detail.includes('offline');
}
function showAuthNetworkError(){
  showToast('📡','ماكو اتصال','تأكد من النت وجرّب مرة ثانية',false);
}

let _authActionPending = false;
let _authPendingMessage = '';
function beginAuthAction(message='ثواني ونكمّل العملية…'){
  if(_authActionPending) return false;
  _authActionPending = true;
  _authPendingMessage = `⏳ ${message}`;
  const screen=document.getElementById('s-auth');
  if(screen) screen.setAttribute('aria-busy','true');
  const msg=document.getElementById('auth-msg');
  if(msg){ msg.style.color=''; msg.textContent=_authPendingMessage; }
  document.querySelectorAll('#s-auth .auth-card button').forEach(button=>{ button.disabled=true; });
  return true;
}
function endAuthAction(){
  _authActionPending = false;
  const screen=document.getElementById('s-auth');
  if(screen) screen.removeAttribute('aria-busy');
  const msg=document.getElementById('auth-msg');
  if(msg && msg.textContent===_authPendingMessage) msg.textContent='';
  _authPendingMessage='';
  document.querySelectorAll('#s-auth .auth-card button').forEach(button=>{ button.disabled=false; });
}

// الطبقة الثانية: Firebase Web SDK (يعمل في المتصفح إذا كان FIREBASE_CONFIG جاهزاً)
let _fbWebSDK = null;
async function getFirebaseWebAuth(){
  if(_fbWebSDK) return _fbWebSDK;
  if(!window.FIREBASE_CONFIGURED) return null;
  try{
    const [appMod, authMod] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js'),
    ]);
    const { initializeApp, getApps } = appMod;
    const { getAuth, signInWithPopup, signInWithRedirect, getRedirectResult, GoogleAuthProvider, OAuthProvider } = authMod;
    const app = getApps().length ? getApps()[0] : initializeApp(window.FIREBASE_CONFIG);
    _fbWebSDK = { auth: getAuth(app), signInWithPopup, signInWithRedirect, getRedirectResult, GoogleAuthProvider, OAuthProvider };
    return _fbWebSDK;
  }catch(e){ logClientEvent('error','firebase.web-sdk'); return null; }
}

async function appleSignIn(){
  if(!beginAuthAction('ثواني ونفتح تسجيل الدخول عن طريق Apple…')) return;
  try{
  sfx('tap'); vibrate(15);
  const isAnon = storeGet('authProvider','')==='anonymous';
  // محاولة 1: Capacitor (iOS app)
  const FA = getFirebaseAuth();
  if(FA){
    try{
      const res = isAnon ? await FA.linkWithApple() : await FA.signInWithApple();
      const u = res && res.user;
      if(u){
        if(u.email) storeSet('authEmail', u.email);
        // await إلزامي: بيانات Apple الحقيقية (اسم/بريد) تُرسَل مرة واحدة فقط
        // أبداً — فقدها بسبب تنقّل/إغلاق سريع قبل اكتمال الطلب لا يُسترجع
        await savePermanentProfile(u.uid, u.displayName, u.email, 'apple');
      }
      afterAuthSuccess((u && u.displayName) || storeGet('playerName','لاعب'), 'apple', u && u.uid, u && u.email);
      return;
    }catch(e){
      const code=String(e && e.code || '');
      if(isAuthCancellation(e)) return;
      if(code.includes('account-exists-with-different-credential') || code.includes('credential-already-in-use')){
        await handleAuthConflict(e, 'apple', null); return;
      }
      if(isAuthNetworkError(e)){ showAuthNetworkError(); return; }
      logClientEvent('error','auth.apple.capacitor');
    }
  }
  // محاولة 2: Firebase Web SDK (متصفح) — SDK محمّل مسبقاً فلا يُمنع الـ popup
  const wb = await getFirebaseWebAuth();
  if(wb){
    try{
      const provider = new wb.OAuthProvider('apple.com');
      provider.addScope('email'); provider.addScope('name');
      let result;
      if(isAnon && wb.auth.currentUser){
        const { linkWithPopup } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
        result = await linkWithPopup(wb.auth.currentUser, provider);
      } else {
        result = await wb.signInWithPopup(wb.auth, provider);
      }
      const u = result.user;
      if(u.email){ storeSet('authEmail', u.email); await savePermanentProfile(u.uid, u.displayName, u.email, 'apple'); }
      afterAuthSuccess(u.displayName || u.email || storeGet('playerName','لاعب'), 'apple', u.uid, u.email);
      return;
    }catch(e){
      if(isAuthCancellation(e)) return;
      if(await handleAuthConflict(e, 'apple', wb)) return;
      logClientEvent('error','auth.apple.web');
      if(isAuthNetworkError(e)) showAuthNetworkError();
      else showToast('⚠️','ما قدرنا ندخّلك','جرّب مرة ثانية',false);
      return;
    }
  }
  showToast('🍎','الإعداد ناقص','يحتاج Firebase config',false);
  }finally{ endAuthAction(); }
}

async function googleSignIn(){
  if(!beginAuthAction('ثواني ونفتح تسجيل الدخول عن طريق Google…')) return;
  try{
  sfx('tap'); vibrate(15);
  const isAnon = storeGet('authProvider','')==='anonymous';
  // محاولة 1: Capacitor (iOS app)
  const FA = getFirebaseAuth();
  if(FA){
    try{
      const res = isAnon ? await FA.linkWithGoogle() : await FA.signInWithGoogle();
      const u = res && res.user;
      if(u){
        if(u.email) storeSet('authEmail', u.email);
        await savePermanentProfile(u.uid, u.displayName, u.email, 'google');
      }
      afterAuthSuccess((u && u.displayName) || storeGet('playerName','لاعب'), 'google', u && u.uid, u && u.email);
      return;
    }catch(e){
      const code=String(e && e.code || '');
      if(isAuthCancellation(e)) return;
      if(code.includes('account-exists-with-different-credential') || code.includes('credential-already-in-use')){
        await handleAuthConflict(e, 'google', null); return;
      }
      if(isAuthNetworkError(e)){ showAuthNetworkError(); return; }
      logClientEvent('error','auth.google.capacitor');
    }
  }
  // محاولة 2: Firebase Web SDK (متصفح)
  const wb = await getFirebaseWebAuth();
  if(wb){
    try{
      const provider = new wb.GoogleAuthProvider();
      let result;
      if(isAnon && wb.auth.currentUser){
        const { linkWithPopup } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
        result = await linkWithPopup(wb.auth.currentUser, provider);
      } else {
        result = await wb.signInWithPopup(wb.auth, provider);
      }
      const u = result.user;
      if(u.email){ storeSet('authEmail', u.email); await savePermanentProfile(u.uid, u.displayName, u.email, 'google'); }
      afterAuthSuccess(u.displayName || u.email || storeGet('playerName','لاعب'), 'google', u.uid, u.email);
      return;
    }catch(e){
      if(isAuthCancellation(e)) return;
      if(await handleAuthConflict(e, 'google', wb)) return;
      logClientEvent('error','auth.google.web');
      if(isAuthNetworkError(e)) showAuthNetworkError();
      else showToast('⚠️','ما قدرنا ندخّلك','جرّب مرة ثانية',false);
      return;
    }
  }
  showToast('🔵','الإعداد ناقص','يحتاج Firebase config',false);
  }finally{ endAuthAction(); }
}

// ---- دخول برقم الهاتف ----
let _authPhoneVerificationId='';
let _authPhoneListenerHandles=[];
let _authPhoneStartPending=false;
let _authPhoneConfirmPending=false;

function setAuthMessage(text, error){
  const msg=document.getElementById('auth-msg');
  if(!msg) return;
  msg.style.color=error?'#ff8a8a':'';
  msg.textContent=text||'';
}

async function cleanupAuthPhoneListeners(){
  const handles=_authPhoneListenerHandles.splice(0);
  await Promise.all(handles.map(handle=>Promise.resolve(handle?.remove?.()).catch(()=>{})));
}

function togglePhoneSignInForm(){
  sfx('tap');
  const phoneForm=document.getElementById('auth-phone-form');
  const emailForm=document.getElementById('auth-email-form');
  if(emailForm) emailForm.style.display='none';
  if(!phoneForm) return;
  const opening=phoneForm.style.display==='none';
  phoneForm.style.display=opening?'block':'none';
  setAuthMessage('');
  if(opening) document.getElementById('auth-phone')?.focus();
}

async function finishPhoneSignIn(user){
  await cleanupAuthPhoneListeners();
  _authPhoneVerificationId='';
  const codeForm=document.getElementById('auth-phone-code-form');
  if(codeForm) codeForm.style.display='none';
  afterAuthSuccess(
    (user && (user.displayName || user.phoneNumber)) || 'لاعب',
    'phone',
    user && user.uid,
    user && user.email
  );
}

async function startPhoneSignIn(){
  sfx('tap');
  const input=document.getElementById('auth-phone');
  const phone=normalizePhoneNumber(input && input.value);
  if(!phone){ setAuthMessage('اكتب الرقم بالصيغة الدولية، مثل +96550001234.', true); return; }
  if(_authPhoneStartPending) return;
  const FA=getFirebaseAuth();
  if(!FA || typeof FA.signInWithPhoneNumber!=='function'){
    setAuthMessage('الدخول بالهاتف متوفر داخل تطبيق iPhone بس.', true);
    return;
  }
  _authPhoneStartPending=true;
  const sendButton=document.getElementById('auth-phone-send-btn');
  if(sendButton) sendButton.disabled=true;
  setAuthMessage('⏳ ثواني ونرسل رمز التحقق…');
  try{
    await cleanupAuthPhoneListeners();
    _authPhoneVerificationId='';
    _authPhoneListenerHandles.push(await FA.addListener('phoneCodeSent', event=>{
      _authPhoneVerificationId=event && event.verificationId || '';
      const codeForm=document.getElementById('auth-phone-code-form');
      if(codeForm) codeForm.style.display='block';
      if(sendButton) sendButton.textContent='إعادة إرسال الرمز';
      setAuthMessage('رسلنا الرمز. اكتبه عشان تكمّل تسجيل الدخول.');
      document.getElementById('auth-phone-code')?.focus();
    }));
    _authPhoneListenerHandles.push(await FA.addListener('phoneVerificationCompleted', event=>{
      const completedUser=event && event.result && event.result.user;
      if(completedUser) finishPhoneSignIn(completedUser);
    }));
    _authPhoneListenerHandles.push(await FA.addListener('phoneVerificationFailed', event=>{
      const eventCode=event && (event.code || event.errorCode || event.message);
      setAuthMessage(phoneAuthErrorMessage(eventCode,'ما قدرنا نرسل الرمز — جرّب مرة ثانية.'),true);
      cleanupAuthPhoneListeners();
    }));
    await FA.signInWithPhoneNumber({phoneNumber:phone});
  }catch(e){
    logClientEvent('error','auth.phone.start');
    await cleanupAuthPhoneListeners();
    setAuthMessage(phoneAuthErrorMessage(e && (e.code||e.message),'ما قدرنا نرسل الرمز — جرّب مرة ثانية.'),true);
  }finally{
    _authPhoneStartPending=false;
    if(sendButton) sendButton.disabled=false;
  }
}

async function confirmPhoneSignIn(){
  sfx('tap');
  const code=(document.getElementById('auth-phone-code')?.value||'').trim();
  if(!code){ setAuthMessage('اكتب رمز التحقق.',true); return; }
  if(_authPhoneConfirmPending) return;
  _authPhoneConfirmPending=true;
  const button=document.getElementById('auth-phone-confirm-btn');
  if(button) button.disabled=true;
  setAuthMessage('⏳ ثواني ونسجّل دخولك…');
  try{
    if(!_authPhoneVerificationId) throw new Error('verification-id-missing');
    const FA=getFirebaseAuth();
    const result=await FA.confirmVerificationCode({
      verificationId:_authPhoneVerificationId,
      verificationCode:code
    });
    await finishPhoneSignIn(result && result.user);
  }catch(e){
    logClientEvent('error','auth.phone.confirm');
    const errorCode=String(e && (e.code||e.message)||'').toLowerCase();
    if(errorCode.includes('invalid-verification-code')) setAuthMessage('رمز التحقق مو صحيح.',true);
    else if(errorCode.includes('session-expired') || errorCode.includes('verification-id-missing')) setAuthMessage('انتهت صلاحية الرمز — أرسل رمز جديد.',true);
    else setAuthMessage(phoneAuthErrorMessage(errorCode,'ما قدرنا نسجّل دخولك — جرّب مرة ثانية.'),true);
  }finally{
    _authPhoneConfirmPending=false;
    if(button) button.disabled=false;
  }
}

// ---- دخول بالبريد وكلمة المرور ----
async function forgotPassword(){
  sfx('tap');
  const emailInput=document.getElementById('auth-email');
  const email=(emailInput && emailInput.value || storeGet('authEmail','')).trim();
  const msg=document.getElementById('auth-msg');
  if(!email || !email.includes('@')){
    if(emailInput) emailInput.focus();
    msg.style.color='#f5c542';
    msg.textContent='اكتب بريدك الإلكتروني أول عشان نرسل رابط تغيير كلمة المرور';
    return;
  }
  if(!beginAuthAction('ثواني ونرسل رابط تغيير كلمة المرور…')) return;
  msg.style.color='';
  msg.textContent='ثواني ونرسل رابط تغيير كلمة المرور…';
  try{
    const FA=getFirebaseAuth();
    if(FA){
      await FA.sendPasswordResetEmail({email});
    } else {
      const wb=await getFirebaseWebAuth();
      if(!wb) throw new Error('firebase-not-configured');
      const {sendPasswordResetEmail}=await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
      await sendPasswordResetEmail(wb.auth,email);
    }
    msg.style.color='#8ee6b0';
    msg.textContent='رسلنا رابط تغيير كلمة المرور لبريدك. شيّك على الوارد والرسائل غير المرغوب فيها.';
  }catch(e){
    logClientEvent('error','auth.password-reset');
    const code=String((e && e.code)||'');
    msg.style.color='#ff8a8a';
    if(code.includes('invalid-email')) msg.textContent='صيغة البريد الإلكتروني مو صحيحة';
    else if(code.includes('user-not-found')) msg.textContent='ماكو حساب مربوط بهالبريد';
    else if(code.includes('too-many-requests')) msg.textContent='صارت محاولات وايد. جرّب بعدين.';
    else if(isAuthNetworkError(e)) msg.textContent='ماكو اتصال بالإنترنت — تأكد من الشبكة وجرّب مرة ثانية';
    else if(code.includes('firebase-not-configured')) msg.textContent='الإعداد ناقص — Firebase غير مهيأ';
    else msg.textContent='ما قدرنا نرسل الرابط — تأكد من البريد وجرّب مرة ثانية';
  }finally{ endAuthAction(); }
}

async function forgotEmail(){
  sfx('tap');
  const msg=document.getElementById('auth-msg');
  const savedEmail=String(storeGet('authEmail','')||'').trim();
  let currentEmail='';
  try{
    const user=await getCurrentFirebaseUserData(false);
    currentEmail=String((user && user.email)||'').trim();
  }catch(e){ logClientEvent('warn','auth.forgot-email'); }
  const email=currentEmail||savedEmail;
  msg.style.color=email?'#8ee6b0':'#f5c542';
  msg.textContent=email
    ? `البريد المربوط بهالجهاز: ${email}`
    : 'ماكو بريد محفوظ على هالجهاز. جرّب Apple أو Google أو رقم الهاتف عشان تدخل حسابك.';
}

async function emailAuth(mode){
  sfx('tap');
  const email    = (document.getElementById('auth-email').value||'').trim();
  const password = document.getElementById('auth-password').value||'';
  const msg = document.getElementById('auth-msg');
  msg.style.color=''; msg.textContent='';
  if(!email || !email.includes('@')){ msg.style.color='#ff8a8a'; msg.textContent='اكتب بريد إلكتروني صحيح'; return; }
  if(password.length < 6){ msg.style.color='#ff8a8a'; msg.textContent='كلمة المرور ٦ أحرف على الأقل'; return; }
  if(!beginAuthAction(mode==='signup' ? 'ثواني وننشئ حسابك…' : 'ثواني ونسجّل دخولك…')) return;
  const isAnon = storeGet('authProvider','')==='anonymous';

  try{
    const FA = getFirebaseAuth();
    if(FA){
      let res;
      if(mode==='signup'){
        res = isAnon ? await FA.linkWithEmailAndPassword({email, password})
                     : await FA.createUserWithEmailAndPassword({email, password});
      } else {
        res = await FA.signInWithEmailAndPassword({email, password});
        clearPendingLinkNative();
      }
      const u = res && res.user;
      await savePermanentProfile(u && u.uid, (u && u.displayName) || storeGet('playerName',''), email, 'password');
      if(mode==='signup') await sendEmailVerificationMessage(true);
      afterAuthSuccess(storeGet('playerName','لاعب'), 'password', u && u.uid, email);
      return;
    }
    const wb = await getFirebaseWebAuth();
    if(wb){
      const authMod = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
      const { createUserWithEmailAndPassword, signInWithEmailAndPassword, linkWithCredential, EmailAuthProvider } = authMod;
      let cred;
      if(mode==='signup'){
        if(isAnon && wb.auth.currentUser){
          const emailCred = EmailAuthProvider.credential(email, password);
          cred = await linkWithCredential(wb.auth.currentUser, emailCred);
        } else {
          cred = await createUserWithEmailAndPassword(wb.auth, email, password);
        }
      } else {
        cred = await signInWithEmailAndPassword(wb.auth, email, password);
        await resolvePendingLinkWeb(wb, cred.user);
      }
      const u = cred.user;
      await savePermanentProfile(u.uid, u.displayName || storeGet('playerName',''), email, 'password');
      if(mode==='signup') await sendEmailVerificationMessage(true);
      afterAuthSuccess(storeGet('playerName','لاعب'), 'password', u.uid, email);
      return;
    }
    msg.style.color='#ff8a8a'; msg.textContent='الإعداد ناقص — Firebase غير مهيأ';
  }catch(e){
    logClientEvent('error','auth.email');
    const code = String((e && e.code) || '');
    if(code.includes('email-already-in-use') || code.includes('credential-already-in-use')){
      msg.style.color='#f5c542';
      msg.textContent='عندك حساب بهالبريد من قبل — اضغط «تسجيل الدخول» بدل إنشاء حساب';
    } else if(code.includes('wrong-password') || code.includes('invalid-credential') || code.includes('user-not-found')){
      msg.style.color='#ff8a8a'; msg.textContent='البريد أو كلمة المرور مو صحيحة';
    } else if(code.includes('weak-password')){
      msg.style.color='#ff8a8a'; msg.textContent='كلمة المرور ضعيفة — اختار كلمة أقوى';
    } else if(isAuthNetworkError(e)){
      msg.style.color='#ff8a8a'; msg.textContent='ماكو اتصال بالإنترنت — تأكد من الشبكة وجرّب مرة ثانية';
    } else {
      msg.style.color='#ff8a8a'; msg.textContent='ما قدرنا نكمّل العملية — جرّب مرة ثانية';
    }
  }finally{ endAuthAction(); }
}

// ---------- التحقق من البريد ورقم الهاتف ----------
let _phoneVerificationId = '';
let _phoneConfirmation = null;
let _phoneListenerHandles = [];
let _phoneRecaptchaVerifier = null;

function setVerificationMessage(text, error){
  const el=document.getElementById('verification-msg');
  if(el){
    el.textContent=text||'';
    el.style.color=error?'#ff8a8a':'';
  }
}

async function getCurrentFirebaseUserData(reload=true, throwOnError=false){
  const FA=getFirebaseAuth();
  if(FA){
    try{
      if(reload && FA.reload) await FA.reload();
      const result=await FA.getCurrentUser();
      return (result && result.user) || null;
    }catch(e){
      logClientEvent('warn','auth.native-user');
      if(throwOnError) throw e;
      return null;
    }
  }
  const wb=await getFirebaseWebAuth();
  if(wb && wb.auth.currentUser){
    try{
      if(reload) await wb.auth.currentUser.reload();
    }catch(e){
      logClientEvent('warn','auth.web-user');
      if(throwOnError) throw e;
    }
    return wb.auth.currentUser;
  }
  return null;
}

async function refreshVerificationStatus(throwOnError=false){
  const status=document.getElementById('verification-status');
  const emailBtn=document.getElementById('send-email-verification-btn');
  if(!status) return;
  const user=await getCurrentFirebaseUserData(true, throwOnError);
  if(!user){
    status.textContent='سجّل دخولك بحساب Firebase عشان تفعّل التحقق.';
    if(emailBtn) emailBtn.style.display='none';
    return;
  }
  if(emailBtn) emailBtn.style.display=user.email?'block':'none';
  const emailLine=user.email
    ? `البريد: ${esc(user.email)} — ${user.emailVerified ? '✅ تم التحقق' : '⚠️ للحين ما تحققنا منه'}`
    : 'ماكو بريد إلكتروني مربوط بهالحساب.';
  const phoneLine=user.phoneNumber
    ? `الهاتف: ${esc(user.phoneNumber)} — ✅ تم التحقق`
    : 'الهاتف: للحين ما تحققنا منه';
  status.innerHTML=`<div>${emailLine}</div><div style="margin-top:5px;">${phoneLine}</div>`;
}

let _emailVerificationPending=false;
async function sendEmailVerificationMessage(silent=false){
  if(_emailVerificationPending) return false;
  _emailVerificationPending=true;
  const button=document.getElementById('send-email-verification-btn');
  if(button) button.disabled=true;
  if(!silent) setVerificationMessage('⏳ ثواني ونرسل رسالة التحقق…');
  try{
    const user=await getCurrentFirebaseUserData();
    if(!user || !user.email){
      setVerificationMessage('ضيف دخول بالبريد أول عشان نرسل رسالة التحقق.', true);
      return false;
    }
    if(user.emailVerified){
      setVerificationMessage('تحققنا من هالبريد من قبل.');
      return true;
    }
    const FA=getFirebaseAuth();
    if(FA){
      await FA.sendEmailVerification();
    }else{
      const wb=await getFirebaseWebAuth();
      if(!wb || !wb.auth.currentUser) throw new Error('Firebase غير مهيأ');
      const { sendEmailVerification } =
        await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
      await sendEmailVerification(wb.auth.currentUser);
    }
    setVerificationMessage('رسلنا رسالة التحقق. افتحها وبعدها حدّث الحالة.');
    if(!silent) showToast('✉️','رسلنا رسالة التحقق','شيّك على بريدك الإلكتروني',false);
    return true;
  }catch(e){
    logClientEvent('error','auth.email-verification');
    const code=String((e && (e.code||e.message))||'').toLowerCase();
    if(isAuthNetworkError(e)) setVerificationMessage('ماكو اتصال بالإنترنت — تأكد من الشبكة وجرّب مرة ثانية.', true);
    else if(code.includes('too-many-requests')) setVerificationMessage('انرسلت طلبات وايد — نطر شوي وجرّب مرة ثانية.', true);
    else setVerificationMessage('ما قدرنا نرسل رسالة التحقق — جرّب مرة ثانية.', true);
    return false;
  }finally{
    _emailVerificationPending=false;
    if(button) button.disabled=false;
  }
}

let _verificationRefreshPending=false;
async function refreshEmailVerificationStatus(){
  if(_verificationRefreshPending) return;
  _verificationRefreshPending=true;
  const button=document.getElementById('refresh-verification-btn');
  if(button) button.disabled=true;
  setVerificationMessage('⏳ ثواني ونحدّث حالة التحقق…');
  try{
    await refreshVerificationStatus(true);
    setVerificationMessage('حدّثنا حالة التحقق.');
  }catch(e){
    logClientEvent('error','auth.verification-refresh');
    if(isAuthNetworkError(e)) setVerificationMessage('ماكو اتصال بالإنترنت — ما قدرنا نحدّث الحالة.', true);
    else setVerificationMessage('ما قدرنا نحدّث حالة التحقق — جرّب مرة ثانية.', true);
  }finally{
    _verificationRefreshPending=false;
    if(button) button.disabled=false;
  }
}

async function cleanupPhoneListeners(){
  const handles=_phoneListenerHandles.splice(0);
  for(const handle of handles){
    try{ await handle.remove(); }catch(e){}
  }
}

async function resetVerificationSession(){
  await cleanupPhoneListeners();
  _phoneVerificationId='';
  _phoneConfirmation=null;
  if(_phoneRecaptchaVerifier){
    try{ _phoneRecaptchaVerifier.clear(); }catch(e){}
    _phoneRecaptchaVerifier=null;
  }
  _phoneStartPending=false;
  _phoneConfirmPending=false;
  _emailVerificationPending=false;
  _verificationRefreshPending=false;
  const codeInput=document.getElementById('verification-phone-code');
  if(codeInput) codeInput.value='';
  const form=document.getElementById('phone-code-form');
  if(form) form.style.display='none';
  const sendButton=document.getElementById('send-phone-code-btn');
  if(sendButton){ sendButton.disabled=false; sendButton.textContent='إرسال رمز SMS'; }
  const confirmButton=document.getElementById('confirm-phone-code-btn');
  if(confirmButton) confirmButton.disabled=false;
  const emailButton=document.getElementById('send-email-verification-btn');
  if(emailButton) emailButton.disabled=false;
  const refreshButton=document.getElementById('refresh-verification-btn');
  if(refreshButton) refreshButton.disabled=false;
  setVerificationMessage('');
}

function normalizePhoneNumber(value){
  let phone=String(value||'').trim()
    .replace(/[٠-٩]/g, digit=>String(digit.charCodeAt(0)-0x660))
    .replace(/[۰-۹]/g, digit=>String(digit.charCodeAt(0)-0x6F0))
    .replace(/[\s().-]/g,'');
  if(phone.startsWith('00')) phone='+'+phone.slice(2);
  let local=phone;
  if(phone.startsWith('+965')) local=phone.slice(4);
  else if(phone.startsWith('965')) local=phone.slice(3);
  return /^[1-9]\d{7}$/.test(local) ? `+965${local}` : '';
}

function phoneAuthErrorMessage(code, fallback){
  const errorCode=String(code||'').toLowerCase();
  if(errorCode.includes('network-request-failed') || errorCode.includes('network error') || errorCode.includes('offline')) return 'ماكو اتصال بالإنترنت — تأكد من الشبكة وجرّب مرة ثانية.';
  if(errorCode.includes('provider-disabled')) return 'الدخول برقم الهاتف مو مفعّل في Firebase.';
  if(errorCode.includes('invalid-phone-number')) return 'رقم الكويت مو صحيح. اكتب ٨ أرقام من غير صفر بالبداية.';
  if(errorCode.includes('too-many-requests')) return 'صارت محاولات وايد لإرسال SMS. نطر شوي وجرّب مرة ثانية.';
  if(errorCode.includes('credential-already-in-use')) return 'رقم الهاتف مربوط بحساب ثاني.';
  if(errorCode.includes('captcha-check-failed')) return 'ما قدرنا نكمّل التحقق الأمني. جرّب من اتصال موثوق.';
  return fallback;
}

async function finishPhoneVerification(user){
  await cleanupPhoneListeners();
  _phoneVerificationId='';
  _phoneConfirmation=null;
  const form=document.getElementById('phone-code-form');
  if(form) form.style.display='none';
  const codeInput=document.getElementById('verification-phone-code');
  if(codeInput) codeInput.value='';
  const sendButton=document.getElementById('send-phone-code-btn');
  if(sendButton) sendButton.textContent='إرسال رمز SMS';
  if(user && user.phoneNumber){
    const input=document.getElementById('verification-phone');
    if(input) input.value=user.phoneNumber;
  }
  setVerificationMessage('تحققنا من رقم الهاتف وربطناه بحسابك.');
  await refreshVerificationStatus();
  renderAccountLinks();
  showToast('📱','وثّقنا رقم الهاتف','ربطنا الرقم بحسابك بنجاح',false);
}

let _phoneStartPending=false;
async function startPhoneVerification(){
  sfx('tap');
  setVerificationMessage('');
  const input=document.getElementById('verification-phone');
  const phone=normalizePhoneNumber(input && input.value);
  if(!phone){
    setVerificationMessage('اكتب الرقم بالصيغة الدولية، مثل +96550001234.', true);
    return;
  }
  if(_phoneStartPending) return;
  _phoneStartPending=true;
  const startButton=document.getElementById('send-phone-code-btn');
  if(startButton) startButton.disabled=true;
  setVerificationMessage('⏳ ثواني ونرسل رمز SMS…');
  try{
  const user=await getCurrentFirebaseUserData(false);
  if(!user){
    setVerificationMessage('سجّل دخولك بحساب Firebase أول.', true);
    return;
  }
  if(user.phoneNumber){
    setVerificationMessage('تحققنا من رقم الهاتف من قبل.');
    return;
  }
  await cleanupPhoneListeners();
  _phoneVerificationId='';
  _phoneConfirmation=null;
    const FA=getFirebaseAuth();
    if(FA){
      _phoneListenerHandles.push(await FA.addListener('phoneCodeSent', event=>{
        _phoneVerificationId=event && event.verificationId || '';
        const form=document.getElementById('phone-code-form');
        if(form) form.style.display='block';
        if(startButton) startButton.textContent='إعادة إرسال رمز SMS';
        setVerificationMessage('رسلنا رمز SMS. اكتبه هني عشان نكمّل التحقق.');
        document.getElementById('verification-phone-code')?.focus();
      }));
      _phoneListenerHandles.push(await FA.addListener('phoneVerificationCompleted', event=>{
        const completedUser=event && event.result && event.result.user;
        if(completedUser) finishPhoneVerification(completedUser);
      }));
      _phoneListenerHandles.push(await FA.addListener('phoneVerificationFailed', event=>{
        const eventCode=event && (event.code || event.errorCode || event.message);
        setVerificationMessage(phoneAuthErrorMessage(eventCode, 'ما قدرنا نرسل رمز SMS — جرّب مرة ثانية.'), true);
        if(startButton) startButton.textContent='إرسال رمز SMS';
        cleanupPhoneListeners();
      }));
      await FA.linkWithPhoneNumber({phoneNumber:phone});
      setVerificationMessage('ثواني ونرسل رمز SMS…');
      return;
    }
    const wb=await getFirebaseWebAuth();
    if(!wb || !wb.auth.currentUser) throw new Error('Firebase غير مهيأ');
    const { linkWithPhoneNumber, RecaptchaVerifier } =
      await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
    if(!_phoneRecaptchaVerifier){
      _phoneRecaptchaVerifier=new RecaptchaVerifier(wb.auth, 'phone-recaptcha', {size:'invisible'});
    }
    _phoneConfirmation=await linkWithPhoneNumber(
      wb.auth.currentUser, phone, _phoneRecaptchaVerifier
    );
    const form=document.getElementById('phone-code-form');
    if(form) form.style.display='block';
    if(startButton) startButton.textContent='إعادة إرسال رمز SMS';
    setVerificationMessage('رسلنا رمز SMS. اكتبه هني عشان نكمّل التحقق.');
    document.getElementById('verification-phone-code')?.focus();
  }catch(e){
    logClientEvent('error','auth.phone.start');
    await cleanupPhoneListeners();
    const code=String(e && (e.code||e.message) || '');
    setVerificationMessage(phoneAuthErrorMessage(code, 'ما قدرنا نرسل رمز SMS — جرّب مرة ثانية.'), true);
    if(startButton) startButton.textContent='إرسال رمز SMS';
  }finally{
    _phoneStartPending=false;
    if(startButton) startButton.disabled=false;
  }
}

let _phoneConfirmPending=false;
async function confirmPhoneVerification(){
  sfx('tap');
  const code=(document.getElementById('verification-phone-code')?.value||'').trim();
  if(!code){
    setVerificationMessage('اكتب رمز التحقق اللي وصلك برسالة SMS.', true);
    return;
  }
  if(_phoneConfirmPending) return;
  _phoneConfirmPending=true;
  const confirmButton=document.getElementById('confirm-phone-code-btn');
  if(confirmButton) confirmButton.disabled=true;
  setVerificationMessage('⏳ ثواني ونتأكد من رمز التحقق…');
  try{
    let result=null;
    const FA=getFirebaseAuth();
    if(FA){
      if(!_phoneVerificationId) throw new Error('verification-id-missing');
      result=await FA.confirmVerificationCode({
        verificationId:_phoneVerificationId, verificationCode:code
      });
    }else if(_phoneConfirmation){
      result=await _phoneConfirmation.confirm(code);
    }else{
      throw new Error('verification-session-missing');
    }
    const user=result && result.user;
    await finishPhoneVerification(user || await getCurrentFirebaseUserData());
  }catch(e){
    logClientEvent('error','auth.phone.confirm');
    const errorCode=String(e && (e.code||e.message) || '').toLowerCase();
    if(errorCode.includes('invalid-verification-code')) setVerificationMessage('رمز التحقق مو صحيح.', true);
    else if(errorCode.includes('session-expired') || errorCode.includes('verification-session-missing') || errorCode.includes('verification-id-missing')){
      await cleanupPhoneListeners();
      _phoneVerificationId='';
      _phoneConfirmation=null;
      const form=document.getElementById('phone-code-form');
      if(form) form.style.display='none';
      const codeInput=document.getElementById('verification-phone-code');
      if(codeInput) codeInput.value='';
      const sendButton=document.getElementById('send-phone-code-btn');
      if(sendButton) sendButton.textContent='إرسال رمز جديد';
      setVerificationMessage('انتهت صلاحية الرمز — اضغط «إرسال رمز جديد».', true);
    }
    else if(isAuthNetworkError(e)) setVerificationMessage('ماكو اتصال بالإنترنت — ما قدرنا نتأكد من الرمز.', true);
    else setVerificationMessage('ما قدرنا نتأكد من الرقم — شيّك على الرمز وجرّب مرة ثانية.', true);
  }finally{
    _phoneConfirmPending=false;
    if(confirmButton) confirmButton.disabled=false;
  }
}

// ===== شاشة التعليم الأولى (onboarding) =====
let _onbStep = 0;
const _ONB_TOTAL = 3;
function _onbSetStep(step){
  // تحديث الأزرار
  document.getElementById('onb-next-btn').textContent = (step === _ONB_TOTAL - 1) ? 'يلا نلعب 🎯' : 'كمّل';
  // تحديث النقاط
  document.querySelectorAll('.onb-dot').forEach((d,i)=>{
    d.classList.toggle('active', i===step);
  });
  // تحريك البطاقات
  for(let i=0; i<_ONB_TOTAL; i++){
    const c = document.getElementById('onb-card-'+i);
    const active=i===step;
    c.classList.remove('active','out');
    if(active) c.classList.add('active');
    else if(i<step) c.classList.add('out');
    c.setAttribute('aria-hidden',active?'false':'true');
    c.inert=!active;
  }
  const screen=document.getElementById('s-onb');
  if(screen?.classList.contains('active')) requestAnimationFrame(()=>focusScreenAccessibilityTitle(screen));
}
function onbNext(){
  sfx('tap');
  if(_onbStep < _ONB_TOTAL - 1){
    _onbStep++;
    _onbSetStep(_onbStep);
  } else {
    onbFinish();
  }
}
function onbFinish(){
  sfx('tap');
  storeSet('onbDone', true);
  checkSubscriptionAndRoute(storeGet('authUid',''));
}

// ────────── RevenueCat — Apple IAP
// مفتاح RevenueCat عام، لكنه لا يبقى في localStorage/Preferences. على iOS
// تحفظه الإضافة المحلية في Keychain وتعيده عند الإقلاع التالي.
let RC_API_KEY = '';
let RC_CONFIGURED = false;
async function loadRcKey(){
  if(RC_API_KEY) return RC_API_KEY;
  const keyStore=window.Capacitor?.Plugins?.RevenueCatKeyStore;
  if(keyStore){
    try{
      const saved=await keyStore.get();
      if(saved && saved.value){
        RC_API_KEY=saved.value;
        RC_CONFIGURED=true;
        return RC_API_KEY;
      }
    }catch(e){ logClientEvent('warn','revenuecat.keychain-read'); }
  }
  try{
    const r = await fetch(apiUrl('/api/rc-config'));
    if(r.ok){
      const d = await r.json();
      if(d && d.apiKey){
        RC_API_KEY = d.apiKey;
        RC_CONFIGURED = true;
        if(keyStore) await keyStore.set({value:d.apiKey});
      }
    }
  }catch(e){ logClientEvent('error','revenuecat.configure'); }
  return RC_API_KEY;
}
// امسح أي نسخة تركتها الإصدارات القديمة في تخزين JavaScript.
localStorage.removeItem(STORAGE_PREFIX+'rcApiKey');
window.Capacitor?.Plugins?.Preferences?.remove({key:STORAGE_PREFIX+'rcApiKey'}).catch(()=>{});
const RC_ENTITLEMENT = 'premium';
const RC_APP_USER_ID_KEY = 'rcAppUserId';
const RC_APP_USER_IDS_KEY = 'rcAppUserIds';
const RC_SUBSCRIPTION_CACHE_KEY = 'rcSubCache';
const RC_SUBSCRIPTION_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RC_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createRcUuid(){
  if(window.crypto && typeof window.crypto.randomUUID === 'function'){
    return window.crypto.randomUUID().toLowerCase();
  }
  if(window.crypto && typeof window.crypto.getRandomValues === 'function'){
    const bytes=new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6]=(bytes[6]&0x0f)|0x40;
    bytes[8]=(bytes[8]&0x3f)|0x80;
    const hex=[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  throw new Error('المتصفح لا يدعم مولّد UUID آمن');
}

function getRcAppUserId(){
  const uid=String(storeGet('authUid','')||'');
  const ids=storeGet(RC_APP_USER_IDS_KEY,{}) || {};
  let value=String((uid && ids[uid]) || storeGet(RC_APP_USER_ID_KEY,'') || '').toLowerCase();
  if(!RC_UUID_RE.test(value)){
    value=createRcUuid();
    if(uid){
      ids[uid]=value;
      storeSet(RC_APP_USER_IDS_KEY,ids);
    }
  }
  storeSet(RC_APP_USER_ID_KEY,'');
  return value;
}

function getRC(){
  return window.Capacitor && window.Capacitor.isNativePlatform()
    && window.Capacitor.Plugins && window.Capacitor.Plugins.Purchases
    || null;
}

let _rcReady = null;
let RC_SDK_CONFIGURED = false;
let RC_CURRENT_APP_USER_ID = '';

function clearRevenueCatSubscriptionCache(){
  localStorage.removeItem(STORAGE_PREFIX+RC_SUBSCRIPTION_CACHE_KEY);
  try{
    const P=window.Capacitor?.Plugins?.Preferences;
    if(P) Promise.resolve(P.remove({key:STORAGE_PREFIX+RC_SUBSCRIPTION_CACHE_KEY})).catch(()=>{});
  }catch(e){}
}

function clearRevenueCatAccessState(){
  clearRevenueCatSubscriptionCache();
  _hasActiveSubscription=false;
  _freeRoundAvailable=false;
  _freeRoundVerificationState='unknown';
  _subscriptionResolved=false;
}

// لا يكفي وجود UID في localStorage لقبول اشتراك مخزّن. لا تُعد الهوية مؤكدة
// إلا عندما تتطابق جلسة التطبيق الحالية، وخريطة UID↔App User ID، وهوية SDK
// التي تم ربطها بالخادم بعد التحقق من Firebase ID token.
function confirmedRevenueCatCacheIdentity(){
  const currentUid=String(window._currentUid||'');
  const storedUid=String(storeGet('authUid','')||'');
  if(!currentUid || !storedUid || currentUid!==storedUid) return null;
  const ids=storeGet(RC_APP_USER_IDS_KEY,{}) || {};
  const expectedAppUserId=String(ids[storedUid]||'').toLowerCase();
  const sdkAppUserId=String(RC_CURRENT_APP_USER_ID||'').toLowerCase();
  if(!RC_UUID_RE.test(expectedAppUserId) || sdkAppUserId!==expectedAppUserId) return null;
  return {uid:storedUid, rcAppUserId:expectedAppUserId};
}

function sameRevenueCatIdentity(left,right){
  return !!left && !!right
    && left.uid===right.uid
    && left.rcAppUserId===right.rcAppUserId;
}

async function resetRevenueCatIdentity(){
  const RC=getRC();
  // يجب سحب الصلاحية من الذاكرة قبل أي await حتى لا يستفيد الحساب التالي من
  // نافذة زمنية قصيرة بينما RevenueCat ينفذ logOut في الخلفية.
  clearRevenueCatAccessState();
  RC_CURRENT_APP_USER_ID='';
  _rcReady=null;
  if(RC && RC_SDK_CONFIGURED && typeof RC.logOut==='function'){
    try{ await RC.logOut(); }
    catch(e){ logClientEvent('warn','revenuecat.logout'); }
  }
}

function rcReady(){
  if(!_rcReady) _rcReady = initRevenueCat();
  return _rcReady;
}

async function initRevenueCat(){
  const RC = getRC();
  if(!RC) return false;
  await loadRcKey();
  if(!RC_CONFIGURED) return false; // لا تهيّئ إذا لم يتوفر المفتاح
  try{
    const uid = storeGet('authUid','');
    const rcAppUserId=getRcAppUserId();
    if(!uid) throw new Error('لا يمكن تهيئة RevenueCat بلا حساب Firebase');
    if(RC_CURRENT_APP_USER_ID && RC_CURRENT_APP_USER_ID!==rcAppUserId){
      // تبديل مباشر للحساب من دون المرور بزر الخروج: لا تبقِ كاش أو صلاحية
      // الحساب السابق أثناء ربط هوية RevenueCat الجديدة.
      clearRevenueCatAccessState();
      RC_CURRENT_APP_USER_ID='';
    }
    let idToken=await getCurrentIdToken();
    const identityRequest=token=>apiFetch('/api/revenuecat/identity',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({uid, rcAppUserId, idToken:token})
    });
    let identityResp=await identityRequest(idToken);
    // Firebase قد يعيد token مخزناً من جلسة سابقة؛ جدّده مرة واحدة قبل الفشل.
    if(identityResp.status===401){
      idToken=await getCurrentIdToken(true);
      identityResp=await identityRequest(idToken);
    }
    if(!identityResp.ok){
      let detail='';
      try{
        const payload=await identityResp.json();
        detail=payload && payload.error ? `: ${payload.error}` : '';
      }catch(e){}
      throw new Error(`ربط هوية RevenueCat فشل (HTTP ${identityResp.status})${detail}`);
    }
    if(!RC_SDK_CONFIGURED){
      await RC.configure({ apiKey: RC_API_KEY, appUserID: rcAppUserId });
      RC_SDK_CONFIGURED=true;
    }else if(RC_CURRENT_APP_USER_ID!==rcAppUserId && typeof RC.logIn==='function'){
      await RC.logIn({ appUserID: rcAppUserId });
    }
    RC_CURRENT_APP_USER_ID=rcAppUserId;
    // لا نرسل البريد أو Firebase UID كـ subscriber attribute.
    // Secure Attributes غير متاحة في هذا SDK؛ الصلاحيات تُحسم بالـwebhook.
    return true;
  }catch(e){
    logClientEvent('error','revenuecat.initialize');
    return false;
  }
}

async function rcIsActive(){
  const RC = getRC();
  if(!RC) return null; // null = غير متاح (ويب)
  // initRevenueCat يثبت Firebase UID لدى الخادم ثم يضبط App User ID داخل SDK.
  // بلا هذه الخطوة لا توجد هوية موثوقة يجوز ربط كاش الاشتراك بها.
  if(!(await rcReady())) return null;
  const identity=confirmedRevenueCatCacheIdentity();
  if(!identity) return null;
  try{
    const { customerInfo } = await RC.getCustomerInfo();
    const active = !!(customerInfo.entitlements.active &&
                      customerInfo.entitlements.active[RC_ENTITLEMENT]);
    const latestIdentity=confirmedRevenueCatCacheIdentity();
    if(!sameRevenueCatIdentity(identity,latestIdentity)) return null;
    // احفظ آخر حالة معروفة لهوية Firebase + RevenueCat المؤكدتين فقط.
    storeSet(RC_SUBSCRIPTION_CACHE_KEY, {
      uid:identity.uid,
      rcAppUserId:identity.rcAppUserId,
      active,
      ts:Date.now(),
    });
    return active;
  }catch(e){
    logClientEvent('error','revenuecat.status');
    // إذا كنا بلا إنترنت على iOS، أعد الحالة المحفوظة (صالحة 7 أيام)
    if(!navigator.onLine){
      const latestIdentity=confirmedRevenueCatCacheIdentity();
      const cache = storeGet(RC_SUBSCRIPTION_CACHE_KEY, null);
      if(sameRevenueCatIdentity(identity,latestIdentity)
        && cache
        && cache.uid===identity.uid
        && cache.rcAppUserId===identity.rcAppUserId
        && Number.isFinite(cache.ts)
        && (Date.now() - cache.ts) >= 0
        && (Date.now() - cache.ts) < RC_SUBSCRIPTION_CACHE_TTL_MS
        && typeof cache.active==='boolean'){
        logClientEvent('info','revenuecat.offline-cache');
        return cache.active;
      }
    }
    return null;
  }
}

// ────────── Paywall — أسعار حقيقية من StoreKit عبر RevenueCat (App Store Guideline 3.1.2)
// getOfferings() يرجّع PurchasesOfferings مباشرة ({all, current}) بلا مفتاح
// "offerings" يغلّفه — راجع node_modules/@revenuecat/purchases-capacitor/dist/esm/definitions.d.ts
function pickPackage(offering, plan){
  if(!offering) return null;
  const direct = plan === 'annual' ? offering.annual : offering.monthly;
  if(direct) return direct;
  const pkgs = offering.availablePackages || [];
  const type = plan === 'annual' ? 'ANNUAL' : 'MONTHLY';
  return pkgs.find(p=>p.packageType === type)
      || pkgs.find(p=>p.identifier === plan)
      || pkgs.find(p=>p.identifier === '$rc_' + plan)
      || null;
}

let _pwPkgs = null; // {monthly, annual} — كاش لنتيجة getOfferings
async function fetchPackages(force){
  if(_pwPkgs && !force) return _pwPkgs;
  const RC = getRC();
  if(!RC) throw new Error('RevenueCat مو متوفر');
  await loadRcKey();
  if(!RC_CONFIGURED) throw new Error('RevenueCat مو مجهّأ — ما قدرنا نجيب المفتاح من الخادم');
  if(!(await rcReady())) throw new Error('ما قدرنا نجهّز RevenueCat — راجع سجلّ Xcode');
  const res = await RC.getOfferings();
  const offerings = (res && res.offerings) ? res.offerings : res; // تسامح مع الشكلين
  const current = offerings && offerings.current;
  if(!current) throw new Error('ماكو عروض متوفرة — تأكد إن Offering محدد كـ Current بلوحة RevenueCat');
  _pwPkgs = {
    monthly: pickPackage(current, 'monthly') || null,
    annual:  pickPackage(current, 'annual')  || null
  };
  return _pwPkgs;
}

// يشتق "يعادل X شهرياً" من priceString نفسه حتى يبقى رمز العملة وموضعه
// كما يعرضهم المتجر بالضبط. عدد الخانات العشرية من معيار العملة (Intl)
// وليس من شكل النص، لأن فاصلة الآلاف (مثل ¥4,500) ليست فاصلة عشرية.
function perMonthFromAnnual(product){
  if(!product || typeof product.priceString !== 'string' || typeof product.price !== 'number') return '';
  const currency = product.currencyCode || 'USD';
  let fractionDigits = 2;
  try{
    fractionDigits = new Intl.NumberFormat('en-US', { style:'currency', currency })
      .resolvedOptions().minimumFractionDigits;
  }catch(e){}
  const scale = Math.pow(10, fractionDigits);
  const perMonth = Math.floor((product.price / 12) * scale) / scale;
  const perMonthStr = perMonth.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
    useGrouping: false
  });
  const numMatch = product.priceString.match(/[\d.,]*\d/);
  if(!numMatch) return '';
  const replaced = product.priceString.slice(0, numMatch.index) + perMonthStr +
                    product.priceString.slice(numMatch.index + numMatch[0].length);
  return `يعادل ${replaced} شهرياً فقط`;
}

function pwCtaSub(plan){
  if(!_pwPkgs) return '';
  const pkg = plan === 'annual' ? _pwPkgs.annual : _pwPkgs.monthly;
  const product = pkg && pkg.product;
  if(!product || !product.priceString) return '';
  const unit = plan === 'annual' ? 'سنة' : 'شهر';
  return `‏${product.priceString} / ${unit} — تُلغى في أي وقت`;
}

let _pwPlan = 'monthly';
let _pwPricesLoading = false;
async function loadPaywallPrices(force){
  if(_pwPricesLoading) return;
  const btn         = document.getElementById('paywall-btn');
  const sub         = document.getElementById('pw-cta-sub');
  const err         = document.getElementById('pw-price-error');
  const note        = document.getElementById('web-payment-note');
  const planAnnual  = document.getElementById('pw-plan-annual');
  const planMonthly = document.getElementById('pw-plan-monthly');

  // بلا Capacitor (ويب): الاشتراك غير متاح هنا، لا تعرض أي سعر
  if(!(window.Capacitor && window.Capacitor.isNativePlatform())){
    if(btn)  btn.style.display = 'none';
    if(note) note.style.display = 'block';
    if(err)  err.style.display = 'none';
    return;
  }

  _pwPricesLoading = true;
  if(btn){ btn.style.display=''; btn.disabled = true; }
  if(sub) sub.textContent = 'ثواني ونجيب الأسعار…';
  if(err)  err.style.display = 'none';
  if(note) note.style.display = 'none';

  try{
    const { monthly, annual } = await fetchPackages(force);
    const monthlyProduct = monthly && monthly.product;
    const annualProduct  = annual  && annual.product;
    if(!monthlyProduct && !annualProduct) throw new Error('ماكو أسعار متوفرة');

    if(planMonthly) planMonthly.style.display = monthlyProduct ? '' : 'none';
    if(planAnnual)  planAnnual.style.display  = annualProduct  ? '' : 'none';

    // لا تعرض سعر وهمي لخطة غائبة — حوّل الاختيار للخطة المتاحة فعلياً
    if(_pwPlan === 'monthly' && !monthlyProduct && annualProduct) _pwPlan = 'annual';
    if(_pwPlan === 'annual'  && !annualProduct  && monthlyProduct) _pwPlan = 'monthly';
    document.querySelectorAll('.pw-plan').forEach(p=>{
      p.setAttribute('aria-checked', p.dataset.plan === _pwPlan ? 'true' : 'false');
    });

    const monthlyPriceEl = document.getElementById('pw-monthly-price');
    const annualPriceEl  = document.getElementById('pw-annual-price');
    const annualSubEl    = document.getElementById('pw-annual-sub');
    const badgeEl         = document.getElementById('pw-annual-badge');
    const termsMonthlyEl = document.getElementById('terms-monthly-price');
    const termsAnnualEl  = document.getElementById('terms-annual-price');

    if(monthlyPriceEl) monthlyPriceEl.textContent = monthlyProduct ? monthlyProduct.priceString : '';
    if(annualPriceEl)  annualPriceEl.textContent  = annualProduct  ? annualProduct.priceString  : '';
    if(termsMonthlyEl) termsMonthlyEl.textContent = monthlyProduct ? `${monthlyProduct.priceString} شهرياً` : '—';
    if(termsAnnualEl)  termsAnnualEl.textContent  = annualProduct  ? `${annualProduct.priceString} سنوياً`  : '—';
    if(annualSubEl)    annualSubEl.textContent    = annualProduct  ? perMonthFromAnnual(annualProduct)     : '';

    if(badgeEl){
      let showBadge = false;
      if(monthlyProduct && annualProduct &&
         typeof monthlyProduct.price==='number' && typeof annualProduct.price==='number'){
        const pct = Math.round((1 - annualProduct.price/(monthlyProduct.price*12)) * 100);
        if(pct > 0){
          badgeEl.textContent = `الأفضل قيمة · وفّر ${pct}%`;
          showBadge = true;
        }
      }
      badgeEl.hidden = !showBadge;
      if(!showBadge) badgeEl.textContent = '';
    }

    if(sub) sub.textContent = pwCtaSub(_pwPlan);
    if(err) err.style.display = 'none';
    if(btn) btn.disabled = false;
  }catch(e){
    logClientEvent('error','paywall.prices');
    if(err) err.style.display = 'block';
    if(sub) sub.textContent = '';
    if(btn) btn.disabled = true;
  }finally{
    _pwPricesLoading = false;
  }
}

async function rcPurchase(plan){
  const RC = getRC();
  if(!RC) throw new Error('RevenueCat مو متوفر');
  const { monthly, annual } = await fetchPackages();
  const pkg = plan === 'annual' ? annual : monthly;
  if(!pkg) throw new Error('الباقة مو موجودة — تأكد من إعداد Offerings في RevenueCat');
  const { customerInfo } = await RC.purchasePackage({ aPackage: pkg });
  // إذا اكتمل الشراء بدون exception → ناجح
  // (RevenueCat قد يأخر تفعيل الـ entitlement بثوانٍ في المحاكي)
  const entActive = customerInfo.entitlements &&
                    customerInfo.entitlements.active &&
                    customerInfo.entitlements.active[RC_ENTITLEMENT];
  return entActive !== undefined ? !!entActive : true;
}

async function rcRestore(){
  const RC = getRC();
  if(!RC){ showToast('ℹ️','متوفر على iOS بس','',false); return; }
  try{
    void trackMetric('restore_started');
    if(!(await rcReady())) throw new Error('ما قدرنا نجهّز RevenueCat — راجع سجلّ Xcode');
    await RC.restorePurchases();
    await checkSubscriptionAndRoute(window._currentUid || storeGet('authUid',''));
    showToast('ℹ️','ثواني ونتأكد من الاستعادة','المحتوى يفتح عقب تأكيد الخادم',false);
  }catch(e){ showToast('⚠️','ما قدرنا نستعيد المشتريات', e.message||'', false); }
}

async function checkSubscriptionAndRoute(uid, {showLoading=true} = {}){
  if(showLoading) go('s-loading');
  // الخادم هو المصدر الأول. إن تأخر webhook بعد شراء صحيح، نستخدم
  // CustomerInfo الموقّع من RevenueCat حتى لا يبقى العميل عالقاً في paywall.
  try{
    const idToken=await getCurrentIdToken();
    if(!idToken) throw new Error('لا توجد جلسة Firebase موثّقة');
    const ctrl = new AbortController();
    const timer = setTimeout(()=>ctrl.abort(), 8000); // 8 ثوانٍ حد أقصى
    let resp;
    try{
      resp = await apiFetch(`/api/subscription/status?uid=${encodeURIComponent(uid||'')}`,{
        headers:{'Authorization':'Bearer '+idToken},
        signal: ctrl.signal
      });
    }finally{ clearTimeout(timer); }
    if(!resp.ok) throw new Error('status error');
    const data = await resp.json();
    if(data.active === true || await rcIsActive() === true){
      _hasActiveSubscription=true; setFreeRoundAvailability(false); _subscriptionResolved=true;
      await routeAfterAccessCheck(uid); return;
    }
    _hasActiveSubscription=false;
    setFreeRoundAvailability(await freeRoundIsAvailable(uid));
    _subscriptionResolved=true;
    // لا نفاجئ المستخدم بشاشة الاشتراك عند كل تشغيل. بعد استهلاك الجولة
    // المجانية يبقى في الرئيسية، وتظهر شاشة الاشتراك عندما يطلب جولة جديدة.
    await routeAfterAccessCheck(uid);
  }catch(e){
    if(await rcIsActive() === true){
      _hasActiveSubscription=true; setFreeRoundAvailability(false); _subscriptionResolved=true;
      await routeAfterAccessCheck(uid); return;
    }
    _hasActiveSubscription=false;
    setFreeRoundAvailability(localFreeRoundCompleted(uid)?false:null);
    _subscriptionResolved=true;
    await routeAfterAccessCheck(uid);
  }
}

async function redeemAppleOfferCode(){
  sfx('tap');
  const RC=getRC();
  if(!window.Capacitor?.isNativePlatform?.() || !RC || typeof RC.presentCodeRedemptionSheet!=='function'){
    showToast('ℹ️','أكواد Apple داخل التطبيق بس','افتح فطنة على iPhone أو iPad عشان تستخدم كود العرض',false);
    return;
  }
  try{
    if(!(await rcReady())) throw new Error('ما قدرنا نجهّز اشتراكات Apple');
    void trackMetric('offer_code_opened');
    await RC.presentCodeRedemptionSheet();
    if(typeof RC.syncPurchases==='function') await RC.syncPurchases();
    await new Promise(resolve=>setTimeout(resolve,1200));
    await checkSubscriptionAndRoute(window._currentUid||storeGet('authUid',''),{showLoading:false});
    if(_hasActiveSubscription){
      showToast('🎉','فعّلنا العرض','اشتراك فطنة برو صار شغّال',false);
    }else{
      showToast('ℹ️','سكّرت نافذة Apple','إذا استخدمت الكود، الاشتراك يطلع عقب تأكيد Apple',false);
    }
  }catch(e){
    recordNonFatal(e,'apple.offer-code');
    showToast('⚠️','ما قدرنا نفتح كود العرض',e.message||'جرّب مرة ثانية',false);
  }
}

function hideSplash(){
  try{ window.Capacitor?.Plugins?.SplashScreen?.hide(); }catch(e){}
}

// ────────── Paywall — اختيار الخطة
document.addEventListener('DOMContentLoaded', ()=>{
  document.querySelectorAll('.pw-plan').forEach(el=>{
    const handler = ()=>{
      if(el.style.display === 'none') return; // خطة غير متاحة حالياً
      document.querySelectorAll('.pw-plan').forEach(p=>p.setAttribute('aria-checked','false'));
      el.setAttribute('aria-checked','true');
      _pwPlan = el.dataset.plan;
      const sub = document.getElementById('pw-cta-sub');
      if(sub) sub.textContent = pwCtaSub(_pwPlan);
    };
    el.addEventListener('click', handler);
    el.addEventListener('keydown', e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); handler(); } });
  });
});

let _checkoutPending=false;
async function startCheckout(){
  if(_checkoutPending) return;
  _checkoutPending=true;
  const btn     = document.getElementById('paywall-btn');
  const loading = document.getElementById('paywall-loading');
  btn.style.display     = 'none';
  loading.style.display = 'block';
  try{
    void trackMetric('purchase_started',{plan:_pwPlan});
    // iOS: Apple IAP عبر RevenueCat
    if(window.Capacitor && window.Capacitor.isNativePlatform()){
      const purchaseConfirmed = await rcPurchase(_pwPlan);
      if(!purchaseConfirmed) throw new Error('اكتمل الدفع بس الاشتراك ما ظهر للحين — استخدم استعادة المشتريات');
      const uid=window._currentUid || storeGet('authUid','');
      let serverActive=false;
      for(let attempt=0; attempt<12 && !serverActive; attempt++){
        if(attempt) await new Promise(resolve=>setTimeout(resolve,1500));
        try{
          const idToken=await getCurrentIdToken();
          const check=await apiFetch(`/api/subscription/status?uid=${encodeURIComponent(uid)}`,
            {headers:idToken ? {'Authorization':'Bearer '+idToken} : {}});
          if(check.ok) serverActive=(await check.json()).active===true;
        }catch(e){}
      }
      if(serverActive || await rcIsActive() === true){
        _hasActiveSubscription=true; _freeRoundAvailable=false; _subscriptionResolved=true;
        void trackMetric('purchase_completed',{plan:_pwPlan});
        go('s-home');
        showToast('🎉','هلا فيك!','فعّلنا اشتراك Apple بنجاح',false);
      } else {
        go('s-paywall');
        showToast('⏳','ثواني ونتأكد من الاشتراك','المحتوى يطلع عقب ما يوصل تأكيد Apple',false);
      }
      return;
    }
    const note = document.getElementById('web-payment-note');
    if(note) note.style.display = 'block';
    showToast('ℹ️','الاشتراك عبر Apple فقط','افتح تطبيق فطنة على iPhone أو iPad لإتمام الاشتراك',false);
    btn.style.display = 'block';
    loading.style.display = 'none';
    return;
  }catch(e){
    // تجاهل إلغاء المستخدم بصمت
    if((e.code||'').toString().includes('CANCELLED') ||
       (e.message||'').toLowerCase().includes('cancel')){ /* صامت */ }
    else{ showToast('⚠️','ما قدرنا نكمّل الدفع', e.message || 'جرّب مرة ثانية', false); }
    btn.style.display     = 'block';
    loading.style.display = 'none';
  }finally{
    _checkoutPending=false;
    btn.style.display='block';
    loading.style.display='none';
  }
}

// ────────── مستوى الصعوبة
const DIFF_TIMES={easy:{normal:45,speed:25,steal:18,bomb:45},normal:{normal:30,speed:15,steal:30,bomb:30},hard:{normal:20,speed:10,steal:20,bomb:20}};
function setDifficulty(d){
  sfx('tap'); state.difficulty=d;
  document.querySelectorAll('#seg-diff button').forEach(button=>{
    const selected=button.dataset.d===d;
    button.classList.toggle('on',selected);
    button.setAttribute('aria-pressed',selected?'true':'false');
  });
  const labels={easy:'⏱ وقت الإجابة: 45 ثانية',normal:'⏱ وقت الإجابة: 30 ثانية',hard:'⏱ وقت الإجابة: 20 ثانية'};
  document.getElementById('diff-hint').textContent=labels[d]||'';
}

// ────────── إعداد الفرق
function setTeamCount(n){
  sfx('tap'); state.teamCount=n;
  document.querySelectorAll('#seg-teams button').forEach(button=>{
    const selected=+button.dataset.n===n;
    button.classList.toggle('on',selected);
    button.setAttribute('aria-pressed',selected?'true':'false');
  });
  renderTeamNames();
  updateCatSplitPreview();
}
function updateCatCount(v){
  sfx('tap');
  state.catCount=+v;
  document.getElementById('catcount-lbl').textContent=v;
  document.querySelectorAll('#seg-catcount button').forEach(button=>{
    const selected=+button.dataset.n===+v;
    button.classList.toggle('on',selected);
    button.setAttribute('aria-pressed',selected?'true':'false');
  });
  updateCatSplitPreview();
}
// حساب توزيع الفئات على الفرق بالتناوب، والزائد للأوائل
function computeSplit(total, teams){
  const base=Math.floor(total/teams);
  let rem=total%teams;
  const arr=[];
  for(let i=0;i<teams;i++){ arr.push(base + (rem>0?1:0)); if(rem>0) rem--; }
  return arr; // مثال: 7 فئات، 3 فرق => [3,2,2]
}
function updateCatSplitPreview(){
  const total=state.catCount||6;
  const split=computeSplit(total, state.teamCount);
  const names=[];
  for(let i=0;i<state.teamCount;i++){
    names.push(`${TEAM_STYLES[i].name}: ${split[i]}`);
  }
  const el=document.getElementById('catcount-split');
  if(el) el.textContent='كل فريق يختار — '+names.join(' · ');
}
function renderTeamNames(){
  const box=document.getElementById('team-names');
  box.innerHTML='<div class="field-label">أسماء الفرق</div>';
  for(let i=0;i<state.teamCount;i++){
    const st=TEAM_STYLES[i];
    const row=document.createElement('div'); row.className='team-row';
    row.innerHTML=`<div class="dot" style="background:${st.dot}; color:${st.dot}"></div>
      <input class="team-input" id="tn-${i}" aria-label="اسم الفريق ${i+1}" value="${st.name}" maxlength="16" oninput="updateCatSplitPreview()">`;
    box.appendChild(row);
  }
}
async function toCats(){
  state.teams=[];
  for(let i=0;i<state.teamCount;i++){
    const val=(document.getElementById('tn-'+i).value||TEAM_STYLES[i].name).trim();
    state.teams.push({name:val||TEAM_STYLES[i].name, score:0, ll:3, used:new Set(), idx:i, bombUsed:false});
  }
  // جهّز توزيع الاختيار بالتناوب
  state.catCount=state.catCount||6;
  state.pickSplit=computeSplit(state.catCount, state.teamCount);
  state.pickTurn=0;          // أي فريق يختار الآن
  state.pickedByTeam=state.teams.map(()=>0); // كم اختار كل فريق
  go('s-cats');
  const grid=document.getElementById('cat-grid');
  grid.innerHTML='<div class="empty-state">ثواني ونجهّز الفئات…</div>';
  try{
    await ensureQuestionBank();
    renderCats();
  }catch(error){
    logClientEvent('error','question-bank.load');
    go('s-teams');
    toast('ما قدرنا نحمّل الأسئلة، جرّب مرة ثانية');
  }
}

// ────────── الفئات
let activeFilter='الكل';
function renderCats(){
  state.cats=[];
  state.catOwner={};        // فئة => رقم الفريق الذي اختارها
  activeFilter='الكل';
  document.getElementById('cat-search').value='';
  buildFilterBar();
  renderCatGrid();
  updatePickTurn();
}
function updatePickTurn(){
  const pill=document.getElementById('pick-turn-pill');
  const total=state.catCount;
  const done=state.cats.length>=total;
  if(done){
    pill.style.background='var(--okb)'; pill.style.color='var(--ok)'; pill.style.borderColor='var(--ok)';
    pill.textContent='✅ اختاروا كل الفئات — يلا نبدأ!';
  } else {
    const ti=state.pickTurn;
    const st=TEAM_STYLES[state.teams[ti].idx];
    const need=state.pickSplit[ti]-state.pickedByTeam[ti];
    pill.style.background=st.bg; pill.style.color=st.color; pill.style.borderColor=st.dot;
    pill.textContent=`دور فريق ${state.teams[ti].name} — اختار ${need} ${need===1?'فئة':'فئات'}`;
  }
  const line=document.getElementById('pick-count-line');
  line.innerHTML=`اختاروا <b>${state.cats.length}</b> من ${total}`;
  const startButton=document.getElementById('start-btn');
  const categoryWord=total===2?'فئتين':`${total} فئات`;
  startButton.disabled=!done;
  startButton.textContent=`يلا نبدأ — ${categoryWord}`;
  startButton.classList.toggle('show',done);
  startButton.setAttribute('aria-hidden',done?'false':'true');
  document.getElementById('s-cats').classList.toggle('start-ready',done);
}
function buildFilterBar(){
  const bar=document.getElementById('filter-bar');
  setupFilterBarDrag();
  bar.innerHTML='';
  const groups=['الكل',...Object.keys(CAT_GROUPS)];
  if((familyCats||[]).some(f=>f.questions.length>0)) groups.push('عائلية');
  groups.forEach(g=>{
    const b=document.createElement('button');
    b.className='fbtn'+(g===activeFilter?' on':'');
    b.setAttribute('aria-pressed',g===activeFilter?'true':'false');
    b.textContent=(g==='الكل'?'🗂️ الكل':(g==='عائلية'?'👨‍👩‍👧‍👦 عائلية':(GROUP_ICONS[g]||'')+' '+g));
    b.onclick=()=>{ sfx('tap'); activeFilter=g; document.getElementById('cat-search').value=''; buildFilterBar(); renderCatGrid(); };
    bar.appendChild(b);
  });
}
function setupFilterBarDrag(){
  const bar=document.getElementById('filter-bar');
  if(!bar || bar.dataset.dragReady==='1') return;
  bar.dataset.dragReady='1';
  let scrolledRecently=false, scrollTimer;
  bar.addEventListener('scroll',()=>{
    scrolledRecently=true;
    clearTimeout(scrollTimer);
    scrollTimer=setTimeout(()=>{ scrolledRecently=false; },200);
  });
  bar.addEventListener('click',e=>{
    if(scrolledRecently){ e.preventDefault(); e.stopPropagation(); scrolledRecently=false; }
  },true);
  let dragging=false, startX=0, startScroll=0;
  bar.addEventListener('mousedown',e=>{
    if(e.button!==0) return;
    dragging=true; startX=e.clientX; startScroll=bar.scrollLeft;
    bar.classList.add('dragging');
  });
  bar.addEventListener('mousemove',e=>{
    if(!dragging) return;
    bar.scrollLeft=startScroll-(e.clientX-startX);
  });
  const endMouse=()=>{ dragging=false; bar.classList.remove('dragging'); };
  bar.addEventListener('mouseup',endMouse);
  bar.addEventListener('mouseleave',endMouse);
}
function catsForFilter(){
  if(activeFilter==='الكل') return [...ALL_CATS, ...familyNames()];
  if(activeFilter==='عائلية') return familyNames();
  return CAT_GROUPS[activeFilter]||[];
}
function familyNames(){ return (familyCats||[]).filter(f=>f.questions.length>0).map(f=>f.name); }
function isFamilyCat(name){ return (familyCats||[]).some(f=>f.name===name); }

function renderCatGrid({focusCategory='',preserveFocus=true}={}){
  const grid=document.getElementById('cat-grid');
  const activeCategory=preserveFocus?(document.activeElement?.closest?.('.cat-pick')?.dataset.category||''):'';
  const categoryToRefocus=focusCategory||activeCategory;
  const search=(document.getElementById('cat-search').value||'').trim();
  grid.innerHTML='';
  let list=catsForFilter();
  if(search) list=[...ALL_CATS,...familyNames()].filter(c=>displayCategoryName(c).includes(search));
  if(!list.length){ grid.innerHTML='<div style="grid-column:1/-1;text-align:center;color:var(--muted);padding:20px;font-size:14px;">ماكو فئات مطابقة</div>'; return; }
  list.forEach(cat=>{
    // زر حقيقي لا <div> — خطوة إلزامية بكل لعبة، وكانت بلا أي دلالة وصول
    // فلا يقدر مستخدم VoiceOver يكتشفها أو يستخدمها إطلاقاً
    const el=document.createElement('button');
    el.type='button';
    el.dataset.category=cat;
    const picked=state.cats.includes(cat);
    el.className='cat-pick'+(picked?' on':'');
    el.setAttribute('aria-pressed', picked?'true':'false');
    const visual=categoryVisual(cat);
    const icon=visual.icon;
    const shownCategory=isFamilyCat(cat)?cat:displayCategoryName(cat);
    el.style.setProperty('--cat-accent',visual.accent);
    el.style.setProperty('--cat-tint',visual.tint);
    el.style.setProperty('--cat-border',visual.border);
    el.dataset.icon=icon;
    el.dataset.tone=visual.tone;
    // إن اختارها فريق، أظهر لون الفريق
    let ownerBadge='', ownerLabel='';
    if(picked && state.catOwner[cat]!=null){
      const ownerName=state.teams[state.catOwner[cat]].name;
      const ost=TEAM_STYLES[state.teams[state.catOwner[cat]].idx];
      el.style.borderColor=ost.dot;
      ownerBadge=`<span style="position:absolute;bottom:6px;left:8px;font-size:10px;font-weight:800;color:${ost.color}">${esc(ownerName)}</span>`;
      ownerLabel=` — اختارتها ${ownerName}`;
    }
    el.innerHTML=`<span class="ci" aria-hidden="true">${icon}</span><span class="cat-name">${esc(shownCategory)}</span>${ownerBadge}`;
    el.setAttribute('aria-label', shownCategory+(picked?' — مختارة'+ownerLabel:''));
    // click.detail يساوي صفر عند التفعيل بالكيبورد أو VoiceOver، وأكبر من صفر
    // عند اللمس. نحفظ التركيز للتقنيات المساعدة فقط حتى لا يحاول WebView
    // تكبير/تمرير البطاقة بعد كل ضغطة لمس سريعة.
    el.onclick=event=>toggleCat(cat,el,{preserveFocus:event.detail===0});
    grid.appendChild(el);
  });
  if(categoryToRefocus){
    const target=[...grid.querySelectorAll('.cat-pick')].find(button=>button.dataset.category===categoryToRefocus);
    if(target) requestAnimationFrame(()=>{
      try{ target.focus({preventScroll:true}); }catch(error){ try{ target.focus(); }catch(focusError){} }
    });
  }
}
function filterCats(){ renderCatGrid(); }

function toggleCat(cat,el,{preserveFocus=true}={}){
  const already=state.cats.indexOf(cat);
  // إلغاء اختيار: فقط الفريق الذي اختارها يقدر يلغيها، وترجع الأدوار
  if(already>=0){
    const owner=state.catOwner[cat];
    if(owner!==state.pickTurn){
      const ownerName=state.teams[owner]?.name||'الفريق الثاني';
      showToast('🔒','هذي الفئة مو لفريقكم',`فريق ${ownerName} هو اللي اختارها، وما يقدر يلغيها إلا بدوره.`,false);
      return false;
    }
    sfx('tap');
    state.cats.splice(already,1);
    delete state.catOwner[cat];
    state.pickedByTeam[owner]--;
    state.pickTurn=owner; // يرجع الدور لمن ألغى
    renderCatGrid({focusCategory:preserveFocus?cat:'',preserveFocus}); updatePickTurn();
    return true;
  }
  // اختيار جديد
  if(state.cats.length>=state.catCount) return false;
  const ti=state.pickTurn;
  state.cats.push(cat);
  state.catOwner[cat]=ti;
  state.pickedByTeam[ti]++;
  sfx('tap'); vibrate(12);
  // هل انتهى نصيب هذا الفريق؟ انتقل للتالي الذي لم يكمل
  advancePickTurn();
  renderCatGrid({focusCategory:preserveFocus?cat:'',preserveFocus}); updatePickTurn();
  return true;
}
function advancePickTurn(){
  const n=state.teamCount;
  // إن كان الفريق الحالي لم يُكمل نصيبه، يبقى دوره
  if(state.pickedByTeam[state.pickTurn]<state.pickSplit[state.pickTurn]) return;
  // وإلا انتقل للفريق التالي الذي لم يُكمل
  for(let step=1;step<=n;step++){
    const next=(state.pickTurn+step)%n;
    if(state.pickedByTeam[next]<state.pickSplit[next]){ state.pickTurn=next; return; }
  }
  // كل الفرق أكملت — يبقى كما هو
}

// ────────── بدء
let roundQuestionBank=Object.create(null);
let roundQuestionToken=0;
let roundImageQuestionIds=new Set();
function questionsForRoundCategory(category){
  return Object.prototype.hasOwnProperty.call(roundQuestionBank,category)
    ? roundQuestionBank[category]
    : (QUESTION_BANK?.[category]||[]);
}
function validRemoteRoundBank(bank,categories){
  if(!bank||Array.isArray(bank)||typeof bank!=='object') return false;
  return categories.every(category=>{
    const questions=bank[category];
    if(!Array.isArray(questions)||questions.length!==6) return false;
    const levels=new Set(); const ids=new Set();
    for(const question of questions){
      if(!question||typeof question!=='object'||!/^gq-[a-f0-9]{20}$/.test(String(question.id||''))) return false;
      if(!Number.isInteger(question.d)||question.d<1||question.d>6||levels.has(question.d)) return false;
      if(typeof question.q!=='string'||question.q.length<12||question.q.length>220) return false;
      if(typeof question.answer!=='string'||!question.answer.trim()||question.answer.length>140) return false;
      if(question.source?.url&&!isHttpsUrl(question.source.url)) return false;
      if(question.review?.status!=='approved'||ids.has(question.id)) return false;
      levels.add(question.d); ids.add(question.id);
    }
    return levels.size===6;
  });
}
function remoteRoundCacheKey(uid,categories){
  return scopedAccessKey(`remote_round_${[...categories].sort().join('|')}`,uid);
}
async function prepareRemoteRoundQuestionBank(uid){
  roundQuestionBank=Object.create(null);
  if(!_hasActiveSubscription||state.familyRound) return true;
  const remoteCategories=state.cats.filter(category=>
    !(QUESTION_BANK?.[category]||[]).some(question=>question.image));
  if(!remoteCategories.length) return true;
  const cacheKey=remoteRoundCacheKey(uid,remoteCategories);
  const cached=storeGet(cacheKey,null);
  const useCache=()=>{
    const age=Date.now()-Number(cached?.savedAt||0);
    if(age<0||age>30*24*60*60*1000||!validRemoteRoundBank(cached?.questions,remoteCategories)) return false;
    roundQuestionBank=Object.assign(Object.create(null),cached.questions);
    return true;
  };
  const idToken=await getCurrentIdToken();
  if(!idToken) return useCache()||!storeGet('remote_question_bank_required',false);
  const history=loadQuestionHistory();
  const excludeQuestionIds=[...new Set(Object.values(history).flat().filter(id=>typeof id==='string'))].slice(-2000);
  try{
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),10000);
    let response;
    try{
      response=await apiFetch('/api/questions/round',{
        method:'POST',signal:controller.signal,
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+idToken},
        body:JSON.stringify({uid,idToken,categories:remoteCategories,excludeQuestionIds}),
      });
    }finally{ clearTimeout(timeout); }
    const payload=await response.json().catch(()=>({}));
    if(response.ok&&payload.schemaVersion===1&&validRemoteRoundBank(payload.questions,remoteCategories)){
      roundQuestionBank=Object.assign(Object.create(null),payload.questions);
      storeSet(cacheKey,{savedAt:Date.now(),bankVersion:payload.bankVersion||'',questions:payload.questions});
      storeSet('remote_question_bank_required',true);
      return true;
    }
    if(useCache()) return true;
    if(['question_bank_not_ready','feature_disabled','unsupported_v2_route','v2_route_required','question_bank_v2_only'].includes(payload.code)) return true;
  }catch(_){ if(useCache()) return true; }
  return !storeGet('remote_question_bank_required',false);
}
async function prepareSelectedImageCategories(){
  roundImageQuestionIds=new Set();
  const categories=state.cats.filter(category=>(QUESTION_BANK?.[category]||[]).some(question=>question.image));
  for(const category of categories){
    const questions=QUESTION_BANK[category];
    try{
      questions.forEach(question=>window.FatinahImageAssets.validateQuestion(question));
      const ready=await window.FatinahImageAssets.prepareCategory(questions);
      for(let difficulty=1;difficulty<=6;difficulty++){
        const ids=ready.get(difficulty);
        if(!ids?.size) return false;
        ids.forEach(id=>roundImageQuestionIds.add(id));
      }
    }catch(_){ return false; }
  }
  return true;
}
function findRoundStockIssue(){
  const history=loadQuestionHistory();
  for(const category of state.cats){
    const familyCategory=(familyCats||[]).find(item=>item.name===category);
    if(familyCategory){
      if(new Set(familyCategory.questions.map(question=>question.q)).size<6){
        return {category,difficulty:null};
      }
      continue;
    }
    const questions=questionsForRoundCategory(category);
    for(let difficulty=1;difficulty<=6;difficulty++){
      const hasUnseenQuestion=questions.some(question=>question.d===difficulty
        &&!questionWasSeen(history,category,question)
        &&(!question.image||roundImageQuestionIds.has(question.id)||window.FatinahImageAssets?.isReady(question)));
      if(!hasUnseenQuestion) return {category,difficulty};
    }
  }
  return null;
}
function canStartRound(){
  if(_hasActiveSubscription) return true;
  if(_freeRoundAvailable) return true;
  if(!_subscriptionResolved||_freeRoundVerificationState==='unknown'){
    showToast('⏳','ثواني ونتأكد','نطر شوي وجرّب مرة ثانية',false);
    return false;
  }
  go('s-paywall');
  return false;
}
let _startGamePending=false;
async function startGame(){
  if(_startGamePending) return false;
  if(!canStartRound()) return;
  _startGamePending=true;
  try{
    const uid=window._currentUid||storeGet('authUid','');
    const startsAsFreeRound=!_hasActiveSubscription;
    // على جهاز جديد يجب تنزيل سجل الحساب قبل اختيار أي سؤال؛ وإلا قد تبدأ
    // الجولة أثناء طلب GET وتعرض سؤالاً شاهده المستخدم على جهاز آخر.
    // الحساب المحلي البحت لا يملك خادماً آخر للمزامنة وسجله على الجهاز كافٍ.
    const provider=storeGet('authProvider','local');
    if(provider!=='local' && !(await syncQuestionHistory())){
      showToast('⚠️','ما قدرنا نزامن أسئلتك','تأكد من الإنترنت وجرّب مرة ثانية حتى ما نكرر عليك سؤالاً',false);
      return false;
    }
    if(!(await prepareRemoteRoundQuestionBank(uid))){
      showToast('⚠️','ما قدرنا نجهّز أسئلة الجولة','تأكد من الإنترنت وجرّب مرة ثانية. إذا سبق وحمّلنا جولة محفوظة راح نستخدمها تلقائياً.',false);
      return false;
    }
    if(!(await prepareSelectedImageCategories())){
      showToast('🖼️','الصورة مو جاهزة','تأكد من الإنترنت وجرّب مرة ثانية. ما راح نبدأ سؤال مصوّر من غير صورة محفوظة وآمنة.',false);
      return false;
    }
    const stockIssue=findRoundStockIssue();
    if(stockIssue){
      const level=Number.isInteger(stockIssue.difficulty)?` بالمستوى ${stockIssue.difficulty}`:'';
      showToast('📚','اختار فئة ثانية',
        `ما بقى سؤال يديد بفئة «${displayCategoryName(stockIssue.category)}»${level}. اختار فئة ثانية عشان نضمن إن الجولة تكتمل.`,false);
      state.pickSplit=computeSplit(state.catCount,state.teamCount);
      state.pickTurn=0;
      state.pickedByTeam=state.teams.map(()=>0);
      renderCats();
      go('s-cats');
      return false;
    }
    // لا نستهلك bit العرض في DeviceCheck إلا بعد اكتمال كل فحوص بدء
    // الجولة؛ حتى لا يفقد اللاعب عرضه بسبب فشل مزامنة سجل الأسئلة.
    if(startsAsFreeRound){
      const claimed=await claimFreeRound(uid);
      if(claimed!==true){
        if(claimed===false) go('s-paywall');
        else showToast('⚠️','ما قدرنا نثبت الجولة','تأكد من الإنترنت وجرّب مرة ثانية',false);
        return false;
      }
    }
  state.familyRound=null; state.usedQ=new Set(); state.usedQuestionIds=new Set();
  // لا نمسح بنك الجولة الذي جُلب وتحققنا منه قبل بناء اللوحة.
  roundQuestionToken++;
  vibrate(30); state.turn=0; state.answered=0; state.cells={};
  state.startedAt=Date.now(); state.roundCorrect=0; state.roundIncorrect=0;
  state.isFreeRound=startsAsFreeRound;
  state.completedFreeRound=false;
  state.roundActive=true; state.cur=null; state.searchTimeLeft=0;
  buildBoard(); renderTeamsBar(); renderTurn(); go('s-board');
  persistActiveRound(true);
  void trackMetric('game_started',{
    difficulty:state.difficulty,teams:state.teams.length,
    categoryCount:state.cats.length,freeRound:state.isFreeRound,
  });
    return true;
  }finally{ _startGamePending=false; }
}
function buildBoard(){
  const n=state.cats.length;
  const boardScroll=document.getElementById('board-scroll');
  const boardGrid=document.getElementById('board-grid');
  const needsHorizontalScroll=n>6;
  boardScroll.classList.toggle('is-scrollable',needsHorizontalScroll);
  boardGrid.style.minWidth=needsHorizontalScroll?`${n*52+(n-1)*5}px`:'0';
  boardScroll.scrollLeft=0;
  const boardHint=document.getElementById('board-hint');
  boardHint.textContent=needsHorizontalScroll
    ?'↔️ اسحب اللوحة يمين ويسار لباقي الفئات · كل خانة فيها سؤال بقيمة نقاطها'
    :'اختار خانة من اللوحة · كل خانة فيها سؤال بقيمة نقاطها';
  const head=document.getElementById('cats-head'); head.innerHTML='';
  head.style.gridTemplateColumns=`repeat(${n},1fr)`;
  state.cats.forEach(c=>{ const h=document.createElement('div'); h.className='cat-h'; h.textContent=isFamilyCat(c)?c:displayCategoryName(c); head.appendChild(h); });
  const board=document.getElementById('board'); board.innerHTML='';
  board.style.gridTemplateColumns=`repeat(${n},1fr)`;
  // خطّ حجم على أساس عدد الفئات (كثرة الأعمدة = خط أصغر)
  const fontSize = n>=9?'12px':(n>=7?'14px':'clamp(13px,3.6vw,19px)');
  for(let r=1;r<=6;r++) for(let col=0;col<n;col++){
    const key=col+'-'+r; state.cells[key]={used:false};
    const cell=document.createElement('button'); cell.className='cell';
    cell.style.background=FIRE[r].bg; cell.style.color=FIRE[r].tx; cell.textContent=POINTS[r];
    cell.setAttribute('aria-label',`سؤال ${isFamilyCat(state.cats[col])?state.cats[col]:displayCategoryName(state.cats[col])} بقيمة ${POINTS[r]} نقطة`);
    cell.style.fontSize=fontSize;
    cell.onclick=()=>openQuestion(col,r,key,cell); board.appendChild(cell);
  }
  // إجمالي الأسئلة = عدد الفئات × 6
  state.totalQuestions = n*6;
}
function renderTeamsBar(){
  const bar=document.getElementById('teams-bar'); bar.innerHTML='';
  bar.classList.toggle('three-teams',state.teams.length===3);
  const max=Math.max(...state.teams.map(t=>t.score));
  state.teams.forEach((t,i)=>{
    const st=TEAM_STYLES[t.idx];
    const chip=document.createElement('div'); chip.className='team-chip'+(i===state.turn?' active':'');
    chip.style.background=st.bg; chip.style.borderColor=(i===state.turn?st.dot:'transparent');
    chip.setAttribute('aria-label',`${t.name}، ${t.score} نقطة${i===state.turn?'، عليه الدور':''}`);
    if(i===state.turn) chip.setAttribute('aria-current','true');
    const lead=(t.score>0&&t.score===max);
    chip.innerHTML=`<span class="crown" style="display:${lead?'block':'none'}">👑</span>
      <span class="cn" style="color:${st.color}">${esc(t.name)}</span>
      <span class="cs" style="color:${st.color}">${t.score}</span>
      <div class="score-adj" style="color:${st.color}">
        <button aria-label="خصم 100 نقطة من ${esc(t.name)}" onclick="adjustScore(${i},-100)">-100</button>
        <button aria-label="إضافة 100 نقطة إلى ${esc(t.name)}" onclick="adjustScore(${i},100)">+100</button>
      </div>`;
    bar.appendChild(chip);
  });
}
function adjustScore(i,delta){
  sfx('tap'); vibrate(15);
  state.teams[i].score+=delta;
  renderTeamsBar();
  persistActiveRound(true);
}
function renderTurn(){
  const st=TEAM_STYLES[state.teams[state.turn].idx];
  const p=document.getElementById('turn-pill');
  p.style.background=st.bg; p.style.color=st.color; p.style.borderColor=st.dot;
  p.innerHTML=`▶ دور ${esc(state.teams[state.turn].name)}`;
  updateBombButton();
}

// ────────── وسيلة «القنبلة»
// تظهر لصاحب الدور إذا وصلت نقاطه لـ1000+، وتُستخدم بدل فتح خانة عادية:
// ترمي سؤالاً صعباً عشوائياً على فريق خصم (يختاره صاحب القنبلة لو 3 فرق)،
// النتيجة تخصّ الفريق المستهدَف فقط (+1200 صح / -1200 خطأ)، بلا أثر على الرامي.
function updateBombButton(){
  const box=document.getElementById('bomb-box');
  if(!box || !state.teams.length) return;
  const canBomb = state.teams[state.turn].score>=1000 && !state.teams[state.turn].bombUsed;
  box.classList.toggle('show', canBomb);
}
function startBomb(){
  if(questionOpenPending||state.cur) return false;
  sfx('tap'); vibrate(15);
  if(state.teams.length===2){
    fireBomb((state.turn+1)%2);
  } else {
    const list=document.getElementById('bomb-target-list'); list.innerHTML='';
    state.teams.forEach((t,i)=>{
      if(i===state.turn) return;
      const st=TEAM_STYLES[t.idx];
      const b=document.createElement('button');
      b.style.background=st.bg; b.style.color=st.color;
      b.textContent='💣 ارمِها على '+t.name;
      b.onclick=()=>{ closeBombTargetPicker(); fireBomb(i); };
      list.appendChild(b);
    });
    openAccessibleModal('bomb-target-modal');
  }
}
function closeBombTargetPicker(){
  closeAccessibleModal('bomb-target-modal');
}
async function fireBomb(targetIdx){
  if(questionOpenPending||state.cur) return false;
  clearInterval(state.searchTimer); // احتياط: لا يبقى مؤقّت بحث من سؤال سابق يلوّث القنبلة
  const n=state.cats.length;
  let col=-1, r=-1;
  for(let lvl=6; lvl>=1 && col===-1; lvl--){
    const candidates=[];
    for(let c=0;c<n;c++){ const key=c+'-'+lvl; if(state.cells[key] && !state.cells[key].used) candidates.push(c); }
    if(candidates.length){ col=candidates[Math.floor(Math.random()*candidates.length)]; r=lvl; }
  }
  if(col===-1){ state.teams[state.turn].bombUsed=true; persistActiveRound(true); return; } // لا خانات متبقية — سجّل القنبلة مستخدمة
  const key=col+'-'+r;
  const cellEls=document.querySelectorAll('#board .cell');
  const cell=cellEls[(r-1)*n+col];
  const cat=state.cats[col];
  const q=pickQuestion(cat,r);
  if(showQuestionExhausted(q)) return q;
  state.cur={col,r,key,cell,cat,d:r,q,points:1200,isBomb:true,bombThrower:state.turn,bombTarget:targetIdx,phase:'bomb',resolved:false};
  const badge=document.getElementById('q-badge');
  badge.textContent='💣 '+(isFamilyCat(cat)?cat:displayCategoryName(cat)); badge.style.background='#8b1a3d'; badge.style.color='#fff';
  document.getElementById('q-points').textContent='±1200 نقطة';
  setQuestionPrompt(q);
  const openingQuestion=state.cur;
  questionOpenPending=true;
  const imageReady=await renderQuestionImage(q);
  questionOpenPending=false;
  if(state.cur!==openingQuestion) return false;
  if(!imageReady){
    state.cur=null;
    showToast('🖼️','الصورة مو جاهزة','ما بدأنا السؤال ولا شغّلنا العداد. تأكد من الإنترنت وجرّب مرة ثانية.',false);
    return false;
  }
  setQuestionAnswer(q);
  setAnswerRevealed(false);
  document.getElementById('search-timer').classList.remove('show');
  document.getElementById('pause-btn').textContent='⏸';
  document.getElementById('pause-btn').disabled=false;
  document.getElementById('pause-btn').style.opacity='1';
  setQuestionHidden(false);
  startPhase('bomb');
  renderLifelines();
  keepAwakeOn();
  showQuestionScreen();
  persistActiveRound(true);
}
function awardBomb(correct){
  const c=state.cur;
  if(!c || c.resolved) return; // حارس ضد نقر مزدوج على أزرار الحكم
  c.resolved=true;
  stats.totalQ++;
  state.teams[c.bombThrower].bombUsed=true;
  if(correct){
    sfx('correct'); vibrate([15,10,15]);
    state.teams[c.bombTarget].score+=1200; stats.correct++; state.roundCorrect=(state.roundCorrect||0)+1;
  } else {
    sfx('wrong'); vibrate([40,30,40]); state.roundIncorrect=(state.roundIncorrect||0)+1;
    state.teams[c.bombTarget].score-=1200;
  }
  markBoardCellUsed(c.cell,c.key);
  state.answered++; renderTeamsBar();
  closeQuestion();
}

// ────────── الأسئلة
let questionFocusOrigin=null;
function setQuestionBackgroundInert(inert){
  const app=document.getElementById('app');
  if(!app) return;
  app.inert=inert;
  if(inert) app.setAttribute('aria-hidden','true');
  else app.removeAttribute('aria-hidden');
}
function showQuestionScreen(){
  const wrap=document.getElementById('q-wrap');
  if(!wrap) return;
  if(!wrap.classList.contains('show')){
    const cell=state.cur?.cell;
    questionFocusOrigin=cell?.isConnected?cell:document.activeElement;
  }
  const sheet=wrap.querySelector('.q-sheet');
  if(sheet) sheet.scrollTop=0;
  setQuestionBackgroundInert(true);
  wrap.classList.add('show');
  wrap.setAttribute('aria-hidden','false');
  document.body.classList.add('question-open');
  requestAnimationFrame(()=>document.getElementById('q-question-card')?.focus({preventScroll:true}));
}
function hideQuestionScreen(restoreBoardFocus=true){
  const wrap=document.getElementById('q-wrap');
  if(wrap){
    wrap.classList.remove('show');
    wrap.setAttribute('aria-hidden','true');
  }
  document.body.classList.remove('question-open');
  setQuestionBackgroundInert(false);
  if(restoreBoardFocus){
    const origin=questionFocusOrigin?.isConnected?questionFocusOrigin:(state.cur&&state.cur.cell);
    requestAnimationFrame(()=>origin?.focus({preventScroll:true}));
  }
  questionFocusOrigin=null;
}
function setAnswerRevealed(revealed){
  const answer=document.getElementById('answer-box');
  if(!answer) return;
  answer.classList.toggle('show',revealed);
  answer.setAttribute('aria-hidden',revealed?'false':'true');
}
function focusRevealedAnswer(){
  requestAnimationFrame(()=>{
    const wrap=document.getElementById('q-wrap');
    const sheet=wrap?.querySelector('.q-sheet');
    const answer=document.getElementById('answer-box');
    const controls=document.getElementById('q-controls');
    if(!wrap?.classList.contains('show')||!sheet||!answer?.classList.contains('show')||!controls) return;
    try{ answer.focus({preventScroll:true}); }catch(error){ try{ answer.focus(); }catch(focusError){} }
    const sheetRect=sheet.getBoundingClientRect();
    const answerRect=answer.getBoundingClientRect();
    const controlsRect=controls.getBoundingClientRect();
    const contentTop=sheet.scrollTop+(answerRect.top-sheetRect.top);
    const contentBottom=sheet.scrollTop+(controlsRect.bottom-sheetRect.top);
    const padding=12;
    let target=sheet.scrollTop;
    if(contentBottom>target+sheet.clientHeight-padding) target=contentBottom-sheet.clientHeight+padding;
    if(contentTop<target+padding) target=Math.max(0,contentTop-padding);
    const reduceMotion=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches===true;
    sheet.scrollTo({top:Math.max(0,target),behavior:reduceMotion?'auto':'smooth'});
  });
}
function setAdaptiveCopy(element,text){
  const value=String(text||'');
  element.textContent=value;
  const length=[...value].length;
  element.classList.toggle('text-long',length>75&&length<=125);
  element.classList.toggle('text-very-long',length>125);
}
function setQuestionPrompt(q){
  setAdaptiveCopy(document.getElementById('q-text'),displayQuestionText(q));
}
function setQuestionPhaseLayout(phase){
  const wrap=document.getElementById('q-wrap');
  if(wrap) wrap.dataset.phase=phase||'owner';
}
let activeQuestionImageUrl='';
let questionImageRequestToken=0;
function revokeQuestionImageUrl(url){
  if(!url) return;
  try{ URL.revokeObjectURL(url); }catch(_){ }
}
async function renderQuestionImage(q,{allowFallback=false}={}){
  const requestToken=++questionImageRequestToken;
  const wrap=document.getElementById('q-image-wrap');
  const image=document.getElementById('q-image');
  const fallback=document.getElementById('q-image-fallback');
  if(activeQuestionImageUrl){ revokeQuestionImageUrl(activeQuestionImageUrl); activeQuestionImageUrl=''; }
  image.removeAttribute('src'); image.alt=''; fallback.hidden=true; wrap.hidden=true;
  wrap.setAttribute('aria-hidden','true');
  if(!q?.image) return true;
  const contentHidden=state.paused===true;
  wrap.hidden=contentHidden;
  wrap.setAttribute('aria-hidden',contentHidden?'true':'false');
  image.alt=q.image.alt;
  try{
    const pendingImage=new Image();
    const loadedUrl=await window.FatinahImageAssets.loadInto(q,pendingImage);
    if(requestToken!==questionImageRequestToken){
      revokeQuestionImageUrl(loadedUrl);
      return false;
    }
    image.src=loadedUrl;
    if(typeof image.decode==='function') await image.decode();
    if(requestToken!==questionImageRequestToken){
      image.removeAttribute('src');
      revokeQuestionImageUrl(loadedUrl);
      return false;
    }
    activeQuestionImageUrl=loadedUrl;
    return true;
  }catch(_){
    if(requestToken!==questionImageRequestToken) return false;
    image.removeAttribute('src');
    fallback.textContent='الصورة مو متوفرة الحين. الوصف: '+q.image.alt;
    fallback.hidden=false;
    return allowFallback;
  }
}
function setQuestionAnswer(q){
  setAdaptiveCopy(document.getElementById('ans-text'),q.answer || (q.o && typeof q.a==='number' ? q.o[q.a] : ''));
  const source=document.getElementById('q-source');
  const validSource=q && q.source && isHttpsUrl(q.source.url);
  source.hidden=true;
  source.style.display='none';
  if(validSource){
    source.href=q.source.url;
    source.textContent='المصدر: '+(q.source.title||'مرجع موثوق');
  }
  const rights=document.getElementById('q-image-rights');
  const imageRights=q?.image?.rights;
  const validRights=imageRights?.owner&&imageRights.credit&&imageRights.provider&&imageRights.license
    &&isHttpsUrl(imageRights.sourcePage)&&isHttpsUrl(imageRights.licenseUrl)&&imageRights.modifications;
  rights.hidden=true;
  const credit=document.getElementById('q-image-credit');
  const sourcePage=document.getElementById('q-image-source-page');
  const license=document.getElementById('q-image-license');
  const modifications=document.getElementById('q-image-modifications');
  if(validRights){
    const attribution=imageRights.credit===imageRights.owner
      ?imageRights.owner:`${imageRights.owner} — ${imageRights.credit}`;
    credit.textContent=`حقوق الصورة: ${attribution} — عبر ${imageRights.provider}`;
    sourcePage.href=imageRights.sourcePage;
    sourcePage.hidden=false;
    license.href=imageRights.licenseUrl;
    license.textContent=`الرخصة: ${imageRights.license}`;
    license.hidden=false;
    modifications.textContent=`معالجة الصورة: ${imageRights.modifications}`;
  }else{
    credit.textContent='';
    sourcePage.removeAttribute('href'); sourcePage.hidden=true;
    license.removeAttribute('href'); license.hidden=true;
    modifications.textContent='';
  }
  const reportButton=document.getElementById('q-report-btn');
  if(reportButton) reportButton.style.display=q&&q.id&&!state.familyRound?'inline-flex':'none';
}
function openQuestionReport(){
  const q=state.cur&&state.cur.q;
  if(!q||!q.id){
    showToast('ℹ️','ما نقدر نرسل هالبلاغ','البلاغات متوفرة لأسئلة بنك فطنة الرسمي بس',false);
    return;
  }
  sfx('tap');
  const details=document.getElementById('question-report-details');
  const reason=document.getElementById('question-report-reason');
  if(details) details.value='';
  if(reason) reason.value='incorrect_answer';
  openAccessibleModal('question-report-modal','#question-report-reason');
}
function closeQuestionReport(){
  sfx('tap');
  closeAccessibleModal('question-report-modal');
}
let _questionReportPending=false;
async function submitQuestionReport(){
  if(_questionReportPending) return;
  const current=state.cur;
  const q=current&&current.q;
  const uid=window._currentUid||storeGet('authUid','');
  if(!q||!q.id||!uid) return;
  const idToken=await getCurrentIdToken();
  if(!idToken){
    showToast('⚠️','ما قدرنا نرسل البلاغ','تأكد من تسجيل الدخول واتصال الإنترنت',false);
    return;
  }
  _questionReportPending=true;
  const button=document.getElementById('question-report-submit');
  if(button){ button.disabled=true; button.textContent='ثواني ونرسل…'; }
  try{
    const response=await apiFetch('/api/questions/report',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+idToken},
      body:JSON.stringify({
        uid,idToken,questionId:q.id,category:current.cat||'',question:q.q||'',
        answer:q.answer||(q.o&&typeof q.a==='number'?q.o[q.a]:''),
        sourceTitle:q.source?.title||'',
        sourceUrl:q.source?.url||'',
        reason:document.getElementById('question-report-reason')?.value||'other',
        details:(document.getElementById('question-report-details')?.value||'').trim(),
        appVersion:APP_VERSION,
      }),
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(data.error||'ما قدرنا نحفظ البلاغ');
    closeQuestionReport();
    void trackMetric('question_reported',{reason:document.getElementById('question-report-reason')?.value||'other'});
    const delivered=data.emailStatus==='sent';
    showToast('✅','وصلنا البلاغ',delivered?'رسلناه لبريد فريق فطنة':'حفظناه بأمان وبنرسله للبريد تلقائياً',false);
  }catch(e){
    recordNonFatal(e,'question.report');
    showToast('⚠️','ما قدرنا نرسل البلاغ',e.message||'جرّب مرة ثانية',false);
  }finally{
    _questionReportPending=false;
    if(button){ button.disabled=false; button.textContent='إرسال البلاغ'; }
  }
}
function questionExhausted(cat,d,isFamily=false){
  return {
    exhausted:true,
    code:'question_pool_exhausted',
    category:cat,
    difficulty:d,
    q:'ماكو أسئلة يديدة لهالفئة',
    answer:isFamily?'ضيف أسئلة ثانية للفئة':'اختار فئة ثانية أو نطر تحديث بنك الأسئلة',
  };
}
function showQuestionExhausted(result){
  if(!result||!result.exhausted) return false;
  const level=Number.isInteger(result.difficulty)?` للمستوى ${result.difficulty}`:'';
  showToast('📚','خلصت الأسئلة اليديدة',
    `ماكو سؤال ما شفته من قبل بفئة «${displayCategoryName(result.category)}»${level}. ${result.answer}`,false);
  return true;
}
function pickQuestion(cat,d){
  // جولة عائلية: اسحب من أسئلة الفئة العائلية بغضّ النظر عن المستوى، مع منع التكرار
  if(state.familyRound){
    const all=state.familyRound.questions;
    let pool=all.filter(q=>!state.usedQ.has(q.q));
    if(!pool.length) return questionExhausted(cat,d,true);
    const q=pool[Math.floor(Math.random()*pool.length)];
    state.usedQ.add(q.q);
    return q;
  }
  // فئة عائلية مختارة ضمن اللعب العادي
  const fam=familyCats && familyCats.find(c=>c.name===cat);
  if(fam){
    let pool=fam.questions.filter(q=>!state.usedQ.has(q.q));
    if(!pool.length) return questionExhausted(cat,d,true);
    const q=pool[Math.floor(Math.random()*pool.length)];
    state.usedQ.add(q.q);
    return q;
  }
  // الفئات الأساسية: صف اللوحة وقيمة النقاط يحددان مستوى الصعوبة، لذلك لا
  // نخلط المستويات عند نفاد البدائل. لا نمسح سجل الحساب ولا نرجع إلى سؤال
  // شاهده سابقاً؛ عند نفاد المستوى تتعامل الواجهة مع الحالة الصريحة.
  const local=questionsForRoundCategory(cat);
  const sessionIds=state.usedQuestionIds||(state.usedQuestionIds=new Set());
  const history=loadQuestionHistory();
  const exact=local.filter(q=>q.d===d&&!sessionIds.has(q.id)&&!state.usedQ.has(q.q)
    &&(!q.image||roundImageQuestionIds.has(q.id)||window.FatinahImageAssets?.isReady(q)));
  const pool=window.__FATINAH_IMAGE_FLOW_UI_TEST__===true
    ? exact
    : exact.filter(q=>!questionWasSeen(history,cat,q));
  if(!pool.length) return questionExhausted(cat,d);
  const q=pool[Math.floor(Math.random()*pool.length)];
  state.usedQ.add(q.q);
  sessionIds.add(q.id);
  rememberQuestion(cat,q);
  return q;
}
let questionOpenPending=false;
function openQuestion(col,r,key,cell){
  if(questionOpenPending||state.cur) return false;
  if(state.cells[key].used) return;
  sfx('tap'); vibrate(15);
  clearInterval(state.searchTimer); // احتياط: لا يبقى مؤقّت بحث من سؤال سابق يلوّث هذا السؤال
  const cat=state.cats[col]; const q=pickQuestion(cat,r);
  if(showQuestionExhausted(q)) return q;
  // owner = الفريق صاحب الدور ، stealQueue = بقية الفرق بالتناوب (يدعم أي عدد فرق)
  const owner=state.turn;
  const stealQueue=[];
  for(let i=1;i<state.teams.length;i++) stealQueue.push((state.turn+i)%state.teams.length);
  state.cur={col,r,key,cell,cat,d:r,q,points:POINTS[r],
    doubledForTeam:null, searchedForTeam:null,
    owner, stealQueue, stealPos:-1, eligibleTeams:new Set([owner]), passedToOpp:false, revealed:false,
    resolved:false, token:0};
  const badge=document.getElementById('q-badge');
  badge.textContent=isFamilyCat(cat)?cat:displayCategoryName(cat); badge.style.background=FIRE[r].bg; badge.style.color=FIRE[r].tx;
  document.getElementById('q-points').textContent='+'+POINTS[r]+' نقطة';
  setQuestionPrompt(q);
  const begin=()=>{
    setQuestionAnswer(q);
    setAnswerRevealed(false);
    document.getElementById('search-timer').classList.remove('show');
    document.getElementById('pause-btn').textContent='⏸';
    document.getElementById('pause-btn').disabled=false;
    document.getElementById('pause-btn').style.opacity='1';
    setQuestionHidden(false);
    startPhase('owner');
    renderLifelines();
    keepAwakeOn();
    showQuestionScreen();
    persistActiveRound(true);
    return true;
  };
  if(!q.image){ void renderQuestionImage(q); return begin(); }
  const openingQuestion=state.cur;
  questionOpenPending=true;
  return renderQuestionImage(q).then(ready=>{
    if(state.cur!==openingQuestion) return false;
    if(ready) return begin();
    state.cur=null;
    showToast('🖼️','الصورة مو جاهزة','ما بدأنا السؤال ولا شغّلنا العداد. تأكد من الإنترنت وجرّب مرة ثانية.',false);
    return false;
  }).finally(()=>{ questionOpenPending=false; });
}

// ────────── مراحل السؤال
function startPhase(phase){
  state.cur.phase=phase;
  setQuestionPhaseLayout(phase);
  const c=state.cur;
  c.token=(c.token||0)+1; // يميّز هذه المرحلة تحديداً عن أي مشغّل (مؤقّت/زر) تابع لمرحلة سابقة
  const dt=DIFF_TIMES[state.difficulty]||DIFF_TIMES.normal;
  if(c.isBomb){
    if(phase==='bomb'){
      setPhasePill(c.bombTarget, '💣 قنبلة! دور فريق '+state.teams[c.bombTarget].name+' — يجاوب شفهياً');
      showTimer(dt.bomb);
      renderFlow();
      renderLifelines();
      persistActiveRound(true);
    } else if(phase==='reveal'){
      clearInterval(state.timer);
      setAnswerRevealed(true);
      sfx('correct');
      setPhasePill(-1, 'شنو النتيجة؟');
      renderFlow();
      renderLifelines();
      focusRevealedAnswer();
      persistActiveRound(true);
    }
    return;
  }
  const isSpeed = c.cat==='إجابة سريعة';
  if(phase==='owner'){
    const t=isSpeed?dt.speed:dt.normal;
    setPhasePill(c.owner, 'دور فريق '+state.teams[c.owner].name+' — يجاوب شفهياً'+(isSpeed?' (سريع!)':''));
    updateQuestionPoints(c.owner);
    showTimer(t);
    renderFlow();
    renderLifelines();
    persistActiveRound(true);
  } else if(phase==='steal'){
    const ti=c.stealQueue[c.stealPos];
    c.eligibleTeams.add(ti);
    const t=isSpeed?Math.round(dt.speed*0.5):dt.steal;
    setPhasePill(ti, 'سرقة! دور فريق '+state.teams[ti].name+' — '+t+' ثانية');
    updateQuestionPoints(ti);
    showTimer(t);
    renderFlow();
    renderLifelines();
    persistActiveRound(true);
  } else if(phase==='reveal'){
    clearInterval(state.timer);
    setAnswerRevealed(true);
    sfx('correct');
    setPhasePill(-1, 'منو جاوب صح؟ اختار الفريق');
    renderFlow();
    renderLifelines();
    focusRevealedAnswer();
    persistActiveRound(true);
  }
}
function updateQuestionPoints(teamIdx){
  const c=state.cur;
  if(!c || c.isBomb || teamIdx<0) return;
  let points=c.points;
  const effects=[];
  if(c.doubledForTeam===teamIdx){ points*=2; effects.push('مضاعف'); }
  if(c.searchedForTeam===teamIdx){ points=Math.round(points/2); effects.push('بعد البحث'); }
  const teamName=state.teams[teamIdx].name;
  document.getElementById('q-points').textContent=
    `+${points} نقطة${effects.length?' ('+effects.join(' · ')+' لفريق '+teamName+')':''}`;
}
// ينتقل للفريق التالي في طابور السرقة، أو يكشف الإجابة إن انتهى الطابور
// token: قيمة state.cur.token الملتقَطة وقت إنشاء المشغّل (زر أو مؤقّت). دونها
// تصادف مؤقّت منتهٍ مع نقرة (أو نقرة مزدوجة) يُسقط فريقاً كاملاً من طابور
// السرقة بصمت — لأن كليهما يستدعي advanceSteal() لنفس المرحلة القديمة.
function advanceSteal(token){
  const c=state.cur;
  if(!c) return;
  if(typeof token==='number' && token!==c.token) return; // نداء تابع لمرحلة سبق تجاوزها
  c.stealPos++;
  if(c.stealPos < c.stealQueue.length){ startPhase('steal'); }
  else{ startPhase('reveal'); }
}
function setPhasePill(teamIdx, text){
  const pill=document.getElementById('phase-pill');
  if(teamIdx<0){ pill.style.background='var(--bg3)'; pill.style.color='var(--gold)'; }
  else{ const st=TEAM_STYLES[state.teams[teamIdx].idx]; pill.style.background=st.bg; pill.style.color=st.color; }
  pill.textContent=text;
}

function renderFlow(){
  const box=document.getElementById('q-flow');
  const c=state.cur;
  box.innerHTML='';
  if(c.isBomb){
    if(c.phase==='bomb'){
      box.appendChild(btn('ghost','👁️ اكشف الإجابة', ()=>{ sfx('tap'); startPhase('reveal'); }));
    } else if(c.phase==='reveal'){
      renderVerdict(box);
    }
    return;
  }
  if(c.phase==='owner'){
    // زر: اطرح على أول فريق في طابور السرقة
    if(c.stealQueue.length){
      const nextName=state.teams[c.stealQueue[0]].name;
      const b=btn('primary','⏭️ اطرح على '+nextName, ()=>{ sfx('tap'); advanceSteal(c.token); });
      box.appendChild(b);
    }
    box.appendChild(btn('ghost','👁️ اكشف الإجابة', ()=>{ sfx('tap'); startPhase('reveal'); }));
  } else if(c.phase==='steal'){
    // زر: اطرح على الفريق التالي في الطابور (إن وُجد) — يدعم أكثر من فريق سارق
    const hasNext = c.stealPos+1 < c.stealQueue.length;
    if(hasNext){
      const nextName=state.teams[c.stealQueue[c.stealPos+1]].name;
      box.appendChild(btn('primary','⏭️ اطرح على '+nextName, ()=>{ sfx('tap'); advanceSteal(c.token); }));
    }
    box.appendChild(btn(hasNext?'ghost':'primary','👁️ اكشف الإجابة', ()=>{ sfx('tap'); startPhase('reveal'); }));
  } else if(c.phase==='reveal'){
    // أزرار الحكم: نقاط لأي فريق
    renderVerdict(box);
  }
}
function btn(kind,label,fn){
  const b=document.createElement('button');
  b.className='btn '+(kind==='primary'?'btn-primary':'btn-ghost');
  b.textContent=label; b.onclick=fn; return b;
}
function renderVerdict(box){
  const c=state.cur;
  if(c.isBomb){
    const label=document.createElement('div');
    label.style.cssText='font-size:13px;color:var(--muted);text-align:center;margin-bottom:2px;font-weight:700;';
    label.textContent='شنو صار مع فريق '+state.teams[c.bombTarget].name+'؟';
    box.appendChild(label);
    box.appendChild(btn('primary','✅ جاوب صح (+1200)', ()=>awardBomb(true)));
    box.appendChild(btn('ghost','❌ جاوب غلط (-1200)', ()=>awardBomb(false)));
    return;
  }
  const label=document.createElement('div');
  label.style.cssText='font-size:13px;color:var(--muted);text-align:center;margin-bottom:2px;font-weight:700;';
  label.textContent='منو جاوب صح؟';
  box.appendChild(label);
  // أزرار الفرق المؤهّلة للحكم:
  // - المالك مؤهّل ما لم يمرّر السؤال بالوسيلة (التمرير = تنازل عن الحق)
  // - أي فريق طُرح عليه السؤال أثناء طابور السرقة مؤهّل أيضاً (يدعم أكثر من فريق سارق)
  const eligible=[...(c.eligibleTeams||[])];
  const row=document.createElement('div'); row.className='verdict-row';
  eligible.forEach(ti=>{
    const st=TEAM_STYLES[state.teams[ti].idx];
    const vb=document.createElement('button'); vb.className='vb';
    vb.style.background=st.solid; vb.textContent='✅ '+state.teams[ti].name;
    vb.onclick=()=>awardTo(ti); row.appendChild(vb);
  });
  box.appendChild(row);
  const none=document.createElement('button'); none.className='vb vb-none';
  none.textContent='❌ محد جاوب صح'; none.onclick=()=>awardTo(-1);
  box.appendChild(none);
}
function markBoardCellUsed(cell,key){
  cell.classList.add('used');
  cell.disabled=true;
  cell.setAttribute('aria-disabled','true');
  state.cells[key].used=true;
}
function awardTo(teamIdx){
  const c=state.cur;
  if(!c || c.resolved) return; // حارس ضد نقر مزدوج على أزرار الحكم
  c.resolved=true;
  stats.totalQ++;
  if(teamIdx>=0){
    sfx('correct'); vibrate([15,10,15]);
    let pts=c.points;
    if(c.doubledForTeam===teamIdx) pts*=2;
    if(c.searchedForTeam===teamIdx) pts=Math.round(pts/2);
    state.teams[teamIdx].score+=pts; stats.correct++; state.roundCorrect=(state.roundCorrect||0)+1;
  } else { sfx('wrong'); vibrate([40,30,40]); state.roundIncorrect=(state.roundIncorrect||0)+1; }
  markBoardCellUsed(c.cell,c.key);
  state.answered++; renderTeamsBar();
  closeQuestion();
}

// ────────── المؤقّت
function showTimer(sec,options={}){
  clearInterval(state.timer); state.timeLeft=sec; state.maxTime=options.maxTime||sec; state.paused=Boolean(options.paused);
  const myToken = state.cur ? state.cur.token : 0;
  const pauseButton=document.getElementById('pause-btn');
  pauseButton.textContent=state.paused?'▶':'⏸';
  pauseButton.setAttribute('aria-label',state.paused?'كمّل العداد':'وقّف العداد مؤقتًا');
  document.getElementById('countdown-timer').classList.toggle('paused',state.paused);
  updateTimerUI();
  state.timer=setInterval(()=>{
    if(state.paused) return;
    state.timeLeft--; updateTimerUI(); persistActiveRound(false);
    if(state.timeLeft<=5&&state.timeLeft>0) sfx('tick');
    if(state.timeLeft<=0){ clearInterval(state.timer); timeUp(myToken); }
  },1000);
}
function updateTimerUI(){
  const num=document.getElementById('timer-num'); num.textContent=state.timeLeft;
  num.classList.toggle('warn',state.timeLeft<=Math.ceil(state.maxTime*0.17));
  const elapsed=Math.max(0,(state.maxTime||state.timeLeft)-state.timeLeft);
  document.getElementById('timer-hourglass').classList.toggle('is-flipped',Math.floor(elapsed/2)%2===1);
  document.getElementById('countdown-timer').setAttribute('aria-label',`باقي ${state.timeLeft} ثانية`);
}
function togglePause(){
  if(state.cur&&state.cur.searching) return;
  if(state.cur&&state.cur.phase==='reveal') return;
  sfx('tap'); state.paused=!state.paused;
  const pauseButton=document.getElementById('pause-btn');
  pauseButton.textContent=state.paused?'▶':'⏸';
  pauseButton.setAttribute('aria-label',state.paused?'كمّل العداد':'وقّف العداد مؤقتًا');
  document.getElementById('countdown-timer').classList.toggle('paused',state.paused);
  setQuestionHidden(state.paused);
  persistActiveRound(true);
}
function setQuestionHidden(hide){
  const qt=document.getElementById('q-text');
  const pv=document.getElementById('q-paused');
  const imageWrap=document.getElementById('q-image-wrap');
  const questionDialog=document.getElementById('q-wrap');
  const ll=document.getElementById('lifelines');
  const fl=document.getElementById('q-flow');
  qt.classList.toggle('blurred',hide);
  qt.setAttribute('aria-hidden',hide?'true':'false');
  const hasImage=Boolean(state.cur?.q?.image);
  imageWrap.hidden=hide||!hasImage;
  imageWrap.setAttribute('aria-hidden',hide||!hasImage?'true':'false');
  pv.classList.toggle('show',hide);
  pv.setAttribute('aria-hidden',hide?'false':'true');
  questionDialog.setAttribute('aria-labelledby',hide?'q-paused-title':'q-text');
  ll.style.display=hide?'none':'';
  fl.style.display=hide?'none':'';
}
function timeUp(token){
  // انتهى وقت المرحلة الحالية — ننتقل تلقائياً للفريق التالي في طابور السرقة، أو للكشف
  const c=state.cur;
  if(!c || (typeof token==='number' && token!==c.token)) return; // مؤقّت قديم تابع لمرحلة تجاوزناها فعلاً
  vibrate([40,30,40]);
  if(c.isBomb){
    if(c.phase==='bomb') startPhase('reveal');
    return;
  }
  if(c.phase==='owner' || c.phase==='steal'){
    advanceSteal(token);
  }
}

function closeQuestion(){
  hideQuestionScreen(true);
  keepAwakeOff();
  // مؤقّت وسيلة "بحث بالجوال" مستقل عن state.timer — إن أُغلق السؤال قبل
  // انتهائه (45 ثانية) يبقى شغّالاً ويكتب state.paused=false على سؤال لاحق
  // غير مرتبط عند انتهائه لاحقاً
  clearInterval(state.searchTimer);
  state.searchTimeLeft=0;
  state.cur=null;
  if(state.answered>=(state.totalQuestions||36)){ persistActiveRound(true); setTimeout(endGame,300); return; }
  state.turn=(state.turn+1)%state.teams.length; renderTeamsBar(); renderTurn();
  persistActiveRound(true);
}

// ────────── وسائل المساعدة
const LIFELINES=[
  {id:'search', label:'بحث بالجوال', icon:'🔍'},
  {id:'pass', label:'مرّرها للخصم', icon:'⚔️'},
  {id:'skip', label:'تغيير السؤال', icon:'🔄'},
  {id:'double', label:'مضاعفة السؤال', icon:'✖️2'},
];
const SEARCH_LIFELINE_SECONDS=45;
function renderLifelines(){
  const box=document.getElementById('lifelines'); box.innerHTML='';
  const c=state.cur; if(!c) return;
  if(c.isBomb) return; // لا وسائل مساعدة أثناء القنبلة — سؤال مفروض بلا اختيار
  // الوسائل تخصّ الفريق صاحب المرحلة الحالية
  const activeTeamIdx = c.phase==='steal'? c.stealQueue[c.stealPos] : c.owner;
  const team=state.teams[activeTeamIdx];
  const inActionPhase = c.phase==='owner' || c.phase==='steal';
  LIFELINES.forEach(ll=>{
    // «مرّرها للخصم» تظهر فقط في مرحلة المالك وقبل التمرير
    if(ll.id==='pass' && (c.phase!=='owner' || c.passedToOpp || state.teams.length<2)){
      return;
    }
    const b=document.createElement('button'); b.className='ll ll-'+ll.id+(team.used.has(ll.id)?' done':'');
    b.innerHTML=`<span class="lli">${ll.icon}</span>${ll.label}`;
    b.setAttribute('aria-label',`${ll.label} — فريق ${team.name}`);
    const noBudget=team.ll<=0&&!team.used.has(ll.id);
    b.disabled=team.used.has(ll.id)||noBudget||!inActionPhase||c.replacingQuestion===true||c.searching===true;
    b.onclick=()=>useLifeline(ll.id,activeTeamIdx); box.appendChild(b);
  });
  const note=document.createElement('div'); note.className='ll-note';
  note.textContent=`باقي لفريق ${team.name}: ${team.ll} وسائل`;
  box.appendChild(note);
}
function useLifeline(id, teamIdx){
  const c=state.cur;
  if(!c||c.searching===true||c.replacingQuestion===true) return false;
  const team=state.teams[teamIdx];
  if(!team) return false;
  if(team.used.has(id)||team.ll<=0) return;
  sfx('tap'); vibrate(15); team.used.add(id); team.ll--;
  if(id==='pass'){
    // مرّر السؤال لأول فريق في طابور السرقة — المالك يخسر حق السرقة، وبقية الطابور يستمر بعده
    c.passedToOpp=true;
    c.eligibleTeams.delete(teamIdx);
    advanceSteal(c.token);
    return;
  } else if(id==='skip'){
    const nq=pickQuestion(c.cat,c.d);
    if(nq.exhausted){
      // لم تُستهلك الوسيلة فعلياً: أبقِ السؤال الحالي وردّ رصيد الفريق،
      // واعرض سبب عدم وجود بديل بدلاً من تحويل رسالة النفاد إلى سؤال وهمي.
      team.used.delete(id); team.ll++;
      showQuestionExhausted(nq);
      renderLifelines();
      return nq;
    }
    const applyReplacement=()=>{
      c.q=nq;
      // السؤال البديل لم يُطرح على الفرق التي أجابت النسخة السابقة. يبدأ حق
      // الحكم من الفريق الذي استهلك وسيلة التغيير، ثم تُضاف الفرق اللاحقة فقط.
      c.eligibleTeams=new Set([teamIdx]);
      setQuestionPrompt(nq);
      setQuestionAnswer(nq);
      const dt2=DIFF_TIMES[state.difficulty]||DIFF_TIMES.normal;
      const isSpd=c.cat==='إجابة سريعة';
      showTimer(c.phase==='steal'?(isSpd?Math.round(dt2.speed*0.5):dt2.steal):(isSpd?dt2.speed:dt2.normal));
    };
    if(nq.image){
      c.replacingQuestion=true;
      renderLifelines();
      void renderQuestionImage(nq).then(ready=>{
        if(state.cur!==c) return;
        c.replacingQuestion=false;
        if(!ready){
          team.used.delete(id); team.ll++;
          void renderQuestionImage(c.q,{allowFallback:true});
          showToast('🖼️','الصورة البديلة مو جاهزة','خلّينا السؤال الحالي وما استهلكنا وسيلة التغيير.',false);
          renderLifelines();
          persistActiveRound(true);
          return;
        }
        applyReplacement();
        renderLifelines();
        persistActiveRound(true);
      });
      return nq;
    }
    void renderQuestionImage(nq);
    applyReplacement();
  } else if(id==='double'){
    c.doubledForTeam=teamIdx;
    updateQuestionPoints(teamIdx);
  } else if(id==='search'){
    c.searchedForTeam=teamIdx; c.searching=true; state.paused=true;
    updateQuestionPoints(teamIdx);
    startSearchCountdown(SEARCH_LIFELINE_SECONDS);
  }
  renderLifelines();
  persistActiveRound(true);
}
function startSearchCountdown(seconds){
  const c=state.cur;
  if(!c) return;
  state.searchTimeLeft=Math.min(SEARCH_LIFELINE_SECONDS,Math.max(1,Number(seconds)||1));
  state.paused=true; c.searching=true;
  const pauseButton=document.getElementById('pause-btn');
  pauseButton.disabled=true; pauseButton.style.opacity='.4';
  document.getElementById('countdown-timer').classList.add('paused');
  document.querySelectorAll('#q-flow button').forEach(button=>{ button.disabled=true; });
  const el=document.getElementById('search-timer'); el.classList.add('show');
  const label=document.getElementById('search-timer-label');
  label.textContent='🔍 باقي للبحث: '+state.searchTimeLeft;
  clearInterval(state.searchTimer);
  state.searchTimer=setInterval(()=>{
    state.searchTimeLeft--;
    label.textContent='🔍 باقي للبحث: '+Math.max(0,state.searchTimeLeft);
    persistActiveRound(false);
    if(state.searchTimeLeft<=0) finishSearchCountdown(c);
  },1000);
  persistActiveRound(true);
}
function finishSearchCountdown(expectedQuestion=state.cur){
  const c=state.cur;
  if(!c||c!==expectedQuestion||c.searching!==true) return false;
  clearInterval(state.searchTimer);
  state.searchTimer=null; state.searchTimeLeft=0; state.paused=false; c.searching=false;
  document.getElementById('search-timer').classList.remove('show');
  document.getElementById('search-timer-label').textContent='';
  const pauseButton=document.getElementById('pause-btn');
  pauseButton.disabled=false; pauseButton.style.opacity='1'; pauseButton.textContent='⏸';
  pauseButton.setAttribute('aria-label','وقّف العداد مؤقتًا');
  document.getElementById('countdown-timer').classList.remove('paused');
  renderFlow(); renderLifelines(); persistActiveRound(true);
  return true;
}
function finishSearchEarly(){
  if(!state.cur?.searching) return false;
  sfx('tap'); vibrate(12);
  return finishSearchCountdown(state.cur);
}
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } }

// ────────── النهاية
function endGame(){
  state.roundActive=false; state.cur=null;
  clearActiveRound();
  const sorted=[...state.teams].sort((a,b)=>b.score-a.score);
  const win=sorted[0]; const tie=sorted.length>1&&sorted[1].score===win.score;
  // تحديث الإحصاءات
  stats.games++;
  const bestThisGame=Math.max(...state.teams.map(t=>t.score));
  if(bestThisGame>stats.bestScore) stats.bestScore=bestThisGame;
  if(!tie) stats.wins++;
  saveStats();
  const durationSeconds=Math.max(0,Math.round((Date.now()-(state.startedAt||Date.now()))/1000));
  void trackMetric('game_completed',{
    difficulty:state.difficulty,teams:state.teams.length,
    categoryCount:state.cats.length,questions:state.answered,
    correct:state.roundCorrect||0,incorrect:state.roundIncorrect||0,
    durationSeconds,topScore:bestThisGame,tie,freeRound:Boolean(state.isFreeRound),
  });
  void completeFreeRound();
  showResult(sorted,win,tie);
  checkAchievements();
}
function showResult(sorted,win,tie){
  const wl=document.getElementById('winner-line');
  wl.innerHTML=tie?'تعادل! 🤝':('🏆 الفايز: <span class="brand">'+esc(win.name)+'</span>');
  const pod=document.getElementById('podium'); pod.innerHTML='';
  const medals=['🥇','🥈','🥉']; const heights={0:156,1:122,2:98};
  const order=[1,0,2].filter(i=>i<sorted.length);
  order.forEach((pos,k)=>{
    const t=sorted[pos]; const st=TEAM_STYLES[t.idx];
    const el=document.createElement('div'); el.className='pod';
    el.style.background=st.bg; el.style.borderColor=st.dot;
    el.style.height=heights[pos]+'px'; el.style.animationDelay=(k*0.12)+'s';
    el.innerHTML=`<div class="medal">${medals[pos]}</div>
      <div class="pn" style="color:${st.color}">${esc(t.name)}</div>
      <div class="ps" style="color:${st.color}">${t.score}</div>`;
    pod.appendChild(el);
  });
  go('s-result');
  const primary=document.getElementById('result-primary-btn');
  if(primary) primary.textContent=state.isFreeRound&&!_hasActiveSubscription
    ? '👑 اكتشف فطنة برو'
    : '🔄 جولة جديدة';
  if(!tie){ sfx('win'); vibrate([60,40,60,40,120]); fireConfetti(); }
}
function restart(){
  state.teams.forEach(t=>{ t.score=0; t.ll=3; t.used=new Set(); t.bombUsed=false; });
  state.turn=0;
  startGame();
}
function afterResultPrimary(){
  if(state.completedFreeRound&&!_hasActiveSubscription){ go('s-paywall'); return; }
  restart();
}
function afterResultHome(){
  if(state.completedFreeRound&&!_hasActiveSubscription){ go('s-paywall'); return; }
  go('s-home');
}
function fireConfetti(){
  const box=document.getElementById('confetti'); box.innerHTML='';
  const cols=['#FFD24B','#FF7A3D','#FF3D71','#B794FF','#4FE3C4','#C026A8'];
  for(let i=0;i<80;i++){
    const c=document.createElement('div'); c.className='conf';
    c.style.left=Math.random()*100+'%'; c.style.top=(-10-Math.random()*20)+'%';
    c.style.background=cols[i%cols.length];
    c.style.animationDuration=(2.2+Math.random()*1.8)+'s';
    c.style.animationDelay=(Math.random()*0.6)+'s';
    box.appendChild(c);
  }
  setTimeout(()=>box.innerHTML='',4500);
}

// ---- الإحصاءات والإنجازات ----
function openStats(){ renderStats(); go('s-stats'); }
function openAccountSettings(){
  renderAccountLinks(); refreshVerificationStatus();
  void initPushMessaging().catch(error=>recordNonFatal(error,'firebase.messaging.account'));
  const inp = document.getElementById('account-name-input');
  if(inp) inp.value = storeGet('playerName','');
  const msg = document.getElementById('account-name-msg');
  if(msg) msg.textContent = '';
  go('s-account');
}

function savePlayerName(){
  const inp = document.getElementById('account-name-input');
  const name = (inp && inp.value.trim()) || '';
  if(!name){ showToast('⚠️','الاسم فاضي','اكتب اسمك أول',false); return; }
  storeSet('playerName', name);
  const nameEl = document.getElementById('user-name');
  if(nameEl) nameEl.textContent = name;
  const msg = document.getElementById('account-name-msg');
  if(msg){ msg.textContent = '✓ حفظنا الاسم'; setTimeout(()=>{ if(msg) msg.textContent=''; }, 2000); }
  sfx('correct');
}

// ---- شاشة ربط الحسابات (Proactive linking) ----
const PROVIDER_INFO = {
  'apple.com': {label:'Apple',   icon:'🍎'},
  'google.com':{label:'Google',  icon:'🔵'},
  'password':  {label:'البريد وكلمة المرور', icon:'📧'},
  'phone':    {label:'رقم الهاتف', icon:'📱'},
};
async function getCurrentProviderData(){
  const FA=getFirebaseAuth();
  if(FA){
    try{ const cur=await FA.getCurrentUser(); return (cur && cur.user && cur.user.providerData) || []; }
    catch(e){ return []; }
  }
  const wb=await getFirebaseWebAuth();
  if(wb && wb.auth.currentUser) return wb.auth.currentUser.providerData || [];
  return [];
}
async function renderAccountLinks(){
  const box=document.getElementById('account-links');
  if(!box) return;
  const linked = await getCurrentProviderData();
  const linkedIds = new Set(linked.map(p=>p.providerId));
  box.innerHTML = Object.keys(PROVIDER_INFO).map(pid=>{
    const info=PROVIDER_INFO[pid];
    const isLinked=linkedIds.has(pid);
    const status = isLinked
      ? '<span style="color:#7CFC7C;font-size:12px;">✓ مربوط</span>'
      : '<span style="color:var(--muted);font-size:12px;">مو مربوط</span>';
    const action = isLinked
      ? `<button class="btn btn-ghost" style="padding:6px 14px;font-size:13px;width:auto;" onclick="unlinkProvider('${pid}')">فك الربط</button>`
      : `<button class="btn btn-primary" style="padding:6px 14px;font-size:13px;width:auto;" onclick="linkProvider('${pid}')">ربط</button>`;
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06);">
      <span>${info.icon} ${info.label} ${status}</span>
      ${action}
    </div>`;
  }).join('');
}
function linkProvider(pid){
  sfx('tap');
  window._authReturnScreen = 's-stats';
  if(pid==='apple.com'){ appleSignIn(); return; }
  if(pid==='google.com'){ googleSignIn(); return; }
  if(pid==='phone'){
    const input=document.getElementById('verification-phone');
    if(input){ input.focus(); input.scrollIntoView({behavior:'smooth',block:'center'}); }
    setVerificationMessage('اكتب رقمك بصيغة دولية ثم أرسل رمز SMS.');
    return;
  }
  openAuth('s-stats');
  document.getElementById('auth-title').textContent='ضيف طريقة دخول يديدة';
  document.getElementById('auth-sub').textContent='ضيف البريد وكلمة المرور كطريقة دخول إضافية لحسابك الحالي';
  document.getElementById('auth-email-form').style.display='block';
}
async function unlinkProvider(pid){
  sfx('tap');
  const linked = await getCurrentProviderData();
  if(linked.length<=1){
    showToast('⚠️','ما نقدر نفك الربط','هذي آخر طريقة دخول لحسابك — ضيف طريقة ثانية قبل لا تفك هذي',false);
    return;
  }
  const label = (PROVIDER_INFO[pid]||{}).label || pid;
  const ok=confirm(`تبي تفك ربط الدخول عن طريق ${label}؟ راح تحتاج طريقة ثانية عشان تسجّل دخولك بعدين.`);
  if(!ok) return;
  try{
    const FA=getFirebaseAuth();
    if(FA){
      await FA.unlink({providerId: pid});
    } else {
      const wb=await getFirebaseWebAuth();
      if(wb && wb.auth.currentUser){
        const { unlink } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
        await unlink(wb.auth.currentUser, pid);
      }
    }
    if(pid==='password') storeSet('authEmail','');
    if(storeGet('authProvider','')===('apple.com'===pid?'apple':'google.com'===pid?'google':'password')){
      // إن كان المزوّد الذي فُكّ ربطه هو المسجَّل حالياً، حدِّث المخزَّن لأقرب مزوّد متبقٍ
      const remaining = await getCurrentProviderData();
      const first = remaining[0];
      if(first){
        const np = first.providerId==='apple.com'?'apple':first.providerId==='google.com'?'google':'password';
        storeSet('authProvider', np);
      }
    }
    showToast('✅','فكّينا الربط','',false);
    renderAccountLinks();
  }catch(e){ logClientEvent('error','account.unlink'); showToast('⚠️','ما قدرنا نفك الربط','',false); }
}
function renderStats(){
  const acc=stats.totalQ?Math.round((stats.correct/stats.totalQ)*100):0;
  const g=document.getElementById('stats-grid');
  g.innerHTML=[
    ['🎮',stats.games,'جولات لعبتها'],
    ['✅',stats.correct,'إجابات صحيحة'],
    ['🎯',acc+'%','نسبة الدقة'],
    ['🏆',stats.wins,'مرات فزت'],
    ['💎',stats.bestScore,'أعلى نقاط'],
    ['📚',stats.totalQ,'أسئلة جاوبتها'],
  ].map(([i,v,l])=>`<div class="stat"><div class="sv">${i} ${v}</div><div class="sl">${l}</div></div>`).join('');
  const list=document.getElementById('ach-list');
  list.innerHTML=ACHIEVEMENTS.map(a=>{
    const on=!!stats.ach[a.id];
    return `<div class="ach ${on?'unlocked':'locked'}"><div class="ai">${on?a.icon:'🔒'}</div>
      <div><div class="at">${a.t}</div><div class="ad">${a.d}</div></div></div>`;
  }).join('');
}
function checkAchievements(){
  ACHIEVEMENTS.forEach(a=>{
    if(!stats.ach[a.id]&&a.chk(stats)){
      stats.ach[a.id]=true; saveStats();
      setTimeout(()=>showToast(a.icon,'إنجاز يديد!',a.t),700);
    }
  });
}
function showToast(icon,title,desc,playAchSound){
  if(playAchSound!==false){ sfx('ach'); vibrate([20,20,40]); }
  const t=document.getElementById('toast');
  t.querySelector('.ti').textContent=icon;
  document.getElementById('toast-t').textContent=title;
  document.getElementById('toast-d').textContent=desc;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),2600);
}

// ────────── الأسئلة العائلية
let familyCats = [];                  // [{name, questions:[{q,o,a}]}]
let familyMode = 'manual';
let manualDraft = { name:'', questions:[], correct:0 };
let previewData = null;                // {name, questions}

function loadFamily(uid=window._currentUid||storeGet('authUid','')){
  return uid ? storeGet(scopedAccessKey('family',uid),[]) : [];
}
function saveFamily(){
  const uid=window._currentUid||storeGet('authUid','');
  if(uid) storeSet(scopedAccessKey('family',uid),familyCats);
}

function openFamily(){
  setFamilyMode('manual');
  renderManualOpts();
  renderSavedFamily();
  go('s-family');
}
function setFamilyMode(m){
  familyMode='manual'; sfx('tap');
  const manual=document.getElementById('family-manual');
  if(manual) manual.style.display='block';
}

// مولّد نموذجي ذكي (يعمل دون إنترنت — لعرض التجربة كاملة)
function templateGenerate(topic,count){
  const templates=[
    {q:`شنو أبرز شي يميّز ${topic}؟`, o:['التنوّع','التاريخ العريق','الموقع','كل ما سبق'], a:3},
    {q:`أي واحد من هذي مرتبط بـ ${topic}؟`, o:['خيار أول','خيار ثانٍ','خيار ثالث','خيار رابع'], a:0},
    {q:`منو المشهور في مجال ${topic}؟`, o:['شخصية أولى','شخصية ثانية','شخصية ثالثة','محد'], a:1},
    {q:`متى ازدهر ${topic}؟`, o:['قديماً','حديثاً','مستمر','متقطّع'], a:2},
    {q:`وين يبرز ${topic} أكثر؟`, o:['المدن','الأرياف','الساحل','كل المناطق'], a:3},
    {q:`شنو أكبر تحدّي جدام ${topic}؟`, o:['الوقت','الموارد','المنافسة','التطوير'], a:0},
    {q:`شلون ينقاس نجاح ${topic}؟`, o:['بالكم','بالكيف','بالأثر','بالجميع'], a:2},
    {q:`شنو مستقبل ${topic}؟`, o:['واعد','مستقر','متغيّر','غامض'], a:0},
    {q:`أي فئة تهتم بـ ${topic} أكثر شي؟`, o:['الشباب','الكبار','الجميع','المختصون'], a:2},
    {q:`شنو أصل ${topic}؟`, o:['محلي','عربي','عالمي','مشترك'], a:3},
    {q:`شنو القيمة الأساسية في ${topic}؟`, o:['الأصالة','الحداثة','التوازن','التميّز'], a:2},
    {q:`شنو أقرب كلمة توصف ${topic}؟`, o:['مميّز','عريق','متطوّر','شامل'], a:0},
  ];
  return templates.slice(0,count).map(t=>({...t}));
}

function renderPreview(){
  document.getElementById('fp-info').textContent=`فئة "${previewData.name}" · ${previewData.questions.length} أسئلة · شيّك عليها وبعدين احفظ`;
  const list=document.getElementById('fp-list');
  // esc() إلزامية لأن نص الأسئلة العائلية أدخله المستخدم ويُخزّن محلياً.
  list.innerHTML=previewData.questions.map((q,i)=>{
    // النظام الخفيف الجديد: سؤال + إجابة نصية فقط (بلا خيارات)
    if(q.answer && !q.o){
      return `<div class="fp-card"><div class="fp-q">${i+1}. ${esc(q.q)}</div><div class="fp-o correct">✓ ${esc(q.answer)}</div></div>`;
    }
    // توافق عكسي: النظام القديم بخيارات
    const opts=(q.o||[]).map((o,j)=>`<div class="fp-o ${j===q.a?'correct':''}">${j===q.a?'✓ ':''}${esc(o)}</div>`).join('');
    return `<div class="fp-card"><div class="fp-q">${i+1}. ${esc(q.q)}</div>${opts}</div>`;
  }).join('');
}
function saveFamilyCategory(){
  if(!previewData) return;
  sfx('correct'); vibrate([15,10,15]);
  // ادمج مع فئة موجودة بنفس الاسم أو أنشئ جديدة
  const existing=familyCats.find(c=>c.name===previewData.name);
  if(existing){ existing.questions.push(...previewData.questions); }
  else{ familyCats.push({name:previewData.name, questions:previewData.questions.slice()}); }
  saveFamily();
  showToast('👨‍👩‍👧‍👦','حفظناها!',`فئة "${previewData.name}" جاهزة`);
  previewData=null;
  openFamily();
}

// ---- وضع الإدخال اليدوي ----
function renderManualOpts(){
  manualDraft.correct=manualDraft.correct||0;
  const box=document.getElementById('fm-opts');
  box.innerHTML='';
  for(let i=0;i<4;i++){
    const row=document.createElement('div'); row.className='fm-opt-row';
    row.innerHTML=`<div class="fm-radio ${i===manualDraft.correct?'on':''}" role="radio" tabindex="0" aria-checked="${i===manualDraft.correct}" aria-label="خل الخيار ${i+1} هو الإجابة الصح" onclick="setManualCorrect(${i})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();setManualCorrect(${i})}"></div>
      <input class="team-input" id="fm-o-${i}" aria-label="الخيار ${i+1}" placeholder="خيار ${i+1}" maxlength="60" style="flex:1;">`;
    box.appendChild(row);
  }
}
function setManualCorrect(i){
  sfx('tap'); manualDraft.correct=i;
  document.querySelectorAll('#fm-opts .fm-radio').forEach((r,j)=>{
    r.classList.toggle('on',j===i);
    r.setAttribute('aria-checked',j===i?'true':'false');
  });
}
function addManualQuestion(){
  const name=(document.getElementById('fm-name').value||'').trim();
  const q=(document.getElementById('fm-q').value||'').trim();
  const o=[0,1,2,3].map(i=>(document.getElementById('fm-o-'+i).value||'').trim());
  if(!name){ shakeField('fm-name'); return; }
  if(!q){ shakeField('fm-q'); return; }
  const emptyIdx=o.findIndex(x=>!x); if(emptyIdx!==-1){ shakeField('fm-o-'+emptyIdx); return; }
  sfx('correct'); vibrate(15);
  manualDraft.name=name;
  manualDraft.questions.push({q, o, a:manualDraft.correct});
  // نظّف حقول السؤال
  document.getElementById('fm-q').value='';
  [0,1,2,3].forEach(i=>document.getElementById('fm-o-'+i).value='');
  manualDraft.correct=0; renderManualOpts();
  document.getElementById('fm-added').textContent=`✅ ضفناه · عندك ${manualDraft.questions.length} أسئلة في "${name}" — زيد أسئلة أو احفظ`;
  // زر حفظ يظهر بعد أول سؤال
  if(manualDraft.questions.length===1){
    const b=document.createElement('button'); b.className='btn btn-primary'; b.style.marginTop='12px';
    b.textContent='💾 احفظ الفئة'; b.id='fm-save-btn'; b.onclick=saveManualCategory;
    document.getElementById('family-manual').appendChild(b);
  }
}
function saveManualCategory(){
  if(!manualDraft.questions.length) return;
  sfx('correct'); vibrate([15,10,15]);
  const existing=familyCats.find(c=>c.name===manualDraft.name);
  if(existing){ existing.questions.push(...manualDraft.questions); }
  else{ familyCats.push({name:manualDraft.name, questions:manualDraft.questions.slice()}); }
  saveFamily();
  showToast('👨‍👩‍👧‍👦','حفظناها!',`فئة "${manualDraft.name}" جاهزة`);
  manualDraft={name:'', questions:[], correct:0};
  const sb=document.getElementById('fm-save-btn'); if(sb) sb.remove();
  document.getElementById('fm-name').value='';
  document.getElementById('fm-added').textContent='ما ضفت أسئلة للحين';
  renderManualOpts(); renderSavedFamily();
}

// ---- الفئات العائلية المحفوظة ----
function renderSavedFamily(){
  const box=document.getElementById('family-saved');
  if(!familyCats.length){ box.innerHTML=''; return; }
  box.innerHTML='<div class="field-label" style="margin-top:20px;">فئاتكم العائلية</div>'+
    familyCats.map((c,i)=>{
      const ready=c.questions.length>=FAMILY_MIN_QUESTIONS;
      const sub=ready ? `${c.questions.length} أسئلة` : `${c.questions.length}/${FAMILY_MIN_QUESTIONS} أسئلة — زيد أسئلة عشان تلعب`;
      return `<div class="fsaved-chip">
      <div><div class="fc-info">👨‍👩‍👧‍👦 ${esc(c.name)}</div><div class="fc-sub">${esc(sub)}</div></div>
      <div class="fsaved-actions">
        <button class="mini-btn play" onclick="playFamilyRound(${i})" style="${ready?'':'opacity:.5;'}">▶ العب</button>
        <button class="mini-btn danger" onclick="deleteFamily(${i})">حذف</button>
      </div></div>`;
    }).join('');
}
let _pendingDeleteFamilyIdx=-1;
function deleteFamily(i){
  sfx('tap');
  _pendingDeleteFamilyIdx=i;
  const cat=familyCats[i];
  document.getElementById('delete-family-sub').textContent=
    `راح تنحذف "${cat.name}" وكل أسئلتها (${cat.questions.length}) نهائياً، وما تقدر تتراجع.`;
  openAccessibleModal('delete-family-modal');
}
function closeDeleteFamilyModal(){
  sfx('tap');
  _pendingDeleteFamilyIdx=-1;
  closeAccessibleModal('delete-family-modal');
}
function doDeleteFamily(){
  if(_pendingDeleteFamilyIdx<0) return;
  sfx('tap'); vibrate(20);
  familyCats.splice(_pendingDeleteFamilyIdx,1); saveFamily(); renderSavedFamily();
  _pendingDeleteFamilyIdx=-1;
  closeAccessibleModal('delete-family-modal');
}

// جولة سريعة منفصلة بفئة عائلية واحدة
// اللوحة 6 خلايا (سؤال لكل مستوى صعوبة) — أقل من 6 أسئلة يعني تكرار نفس
// السؤال حرفياً على أكثر من خلية، فامنع اللعب واطلب إكمال العدد أولاً
const FAMILY_MIN_QUESTIONS = 6;
let _startFamilyRoundPending=false;
async function playFamilyRound(i){
  if(_startFamilyRoundPending) return false;
  if(!canStartRound()) return;
  const cat=familyCats[i];
  if(cat.questions.length<FAMILY_MIN_QUESTIONS){
    sfx('tap');
    showToast('✋','تحتاج أسئلة أكثر',
      `زيد ${FAMILY_MIN_QUESTIONS-cat.questions.length} سؤال على الأقل بفئة "${cat.name}" عشان ما تتكرر الأسئلة باللوحة`, false);
    return;
  }
  _startFamilyRoundPending=true;
  const startsAsFreeRound=!_hasActiveSubscription;
  if(startsAsFreeRound){
    const uid=window._currentUid||storeGet('authUid','');
    const claimed=await claimFreeRound(uid);
    if(claimed!==true){
      _startFamilyRoundPending=false;
      if(claimed===false) go('s-paywall');
      else showToast('⚠️','ما قدرنا نثبت الجولة','تأكد من الإنترنت وجرّب مرة ثانية',false);
      return false;
    }
  }
  sfx('start'); vibrate(30);
  // أنشئ فرقاً افتراضية سريعة (فريقان)
  state.teams=[
    {name:TEAM_STYLES[0].name, score:0, ll:3, used:new Set(), idx:0, bombUsed:false},
    {name:TEAM_STYLES[1].name, score:0, ll:3, used:new Set(), idx:1, bombUsed:false},
  ];
  state.teamCount=2;
  // فئة واحدة وست خلايا فقط؛ تكرار الفئة في ستة أعمدة كان يصنع 36 خلية
  // من ستة أسئلة ويجبر اللعبة على التكرار.
  state.cats=[cat.name];
  state.familyRound=cat; // علامة لسحب الأسئلة من الفئة العائلية
  state.usedQ=new Set(); state.usedQuestionIds=new Set();
  state.turn=0; state.answered=0; state.cells={};
  state.startedAt=Date.now(); state.roundCorrect=0; state.roundIncorrect=0;
  state.isFreeRound=startsAsFreeRound;
  state.completedFreeRound=false;
  state.roundActive=true; state.cur=null; state.searchTimeLeft=0;
  buildBoard(); renderTeamsBar(); renderTurn(); go('s-board');
  persistActiveRound(true);
  void trackMetric('game_started',{
    difficulty:state.difficulty,teams:state.teams.length,
    categoryCount:1,freeRound:state.isFreeRound,familyRound:true,
  });
  _startFamilyRoundPending=false;
  return true;
}

function shakeField(id){
  const el=document.getElementById(id); if(!el) return;
  el.style.borderColor='var(--no)'; el.classList.add('shake-x');
  vibrate([30,20,30]);
  setTimeout(()=>{ el.style.borderColor=''; el.classList.remove('shake-x'); },500);
}

// ---- مؤشر وضع دون اتصال ----
(function initConnectivity(){
  const bar = document.getElementById('offline-bar');
  const message = document.getElementById('connectivity-message');
  if(!bar) return;
  let lastOffline=null;
  let hideTimer=0;

  function setOffline(offline){
    if(offline===lastOffline) return;
    clearTimeout(hideTimer);
    const wasOffline=lastOffline===true;
    lastOffline=offline;
    bar.classList.toggle('online',!offline);
    if(message) message.textContent=offline?'ماكو اتصال بالإنترنت':'رجع الاتصال بالإنترنت';
    if(!offline&&!wasOffline){
      bar.classList.remove('show');
      bar.setAttribute('aria-hidden','true');
      return;
    }
    bar.setAttribute('aria-hidden','false');
    bar.classList.add('show');
    if(!offline){
      hideTimer=setTimeout(()=>{
        bar.classList.remove('show','online');
        bar.setAttribute('aria-hidden','true');
      },1800);
    }
  }

  // الحالة الأولية
  setOffline(!navigator.onLine);

  // استمع لأحداث المتصفح (تعمل داخل WKWebView أيضاً)
  window.addEventListener('online',  () => setOffline(false));
  window.addEventListener('offline', () => setOffline(true));

  // على iOS (Capacitor) — استخدم Network plugin إن توفّر للتحقق المبكّر
  const Net = window.Capacitor?.Plugins?.Network;
  if(Net){
    Net.getStatus().then(s => setOffline(!s.connected)).catch(()=>{});
    Net.addListener('networkStatusChange', s => setOffline(!s.connected));
  }
})();

// ---- تهيئة ----
async function startGameFlowUITest(){
  await ensureQuestionBank();
  const uid='ui-test-player';
  window._currentUid=uid;
  storeSet('authUid',uid);
  storeSet('authProvider','local');
  saveQuestionHistory({});
  _hasActiveSubscription=true;
  _subscriptionResolved=true;
  _freeRoundAvailable=false;
  state.teamCount=2;
  state.teams=TEAM_STYLES.slice(0,2).map((style,idx)=>({
    name:style.name,score:0,ll:3,used:new Set(),idx,bombUsed:false,
  }));
  state.catCount=2;
  const imageCategories=ALL_CATS.filter(category=>(QUESTION_BANK[category]||[]).some(question=>question.image));
  if(window.__FATINAH_IMAGE_FLOW_UI_TEST__===true){
    const primary=imageCategories.includes('تعرف على الصورة')?'تعرف على الصورة':imageCategories[0];
    state.cats=[primary,...imageCategories.filter(category=>category!==primary)].slice(0,2);
    roundImageQuestionIds=new Set();
    const ready=await window.FatinahImageAssets.prepareCategory(QUESTION_BANK[primary]||[]);
    for(const ids of ready.values()) ids.forEach(id=>roundImageQuestionIds.add(id));
  }else{
    state.cats=ALL_CATS.slice(0,2);
  }
  state.difficulty='normal';
  state.familyRound=null;
  state.usedQ=new Set();
  state.usedQuestionIds=new Set();
  state.turn=0;
  state.answered=0;
  state.cells={};
  state.startedAt=Date.now();
  state.roundCorrect=0;
  state.roundIncorrect=0;
  state.isFreeRound=false;
  state.completedFreeRound=false;
  buildBoard();
  renderTeamsBar();
  renderTurn();
  go('s-board');
  hideSplash();
  document.body.dataset.gameFlowUiTest='ready';
  if(window.__FATINAH_DYNAMIC_TYPE_UI_TEST__===true||window.__FATINAH_IMAGE_FLOW_UI_TEST__===true){
    const firstCell=document.querySelector('#board .cell');
    if(firstCell) firstCell.click();
  }
}

(async function startApplication(){
const restoredPreferences=await hydrateNativePreferences();
if(restoredPreferences>0 && sessionStorage.getItem('fatinah_preferences_hydrated')!=='1'){
  sessionStorage.setItem('fatinah_preferences_hydrated','1');
  window.location.reload();
  return;
}
renderTeamNames();
(function initSoundIcon(){
  const b=document.getElementById('sound-btn');
  if(b) b.textContent = soundOn ? '🔊' : '🔇';
})();
(function initSavedName(){
  const saved=storeGet('playerName', '');
  const userNameEl=document.getElementById('user-name');
  if(saved && userNameEl) userNameEl.textContent=saved;
})();

if(window.__FATINAH_GAME_FLOW_UI_TEST__===true){
  await startGameFlowUITest();
  return;
}

// على iOS نستخدم مكوّن Firebase الأصلي. لا نحمّل SDK الويب من الشبكة عند
// الإقلاع لأنه ينافس طلبات المصادقة والاشتراك؛ يُحمّل فقط كاحتياط عند الحاجة.
if(!(window.Capacitor && window.Capacitor.isNativePlatform())){
  getFirebaseWebAuth();
}

// ---- إقلاع نظام الهوية الموحّد ----
// أول فتح للتطبيق: جلسة Firebase مجهولة فورية بلا شاشة تسجيل إجبارية.
// فتح لاحق: نثق بـ authUid المحفوظ (الجلسة محفوظة تلقائياً من طبقة Firebase)
// وننتقل مباشرة للرئيسية بدل إجبار المستخدم على تسجيل الدخول من جديد.
// ⚠️ SCREENSHOT MODE — يُحذف بعد أخذ اللقطات
const __SCREENSHOT_SCREEN = null; // home | teams | board | paywall | result
initCrashReporting();
await initAppIntegrity();
void initPushMessaging().catch(error=>recordNonFatal(error,'firebase.messaging'));
(async function bootAuth(){
  hideSplash();
  if(__SCREENSHOT_SCREEN){
    // اسم عرض ثابت لالتقاط لقطات تسويقية فقط — لا يُكتب فوق اسم المستخدم الحقيقي
    // في التشغيل العادي (كان يُكتب بلا شرط قبل هذا الإصلاح، ويمحو الاسم المحفوظ كل إقلاع)
    storeSet('playerName','مجلس فطنة');
    const nameEl=document.getElementById('user-name');
    if(nameEl) nameEl.textContent='مجلس فطنة';
  }
  if(__SCREENSHOT_SCREEN==='home'){ go('s-home'); return; }
  if(__SCREENSHOT_SCREEN==='paywall'){ go('s-paywall'); return; }
  if(__SCREENSHOT_SCREEN==='teams'){ go('s-teams'); return; }
  if(__SCREENSHOT_SCREEN==='board'){
    state.teams=[{name:'الفريق 🔥',score:1400},{name:'الفريق 💎',score:800}];
    state.cats=['معلومات','رياضة','تاريخ','جغرافيا','دين'];
    state.turn=0; state.answered=0; state.cells={};
    buildBoard(); renderTeamsBar(); renderTurn(); go('s-board'); return;
  }
  if(__SCREENSHOT_SCREEN==='result'){
    state.teams=[{name:'الفريق 🔥',score:2600},{name:'الفريق 💎',score:1200}];
    renderResult(); go('s-result'); return;
  }
  // لا نعرض شاشة الاشتراك قبل أن نعرف هل للمستخدم جولة مجانية أو اشتراك.
  // شاشة تحميل قصيرة تمنع وميض paywall المخالف لتجربة الجولة التعريفية.
  go('s-loading');
  void (async ()=>{
    const { uid } = await ensureAnonymousSession();
    window._currentUid = uid;
    activateLocalAccount(uid);
    void syncQuestionHistory();
    void flushMetricEvents();
    // أعطِ WebKit إطارين للرسم قبل بدء اتصال الخادم، ثم أجّل StoreKit/RevenueCat
    // لأنه يوقظ عمليات Apple الثقيلة ولا يلزم لعرض شاشة البداية أو أسعارها الأساسية.
    const afterFirstPaint=(task, delay)=>{
      requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(task, delay)));
    };
    afterFirstPaint(()=>{
      void checkSubscriptionAndRoute(uid, {showLoading:false});
    }, 450);
    afterFirstPaint(()=>{
      _rcReady = initRevenueCat();
      void _rcReady.then(ready=>{
        if(ready && document.getElementById('s-paywall')?.classList.contains('active')){
          return loadPaywallPrices();
        }
      }).catch(()=>logClientEvent('warn','revenuecat.deferred-startup'));
    }, 1800);
  })();
})();
})().catch(error=>{
  recordNonFatal(error,'application.start');
  hideSplash();
  go('s-home');
});

// لا نعتمد على معاملات عودة دفع قديمة أو على cache محلي لمنح الصلاحية
// نستخدم uid المحفوظ مسبقاً في localStorage فقط (لا uid من URL)
(function clearLegacyPaymentReturn(){
  const p = new URLSearchParams(window.location.search);
  if(p.has('subscribed') || p.has('canceled')){
    window.history.replaceState({},'','/');
  }
})();
