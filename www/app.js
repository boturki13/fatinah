let QUESTION_BANK = null;
let ALL_CATS = [];
let _questionBankReady = null;
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
      QUESTION_BANK=bank;
      ALL_CATS=Object.keys(bank);
      delete window.__QUESTION_BANK_DATA__;
      resolve(bank);
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
function apiUrl(path){ return `${API_ORIGIN}${path}`; }
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
const CAT_ICONS={
  "معلومات عامة":"🧠","رياضة":"⚽","تاريخ":"🏛️","جغرافيا":"🗺️",
  "أمثال":"💬","ثقافة خليجية":"🐪","دين وسيرة":"🕋","علوم وتقنية":"🔬",
  "محرّكات ومركبات":"🏎️","السيرة النبوية":"🕌","القرآن الكريم":"📖","فتوحات المسلمين":"⚔️",
  "ألغاز وتحدّي ذكاء":"🧩","الصحابة":"👳","الشعر العربي":"📜",
  "الفضاء والكون":"🪐","حيوانات وطبيعة":"🦁","حضارات قديمة":"🏺","جسم الإنسان":"🫀",
  "كأس العالم":"🏆","أعلام الدول":"🚩","خرائط دول":"🧭","إجابة سريعة":"⚡",
  "دوري أبطال أوروبا":"⭐","أنمي":"🦸","كأس الخليج":"🥇","مسلسلات خليجية":"📺",
  "أفلام عربية":"🎬","الألعاب الأولمبية":"🔥","أغاني خليجية":"🎤",
};
// تصنيف الفئات إلى مجموعات للفلترة
const CAT_GROUPS={
  "إسلاميات":["السيرة النبوية","القرآن الكريم","فتوحات المسلمين","الصحابة","دين وسيرة"],
  "معرفة وعلوم":["معلومات عامة","علوم وتقنية","الفضاء والكون","جسم الإنسان"],
  "تاريخ وجغرافيا":["تاريخ","جغرافيا","حضارات قديمة","أعلام الدول","خرائط دول"],
  "رياضة":["رياضة","كأس العالم","دوري أبطال أوروبا","كأس الخليج","الألعاب الأولمبية"],
  "محرّكات":["محرّكات ومركبات"],
  "ثقافة وتراث":["ثقافة خليجية","أمثال","مسلسلات خليجية","أغاني خليجية"],
  "ألغاز وذكاء":["ألغاز وتحدّي ذكاء","إجابة سريعة"],
  "فنون وأدب":["الشعر العربي","أنمي","أفلام عربية"],
  "طبيعة وحيوانات":["حيوانات وطبيعة"],
};
const GROUP_ICONS={"إسلاميات":"🕌","معرفة وعلوم":"🧠","تاريخ وجغرافيا":"🏛️","رياضة":"⚽","محرّكات":"🏎️","ثقافة وتراث":"🐪","ألغاز وذكاء":"🧩","فنون وأدب":"📜","طبيعة وحيوانات":"🦁"};

let state={teamCount:2, catCount:6, difficulty:'normal', teams:[], cats:[], turn:0, cells:{}, answered:0, cur:null,
  timer:null, timeLeft:60, paused:false, searchTimer:null, answering:true};

// ────────── التخزين الدائم
// أولوية: Capacitor Preferences (تخزين أصلي داخل تطبيق iOS) إن توفّر، وإلا localStorage (يعمل في المتصفح وداخل WKWebView أيضاً).
// هذا يحل مشكلة فقدان كل البيانات عند إغلاق التطبيق.
const STORAGE_PREFIX='fatinah_';
// ────────── XSS sanitizer
function esc(str){ const d=document.createElement('div'); d.textContent=String(str||''); return d.innerHTML; }
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

// ────────── الإحصاءات (محفوظة دائماً)
let stats=loadStats();
function loadStats(){
  return storeGet('stats', {games:0, correct:0, totalQ:0, bestScore:0, wins:0, ach:{}});
}
function saveStats(){ storeSet('stats', stats); }

const ACHIEVEMENTS=[
  {id:'first', icon:'🎮', t:'أول جولة', d:'أكملت أول جولة', chk:s=>s.games>=1},
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
function go(id){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo(0,0);
  // لا تبدأ أسعار RevenueCat قبل وجود جلسة Firebase وهوية RevenueCat؛
  // هذا يسمح بعرض شاشة الاشتراك فوراً عند الإقلاع من دون طلبات فاشلة.
  if(id==='s-paywall' && typeof loadPaywallPrices==='function'){
    // على الويب لا توجد تهيئة RevenueCat أصلاً؛ استدعِ الدالة فوراً كي تعرض
    // ملاحظة أن الدفع متاح داخل iOS بدلاً من ترك الشاشة على «جاري الجلب».
    if(!getRC() || _rcReady){
      loadPaywallPrices().catch(e=>console.error('paywall prices:', (e && e.message) || e));
    }
  }
}

// ────────── الخروج من الجولة
function confirmExit(){
  sfx('tap'); vibrate(15);
  document.getElementById('exit-modal').classList.add('show');
}
function closeExitModal(){
  sfx('tap');
  document.getElementById('exit-modal').classList.remove('show');
}
function doExit(){
  sfx('tap'); vibrate(20);
  // أوقف أي مؤقّتات جارية وأغلق السؤال إن كان مفتوحاً
  clearInterval(state.timer); clearInterval(state.searchTimer);
  keepAwakeOff();
  const qw=document.getElementById('q-wrap'); if(qw) qw.classList.remove('show');
  document.getElementById('exit-modal').classList.remove('show');
  go('s-home');
}

// ────────── حذف الحساب (5.1.1)
// إعادة المصادقة عند requires-recent-login حسب مزوّد الدخول المخزَّن
async function reauthThen(provider, fn){
  // Normalize Firebase providerId format (stored as 'apple.com'/'google.com' in old sessions)
  if(provider==='apple.com') provider='apple';
  if(provider==='google.com') provider='google';
  console.log('[reauthThen] normalized provider:', provider);
  const FA=window.Capacitor?.Plugins?.FirebaseAuthentication;
  if(FA){
    if(provider==='google'){
      if(typeof FA.reauthenticateWithGoogle==='function') await FA.reauthenticateWithGoogle();
      else await FA.signInWithGoogle();
    } else if(provider==='apple'){
      const hasReauth = typeof FA.reauthenticateWithApple==='function';
      console.log('[reauth] apple hasReauth:', hasReauth);
      try{
        if(hasReauth) await FA.reauthenticateWithApple();
        else await FA.signInWithApple();
      }catch(appleErr){
        console.error('[reauth] apple error — json:', JSON.stringify(appleErr),
          'msg:', appleErr?.message, 'code:', appleErr?.code, 'type:', typeof appleErr);
        throw appleErr;
      }
    } else if(provider==='password'){
      const email = storeGet('authEmail','');
      const password = prompt('لتأكيد الحذف، أدخل كلمة مرور حساب ' + email + ':');
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
      const password = prompt('لتأكيد الحذف، أدخل كلمة مرور حساب ' + email + ':');
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
  console.log('[deleteFirebaseUser] stored provider:', JSON.stringify(provider));
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
          console.error('reauth+delete:', e2, 'json:', JSON.stringify(e2));
          const isCancelled = !e2 || JSON.stringify(e2)==='{}' ||
            (e2?.code||'').includes('CANCEL') || (e2?.message||'').toLowerCase().includes('cancel') ||
            e2?.code==='1001'; // ASAuthorizationError.canceled
          if(isCancelled) showToast('❌','إلغاء التحقق','لإتمام حذف الحساب، أكمل التحقق عبر Apple',false);
          return false;
        }
      }
      console.error('Capacitor deleteUser:', e);
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
        }catch(e2){ console.error('web reauth+delete:', e2); return false; }
      }
      console.error('web deleteUser:', e);
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
  const ok=confirm('هل تريد تسجيل الخروج؟ ستبقى بياناتك المحلية محفوظة على هذا الجهاز.');
  if(!ok) return;
  if(!beginAccountAction('جارٍ تسجيل الخروج…')) return;
  let completed=false;
  try{
  await resetVerificationSession();
  // امسح توكن Firebase من Keychain (يمنع الدخول التلقائي بعد إعادة التثبيت)
  try{
    const FA=window.Capacitor?.Plugins?.FirebaseAuthentication;
    if(FA) await FA.signOut();
  }catch(e){ console.warn('signOut FA:', e); }
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
  stats={games:0,correct:0,totalQ:0,bestScore:0,wins:0,ach:{}};
  showToast('✅','تم تسجيل الخروج','يمكنك الدخول بحساب آخر',false);
  completed=true;
  setTimeout(()=>{ endAccountAction(); go('s-auth'); },1200);
  }finally{ if(!completed) endAccountAction(); }
}

