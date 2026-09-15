/* محرك جولات 1.4: بلا فئات، وبإجابات متتابعة مخفية. */
(()=>{
'use strict';

const PLAYER_COLORS=['#ff4778','#56ddc1','#b794ff'];
const ARABIC_DIGITS='٠١٢٣٤٥٦٧٨٩';
const PACK_SCHEMA=1;
const modernGame={
  playerCount:2,questionsPerPlayer:10,players:[],pack:null,index:0,
  current:null,answerOrder:[],answerPosition:0,answers:[],eliminated:new Set(),
  doubled:false,phase:'idle',timer:null,timeLeft:30,outcomes:[],usedReplacementIds:[],
  transitionTimer:null,startedAt:0,starting:false,reportQuestion:null,
};

const byId=id=>document.getElementById(id);
const ar=value=>String(value).replace(/\d/g,digit=>ARABIC_DIGITS[Number(digit)]);
const cleanName=(value,index)=>String(value||'').trim().slice(0,24)||`لاعب ${ar(index+1)}`;
const queueKey=uid=>scopedAccessKey('encrypted_game_packs_v1',uid);
const pendingCompletionKey=uid=>scopedAccessKey('game_completion_outbox_v1',uid);
const securityContext=uid=>`${String(uid||'guest').slice(0,128)}|fatinah-game-packs-v1`;

function validPack(pack,players,questions){
  if(!pack||pack.schemaVersion!==PACK_SCHEMA||typeof pack.packId!=='string') return false;
  if(pack.playerCount!==players||pack.questionsPerPlayer!==questions||pack.timerSeconds!==30) return false;
  if(!Array.isArray(pack.questions)||pack.questions.length!==players*questions) return false;
  if(!pack.replacements||typeof pack.replacements!=='object') return false;
  return pack.questions.every(question=>validQuestion(question,players));
}
function validQuestion(question,players){
  return !!question&&typeof question.questionId==='string'&&typeof question.question==='string'
    &&Array.isArray(question.options)&&question.options.length===4
    &&question.options.every(value=>typeof value==='string'&&value.trim())
    &&new Set(question.options).size===4
    &&Number.isInteger(question.correctIndex)&&question.correctIndex>=0&&question.correctIndex<4
    &&Number.isInteger(question.level)&&question.level>=1&&question.level<=6
    &&question.points===question.level*100
    &&Number.isInteger(question.ownerIndex)&&question.ownerIndex>=0&&question.ownerIndex<players
    &&question.sources===undefined&&question.source===undefined;
}

async function webCryptoKey(){
  if(!globalThis.crypto?.subtle||!globalThis.indexedDB) throw new Error('secure_storage_unavailable');
  const database=await new Promise((resolve,reject)=>{
    const request=indexedDB.open('fatinah-secure-storage',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('keys');
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  const read=()=>new Promise((resolve,reject)=>{
    const request=database.transaction('keys','readonly').objectStore('keys').get('game-packs-v1');
    request.onsuccess=()=>resolve(request.result||null);request.onerror=()=>reject(request.error);
  });
  let key=await read();
  if(!key){
    key=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    await new Promise((resolve,reject)=>{
      const request=database.transaction('keys','readwrite').objectStore('keys').put(key,'game-packs-v1');
      request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error);
    });
  }
  database.close();return key;
}
function bytesToBase64(bytes){
  let binary='';for(let offset=0;offset<bytes.length;offset+=0x8000){
    binary+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));
  }
  return btoa(binary);
}
function base64ToBytes(value){
  const binary=atob(value);const result=new Uint8Array(binary.length);
  for(let index=0;index<binary.length;index++) result[index]=binary.charCodeAt(index);
  return result;
}
async function sealForDevice(value,uid){
  const plaintext=JSON.stringify(value);const context=securityContext(uid);
  const native=window.Capacitor?.Plugins?.FatinahSecureGamePack;
  if(native){
    const result=await native.seal({plaintext,context});
    if(!result?.sealed) throw new Error('secure_storage_failed');
    return {provider:'ios-keychain-aesgcm',sealed:result.sealed};
  }
  const key=await webCryptoKey();const nonce=crypto.getRandomValues(new Uint8Array(12));
  const encoded=new TextEncoder();
  const encrypted=await crypto.subtle.encrypt(
    {name:'AES-GCM',iv:nonce,additionalData:encoded.encode(context)},key,encoded.encode(plaintext));
  return {provider:'webcrypto-aesgcm',nonce:bytesToBase64(nonce),sealed:bytesToBase64(new Uint8Array(encrypted))};
}
async function openForDevice(envelope,uid){
  if(!envelope||typeof envelope!=='object') return null;
  const context=securityContext(uid);let plaintext='';
  if(envelope.provider==='ios-keychain-aesgcm'){
    const native=window.Capacitor?.Plugins?.FatinahSecureGamePack;
    if(!native) return null;
    plaintext=(await native.open({sealed:envelope.sealed,context}))?.plaintext||'';
  }else if(envelope.provider==='webcrypto-aesgcm'){
    const key=await webCryptoKey();const encoded=new TextEncoder();
    const decrypted=await crypto.subtle.decrypt({
      name:'AES-GCM',iv:base64ToBytes(envelope.nonce),additionalData:encoded.encode(context),
    },key,base64ToBytes(envelope.sealed));
    plaintext=new TextDecoder().decode(decrypted);
  }
  return plaintext?JSON.parse(plaintext):null;
}
async function loadPackQueue(uid){
  const envelope=storeGet(queueKey(uid),null);if(!envelope) return [];
  try{
    const value=await openForDevice(envelope,uid);
    return Array.isArray(value?.packs)?value.packs:[];
  }catch(error){
    storeRemove(queueKey(uid));recordNonFatal(error,'game-packs.decrypt');return [];
  }
}
async function savePackQueue(uid,packs){
  if(!packs.length){storeRemove(queueKey(uid));return;}
  const envelope=await sealForDevice({schemaVersion:1,packs,savedAt:new Date().toISOString()},uid);
  storeSet(queueKey(uid),envelope);
}

async function gameRequest(path,payload,{timeoutMs=18000}={}){
  if(typeof window.__FATINAH_GAME_API__==='function') return window.__FATINAH_GAME_API__(path,payload);
  const uid=String(window._currentUid||storeGet('authUid','')||'');
  const idToken=await getCurrentIdToken();
  if(!uid||!idToken) throw Object.assign(new Error('انتهت جلسة الدخول'),{code:'player_auth_required'});
  const response=await apiFetch(`/api/v2/game/${path}`,{
    method:'POST',timeoutMs,headers:{'Content-Type':'application/json','Authorization':`Bearer ${idToken}`},
    body:JSON.stringify({uid,idToken,...payload}),
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw Object.assign(new Error(data.error||'تعذّر إكمال الطلب'),{code:data.code,status:response.status,data});
  return data;
}

function setModernPlayerCount(count){
  const value=Math.max(1,Math.min(3,Number(count)||2));modernGame.playerCount=value;
  document.querySelectorAll('#seg-players button').forEach(button=>{
    const selected=Number(button.dataset.n)===value;
    button.classList.toggle('on',selected);button.setAttribute('aria-pressed',String(selected));
  });
  renderModernNames();updateModernQuestionSummary();sfx('tap');
}
function setModernQuestionCount(value){
  modernGame.questionsPerPlayer=Math.max(10,Math.min(30,Number(value)||10));
  byId('modern-question-count-label').textContent=ar(modernGame.questionsPerPlayer);
  updateModernQuestionSummary();
}
function updateModernQuestionSummary(){
  const total=modernGame.playerCount*modernGame.questionsPerPlayer;
  byId('modern-question-summary').textContent=`إجمالي ${ar(total)} سؤال · ٣٠ ثانية لكل إجابة`;
}
function renderModernNames(){
  const container=byId('modern-player-names');if(!container)return;
  const previous=[...container.querySelectorAll('input')].map(input=>input.value);
  container.innerHTML='<div class="field-label">أسماء اللاعبين</div>';
  for(let index=0;index<modernGame.playerCount;index++){
    const row=document.createElement('div');row.className='team-row';
    const defaultName=index===0?(storeGet('playerName','')||`لاعب ${ar(index+1)}`):`لاعب ${ar(index+1)}`;
    row.innerHTML=`<div class="dot" style="background:${PLAYER_COLORS[index]};color:${PLAYER_COLORS[index]}"></div><input class="team-input" id="modern-player-${index}" aria-label="اسم اللاعب ${ar(index+1)}" maxlength="24">`;
    row.querySelector('input').value=previous[index]||defaultName;container.appendChild(row);
  }
}
function setupPlayers(){
  const players=[];const seen=new Set();
  for(let index=0;index<modernGame.playerCount;index++){
    const input=byId(`modern-player-${index}`);const name=cleanName(input?.value,index);
    if(seen.has(name)){shakeField(input.id);showToast('✏️','الأسماء متشابهة','حط اسم مختلف لكل لاعب',false);return null;}
    seen.add(name);players.push({name,score:0,lifelines:{phone:false,eliminate:false,change:false,double:false}});
  }
  return players;
}
function bankErrorCopy(error){
  if(error?.code==='question_bank_not_ready') return ['📚','بنك الأسئلة قيد التجهيز','نبني المخزون الموثّق حالياً. الجولة ما بدت وما راح تنحسب.'];
  if(!navigator.onLine) return ['📶','ماكو اتصال','أول تحميل يحتاج النت؛ بعدها تكون الجولات جاهزة على الجهاز.'];
  if(error?.code==='player_auth_required') return ['🔐','انتهت جلسة الدخول','سجّل دخولك مرة ثانية وجرّب.'];
  return ['⚠️','ما قدرنا نجهّز الجولة','جرّب مرة ثانية، وإذا استمرت المشكلة تواصل مع الدعم.'];
}
async function ensureQueue(uid,players,questions,target=2){
  let queue=(await loadPackQueue(uid)).filter(pack=>validPack(pack,players,questions)&&new Date(pack.expiresAt).getTime()>Date.now());
  if(queue.length>=target)return queue;
  const result=await gameRequest('packs/ensure',{playerCount:players,questionsPerPlayer:questions,target});
  const byPack=new Map(queue.map(pack=>[pack.packId,pack]));
  for(const pack of result.packs||[])if(validPack(pack,players,questions))byPack.set(pack.packId,pack);
  queue=[...byPack.values()];await savePackQueue(uid,queue);return queue;
}
async function prefetchTwo(uid){
  try{
    const result=await gameRequest('packs/ensure',{playerCount:modernGame.playerCount,questionsPerPlayer:modernGame.questionsPerPlayer,target:2});
    const current=await loadPackQueue(uid);const map=new Map(current.map(pack=>[pack.packId,pack]));
    for(const pack of result.packs||[])if(validPack(pack,modernGame.playerCount,modernGame.questionsPerPlayer))map.set(pack.packId,pack);
    await savePackQueue(uid,[...map.values()]);
  }catch(error){recordNonFatal(error,'game-packs.prefetch');}
}
function packClaimKey(uid){return scopedAccessKey('game_pack_claim_pending',uid);}
function pendingPackClaim(uid){
  const value=storeGet(packClaimKey(uid),null);
  return value?.playerCount===modernGame.playerCount&&value?.questionsPerPlayer===modernGame.questionsPerPlayer?value:null;
}
async function savePendingPackClaim(uid){
  const value={playerCount:modernGame.playerCount,questionsPerPlayer:modernGame.questionsPerPlayer,claimConfirmed:false,createdAt:Date.now()};
  storeSet(packClaimKey(uid),value);
  try{await window.Capacitor?.Plugins?.Preferences?.set?.({key:`fatinah_${packClaimKey(uid)}`,value:JSON.stringify(value)});}catch(error){recordNonFatal(error,'game-pack.claim-pending');}
}
async function confirmPendingPackClaim(uid){
  const current=pendingPackClaim(uid);if(!current)return;
  const value={...current,claimConfirmed:true};storeSet(packClaimKey(uid),value);
  try{await window.Capacitor?.Plugins?.Preferences?.set?.({key:`fatinah_${packClaimKey(uid)}`,value:JSON.stringify(value)});}catch(error){recordNonFatal(error,'game-pack.claim-confirmed');}
}
async function clearPendingPackClaim(uid){
  storeRemove(packClaimKey(uid));
  try{await window.Capacitor?.Plugins?.Preferences?.remove?.({key:`fatinah_${packClaimKey(uid)}`});}catch(error){recordNonFatal(error,'game-pack.claim-pending');}
}
function canStartModernRound(uid,testHarness){
  if(testHarness||_hasActiveSubscription||isLocalWebPreview()||pendingPackClaim(uid))return true;
  if(_freeRoundVerificationPending){showToast('⏳','لحظة ونتأكد','جاري التحقق من جولتك المجانية',false);return false;}
  if(_freeRoundAvailable&&_freeRoundVerificationState==='eligible')return true;
  go('s-paywall');return false;
}
async function startModernGame(){
  if(modernGame.starting||modernGame.phase!=='idle'&&modernGame.phase!=='finished')return;
  const players=setupPlayers();const testHarness=typeof window.__FATINAH_GAME_API__==='function';
  const uid=String(window._currentUid||storeGet('authUid','')||'');
  if(!players||!canStartModernRound(uid,testHarness))return;
  const button=byId('modern-start-btn');modernGame.starting=true;button.disabled=true;button.textContent='ثواني ونجهّز جولتك…';
  try{
    const startsFree=!_hasActiveSubscription;
    const claimState=pendingPackClaim(uid);
    let queue=await loadPackQueue(uid);
    queue=queue.filter(pack=>validPack(pack,modernGame.playerCount,modernGame.questionsPerPlayer)&&new Date(pack.expiresAt).getTime()>Date.now());
    if(!queue.length){
      if(startsFree&&!testHarness&&claimState?.claimConfirmed!==true){
        if(!claimState){
          const readiness=await gameRequest('packs/readiness',{});
          if(readiness?.ready!==true)throw Object.assign(new Error('question_bank_not_ready'),{code:'question_bank_not_ready'});
          await savePendingPackClaim(uid);
        }
        const claimed=await claimFreeRound(uid);
        if(claimed===true)await confirmPendingPackClaim(uid);
        else if(claimed===false){
          // A lost response may mean the server already recorded the claim. The
          // pack endpoint is authoritative and only permits one free pack.
          try{queue=await ensureQueue(uid,modernGame.playerCount,modernGame.questionsPerPlayer,1);}
          catch(error){await clearPendingPackClaim(uid);go('s-paywall');return;}
        }else throw new Error('free_round_claim_failed');
      }
      if(!queue.length)queue=await ensureQueue(uid,modernGame.playerCount,modernGame.questionsPerPlayer,startsFree?1:2);
    }
    const pack=queue.shift();if(!pack)throw Object.assign(new Error('question_bank_not_ready'),{code:'question_bank_not_ready'});
    await savePackQueue(uid,queue);
    try{await gameRequest('packs/start',{packId:pack.packId});}catch(error){
      if(navigator.onLine)throw error;recordNonFatal(error,'game-pack.start-offline');
    }
    modernGame.players=players;modernGame.pack=pack;modernGame.index=0;modernGame.outcomes=[];modernGame.usedReplacementIds=[];modernGame.startedAt=Date.now();modernGame.phase='answering';
    if(startsFree&&!testHarness)await clearPendingPackClaim(uid);
    state.roundActive=true;keepAwakeOn();go('s-modern-game');openModernQuestion();
    void trackMetric('game_started',{difficulty:'normal',teams:players.length,categoryCount:0,freeRound:startsFree,familyRound:false});
    if(queue.length===0&&!startsFree)void prefetchTwo(uid);
  }catch(error){
    if(error?.code==='introductory_round_consumed'||error?.code==='subscription_or_free_round_required'){
      await clearPendingPackClaim(uid);go('s-paywall');return;
    }
    const [icon,title,copy]=bankErrorCopy(error);showToast(icon,title,copy,false);recordNonFatal(error,'modern-game.start');
  }
  finally{modernGame.starting=false;button.disabled=false;button.textContent='🎯 ابدأ الجولة';}
}

function openModernQuestion(){
  clearTimeout(modernGame.transitionTimer);modernGame.transitionTimer=null;
  const question=modernGame.pack?.questions?.[modernGame.index];if(!question){finishModernGame();return;}
  modernGame.current=question;modernGame.answerOrder=Array.from({length:modernGame.playerCount},(_,offset)=>(question.ownerIndex+offset)%modernGame.playerCount);
  modernGame.answerPosition=0;modernGame.answers=[];modernGame.eliminated=new Set();modernGame.doubled=false;modernGame.phase='answering';
  byId('modern-next-btn').hidden=true;byId('modern-reveal').hidden=true;byId('modern-waiting').hidden=true;
  renderModernQuestion();startModernTimer();
}
function renderModernQuestion(){
  const question=modernGame.current;const answering=modernGame.answerOrder[modernGame.answerPosition];
  document.documentElement.style.setProperty('--player-color',PLAYER_COLORS[answering]);
  byId('modern-question').textContent=question.question;byId('modern-level').textContent=ar(question.points);
  byId('modern-progress-copy').textContent=`السؤال ${ar(modernGame.index+1)} من ${ar(modernGame.pack.questions.length)}`;
  byId('modern-progress-bar').style.width=`${((modernGame.index+1)/modernGame.pack.questions.length)*100}%`;
  byId('modern-owner-pill').textContent=`سؤال ${modernGame.players[question.ownerIndex].name}`;
  byId('modern-answering-pill').textContent=`الحين ${modernGame.players[answering].name}`;
  byId('modern-options').innerHTML=question.options.map((option,index)=>`<button class="modern-option${modernGame.eliminated.has(index)?' eliminated':''}" ${modernGame.eliminated.has(index)?'disabled':''} data-action="modern-answer" data-option-index="${index}"><b>${ar(index+1)}</b>${esc(option)}</button>`).join('');
  renderModernScoreboard();renderModernLifelines();
}
function renderModernScoreboard(){
  const owner=modernGame.current?.ownerIndex??-1;const board=byId('modern-scoreboard');
  board.style.setProperty('--players',modernGame.players.length);
  board.innerHTML=modernGame.players.map((player,index)=>`<div class="modern-score${index===owner?' owner':''}" style="--player-color:${PLAYER_COLORS[index]}"><span>${esc(player.name)}</span><strong>${ar(player.score)}</strong></div>`).join('');
}
function renderModernLifelines(){
  const owner=modernGame.current.ownerIndex;const answering=modernGame.answerOrder[modernGame.answerPosition];const mayUse=modernGame.phase==='answering'&&answering===owner;
  document.querySelectorAll('#modern-lifelines button').forEach(button=>{
    const name=button.dataset.lifeline;const used=modernGame.players[owner].lifelines[name];
    button.disabled=!mayUse||used;button.classList.toggle('active',name==='double'&&modernGame.doubled);
    button.setAttribute('aria-label',`${button.textContent.trim()}${used?' — استخدمت':''}`);
  });
}
function startModernTimer(){
  clearInterval(modernGame.timer);modernGame.timeLeft=30;renderModernTimer();
  modernGame.timer=setInterval(()=>{
    modernGame.timeLeft-=1;renderModernTimer();if(modernGame.timeLeft<=5&&modernGame.timeLeft>0)sfx('tick');
    if(modernGame.timeLeft<=0){clearInterval(modernGame.timer);submitModernAnswer(null,true);}
  },1000);
}
function renderModernTimer(){
  byId('modern-timer-value').textContent=ar(Math.max(0,modernGame.timeLeft));
  byId('modern-timer-bar').style.height=`${Math.max(0,modernGame.timeLeft)/30*100}%`;
}
function lockModernChoice(optionIndex){
  document.querySelectorAll('#modern-options .modern-option').forEach((button,index)=>{
    button.disabled=true;
    const selected=index===optionIndex;
    button.classList.toggle('locked-choice',selected);
    button.setAttribute('aria-pressed',String(selected));
  });
  renderModernLifelines();
}
function submitModernAnswer(optionIndex,timedOut=false){
  if(modernGame.phase!=='answering')return;
  if(optionIndex!==null&&(!Number.isInteger(optionIndex)||optionIndex<0||optionIndex>3||modernGame.eliminated.has(optionIndex)))return;
  clearInterval(modernGame.timer);modernGame.phase='locked';
  const playerIndex=modernGame.answerOrder[modernGame.answerPosition];
  modernGame.answers.push({playerIndex,optionIndex,timedOut,optionText:optionIndex===null?'':modernGame.current.options[optionIndex]});
  lockModernChoice(optionIndex);
  const nextPosition=modernGame.answerPosition+1;
  const hasNext=nextPosition<modernGame.answerOrder.length;
  const waiting=byId('modern-waiting');waiting.hidden=false;
  waiting.textContent=hasNext
    ?`تمّ تثبيت إجابة ${modernGame.players[playerIndex].name}. الدور الحين لـ ${modernGame.players[modernGame.answerOrder[nextPosition]].name}`
    :`تمّ تثبيت إجابة ${modernGame.players[playerIndex].name}. نعرض الحل…`;
  clearTimeout(modernGame.transitionTimer);
  modernGame.transitionTimer=setTimeout(()=>{
    modernGame.transitionTimer=null;modernGame.answerPosition=nextPosition;waiting.hidden=true;
    if(hasNext){modernGame.phase='answering';renderModernQuestion();startModernTimer();}
    else revealModernAnswer();
  },650);
}
function revealModernAnswer(){
  clearInterval(modernGame.timer);modernGame.phase='reveal';const question=modernGame.current;const owner=question.ownerIndex;
  const answers=new Map(modernGame.answers.map(answer=>[answer.playerIndex,answer]));let winner=-1;let penalty=0;
  const ownerAnswer=answers.get(owner);const ownerCorrect=ownerAnswer?.optionIndex===question.correctIndex;
  if(modernGame.doubled){
    if(ownerCorrect){winner=owner;modernGame.players[owner].score+=question.points*2;}
    else{penalty=question.points*2;modernGame.players[owner].score-=penalty;}
  }
  if(winner<0){
    for(const playerIndex of modernGame.answerOrder){
      if(playerIndex===owner&&modernGame.doubled)continue;
      if(answers.get(playerIndex)?.optionIndex===question.correctIndex){winner=playerIndex;modernGame.players[playerIndex].score+=question.points;break;}
    }
  }
  document.querySelectorAll('#modern-options .modern-option').forEach((button,index)=>{
    button.disabled=true;button.classList.remove('locked-choice');button.removeAttribute('aria-pressed');
    button.classList.toggle('correct',index===question.correctIndex);
    const selectedWrong=modernGame.answers.some(answer=>answer.optionIndex===index)&&index!==question.correctIndex;
    button.classList.toggle('wrong',selectedWrong);
  });
  const result=winner>=0
    ?`<strong>${esc(modernGame.players[winner].name)} أخذ ${ar(winner===owner&&modernGame.doubled?question.points*2:question.points)} نقطة</strong>`
    :'<span>ما حد أخذ نقاط السؤال</span>';
  const penaltyCopy=penalty?`<div class="loss">انخصم من ${esc(modernGame.players[owner].name)} ${ar(penalty)} نقطة</div>`:'';
  const selections=modernGame.answers.map(answer=>`${esc(modernGame.players[answer.playerIndex].name)}: ${answer.timedOut?'انتهى الوقت':esc(answer.optionText)}`).join('<br>');
  const reveal=byId('modern-reveal');reveal.innerHTML=`الإجابة: <strong>${esc(question.options[question.correctIndex])}</strong><hr>${result}${penaltyCopy}<small>${selections}</small><br><button class="btn btn-ghost" data-action="open-modern-report" style="margin-top:10px">🚩 بلاغ عن السؤال</button>`;reveal.hidden=false;
  modernGame.outcomes.push({questionId:question.questionId,answeredCorrectly:winner>=0,winnerIndex:winner});
  stats.totalQ+=modernGame.players.length;if(winner>=0)stats.correct+=1;saveStats();renderModernScoreboard();renderModernLifelines();
  byId('modern-next-btn').hidden=false;sfx(winner>=0?'correct':'wrong');vibrate(winner>=0?[15,10,15]:30);
}
function useModernLifeline(name){
  if(modernGame.phase!=='answering')return;const owner=modernGame.current.ownerIndex;
  if(modernGame.answerOrder[modernGame.answerPosition]!==owner||modernGame.players[owner].lifelines[name])return;
  if(name==='change'){
    const replacement=modernGame.pack.replacements?.[`${owner}:${modernGame.current.level}`];
    if(!replacement||!validQuestion(replacement,modernGame.playerCount)){showToast('⚠️','ماكو بديل جاهز','كمّل بالسؤال الحالي',false);return;}
    modernGame.players[owner].lifelines.change=true;modernGame.usedReplacementIds.push(replacement.questionId);
    modernGame.current={...replacement,ownerQuestionNumber:modernGame.current.ownerQuestionNumber};modernGame.pack.questions[modernGame.index]=modernGame.current;
    modernGame.answers=[];modernGame.answerPosition=0;modernGame.eliminated=new Set();modernGame.doubled=false;renderModernQuestion();startModernTimer();showToast('🔄','تغيّر السؤال','سؤال يديد من نفس المستوى',false);return;
  }
  modernGame.players[owner].lifelines[name]=true;
  if(name==='phone')showToast('📱','ابحث بالهاتف','كمّل إجابتك قبل نهاية الـ ٣٠ ثانية',false);
  if(name==='eliminate'){
    const wrong=[0,1,2,3].filter(index=>index!==modernGame.current.correctIndex).sort(()=>Math.random()-.5);
    modernGame.eliminated=new Set(wrong.slice(0,2));renderModernQuestion();
  }
  if(name==='double'){modernGame.doubled=true;renderModernLifelines();showToast('×٢','دبل النقاط','الصح: دبل · الغلط أو انتهاء الوقت: خصم دبل',false);}
  renderModernLifelines();
}
function modernNext(){if(modernGame.phase!=='reveal')return;modernGame.index+=1;openModernQuestion();}
async function finishModernGame(){
  clearInterval(modernGame.timer);clearTimeout(modernGame.transitionTimer);modernGame.transitionTimer=null;keepAwakeOff();modernGame.phase='finished';state.roundActive=false;
  const scores=modernGame.players.map(player=>player.score);const high=Math.max(...scores);const winners=modernGame.players.filter(player=>player.score===high);
  byId('winner-line').textContent=winners.length===1?`🏆 ${winners[0].name} هو الفايز!`:`🏆 تعادل: ${winners.map(player=>player.name).join(' و ')}`;
  byId('modern-podium').innerHTML=[...modernGame.players].sort((a,b)=>b.score-a.score).map((player,index)=>`<div class="modern-score-result"><span>${index===0?'👑':'🎯'} ${esc(player.name)}</span><strong>${ar(player.score)} نقطة</strong></div>`).join('');
  stats.games+=1;stats.bestScore=Math.max(stats.bestScore,high);if(winners.length===1)stats.wins+=1;checkAchievements();saveStats();go('s-result');sfx('win');
  const durationSeconds=Math.max(0,Math.round((Date.now()-modernGame.startedAt)/1000));
  void trackMetric('game_completed',{difficulty:'normal',teams:modernGame.players.length,categoryCount:0,questions:modernGame.pack.questions.length,correct:modernGame.outcomes.filter(item=>item.answeredCorrectly).length,incorrect:modernGame.outcomes.filter(item=>!item.answeredCorrectly).length,durationSeconds,topScore:high,tie:winners.length>1,freeRound:!_hasActiveSubscription});
  await completeModernPack();
}
async function completeModernPack(){
  if(!modernGame.pack)return;const uid=String(window._currentUid||storeGet('authUid','')||'');
  const payload={packId:modernGame.pack.packId,usedReplacementIds:modernGame.usedReplacementIds,outcomes:modernGame.outcomes};
  try{await gameRequest('packs/complete',payload);storeSet(pendingCompletionKey(uid),null);}
  catch(error){storeSet(pendingCompletionKey(uid),payload);recordNonFatal(error,'game-pack.complete');}
}
async function flushModernCompletion(){
  const uid=String(window._currentUid||storeGet('authUid','')||'');const payload=storeGet(pendingCompletionKey(uid),null);if(!payload)return;
  try{await gameRequest('packs/complete',payload);storeRemove(pendingCompletionKey(uid));}catch(_){/* يبقى في صندوق الإرسال */}
}
function confirmModernExit(){openAccessibleModal('exit-modal');}
function exitModernGame(){
  clearInterval(modernGame.timer);clearTimeout(modernGame.transitionTimer);modernGame.transitionTimer=null;keepAwakeOff();state.roundActive=false;closeAccessibleModal('exit-modal',{restoreFocus:false});
  void completeModernPack();modernGame.phase='idle';go('s-home');
}
function openModernReport(){modernGame.reportQuestion=modernGame.current;byId('modern-report-details').value='';byId('modern-report-status').textContent='';openAccessibleModal('modern-report-modal','#modern-report-reason');}
function closeModernReport(){closeAccessibleModal('modern-report-modal');}
async function sendModernReport(){
  const status=byId('modern-report-status');status.textContent='جاري الإرسال…';
  try{
    await gameRequest('questions/report',{questionId:modernGame.reportQuestion.questionId,reason:byId('modern-report-reason').value,details:byId('modern-report-details').value,selections:modernGame.answers});
    status.textContent='تم البلاغ، مشكور على مساعدتنا 🙏';setTimeout(closeModernReport,900);
  }catch(error){status.textContent=navigator.onLine?'ما قدرنا نرسله الحين، جرّب مرة ثانية.':'البلاغ يحتاج اتصال بالنت.';}
}
function modernNewGame(){modernGame.phase='idle';go('s-teams');renderModernNames();void flushModernCompletion();}
function modernResultHome(){modernGame.phase='idle';go('s-home');void flushModernCompletion();}

UI_CLICK_ACTIONS.set('set-modern-player-count',element=>setModernPlayerCount(boundedActionInteger(element,'n',1,3)));
UI_CLICK_ACTIONS.set('start-modern-game',()=>startModernGame());
UI_CLICK_ACTIONS.set('modern-answer',element=>submitModernAnswer(boundedActionInteger(element,'optionIndex',0,3)));
UI_CLICK_ACTIONS.set('modern-lifeline',element=>useModernLifeline(String(element.dataset.lifeline||'')));
UI_CLICK_ACTIONS.set('modern-next',()=>modernNext());
UI_CLICK_ACTIONS.set('confirm-modern-exit',()=>confirmModernExit());
UI_CLICK_ACTIONS.set('exit-round',()=>modernGame.phase==='answering'||modernGame.phase==='reveal'?exitModernGame():doExit());
UI_CLICK_ACTIONS.set('close-exit-modal',()=>closeAccessibleModal('exit-modal'));
UI_CLICK_ACTIONS.set('open-modern-report',()=>openModernReport());
UI_CLICK_ACTIONS.set('close-modern-report',()=>closeModernReport());
UI_CLICK_ACTIONS.set('send-modern-report',()=>sendModernReport());
UI_CLICK_ACTIONS.set('modern-new-game',()=>modernNewGame());
UI_CLICK_ACTIONS.set('modern-result-home',()=>modernResultHome());
document.addEventListener('input',event=>{if(event.target?.dataset?.inputAction==='set-modern-question-count')setModernQuestionCount(event.target.value);});

renderModernNames();setModernQuestionCount(byId('modern-question-count')?.value||10);
window.addEventListener('online',()=>void flushModernCompletion());
window.FatinahModernGame=Object.freeze({difficultySequence:count=>{
  const base=Math.floor(count/6),remainder=count%6,result=[];
  for(let level=1;level<=6;level++)for(let index=0;index<base+(level<=remainder?1:0);index++)result.push(level);
  return result;
},state:modernGame});
})();