async function confirmDeleteAccount(){
  const ok=confirm('سيتم حذف حسابك نهائياً من النظام مع جميع بياناتك (نقاط، إنجازات، إعدادات، اشتراك). لا يمكن التراجع. هل أنت متأكد؟');
  if(!ok) return;
  if(!beginAccountAction('جارٍ حذف الحساب والبيانات…')) return;
  let completed=false;
  try{
  const uid = storeGet('authUid','');
  // 1) احذف بيانات الخادم — best-effort، لا يوقف الحذف المحلي عند الفشل
  if(uid){
    try{
      const idToken = await getCurrentIdToken(true);
      const resp = await fetch(apiUrl('/api/account/delete'),{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({uid, idToken})
      });
      if(!resp.ok) console.warn('server delete returned', resp.status);
    }catch(e){
      console.warn('server delete failed (continuing locally):', e);
    }
  }
  // 2) امسح RevenueCat
  const rcIds=storeGet('rcAppUserIds',{}) || {};
  delete rcIds[uid];
  storeSet('rcAppUserIds',rcIds);
  storeSet('rcAppUserId','');
  // 3) احذف مستخدم Firebase فعلياً (مع معالجة requires-recent-login)
  const deleted = await deleteFirebaseUser();
  if(!deleted){
    showToast('⚠️','تعذّر حذف الحساب بالكامل','لم يتم إكمال الحذف. أعد تسجيل الدخول وحاول من جديد',false);
    return;
  }
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
  stats={games:0,correct:0,totalQ:0,bestScore:0,wins:0,ach:{}};
  showToast('✅','تم حذف حسابك','حُذف الحساب وجميع البيانات نهائياً',false);
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
  document.getElementById('auth-sub').textContent = 'سجّل بأي طريقة تحفظ نقاطك وإنجازاتك حتى لو غيّرت جهازك';
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
        console.warn('Firebase Anonymous sign-in is disabled; using the local fallback until it is enabled in Firebase Console.');
      } else {
        console.error('anon Capacitor:', e);
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
          console.warn(
            '%c⚠️ تسجيل الدخول المجهول (Anonymous) غير مفعّل في Firebase Console\n' +
            'لتفعيله: Firebase Console → Authentication → Sign-in method → Anonymous → Enable\n' +
            'حتى يُفعَّل، يعمل التطبيق بمعرّف جهاز محلي (بلا مزامنة تقدّم عبر الأجهزة).',
            'color:#FFD24B; font-weight:bold;'
          );
        } else {
          console.error('anon Web:', e);
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
  if(name) storeSet('playerName', name);
  storeSet('authProvider', provider);
  if(uid) storeSet('authUid', uid);
  if(email) storeSet('authEmail', email);
  window._currentUid = uid || storeGet('authUid','');
  const nameEl=document.getElementById('user-name');
  if(nameEl) nameEl.textContent = storeGet('playerName','لاعب');
  const emailForm=document.getElementById('auth-email-form');
  if(emailForm) emailForm.style.display='none';
  showToast('✅','تم الدخول','تم ربط حسابك بنجاح',false);
  renderAccountLinks();
  const target = window._authReturnScreen || 's-home';
  if(target==='s-stats'){ go('s-stats'); }
  else if(!storeGet('onbDone', false)){ _onbStep=0; _onbSetStep(0); go('s-onb'); }
  else { checkSubscriptionAndRoute(window._currentUid); }
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
    await fetch(apiUrl('/api/account/profile'), {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({uid, name: name||'', email: email||'', provider: provider||'', idToken})
    });
  }catch(e){ console.error('save profile:', e); }
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
    : 'طريقتك الأصلية';

  window._pendingLinkCred    = pendingCred;
  window._pendingLinkEmail   = email || '';
  window._pendingLinkOriginal= original;

  openAuth(window._authReturnScreen || currentScreenId());
  document.getElementById('auth-title').textContent = 'لديك حساب بالفعل';
  document.getElementById('auth-sub').textContent = email
    ? `البريد (${email}) مسجَّل مسبقاً عبر ${originalLabel}. سجّل دخولك بهذه الطريقة أولاً وسنربط حسابك تلقائياً.`
    : 'لديك حساب بالفعل بطريقة دخول مختلفة. سجّل دخولك بطريقتك الأصلية أولاً ثم يمكنك ربط الطريقة الجديدة من إعدادات الحساب.';
  if(original.includes('password') && email){
    document.getElementById('auth-email-form').style.display='block';
    document.getElementById('auth-email').value = email;
  }
  showToast('🔗','لديك حساب بالفعل', originalLabel ? `سجّل عبر ${originalLabel} للمتابعة` : 'سجّل بطريقتك الأصلية', false);
  return true;
}

// بعد نجاح تسجيل الدخول بالطريقة الأصلية، إن كان هناك ربط معلّق نكمله تلقائياً
async function resolvePendingLinkWeb(wb, userAfterSignIn){
  if(!window._pendingLinkCred || !userAfterSignIn) return false;
  try{
    const { linkWithCredential } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
    await linkWithCredential(userAfterSignIn, window._pendingLinkCred);
    showToast('🔗','تم الربط بنجاح','أصبح بإمكانك الدخول من الطريقتين الآن',false);
    return true;
  }catch(e){ console.error('resolve pending link:', e); return false; }
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
function recordNonFatal(error, source){
  const crashlytics=getCrashlytics();
  if(!crashlytics) return;
  const message=String((error && (error.message||error.reason)) || error || 'Unknown error').slice(0,1000);
  crashlytics.recordException({message:`${source}: ${message}`}).catch(()=>{});
}
function initCrashReporting(){
  const crashlytics=getCrashlytics();
  if(!crashlytics) return;
  crashlytics.setEnabled({enabled:true}).catch(()=>{});
  window.addEventListener('error', event=>recordNonFatal(event.error||event.message,'window.error'));
  window.addEventListener('unhandledrejection', event=>recordNonFatal(event.reason,'unhandledrejection'));
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
  showToast('📡','لا يوجد اتصال','تحقق من الإنترنت ثم حاول مرة أخرى',false);
}

let _authActionPending = false;
let _authPendingMessage = '';
function beginAuthAction(message='جارٍ إكمال العملية…'){
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
  }catch(e){ console.error('Firebase Web SDK:', e); return null; }
}

async function appleSignIn(){
  if(!beginAuthAction('جارٍ فتح تسجيل الدخول عبر Apple…')) return;
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
      console.error('Capacitor Apple:', e);
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
      console.error('Web Apple:', e);
      if(isAuthNetworkError(e)) showAuthNetworkError();
      else showToast('⚠️','تعذّر الدخول','جرّب مرة ثانية',false);
      return;
    }
  }
  showToast('🍎','الإعداد ناقص','يحتاج Firebase config',false);
  }finally{ endAuthAction(); }
}

async function googleSignIn(){
  if(!beginAuthAction('جارٍ فتح تسجيل الدخول عبر Google…')) return;
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
      console.error('Capacitor Google:', e);
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
      console.error('Web Google:', e);
      if(isAuthNetworkError(e)) showAuthNetworkError();
      else showToast('⚠️','تعذّر الدخول','جرّب مرة ثانية',false);
      return;
    }
  }
  showToast('🔵','الإعداد ناقص','يحتاج Firebase config',false);
  }finally{ endAuthAction(); }
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
    msg.textContent='اكتب بريدك الإلكتروني أولاً لإرسال رابط إعادة كلمة المرور';
    return;
  }
  if(!beginAuthAction('جارٍ إرسال رابط إعادة كلمة المرور…')) return;
  msg.style.color='';
  msg.textContent='جارٍ إرسال رابط إعادة كلمة المرور…';
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
    msg.textContent='تم إرسال رابط إعادة كلمة المرور إلى بريدك. افحص البريد والرسائل غير المرغوب فيها.';
  }catch(e){
    console.error('password reset:',e);
    const code=String((e && e.code)||'');
    msg.style.color='#ff8a8a';
    if(code.includes('invalid-email')) msg.textContent='صيغة البريد الإلكتروني غير صحيحة';
    else if(code.includes('user-not-found')) msg.textContent='لا يوجد حساب مرتبط بهذا البريد';
    else if(code.includes('too-many-requests')) msg.textContent='تمت محاولات كثيرة. حاول لاحقاً.';
    else if(isAuthNetworkError(e)) msg.textContent='لا يوجد اتصال بالإنترنت — تحقق من الشبكة ثم حاول مرة أخرى';
    else if(code.includes('firebase-not-configured')) msg.textContent='الإعداد ناقص — Firebase غير مهيأ';
    else msg.textContent='تعذّر إرسال الرابط — تأكد من البريد وحاول مرة أخرى';
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
  }catch(e){ console.warn('forgot email lookup:',e); }
  const email=currentEmail||savedEmail;
  msg.style.color=email?'#8ee6b0':'#f5c542';
  msg.textContent=email
    ? `البريد المرتبط بهذا الجهاز هو: ${email}`
    : 'لا يوجد بريد محفوظ على هذا الجهاز. جرّب Apple أو Google أو رقم الهاتف للدخول إلى حسابك.';
}

async function emailAuth(mode){
  sfx('tap');
  const email    = (document.getElementById('auth-email').value||'').trim();
  const password = document.getElementById('auth-password').value||'';
  const msg = document.getElementById('auth-msg');
  msg.style.color=''; msg.textContent='';
  if(!email || !email.includes('@')){ msg.style.color='#ff8a8a'; msg.textContent='أدخل بريداً إلكترونياً صحيحاً'; return; }
  if(password.length < 6){ msg.style.color='#ff8a8a'; msg.textContent='كلمة المرور ٦ أحرف على الأقل'; return; }
  if(!beginAuthAction(mode==='signup' ? 'جارٍ إنشاء الحساب…' : 'جارٍ تسجيل الدخول…')) return;
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
    console.error('email auth:', e);
    const code = String((e && e.code) || '');
    if(code.includes('email-already-in-use') || code.includes('credential-already-in-use')){
      msg.style.color='#f5c542';
      msg.textContent='لديك حساب بهذا البريد بالفعل — اضغط "تسجيل الدخول" بدل إنشاء حساب';
    } else if(code.includes('wrong-password') || code.includes('invalid-credential') || code.includes('user-not-found')){
      msg.style.color='#ff8a8a'; msg.textContent='البريد أو كلمة المرور غير صحيحة';
    } else if(code.includes('weak-password')){
      msg.style.color='#ff8a8a'; msg.textContent='كلمة المرور ضعيفة — اختر كلمة أقوى';
    } else if(isAuthNetworkError(e)){
      msg.style.color='#ff8a8a'; msg.textContent='لا يوجد اتصال بالإنترنت — تحقق من الشبكة ثم حاول مرة أخرى';
    } else {
      msg.style.color='#ff8a8a'; msg.textContent='تعذّر إكمال العملية — حاول مرة أخرى';
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
      console.warn('native auth user:',e);
      if(throwOnError) throw e;
      return null;
    }
  }
  const wb=await getFirebaseWebAuth();
  if(wb && wb.auth.currentUser){
    try{
      if(reload) await wb.auth.currentUser.reload();
    }catch(e){
      console.warn('web auth user:',e);
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
    status.textContent='سجّل الدخول بحساب Firebase لتفعيل التحقق.';
    if(emailBtn) emailBtn.style.display='none';
    return;
  }
  if(emailBtn) emailBtn.style.display=user.email?'block':'none';
  const emailLine=user.email
    ? `البريد: ${esc(user.email)} — ${user.emailVerified ? '✅ تم التحقق' : '⚠️ لم يتم التحقق بعد'}`
    : 'لا يوجد بريد إلكتروني مرتبط بهذا الحساب.';
  const phoneLine=user.phoneNumber
    ? `الهاتف: ${esc(user.phoneNumber)} — ✅ تم التحقق`
    : 'الهاتف: لم يتم التحقق منه بعد';
  status.innerHTML=`<div>${emailLine}</div><div style="margin-top:5px;">${phoneLine}</div>`;
}

let _emailVerificationPending=false;
async function sendEmailVerificationMessage(silent=false){
  if(_emailVerificationPending) return false;
  _emailVerificationPending=true;
  const button=document.getElementById('send-email-verification-btn');
  if(button) button.disabled=true;
  if(!silent) setVerificationMessage('⏳ جارٍ إرسال رسالة التحقق…');
  try{
    const user=await getCurrentFirebaseUserData();
    if(!user || !user.email){
      setVerificationMessage('أضف وسيلة دخول بالبريد أولاً حتى نرسل رسالة التحقق.', true);
      return false;
    }
    if(user.emailVerified){
      setVerificationMessage('هذا البريد تم التحقق منه مسبقاً.');
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
    setVerificationMessage('تم إرسال رسالة التحقق. افتحها ثم حدّث الحالة.');
    if(!silent) showToast('✉️','تم إرسال رسالة التحقق','تحقق من بريدك الإلكتروني',false);
    return true;
  }catch(e){
    console.error('email verification:',e);
    const code=String((e && (e.code||e.message))||'').toLowerCase();
    if(isAuthNetworkError(e)) setVerificationMessage('لا يوجد اتصال بالإنترنت — تحقق من الشبكة ثم حاول مرة أخرى.', true);
    else if(code.includes('too-many-requests')) setVerificationMessage('تم إرسال طلبات كثيرة — انتظر قليلاً ثم حاول مرة أخرى.', true);
    else setVerificationMessage('تعذّر إرسال رسالة التحقق — حاول مرة أخرى.', true);
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
  setVerificationMessage('⏳ جارٍ تحديث حالة التحقق…');
  try{
    await refreshVerificationStatus(true);
    setVerificationMessage('تم تحديث حالة التحقق.');
  }catch(e){
    console.error('refresh verification:',e);
    if(isAuthNetworkError(e)) setVerificationMessage('لا يوجد اتصال بالإنترنت — تعذّر تحديث الحالة.', true);
    else setVerificationMessage('تعذّر تحديث حالة التحقق — حاول مرة أخرى.', true);
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
  if(errorCode.includes('network-request-failed') || errorCode.includes('network error') || errorCode.includes('offline')) return 'لا يوجد اتصال بالإنترنت — تحقق من الشبكة ثم حاول مرة أخرى.';
  if(errorCode.includes('provider-disabled')) return 'تسجيل الدخول برقم الهاتف غير مفعّل في Firebase.';
  if(errorCode.includes('invalid-phone-number')) return 'رقم الكويت غير صحيح. أدخل ٨ أرقام بدون صفر بالبداية.';
  if(errorCode.includes('too-many-requests')) return 'تمت محاولات كثيرة لإرسال SMS. انتظر قليلاً ثم حاول مرة أخرى.';
  if(errorCode.includes('credential-already-in-use')) return 'رقم الهاتف مرتبط بحساب آخر.';
  if(errorCode.includes('captcha-check-failed')) return 'تعذر التحقق الأمني. أعد المحاولة من اتصال موثوق.';
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
  setVerificationMessage('تم التحقق من رقم الهاتف وربطه بحسابك.');
  await refreshVerificationStatus();
  renderAccountLinks();
  showToast('📱','تم توثيق رقم الهاتف','تم ربط الرقم بحسابك بنجاح',false);
}

let _phoneStartPending=false;
async function startPhoneVerification(){
  sfx('tap');
  setVerificationMessage('');
  const input=document.getElementById('verification-phone');
  const phone=normalizePhoneNumber(input && input.value);
  if(!phone){
    setVerificationMessage('اكتب الرقم بصيغة دولية، مثل +96550001234.', true);
    return;
  }
  if(_phoneStartPending) return;
  _phoneStartPending=true;
  const startButton=document.getElementById('send-phone-code-btn');
  if(startButton) startButton.disabled=true;
  setVerificationMessage('⏳ جارٍ إرسال رمز SMS…');
  try{
  const user=await getCurrentFirebaseUserData(false);
  if(!user){
    setVerificationMessage('سجّل الدخول بحساب Firebase أولاً.', true);
    return;
  }
  if(user.phoneNumber){
    setVerificationMessage('رقم الهاتف تم التحقق منه مسبقاً.');
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
        setVerificationMessage('تم إرسال رمز SMS. أدخله هنا لإكمال التحقق.');
        document.getElementById('verification-phone-code')?.focus();
      }));
      _phoneListenerHandles.push(await FA.addListener('phoneVerificationCompleted', event=>{
        const completedUser=event && event.result && event.result.user;
        if(completedUser) finishPhoneVerification(completedUser);
      }));
      _phoneListenerHandles.push(await FA.addListener('phoneVerificationFailed', event=>{
        const eventCode=event && (event.code || event.errorCode || event.message);
        setVerificationMessage(phoneAuthErrorMessage(eventCode, 'تعذّر إرسال رمز SMS — حاول مرة أخرى.'), true);
        if(startButton) startButton.textContent='إرسال رمز SMS';
        cleanupPhoneListeners();
      }));
      await FA.linkWithPhoneNumber({phoneNumber:phone});
      setVerificationMessage('جارٍ إرسال رمز SMS…');
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
    setVerificationMessage('تم إرسال رمز SMS. أدخله هنا لإكمال التحقق.');
    document.getElementById('verification-phone-code')?.focus();
  }catch(e){
    console.error('phone verification start:',e);
    await cleanupPhoneListeners();
    const code=String(e && (e.code||e.message) || '');
    setVerificationMessage(phoneAuthErrorMessage(code, 'تعذّر إرسال رمز SMS — حاول مرة أخرى.'), true);
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
    setVerificationMessage('أدخل رمز التحقق المرسل برسالة SMS.', true);
    return;
  }
  if(_phoneConfirmPending) return;
  _phoneConfirmPending=true;
  const confirmButton=document.getElementById('confirm-phone-code-btn');
  if(confirmButton) confirmButton.disabled=true;
  setVerificationMessage('⏳ جارٍ تأكيد رمز التحقق…');
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
    console.error('phone verification confirm:',e);
    const errorCode=String(e && (e.code||e.message) || '').toLowerCase();
    if(errorCode.includes('invalid-verification-code')) setVerificationMessage('رمز التحقق غير صحيح.', true);
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
    else if(isAuthNetworkError(e)) setVerificationMessage('لا يوجد اتصال بالإنترنت — تعذّر تأكيد الرمز.', true);
    else setVerificationMessage('تعذّر تأكيد الرقم — تحقق من الرمز وحاول مرة أخرى.', true);
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
  document.getElementById('onb-next-btn').textContent = (step === _ONB_TOTAL - 1) ? 'ابدأ اللعب 🎯' : 'التالي';
  // تحديث النقاط
  document.querySelectorAll('.onb-dot').forEach((d,i)=>{
    d.classList.toggle('active', i===step);
  });
  // تحريك البطاقات
  for(let i=0; i<_ONB_TOTAL; i++){
    const c = document.getElementById('onb-card-'+i);
    c.classList.remove('active','out');
    if(i===step) c.classList.add('active');
    else if(i<step) c.classList.add('out');
  }
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
    }catch(e){ console.warn('RC Keychain read:',e); }
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
  }catch(e){ console.error('RC config:', e); }
  return RC_API_KEY;
}
// امسح أي نسخة تركتها الإصدارات القديمة في تخزين JavaScript.
localStorage.removeItem(STORAGE_PREFIX+'rcApiKey');
window.Capacitor?.Plugins?.Preferences?.remove({key:STORAGE_PREFIX+'rcApiKey'}).catch(()=>{});
const RC_ENTITLEMENT = 'premium';
const RC_APP_USER_ID_KEY = 'rcAppUserId';
const RC_APP_USER_IDS_KEY = 'rcAppUserIds';
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
    let idToken=await getCurrentIdToken();
    const identityRequest=token=>fetch(apiUrl('/api/revenuecat/identity'),{
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
    await RC.configure({ apiKey: RC_API_KEY, appUserID: rcAppUserId });
    // لا نرسل البريد أو Firebase UID كـ subscriber attribute.
    // Secure Attributes غير متاحة في هذا SDK؛ الصلاحيات تُحسم بالـwebhook.
    return true;
  }catch(e){
    const detail=String(e && (e.message||e.code) || e || 'خطأ غير معروف');
    console.error('RC init:', detail);
    return false;
  }
}

async function rcIsActive(){
  const RC = getRC();
  if(!RC) return null; // null = غير متاح (ويب)
  await loadRcKey();
  if(!RC_CONFIGURED) return null; // المفتاح غير متوفر
  try{
    const { customerInfo } = await RC.getCustomerInfo();
    const active = !!(customerInfo.entitlements.active &&
                      customerInfo.entitlements.active[RC_ENTITLEMENT]);
    // احفظ آخر حالة معروفة (للاستخدام عند انعدام الإنترنت)
    storeSet('rcSubCache', { active, ts: Date.now() });
    return active;
  }catch(e){
    console.error('RC status:', e);
    // إذا كنا بلا إنترنت على iOS، أعد الحالة المحفوظة (صالحة 7 أيام)
    if(!navigator.onLine){
      const cache = storeGet('rcSubCache', null);
      if(cache && (Date.now() - cache.ts) < 7 * 24 * 60 * 60 * 1000){
        console.log('RC offline — using cached state:', cache.active);
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
  if(!RC) throw new Error('RevenueCat غير متاح');
  await loadRcKey();
  if(!RC_CONFIGURED) throw new Error('RevenueCat غير مهيَّأ — تعذّر جلب المفتاح من الخادم');
  if(!(await rcReady())) throw new Error('تعذّرت تهيئة RevenueCat — راجع سجلّ Xcode');
  const res = await RC.getOfferings();
  const offerings = (res && res.offerings) ? res.offerings : res; // تسامح مع الشكلين
  const current = offerings && offerings.current;
  if(!current) throw new Error('لا توجد عروض متاحة — تأكد من تعليم Offering كـ Current بلوحة RevenueCat');
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
  if(sub) sub.textContent = 'جاري جلب الأسعار…';
  if(err)  err.style.display = 'none';
  if(note) note.style.display = 'none';

  try{
    const { monthly, annual } = await fetchPackages(force);
    const monthlyProduct = monthly && monthly.product;
    const annualProduct  = annual  && annual.product;
    if(!monthlyProduct && !annualProduct) throw new Error('لا توجد أسعار متاحة');

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
    console.error('paywall prices:', (e && e.message) || e);
    if(err) err.style.display = 'block';
    if(sub) sub.textContent = '';
    if(btn) btn.disabled = true;
  }finally{
    _pwPricesLoading = false;
  }
}

async function rcPurchase(plan){
  const RC = getRC();
  if(!RC) throw new Error('RevenueCat غير متاح');
  const { monthly, annual } = await fetchPackages();
  const pkg = plan === 'annual' ? annual : monthly;
  if(!pkg) throw new Error('الباقة غير موجودة — تأكد من إعداد Offerings في RevenueCat');
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
  if(!RC){ showToast('ℹ️','متاح على iOS فقط','',false); return; }
  try{
    if(!(await rcReady())) throw new Error('تعذّرت تهيئة RevenueCat — راجع سجلّ Xcode');
    await RC.restorePurchases();
    await checkSubscriptionAndRoute(window._currentUid || storeGet('authUid',''));
    showToast('ℹ️','جاري التحقق من الاستعادة','سيُفتح المحتوى بعد تأكيد الخادم',false);
  }catch(e){ showToast('⚠️','تعذّر الاستعادة', e.message||'', false); }
}

async function promoIsActive(uid){
  if(!uid) return false;
  try{
    const idToken = await getCurrentIdToken();
    if(!idToken) return false;
    const r = await fetch(apiUrl(`/api/promo/status?uid=${encodeURIComponent(uid)}`),
      {headers:{'Authorization':'Bearer '+idToken}});
    if(!r.ok) return false;
    const d = await r.json();
    return d.active === true;
  }catch(e){ return false; }
}

async function checkSubscriptionAndRoute(uid, {showLoading=true} = {}){
  if(showLoading) go('s-loading');
  // جميع المنصات: الخادم هو مصدر الصلاحية. لا نفتح المحتوى بناءً على
  // CustomerInfo أو cache محلي؛ webhook هو الذي يحدّث حالة الاشتراك.
  try{
    const idToken=await getCurrentIdToken();
    if(!idToken) throw new Error('لا توجد جلسة Firebase موثّقة');
    const ctrl = new AbortController();
    const timer = setTimeout(()=>ctrl.abort(), 8000); // 8 ثوانٍ حد أقصى
    let resp;
    try{
      resp = await fetch(apiUrl(`/api/subscription/status?uid=${encodeURIComponent(uid||'')}`),{
        headers:{'Authorization':'Bearer '+idToken},
        signal: ctrl.signal
      });
    }finally{ clearTimeout(timer); }
    if(!resp.ok) throw new Error('status error');
    const data = await resp.json();
    if(data.active === true){ hideSplash(); go('s-home'); return; }
    // تحقق من كود مجاني
    if(uid && await promoIsActive(uid)){ hideSplash(); go('s-home'); return; }
    hideSplash(); go('s-paywall');
  }catch(e){
    // فشل التحقق من الخادم (شبكة بطيئة أو خطأ) — اعرض الـ Paywall مباشرة
    hideSplash(); go('s-paywall');
  }
}

function hideSplash(){
  try{ window.Capacitor?.Plugins?.SplashScreen?.hide(); }catch(e){}
}

// ────────── كود مكافأة مجاني
function togglePromoBox(){
  const form = document.getElementById('pw-promo-form');
  const btn  = document.getElementById('pw-promo-toggle');
  const open = form.style.display === 'none';
  form.style.display = open ? 'flex' : 'none';
  form.style.flexDirection = 'column';
  btn.textContent = open ? '✖ إخفاء' : '🎁 عندك كود مجاني؟';
  if(open) document.getElementById('pw-promo-input').focus();
}

async function redeemPromo(){
  const code = (document.getElementById('pw-promo-input').value||'').trim().toUpperCase();
  const msg  = document.getElementById('pw-promo-msg');
  if(!code){ msg.style.color='#ff8a8a'; msg.textContent='أدخل الكود أولاً'; return; }
  msg.style.color='#C4B8E0'; msg.textContent='⏳ جاري التحقق...';
  try{
    const uid = window._currentUid || '';
    const idToken = await getCurrentIdToken();
    if(!uid || !idToken){
      msg.style.color='#ff8a8a';
      msg.textContent='⚠️ سجّل الدخول أولاً ثم أعد المحاولة';
      return;
    }
    const r = await fetch(apiUrl('/api/promo/redeem'),{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+idToken},
      body: JSON.stringify({code, uid, idToken})
    });
    const d = await r.json();
    if(d.ok){
      const exp = new Date(d.expires_at);
      const opts = {year:'numeric',month:'long',day:'numeric'};
      const expStr = exp.toLocaleDateString('ar-SA', opts);
      msg.style.color='#7fff9a';
      msg.textContent = d.already
        ? `✅ الكود فعّال حتى ${expStr}`
        : `🎉 تم التفعيل! مجاني حتى ${expStr}`;
      setTimeout(()=>{ go('s-home'); showToast('🎁','تم تفعيل الكود!',`مجاني حتى ${expStr}`,false); }, 1200);
    } else {
      msg.style.color='#ff8a8a';
      msg.textContent = '❌ ' + (d.error || 'الكود غير صحيح');
    }
  }catch(e){
    msg.style.color='#ff8a8a';
    msg.textContent='⚠️ تعذّر الاتصال — تأكد من الإنترنت';
  }
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
    // iOS: Apple IAP عبر RevenueCat
    if(window.Capacitor && window.Capacitor.isNativePlatform()){
      await rcPurchase(_pwPlan);
      const uid=window._currentUid || storeGet('authUid','');
      let serverActive=false;
      for(let attempt=0; attempt<6 && !serverActive; attempt++){
        if(attempt) await new Promise(resolve=>setTimeout(resolve,1500));
        try{
          const idToken=await getCurrentIdToken();
          const check=await fetch(apiUrl(`/api/subscription/status?uid=${encodeURIComponent(uid)}`),
            {headers:idToken ? {'Authorization':'Bearer '+idToken} : {}});
          if(check.ok) serverActive=(await check.json()).active===true;
        }catch(e){}
      }
      if(serverActive){
        go('s-home');
        showToast('🎉','مرحباً بك!','تم تأكيد اشتراكك من الخادم',false);
      } else {
        go('s-paywall');
        showToast('⏳','جاري تأكيد الاشتراك','سيظهر المحتوى بعد وصول تأكيد Apple',false);
      }
      return;
    }
    const note = document.getElementById('web-payment-note');
    if(note) note.style.display = 'block';
    showToast('ℹ️','الاشتراك عبر Apple فقط','افتح تطبيق فَطِنة على iPhone أو iPad لإتمام الاشتراك',false);
    btn.style.display = 'block';
    loading.style.display = 'none';
    return;
  }catch(e){
    // تجاهل إلغاء المستخدم بصمت
    if((e.code||'').toString().includes('CANCELLED') ||
       (e.message||'').toLowerCase().includes('cancel')){ /* صامت */ }
    else{ showToast('⚠️','تعذّر الدفع', e.message || 'جرّب مرة ثانية', false); }
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
  document.querySelectorAll('#seg-diff button').forEach(b=>b.classList.toggle('on',b.dataset.d===d));
  const labels={easy:'⏱ وقت الإجابة: 45 ثانية',normal:'⏱ وقت الإجابة: 30 ثانية',hard:'⏱ وقت الإجابة: 20 ثانية'};
  document.getElementById('diff-hint').textContent=labels[d]||'';
}

// ────────── إعداد الفرق
function setTeamCount(n){
  sfx('tap'); state.teamCount=n;
  document.querySelectorAll('#seg-teams button').forEach(b=>b.classList.toggle('on',+b.dataset.n===n));
  renderTeamNames();
  updateCatSplitPreview();
}
function updateCatCount(v){
  sfx('tap');
  state.catCount=+v;
  document.getElementById('catcount-lbl').textContent=v;
  document.querySelectorAll('#seg-catcount button').forEach(b=>b.classList.toggle('on', +b.dataset.n===+v));
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
      <input class="team-input" id="tn-${i}" value="${st.name}" maxlength="16" oninput="updateCatSplitPreview()">`;
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
  grid.innerHTML='<div class="empty-state">جاري تجهيز الفئات…</div>';
  try{
    await ensureQuestionBank();
    renderCats();
  }catch(error){
    console.error('Question bank loading failed',error);
    go('s-teams');
    toast('تعذر تحميل الأسئلة، حاول مرة أخرى');
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
    pill.textContent='✅ تم اختيار كل الفئات — يلا نبدأ!';
  } else {
    const ti=state.pickTurn;
    const st=TEAM_STYLES[state.teams[ti].idx];
    const need=state.pickSplit[ti]-state.pickedByTeam[ti];
    pill.style.background=st.bg; pill.style.color=st.color; pill.style.borderColor=st.dot;
    pill.textContent=`دور فريق ${state.teams[ti].name} — اختر ${need} ${need===1?'فئة':'فئات'}`;
  }
  const line=document.getElementById('pick-count-line');
  line.innerHTML=`اختُيرت <b>${state.cats.length}</b> من ${total}`;
  document.getElementById('start-btn').disabled = !done;
  document.getElementById('start-btn').style.display = done?'flex':'none';
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

function renderCatGrid(){
  const grid=document.getElementById('cat-grid');
  const search=(document.getElementById('cat-search').value||'').trim();
  grid.innerHTML='';
  let list=catsForFilter();
  if(search) list=[...ALL_CATS,...familyNames()].filter(c=>c.includes(search));
  if(!list.length){ grid.innerHTML='<div style="grid-column:1/-1;text-align:center;color:var(--muted);padding:20px;font-size:14px;">لا توجد فئات مطابقة</div>'; return; }
  list.forEach(cat=>{
    // زر حقيقي لا <div> — خطوة إلزامية بكل لعبة، وكانت بلا أي دلالة وصول
    // فلا يقدر مستخدم VoiceOver يكتشفها أو يستخدمها إطلاقاً
    const el=document.createElement('button');
    el.type='button';
    const picked=state.cats.includes(cat);
    el.className='cat-pick'+(picked?' on':'');
    el.setAttribute('aria-pressed', picked?'true':'false');
    const icon = isFamilyCat(cat)?'👨‍👩‍👧‍👦':(CAT_ICONS[cat]||'❓');
    // إن اختارها فريق، أظهر لون الفريق
    let ownerBadge='', ownerLabel='';
    if(picked && state.catOwner[cat]!=null){
      const ownerName=state.teams[state.catOwner[cat]].name;
      const ost=TEAM_STYLES[state.teams[state.catOwner[cat]].idx];
      el.style.borderColor=ost.dot;
      ownerBadge=`<span style="position:absolute;bottom:6px;left:8px;font-size:10px;font-weight:800;color:${ost.color}">${esc(ownerName)}</span>`;
      ownerLabel=` — اختارتها ${ownerName}`;
    }
    el.innerHTML=`<span class="ci" aria-hidden="true">${icon}</span>${esc(cat)}${ownerBadge}`;
    el.setAttribute('aria-label', cat+(picked?' — مُختارة'+ownerLabel:''));
    el.onclick=()=>toggleCat(cat,el);
    grid.appendChild(el);
  });
}
function filterCats(){ renderCatGrid(); }

function toggleCat(cat,el){
  const already=state.cats.indexOf(cat);
  // إلغاء اختيار: فقط الفريق الذي اختارها يقدر يلغيها، وترجع الأدوار
  if(already>=0){
    const owner=state.catOwner[cat];
    sfx('tap');
    state.cats.splice(already,1);
    delete state.catOwner[cat];
    state.pickedByTeam[owner]--;
    state.pickTurn=owner; // يرجع الدور لمن ألغى
    renderCatGrid(); updatePickTurn();
    return;
  }
  // اختيار جديد
  if(state.cats.length>=state.catCount) return;
  const ti=state.pickTurn;
  state.cats.push(cat);
  state.catOwner[cat]=ti;
  state.pickedByTeam[ti]++;
  sfx('tap'); vibrate(12);
  // هل انتهى نصيب هذا الفريق؟ انتقل للتالي الذي لم يكمل
  advancePickTurn();
  renderCatGrid(); updatePickTurn();
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
const AI_ROUND_BLOCKED_CATEGORIES=new Set([
  'دين وسيرة','السيرة النبوية','القرآن الكريم','فتوحات المسلمين','الصحابة'
]);
function startGame(){
  state.familyRound=null; state.usedQ=new Set();
  roundQuestionBank=Object.create(null);
  const token=++roundQuestionToken;
  vibrate(30); state.turn=0; state.answered=0; state.cells={};
  buildBoard(); renderTeamsBar(); renderTurn(); go('s-board');
  // لا نؤخّر بدء اللعب: تُجلب دفعة الجولة في الخلفية، ويبقى البنك المحلي
  // الصغير جاهزاً إن كانت الشبكة بطيئة أو تعذّر التحقق من المصدر.
  void prepareTrustedRoundQuestions(state.cats,token);
}
async function prepareTrustedRoundQuestions(categories,token){
  if(!navigator.onLine) return;
  const eligible=[...new Set(categories)].filter(cat=>!AI_ROUND_BLOCKED_CATEGORIES.has(cat));
  await Promise.all(eligible.map(async cat=>{
    try{
      const questions=await aiGenerate(cat,6,{trustedRound:true});
      if(token!==roundQuestionToken || !questions.length) return;
      roundQuestionBank[cat]=questions.map((q,index)=>({...q,d:index+1}));
    }catch(error){
      // لا نعرض خطأ للمستخدم؛ البنك المحلي هو المسار الاحتياطي المتعمد.
      console.warn('Trusted round questions unavailable for',cat,error);
    }
  }));
}
function buildBoard(){
  const n=state.cats.length;
  const head=document.getElementById('cats-head'); head.innerHTML='';
  head.style.gridTemplateColumns=`repeat(${n},1fr)`;
  state.cats.forEach(c=>{ const h=document.createElement('div'); h.className='cat-h'; h.textContent=c; head.appendChild(h); });
  const board=document.getElementById('board'); board.innerHTML='';
  board.style.gridTemplateColumns=`repeat(${n},1fr)`;
  // خطّ حجم على أساس عدد الفئات (كثرة الأعمدة = خط أصغر)
  const fontSize = n>=9?'12px':(n>=7?'14px':'clamp(13px,3.6vw,19px)');
  for(let r=1;r<=6;r++) for(let col=0;col<n;col++){
    const key=col+'-'+r; state.cells[key]={used:false};
    const cell=document.createElement('button'); cell.className='cell';
    cell.style.background=FIRE[r].bg; cell.style.color=FIRE[r].tx; cell.textContent=POINTS[r];
    cell.setAttribute('aria-label',`سؤال ${state.cats[col]} بقيمة ${POINTS[r]} نقطة`);
    cell.style.fontSize=fontSize;
    cell.onclick=()=>openQuestion(col,r,key,cell); board.appendChild(cell);
  }
  // إجمالي الأسئلة = عدد الفئات × 6
  state.totalQuestions = n*6;
}
function renderTeamsBar(){
  const bar=document.getElementById('teams-bar'); bar.innerHTML='';
  const max=Math.max(...state.teams.map(t=>t.score));
  state.teams.forEach((t,i)=>{
    const st=TEAM_STYLES[t.idx];
    const chip=document.createElement('div'); chip.className='team-chip'+(i===state.turn?' active':'');
    chip.style.background=st.bg; chip.style.borderColor=(i===state.turn?st.dot:'transparent');
    const lead=(t.score>0&&t.score===max);
    chip.innerHTML=`<span class="crown" style="display:${lead?'block':'none'}">👑</span>
      <span class="cn" style="color:${st.color}">${t.name}</span>
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
    document.getElementById('bomb-target-modal').classList.add('show');
  }
}
function closeBombTargetPicker(){
  document.getElementById('bomb-target-modal').classList.remove('show');
}
function fireBomb(targetIdx){
  clearInterval(state.searchTimer); // احتياط: لا يبقى مؤقّت بحث من سؤال سابق يلوّث القنبلة
  const n=state.cats.length;
  let col=-1, r=-1;
  for(let lvl=6; lvl>=1 && col===-1; lvl--){
    const candidates=[];
    for(let c=0;c<n;c++){ const key=c+'-'+lvl; if(state.cells[key] && !state.cells[key].used) candidates.push(c); }
    if(candidates.length){ col=candidates[Math.floor(Math.random()*candidates.length)]; r=lvl; }
  }
  if(col===-1){ state.teams[state.turn].bombUsed=true; return; } // لا خانات متبقية — سجّل القنبلة مستخدمة
  const key=col+'-'+r;
  const cellEls=document.querySelectorAll('#board .cell');
  const cell=cellEls[(r-1)*n+col];
  const cat=state.cats[col];
  const q=pickQuestion(cat,r);
  state.cur={col,r,key,cell,cat,d:r,q,points:1200,isBomb:true,bombThrower:state.turn,bombTarget:targetIdx,phase:'bomb',resolved:false};
  const badge=document.getElementById('q-badge');
  badge.textContent='💣 '+cat; badge.style.background='#8b1a3d'; badge.style.color='#fff';
  document.getElementById('q-points').textContent='±1200 نقطة';
  document.getElementById('q-text').textContent=q.q;
  setQuestionAnswer(q);
  document.getElementById('answer-box').classList.remove('show');
  document.getElementById('search-timer').classList.remove('show');
  document.getElementById('pause-btn').textContent='⏸';
  document.getElementById('pause-btn').disabled=false;
  document.getElementById('pause-btn').style.opacity='1';
  setQuestionHidden(false);
  startPhase('bomb');
  renderLifelines();
  keepAwakeOn();
  document.getElementById('q-wrap').classList.add('show');
}
function awardBomb(correct){
  const c=state.cur;
  if(!c || c.resolved) return; // حارس ضد نقر مزدوج على أزرار الحكم
  c.resolved=true;
  stats.totalQ++;
  state.teams[c.bombThrower].bombUsed=true;
  if(correct){
    sfx('correct'); vibrate([15,10,15]);
    state.teams[c.bombTarget].score+=1200; stats.correct++;
  } else {
    sfx('wrong'); vibrate([40,30,40]);
    state.teams[c.bombTarget].score-=1200;
  }
  c.cell.classList.add('used'); state.cells[c.key].used=true;
  state.answered++; renderTeamsBar();
  closeQuestion();
}

// ────────── الأسئلة
function setQuestionAnswer(q){
  document.getElementById('ans-text').textContent=q.answer || (q.o && typeof q.a==='number' ? q.o[q.a] : '');
  const source=document.getElementById('q-source');
  const validSource=q && q.source && /^https:\/\//.test(q.source.url||'');
  source.style.display=validSource?'inline-block':'none';
  if(validSource){
    source.href=q.source.url;
    source.textContent='المصدر: '+(q.source.title||'مرجع موثوق');
  }
}
function pickQuestion(cat,d){
  // جولة عائلية: اسحب من أسئلة الفئة العائلية بغضّ النظر عن المستوى، مع منع التكرار
  if(state.familyRound){
    const all=state.familyRound.questions;
    let pool=all.filter(q=>!state.usedQ.has(q.q));
    if(!pool.length) pool=all; // استُهلكت كل الأسئلة — اسمح بالتكرار كخيار أخير فقط
    const q=pool[Math.floor(Math.random()*pool.length)];
    state.usedQ.add(q.q);
    return q;
  }
  // فئة عائلية مختارة ضمن اللعب العادي
  const fam=familyCats && familyCats.find(c=>c.name===cat);
  if(fam){
    let pool=fam.questions.filter(q=>!state.usedQ.has(q.q));
    if(!pool.length) pool=fam.questions;
    const q=pool[Math.floor(Math.random()*pool.length)];
    state.usedQ.add(q.q);
    return q;
  }
  const generated=roundQuestionBank[cat]||[];
  let generatedPool=generated.filter(q=>q.d===d && !state.usedQ.has(q.q));
  if(!generatedPool.length) generatedPool=generated.filter(q=>!state.usedQ.has(q.q));
  if(generatedPool.length){
    const q=generatedPool[Math.floor(Math.random()*generatedPool.length)];
    state.usedQ.add(q.q);
    return q;
  }
  // الفئات الأساسية: استبعد ما استُخدم في هذه الجولة، مع سقوط منطقي عند النفاد
  const local=QUESTION_BANK[cat]||[];
  let pool=local.filter(q=>q.d===d && !state.usedQ.has(q.q));
  if(!pool.length) pool=local.filter(q=>!state.usedQ.has(q.q)); // جرّب أي مستوى آخر بنفس الفئة
  if(!pool.length) pool=local; // الفئة استُهلكت كاملة — اسمح بالتكرار كخيار أخير فقط
  if(!pool.length) return {q:'تعذر تجهيز سؤال لهذه الفئة',answer:'اختر خانة أخرى'};
  const q=pool[Math.floor(Math.random()*pool.length)];
  state.usedQ.add(q.q);
  return q;
}
function openQuestion(col,r,key,cell){
  if(state.cells[key].used) return;
  sfx('tap'); vibrate(15);
  clearInterval(state.searchTimer); // احتياط: لا يبقى مؤقّت بحث من سؤال سابق يلوّث هذا السؤال
  const cat=state.cats[col]; const q=pickQuestion(cat,r);
  // owner = الفريق صاحب الدور ، stealQueue = بقية الفرق بالتناوب (يدعم أي عدد فرق)
  const owner=state.turn;
  const stealQueue=[];
  for(let i=1;i<state.teams.length;i++) stealQueue.push((state.turn+i)%state.teams.length);
  state.cur={col,r,key,cell,cat,d:r,q,points:POINTS[r],doubled:false,searched:false,
    owner, stealQueue, stealPos:-1, askedTeams:new Set(), passedToOpp:false, revealed:false,
    resolved:false, token:0};
  const badge=document.getElementById('q-badge');
  badge.textContent=cat; badge.style.background=FIRE[r].bg; badge.style.color=FIRE[r].tx;
  document.getElementById('q-points').textContent='+'+POINTS[r]+' نقطة';
  document.getElementById('q-text').textContent=q.q;
  setQuestionAnswer(q);
  document.getElementById('answer-box').classList.remove('show');
  document.getElementById('search-timer').classList.remove('show');
  document.getElementById('pause-btn').textContent='⏸';
  document.getElementById('pause-btn').disabled=false;
  document.getElementById('pause-btn').style.opacity='1';
  setQuestionHidden(false);
  startPhase('owner');
  renderLifelines();
  keepAwakeOn();
  document.getElementById('q-wrap').classList.add('show');
}

// ────────── مراحل السؤال
function startPhase(phase){
  state.cur.phase=phase;
  const c=state.cur;
  c.token=(c.token||0)+1; // يميّز هذه المرحلة تحديداً عن أي مشغّل (مؤقّت/زر) تابع لمرحلة سابقة
  const dt=DIFF_TIMES[state.difficulty]||DIFF_TIMES.normal;
  if(c.isBomb){
    if(phase==='bomb'){
      setPhasePill(c.bombTarget, '💣 قنبلة! دور فريق '+state.teams[c.bombTarget].name+' — يجاوب شفهياً');
      showTimer(dt.bomb);
      renderFlow();
    } else if(phase==='reveal'){
      clearInterval(state.timer);
      document.getElementById('answer-box').classList.add('show');
      sfx('correct');
      setPhasePill(-1, 'وش النتيجة؟');
      renderFlow();
    }
    return;
  }
  const isSpeed = c.cat==='إجابة سريعة';
  if(phase==='owner'){
    const t=isSpeed?dt.speed:dt.normal;
    setPhasePill(c.owner, 'دور فريق '+state.teams[c.owner].name+' — يجاوب شفهياً'+(isSpeed?' (سريع!)':''));
    showTimer(t);
    renderFlow();
  } else if(phase==='steal'){
    const ti=c.stealQueue[c.stealPos];
    c.askedTeams.add(ti);
    const t=isSpeed?Math.round(dt.speed*0.5):dt.steal;
    setPhasePill(ti, 'سرقة! دور فريق '+state.teams[ti].name+' — '+t+' ثانية');
    showTimer(t);
    renderFlow();
  } else if(phase==='reveal'){
    clearInterval(state.timer);
    document.getElementById('answer-box').classList.add('show');
    sfx('correct');
    setPhasePill(-1, 'مين جاوب صح؟ اختر الفريق');
    renderFlow();
  }
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
    label.textContent='وش صار مع فريق '+state.teams[c.bombTarget].name+'؟';
    box.appendChild(label);
    box.appendChild(btn('primary','✅ أجاب صح (+1200)', ()=>awardBomb(true)));
    box.appendChild(btn('ghost','❌ أخطأ (-1200)', ()=>awardBomb(false)));
    return;
  }
  const label=document.createElement('div');
  label.style.cssText='font-size:13px;color:var(--muted);text-align:center;margin-bottom:2px;font-weight:700;';
  label.textContent='مين جاوب صح؟';
  box.appendChild(label);
  // أزرار الفرق المؤهّلة للحكم:
  // - المالك مؤهّل ما لم يمرّر السؤال بالوسيلة (التمرير = تنازل عن الحق)
  // - أي فريق طُرح عليه السؤال أثناء طابور السرقة مؤهّل أيضاً (يدعم أكثر من فريق سارق)
  const eligible=[];
  if(!c.passedToOpp) eligible.push(c.owner);
  c.askedTeams.forEach(ti=>{ if(!eligible.includes(ti)) eligible.push(ti); });
  const row=document.createElement('div'); row.className='verdict-row';
  eligible.forEach(ti=>{
    const st=TEAM_STYLES[state.teams[ti].idx];
    const vb=document.createElement('button'); vb.className='vb';
    vb.style.background=st.solid; vb.textContent='✅ '+state.teams[ti].name;
    vb.onclick=()=>awardTo(ti); row.appendChild(vb);
  });
  box.appendChild(row);
  const none=document.createElement('button'); none.className='vb vb-none';
  none.textContent='❌ لا أحد أجاب صح'; none.onclick=()=>awardTo(-1);
  box.appendChild(none);
}
function awardTo(teamIdx){
  const c=state.cur;
  if(!c || c.resolved) return; // حارس ضد نقر مزدوج على أزرار الحكم
  c.resolved=true;
  stats.totalQ++;
  if(teamIdx>=0){
    sfx('correct'); vibrate([15,10,15]);
    let pts=c.points;
    if(c.doubled) pts*=2;
    if(c.searched) pts=Math.round(pts/2);
    state.teams[teamIdx].score+=pts; stats.correct++;
  } else { sfx('wrong'); vibrate([40,30,40]); }
  c.cell.classList.add('used'); state.cells[c.key].used=true;
  state.answered++; renderTeamsBar();
  closeQuestion();
}

// ────────── المؤقّت
function showTimer(sec){
  clearInterval(state.timer); state.timeLeft=sec; state.maxTime=sec; state.paused=false;
  const myToken = state.cur ? state.cur.token : 0;
  document.getElementById('pause-btn').textContent='⏸'; updateTimerUI();
  state.timer=setInterval(()=>{
    if(state.paused) return;
    state.timeLeft--; updateTimerUI();
    if(state.timeLeft<=5&&state.timeLeft>0) sfx('tick');
    if(state.timeLeft<=0){ clearInterval(state.timer); timeUp(myToken); }
  },1000);
}
function updateTimerUI(){
  const pct=(state.timeLeft/(state.maxTime||60))*100; const fill=document.getElementById('timer-fill');
  fill.style.width=pct+'%';
  fill.style.background=state.timeLeft>state.maxTime*0.33?'var(--ok)':(state.timeLeft>state.maxTime*0.17?'var(--fire2)':'var(--no)');
  const num=document.getElementById('timer-num'); num.textContent=state.timeLeft;
  num.classList.toggle('warn',state.timeLeft<=Math.ceil(state.maxTime*0.17));
}
function togglePause(){
  if(state.cur&&state.cur.searching) return;
  if(state.cur&&state.cur.phase==='reveal') return;
  sfx('tap'); state.paused=!state.paused;
  document.getElementById('pause-btn').textContent=state.paused?'▶':'⏸';
  setQuestionHidden(state.paused);
}
function setQuestionHidden(hide){
  const qt=document.getElementById('q-text');
  const pv=document.getElementById('q-paused');
  const ll=document.getElementById('lifelines');
  const fl=document.getElementById('q-flow');
  qt.classList.toggle('blurred',hide);
  pv.classList.toggle('show',hide);
  ll.style.display=hide?'none':'flex';
  fl.style.display=hide?'none':'flex';
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
  document.getElementById('q-wrap').classList.remove('show');
  keepAwakeOff();
  // مؤقّت وسيلة "بحث بالجوال" مستقل عن state.timer — إن أُغلق السؤال قبل
  // انتهائه (60 ثانية) يبقى شغّالاً ويكتب state.paused=false على سؤال لاحق
  // غير مرتبط عند انتهائه لاحقاً
  clearInterval(state.searchTimer);
  if(state.answered>=(state.totalQuestions||36)){ setTimeout(endGame,300); return; }
  state.turn=(state.turn+1)%state.teams.length; renderTeamsBar(); renderTurn();
}

// ────────── وسائل المساعدة
const LIFELINES=[
  {id:'search', label:'بحث بالجوال', icon:'🔍'},
  {id:'pass', label:'مرّرها للخصم', icon:'🔀'},
  {id:'skip', label:'تغيير السؤال', icon:'🔄'},
  {id:'double', label:'مضاعفة', icon:'✖️2'},
];
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
    const b=document.createElement('button'); b.className='ll'+(team.used.has(ll.id)?' done':'');
    b.innerHTML=`<span class="lli">${ll.icon}</span>${ll.label}`;
    b.setAttribute('aria-label',`${ll.label} — فريق ${team.name}`);
    const noBudget=team.ll<=0&&!team.used.has(ll.id);
    b.disabled=team.used.has(ll.id)||noBudget||!inActionPhase;
    b.onclick=()=>useLifeline(ll.id,activeTeamIdx); box.appendChild(b);
  });
  const note=document.createElement('div'); note.className='ll-note';
  note.textContent=`متبقّي لفريق ${team.name}: ${team.ll} وسائل`;
  box.appendChild(note);
}
function useLifeline(id, teamIdx){
  const team=state.teams[teamIdx]; const c=state.cur;
  if(team.used.has(id)||team.ll<=0) return;
  sfx('tap'); vibrate(15); team.used.add(id); team.ll--;
  if(id==='pass'){
    // مرّر السؤال لأول فريق في طابور السرقة — المالك يخسر حق السرقة، وبقية الطابور يستمر بعده
    c.passedToOpp=true;
    advanceSteal(c.token);
    return;
  } else if(id==='skip'){
    const nq=pickQuestion(c.cat,c.d); c.q=nq;
    document.getElementById('q-text').textContent=nq.q;
    setQuestionAnswer(nq);
    const dt2=DIFF_TIMES[state.difficulty]||DIFF_TIMES.normal;
    const isSpd=c.cat==='إجابة سريعة';
    showTimer(c.phase==='steal'?(isSpd?Math.round(dt2.speed*0.5):dt2.steal):(isSpd?dt2.speed:dt2.normal));
  } else if(id==='double'){
    c.doubled=true;
    document.getElementById('q-points').textContent='+'+(c.points*2)+' نقطة (مضاعف!)';
  } else if(id==='search'){
    c.searched=true; c.searching=true; state.paused=true;
    document.getElementById('pause-btn').disabled=true;
    document.getElementById('pause-btn').style.opacity='.4';
    let s=60; const el=document.getElementById('search-timer'); el.classList.add('show');
    el.textContent='🔍 وقت البحث: '+s;
    clearInterval(state.searchTimer);
    state.searchTimer=setInterval(()=>{ s--; el.textContent='🔍 وقت البحث: '+s;
      if(s<=0){ clearInterval(state.searchTimer); el.classList.remove('show'); state.paused=false; c.searching=false; const pb=document.getElementById('pause-btn'); pb.disabled=false; pb.style.opacity='1'; pb.textContent='⏸'; }
    },1000);
  }
  renderLifelines();
}
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } }

// ────────── النهاية
function endGame(){
  const sorted=[...state.teams].sort((a,b)=>b.score-a.score);
  const win=sorted[0]; const tie=sorted.length>1&&sorted[1].score===win.score;
  // تحديث الإحصاءات
  stats.games++;
  const bestThisGame=Math.max(...state.teams.map(t=>t.score));
  if(bestThisGame>stats.bestScore) stats.bestScore=bestThisGame;
  if(!tie) stats.wins++;
  saveStats();
  showResult(sorted,win,tie);
  checkAchievements();
}
function showResult(sorted,win,tie){
  const wl=document.getElementById('winner-line');
  wl.innerHTML=tie?'تعادل! 🤝':('🏆 الفائز: <span class="brand">'+esc(win.name)+'</span>');
  const pod=document.getElementById('podium'); pod.innerHTML='';
  const medals=['🥇','🥈','🥉']; const heights={0:156,1:122,2:98};
  const order=[1,0,2].filter(i=>i<sorted.length);
  order.forEach((pos,k)=>{
    const t=sorted[pos]; const st=TEAM_STYLES[t.idx];
    const el=document.createElement('div'); el.className='pod';
    el.style.background=st.bg; el.style.borderColor=st.dot;
    el.style.height=heights[pos]+'px'; el.style.animationDelay=(k*0.12)+'s';
    el.innerHTML=`<div class="medal">${medals[pos]}</div>
      <div class="pn" style="color:${st.color}">${t.name}</div>
      <div class="ps" style="color:${st.color}">${t.score}</div>`;
    pod.appendChild(el);
  });
  go('s-result');
  if(!tie){ sfx('win'); vibrate([60,40,60,40,120]); fireConfetti(); }
}
function restart(){
  state.teams.forEach(t=>{ t.score=0; t.ll=3; t.used=new Set(); });
  startGame();
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
  const inp = document.getElementById('account-name-input');
  if(inp) inp.value = storeGet('playerName','');
  const msg = document.getElementById('account-name-msg');
  if(msg) msg.textContent = '';
  go('s-account');
}

function savePlayerName(){
  const inp = document.getElementById('account-name-input');
  const name = (inp && inp.value.trim()) || '';
  if(!name){ showToast('⚠️','الاسم فارغ','أدخل اسمك أولاً',false); return; }
  storeSet('playerName', name);
  const nameEl = document.getElementById('user-name');
  if(nameEl) nameEl.textContent = name;
  const msg = document.getElementById('account-name-msg');
  if(msg){ msg.textContent = '✓ تم حفظ الاسم'; setTimeout(()=>{ if(msg) msg.textContent=''; }, 2000); }
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
      ? '<span style="color:#7CFC7C;font-size:12px;">✓ مرتبط</span>'
      : '<span style="color:var(--muted);font-size:12px;">غير مرتبط</span>';
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
  document.getElementById('auth-title').textContent='أضف طريقة دخول جديدة';
  document.getElementById('auth-sub').textContent='أضف البريد وكلمة المرور كوسيلة دخول إضافية لحسابك الحالي';
  document.getElementById('auth-email-form').style.display='block';
}
async function unlinkProvider(pid){
  sfx('tap');
  const linked = await getCurrentProviderData();
  if(linked.length<=1){
    showToast('⚠️','لا يمكن فك الربط','هذه آخر وسيلة دخول لحسابك — أضف وسيلة أخرى أولاً قبل فك هذه',false);
    return;
  }
  const label = (PROVIDER_INFO[pid]||{}).label || pid;
  const ok=confirm(`هل تريد فك ربط الدخول عبر ${label}؟ ستحتاج وسيلة أخرى لتسجيل الدخول لاحقاً.`);
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
    showToast('✅','تم فك الربط','',false);
    renderAccountLinks();
  }catch(e){ console.error('unlink:', e); showToast('⚠️','تعذّر فك الربط','',false); }
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
      setTimeout(()=>showToast(a.icon,'إنجاز جديد!',a.t),700);
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
let familyCats = loadFamily();        // [{name, questions:[{q,o,a}]}]
let familyMode = 'ai';
let manualDraft = { name:'', questions:[], correct:0 };
let previewData = null;                // {name, questions}

function loadFamily(){ return storeGet('family', []); }
function saveFamily(){ storeSet('family', familyCats); }

function openFamily(){
  setFamilyMode('ai');
  renderManualOpts();
  renderSavedFamily();
  go('s-family');
}
function setFamilyMode(m){
  familyMode=m; sfx('tap');
  document.getElementById('fmode-ai').classList.toggle('on',m==='ai');
  document.getElementById('fmode-manual').classList.toggle('on',m==='manual');
  document.getElementById('family-ai').style.display = m==='ai'?'block':'none';
  document.getElementById('family-manual').style.display = m==='manual'?'block':'none';
}

// ---- وضع التوليد بالذكاء ----
async function generateFamily(){
  const name=(document.getElementById('fai-name').value||'').trim();
  const topic=(document.getElementById('fai-topic').value||'').trim();
  const count=+document.getElementById('fai-count').value;
  if(!name){ shakeField('fai-name'); return; }
  if(!topic){ shakeField('fai-topic'); return; }
  sfx('start'); vibrate(20);
  const btn=document.getElementById('fai-btn');
  btn.disabled=true; btn.innerHTML='<span class="spin" style="display:inline-block">⏳</span> يولّد الأسئلة...';
  let questions=null; let failed=false;
  try{ questions = await aiGenerate(topic,count); }
  catch(e){ failed=true; }
  btn.disabled=false; btn.innerHTML='✨ ولّد الأسئلة';
  if(failed || !questions || !questions.length){
    // رسالة صادقة بدل أسئلة قوالب وهمية بلا معنى
    showToast('⚠️','تعذّر التوليد','تأكّد من الإنترنت وحاول مرة ثانية، أو استخدم الإدخال اليدوي',false);
    return;
  }
  previewData={name, questions};
  renderPreview(); go('s-family-preview');
}

// توليد الأسئلة عبر الخادم المحلي (يستخدم Claude / Anthropic بأمان من جهة الخادم)
// في بيئة iOS الأصلية نعود للـ Firebase Cloud Function كاحتياط
const AI_BACKEND_URL = (typeof window !== 'undefined' && window.location.hostname !== 'localhost' && !window.location.hostname.includes('127.0.0.1') && window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
  ? 'https://us-central1-fatinah-game.cloudfunctions.net/generateQuestions'
  : '/api/generate';
// تتبّع الأسئلة المُشاهدة لكل موضوع — يضمن أسئلة جديدة دائماً ويوفّر التوكن
// نفس تطبيع الخادم (normalize_topic) حتى تتطابق المفاتيح
function seenKey(topic){
  let t=topic.trim().toLowerCase();
  t=t.replace(/[\u064B-\u0652\u0670]/g,'');
  t=t.replace(/[أإآ]/g,'ا').replace(/ة/g,'ه').replace(/ى/g,'ي');
  return t.replace(/\s+/g,' ');
}
function getSeen(topic){ const m=storeGet('seenQ',{}); return m[seenKey(topic)]||[]; }
function addSeen(topic, ids){
  if(!ids.length) return;
  const m=storeGet('seenQ',{}); const k=seenKey(topic);
  m[k]=[...new Set([...(m[k]||[]), ...ids])].slice(-5000);
  // حد أقصى 40 موضوعاً — احذف الأقدم عند التجاوز (حماية سعة localStorage)
  const keys=Object.keys(m);
  if(keys.length>40){ keys.slice(0,keys.length-40).forEach(x=>delete m[x]); }
  storeSet('seenQ', m);
}
async function aiGenerate(topic,count,{trustedRound=false}={}){
  const uid=window._currentUid || storeGet('authUid','');
  const idToken=await getCurrentIdToken();
  const res=await fetch(AI_BACKEND_URL,{
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ topic, count, seen:getSeen(topic), uid, idToken, trustedRound })
  });
  if(!res.ok) throw new Error('فشل الاتصال بالخادم');
  const data=await res.json();
  const arr=(data.questions||[]).filter(x=>{
    if(!x || !x.q || !x.answer) return false;
    // لا تقبل الجولة أسئلة من خادم قديم أو استجابة غير موثقة.
    return !trustedRound || Boolean(x.source && /^https:\/\//.test(x.source.url||''));
  }).slice(0,count);
  addSeen(topic, arr.map(x=>x.id).filter(Boolean));
  return arr;
}

// مولّد نموذجي ذكي (يعمل دون إنترنت — لعرض التجربة كاملة)
function templateGenerate(topic,count){
  const templates=[
    {q:`ما أبرز ما يميّز ${topic}؟`, o:['التنوّع','التاريخ العريق','الموقع','كل ما سبق'], a:3},
    {q:`أي مما يلي مرتبط بـ ${topic}؟`, o:['خيار أول','خيار ثانٍ','خيار ثالث','خيار رابع'], a:0},
    {q:`من المشهور في مجال ${topic}؟`, o:['شخصية أولى','شخصية ثانية','شخصية ثالثة','لا أحد'], a:1},
    {q:`متى ازدهر ${topic}؟`, o:['قديماً','حديثاً','مستمر','متقطّع'], a:2},
    {q:`أين يبرز ${topic} أكثر؟`, o:['المدن','الأرياف','الساحل','كل المناطق'], a:3},
    {q:`ما التحدّي الأكبر أمام ${topic}؟`, o:['الوقت','الموارد','المنافسة','التطوير'], a:0},
    {q:`كيف يُقاس نجاح ${topic}؟`, o:['بالكم','بالكيف','بالأثر','بالجميع'], a:2},
    {q:`ما مستقبل ${topic}؟`, o:['واعد','مستقر','متغيّر','غامض'], a:0},
    {q:`أي فئة تهتم بـ ${topic} أكثر؟`, o:['الشباب','الكبار','الجميع','المختصون'], a:2},
    {q:`ما أصل ${topic}؟`, o:['محلي','عربي','عالمي','مشترك'], a:3},
    {q:`ما القيمة الأساسية في ${topic}؟`, o:['الأصالة','الحداثة','التوازن','التميّز'], a:2},
    {q:`ما الكلمة الأقرب لوصف ${topic}؟`, o:['مميّز','عريق','متطوّر','شامل'], a:0},
  ];
  return templates.slice(0,count).map(t=>({...t}));
}

function renderPreview(){
  document.getElementById('fp-info').textContent=`فئة "${previewData.name}" · ${previewData.questions.length} أسئلة · راجعها ثم احفظ`;
  const list=document.getElementById('fp-list');
  // esc() إلزامية هنا — نص الأسئلة قد يكون مولَّداً بالذكاء الاصطناعي ومخزَّناً
  // بمخزن مشترك بين المستخدمين (question_bank بالخادم)؛ إدراجه خاماً بـinnerHTML
  // يفتح ثغرة XSS مخزَّنة حقيقية (خلافاً لشاشة اللعب الفعلية التي تستخدم
  // .textContent بشكل صحيح لنفس البيانات)
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
  showToast('👨‍👩‍👧‍👦','تم الحفظ!',`فئة "${previewData.name}" جاهزة`);
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
    row.innerHTML=`<div class="fm-radio ${i===manualDraft.correct?'on':''}" role="radio" tabindex="0" aria-checked="${i===manualDraft.correct}" aria-label="تعيين الخيار ${i+1} كإجابة صحيحة" onclick="setManualCorrect(${i})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();setManualCorrect(${i})}"></div>
      <input class="team-input" id="fm-o-${i}" placeholder="خيار ${i+1}" maxlength="60" style="flex:1;">`;
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
  document.getElementById('fm-added').textContent=`✅ أُضيف · لديك ${manualDraft.questions.length} أسئلة في "${name}" — أضف المزيد أو احفظ`;
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
  showToast('👨‍👩‍👧‍👦','تم الحفظ!',`فئة "${manualDraft.name}" جاهزة`);
  manualDraft={name:'', questions:[], correct:0};
  const sb=document.getElementById('fm-save-btn'); if(sb) sb.remove();
  document.getElementById('fm-name').value='';
  document.getElementById('fm-added').textContent='لم تُضف أسئلة بعد';
  renderManualOpts(); renderSavedFamily();
}

// ---- الفئات العائلية المحفوظة ----
function renderSavedFamily(){
  const box=document.getElementById('family-saved');
  if(!familyCats.length){ box.innerHTML=''; return; }
  box.innerHTML='<div class="field-label" style="margin-top:20px;">فئاتكم العائلية</div>'+
    familyCats.map((c,i)=>{
      const ready=c.questions.length>=FAMILY_MIN_QUESTIONS;
      const sub=ready ? `${c.questions.length} أسئلة` : `${c.questions.length}/${FAMILY_MIN_QUESTIONS} أسئلة — أضف المزيد لتلعب`;
      return `<div class="fsaved-chip">
      <div><div class="fc-info">👨‍👩‍👧‍👦 ${c.name}</div><div class="fc-sub">${sub}</div></div>
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
    `سيُحذف "${cat.name}" وكل أسئلتها (${cat.questions.length}) نهائياً ولا يمكن التراجع.`;
  document.getElementById('delete-family-modal').classList.add('show');
}
function closeDeleteFamilyModal(){
  sfx('tap');
  _pendingDeleteFamilyIdx=-1;
  document.getElementById('delete-family-modal').classList.remove('show');
}
function doDeleteFamily(){
  if(_pendingDeleteFamilyIdx<0) return;
  sfx('tap'); vibrate(20);
  familyCats.splice(_pendingDeleteFamilyIdx,1); saveFamily(); renderSavedFamily();
  _pendingDeleteFamilyIdx=-1;
  document.getElementById('delete-family-modal').classList.remove('show');
}

// جولة سريعة منفصلة بفئة عائلية واحدة
// اللوحة 6 خلايا (سؤال لكل مستوى صعوبة) — أقل من 6 أسئلة يعني تكرار نفس
// السؤال حرفياً على أكثر من خلية، فامنع اللعب واطلب إكمال العدد أولاً
const FAMILY_MIN_QUESTIONS = 6;
function playFamilyRound(i){
  const cat=familyCats[i];
  if(cat.questions.length<FAMILY_MIN_QUESTIONS){
    sfx('tap');
    showToast('✋','تحتاج المزيد من الأسئلة',
      `أضف ${FAMILY_MIN_QUESTIONS-cat.questions.length} سؤالاً آخر على الأقل بفئة "${cat.name}" حتى لا تتكرر الأسئلة باللوحة`, false);
    return;
  }
  sfx('start'); vibrate(30);
  // أنشئ فرقاً افتراضية سريعة (فريقان)
  state.teams=[
    {name:TEAM_STYLES[0].name, score:0, ll:3, used:new Set(), idx:0, bombUsed:false},
    {name:TEAM_STYLES[1].name, score:0, ll:3, used:new Set(), idx:1, bombUsed:false},
  ];
  state.teamCount=2;
  // فئة واحدة مكرّرة عبر الأعمدة الستة، أو استخدم الأسئلة المتاحة
  state.cats=[cat.name,cat.name,cat.name,cat.name,cat.name,cat.name];
  state.familyRound=cat; // علامة لسحب الأسئلة من الفئة العائلية
  state.usedQ=new Set();
  state.turn=0; state.answered=0; state.cells={};
  buildBoard(); renderTeamsBar(); renderTurn(); go('s-board');
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
  if(!bar) return;

  function setOffline(offline){
    bar.classList.toggle('show', offline);
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
  // اعرض واجهة مفيدة فوراً بدلاً من إبقاء اللاعب في شاشة تحميل أثناء انتظار
  // Firebase والخادم. لا يُفتح المحتوى المدفوع هنا؛ المشترك فقط يُنقل للرئيسية
  // بعد تحقق الخادم في الخلفية.
  go('s-paywall');
  void (async ()=>{
    const { uid } = await ensureAnonymousSession();
    window._currentUid = uid;
    const crashlytics=getCrashlytics();
    if(crashlytics && uid) crashlytics.setUserId({userId:uid}).catch(()=>{});
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
      }).catch(e=>console.warn('RevenueCat deferred startup:', (e && e.message) || e));
    }, 1800);
  })();
})();

// لا نعتمد على معاملات عودة دفع قديمة أو على cache محلي لمنح الصلاحية
// نستخدم uid المحفوظ مسبقاً في localStorage فقط (لا uid من URL)
(function clearLegacyPaymentReturn(){
  const p = new URLSearchParams(window.location.search);
  if(p.has('subscribed') || p.has('canceled')){
    window.history.replaceState({},'','/');
  }
})();
