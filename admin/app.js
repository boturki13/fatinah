const apiPath=path=>`/api/v2${path.slice(4)}`;
const state={questions:[],editing:null,dashboard:null};
const $=selector=>document.querySelector(selector);
const escapeHtml=value=>String(value??'').replace(/[&<>'"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
async function request(path,options={}){
  const response=await fetch(apiPath(path),{
    credentials:'same-origin',headers:{'Content-Type':'application/json',...(options.headers||{})},...options,
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok){const error=new Error(data.error||'تعذّر إكمال الطلب');error.data=data;throw error;}
  return data;
}
function showAuthenticated(authenticated){
  $('#login-view').hidden=authenticated;$('#dashboard-view').hidden=!authenticated;
  if(authenticated) void refreshAll();
}
function showSetupMode(enabled){
  $('#setup-pane').hidden=!enabled;$('#login-pane').hidden=enabled;
}
function passwordStrength(value){
  const checks=[value.length>=12,/[\p{L}]/u.test(value),/\d/u.test(value),/[^\p{L}\p{N}\s]/u.test(value),value.length>=16];
  return checks.filter(Boolean).length;
}
function renderPasswordStrength(){
  const value=$('#new-admin-password').value;const score=passwordStrength(value);
  const bar=$('#password-strength-bar');bar.style.width=`${score*20}%`;
  bar.style.background=score>=4?'var(--ok)':score>=3?'var(--gold)':'var(--danger)';
  $('#password-guidance').textContent=score>=4?'كلمة قوية وجاهزة للحفظ.':'١٢ خانة على الأقل، وتتضمن حرفاً ورقماً ورمزاً.';
}
function switchTab(name){
  document.querySelectorAll('.tab').forEach(tab=>tab.classList.toggle('active',tab.dataset.tab===name));
  for(const panel of ['questions','editor','reports']) $(`#${panel}-panel`).hidden=panel!==name;
}
function statusLabel(status){return({draft:'مسودة',review:'قيد التدقيق',approved:'معتمد',paused:'موقوف',rejected:'مرفوض',retired:'مؤرشف'})[status]||status;}
function renderDashboard(data){
  state.dashboard=data;const values=Object.values(data.approvedByLevel).map(Number);
  const total=values.reduce((sum,value)=>sum+value,0);const percent=Math.min(100,Math.round(total/6));
  $('#launch-ring').style.setProperty('--p',percent);$('#launch-ring span').textContent=`${percent}%`;
  $('#launch-copy').textContent=data.launchReady?'البنك يحقق الحد الأدنى لكل مستوى.':'لن يُعد البنك جاهزاً حتى يبلغ كل مستوى 100 سؤال معتمد.';
  $('#report-badge').textContent=data.openReports;
  $('#level-grid').innerHTML=values.map((value,index)=>`<article class="metric"><span>مستوى ${(index+1)*100}</span><strong>${value}<small>/100</small></strong><div class="progress"><i style="width:${Math.min(100,value)}%"></i></div></article>`).join('');
}
function renderQuestions(data){
  state.questions=data.items;$('#question-count').textContent=`${data.total} سؤال`;
  $('#question-list').innerHTML=data.items.length?data.items.map(question=>`<button class="question-row" type="button" data-edit="${escapeHtml(question.questionId)}"><span class="score">${question.quality.score}%</span><span><h3>${escapeHtml(question.prompt)}</h3><p>${escapeHtml(question.questionId)} · ${escapeHtml(question.topic)}</p></span><span class="pill ${question.status}">${statusLabel(question.status)}</span><span>${question.points} نقطة</span><span>${question.reportCount} بلاغ</span></button>`).join(''):'<p class="muted">لا توجد أسئلة مطابقة.</p>';
}
function optionMarkup(index){return `<label class="option-line"><input type="radio" name="correct" value="${index}" aria-label="الإجابة الصحيحة الخيار ${index+1}"><input class="option-input" data-index="${index}" required maxlength="240" placeholder="الخيار ${index+1}"></label>`;}
function reasonMarkup(index){return `<label>الخيار ${index+1}<textarea class="reason-input" data-index="${index}" rows="2" placeholder="اشرح سبب خطئه بوضوح"></textarea></label>`;}
function addSource(source={}){
  const row=document.createElement('div');row.className='source-row';
  row.innerHTML=`<input class="source-title" placeholder="اسم المصدر" value="${escapeHtml(source.title||'')}"><input class="source-url" type="url" placeholder="https://" value="${escapeHtml(source.url||'')}"><input class="source-license" placeholder="الترخيص" value="${escapeHtml(source.license||'')}"><button class="quiet danger remove-source" type="button">حذف</button>`;
  $('#sources-grid').appendChild(row);
}
function resetEditor(question=null){
  state.editing=question;$('#question-form').reset();$('#question-id').value=question?.questionId||'';
  $('#editor-title').textContent=question?question.questionId:'سؤال جديد';$('#prompt').value=question?.prompt||'';
  $('#level').value=String(question?.level||1);$('#topic').value=question?.topic||'';$('#correct-reason').value=question?.correctReason||'';
  document.querySelectorAll('.option-input').forEach((input,index)=>{input.value=question?.options?.[index]||'';});
  document.querySelectorAll('.reason-input').forEach((input,index)=>{input.value=question?.distractorReasons?.[index]||'';});
  const radio=document.querySelector(`input[name=correct][value="${question?.correctIndex??0}"]`);if(radio)radio.checked=true;
  $('#verification-notes').value=(question?.verificationNotes||[]).join('\n');$('#author').value=question?.author||'';$('#reviewer').value=question?.reviewer||'';
  $('#language-reviewed').checked=question?.languageReviewed===true;$('#ambiguity-checked').checked=question?.ambiguityChecked===true;$('#player-tested').checked=question?.playerTested===true;$('#safety-reviewed').checked=question?.safetyReviewed===true;$('#confidence-verified').checked=question?.confidenceStatus==='verified';
  $('#sources-grid').innerHTML='';for(const source of question?.sources?.length?question.sources:[{},{}])addSource(source);
  $('#retire-btn').hidden=!question;renderQuality(question?.quality);switchTab('editor');
}
function formData(status){return{questionId:$('#question-id').value||undefined,prompt:$('#prompt').value,level:Number($('#level').value),topic:$('#topic').value,options:[...document.querySelectorAll('.option-input')].map(input=>input.value),correctIndex:Number(document.querySelector('input[name=correct]:checked')?.value??-1),correctReason:$('#correct-reason').value,distractorReasons:[...document.querySelectorAll('.reason-input')].map(input=>input.value),sources:[...document.querySelectorAll('.source-row')].map(row=>({title:row.querySelector('.source-title').value,url:row.querySelector('.source-url').value,license:row.querySelector('.source-license').value})),verificationNotes:$('#verification-notes').value.split('\n').map(line=>line.trim()).filter(Boolean),author:$('#author').value,reviewer:$('#reviewer').value,languageReviewed:$('#language-reviewed').checked,ambiguityChecked:$('#ambiguity-checked').checked,playerTested:$('#player-tested').checked,safetyReviewed:$('#safety-reviewed').checked,confidenceStatus:$('#confidence-verified').checked?'verified':'pending',status};}
function renderQuality(quality){
  const value=quality||{score:0,ready:false,issues:[]};$('#quality-score').textContent=`${value.score}%`;
  $('#quality-issues').innerHTML=value.ready?'<div class="issue ok">✓ السؤال يجتاز جميع بوابات الجودة</div>':value.issues.map(issue=>`<div class="issue">${escapeHtml(issue.message)}</div>`).join('');
}
async function loadQuestions(){const query=new URLSearchParams({status:$('#status-filter').value,level:$('#level-filter').value,search:$('#question-search').value});renderQuestions(await request(`/api/admin/questions?${query}`));}
async function loadReports(){const data=await request('/api/admin/reports');$('#report-list').innerHTML=data.items.length?data.items.map(report=>`<details class="report-card"><summary>${report.resolved_at?'✓ ':''}${escapeHtml(report.question?.prompt)} · ${escapeHtml(report.reason)}</summary><div class="report-details"><span>المبلّغ: ${escapeHtml(report.reporter_name||report.uid)}</span><span>البريد: ${escapeHtml(report.reporter_email||'غير متوفر')}</span><span>حالة البريد: ${escapeHtml(report.email_status)}</span><p>${escapeHtml(report.details||'بلا تفاصيل')}</p>${report.resolved_at?'<span class="pill approved">تمت المعالجة</span>':`<button class="quiet" type="button" data-resolve="${escapeHtml(report.report_id)}">تعليم كمعالج</button>`}</div></details>`).join(''):'<p class="muted">لا توجد بلاغات.</p>';}
async function refreshAll(){try{const [dashboard]=await Promise.all([request('/api/admin/dashboard'),loadQuestions(),loadReports()]);renderDashboard(dashboard);}catch(error){if(error.data?.code==='admin_session_required')showAuthenticated(false);}}
$('#options-grid').innerHTML=[0,1,2,3].map(optionMarkup).join('');$('#reasons-grid').innerHTML=[0,1,2,3].map(reasonMarkup).join('');
document.querySelectorAll('[data-password-target]').forEach(button=>button.addEventListener('click',()=>{const input=$(`#${button.dataset.passwordTarget}`);const reveal=input.type==='password';input.type=reveal?'text':'password';button.textContent=reveal?'إخفاء':'إظهار';button.setAttribute('aria-label',`${reveal?'إخفاء':'إظهار'} كلمة الدخول`);}));
$('#new-admin-password').addEventListener('input',renderPasswordStrength);
$('#setup-form').addEventListener('submit',async event=>{event.preventDefault();
  if(location.protocol==='file:'){$('#setup-status').textContent='افتح اللوحة المحلية من الزر أعلاه أولاً حتى تُحفظ الكلمة في الخادم.';return;}
  const password=$('#new-admin-password').value;const confirmation=$('#confirm-admin-password').value;
  $('#setup-status').textContent='جاري الحفظ الآمن…';
  try{await request('/api/admin/setup',{method:'POST',body:JSON.stringify({password,confirmation})});
    $('#setup-form').reset();renderPasswordStrength();showSetupMode(false);$('#login-status').textContent='تم إنشاء كلمة الدخول. اكتبها الآن للدخول.';$('#admin-password').focus();
  }catch(error){$('#setup-status').textContent=error.message;}
});
$('#login-form').addEventListener('submit',async event=>{event.preventDefault();$('#login-status').textContent='جاري التحقق…';try{await request('/api/admin/login',{method:'POST',body:JSON.stringify({password:$('#admin-password').value})});$('#admin-password').value='';$('#login-status').textContent='';showAuthenticated(true);}catch(error){$('#login-status').textContent=error.message;}});
$('#logout-btn').addEventListener('click',async()=>{await request('/api/admin/logout',{method:'POST',body:'{}'}).catch(()=>{});showAuthenticated(false);});
$('#refresh-btn').addEventListener('click',refreshAll);document.querySelectorAll('.tab').forEach(tab=>tab.addEventListener('click',()=>switchTab(tab.dataset.tab)));
$('#new-question-btn').addEventListener('click',()=>resetEditor());$('#add-source-btn').addEventListener('click',()=>addSource());
$('#sources-grid').addEventListener('click',event=>{if(event.target.closest('.remove-source'))event.target.closest('.source-row').remove();});
$('#question-list').addEventListener('click',event=>{const id=event.target.closest('[data-edit]')?.dataset.edit;const question=state.questions.find(item=>item.questionId===id);if(question)resetEditor(question);});
$('#report-list').addEventListener('click',async event=>{const reportId=event.target.closest('[data-resolve]')?.dataset.resolve;if(!reportId)return;event.target.disabled=true;try{await request('/api/admin/report-status',{method:'POST',body:JSON.stringify({reportId,resolved:true})});await refreshAll();}catch(error){event.target.disabled=false;alert(error.message);}});
for(const filter of [$('#status-filter'),$('#level-filter')])filter.addEventListener('change',loadQuestions);let searchTimer;$('#question-search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(loadQuestions,250);});
$('#question-form').addEventListener('submit',async event=>{event.preventDefault();const status=event.submitter?.dataset.saveStatus||'draft';$('#editor-status').textContent='جاري الحفظ…';try{const saved=await request('/api/admin/questions',{method:'POST',body:JSON.stringify(formData(status))});state.editing=saved;$('#question-id').value=saved.questionId;$('#editor-title').textContent=saved.questionId;$('#retire-btn').hidden=false;renderQuality(saved.quality);$('#editor-status').textContent='تم الحفظ بنجاح';await refreshAll();}catch(error){renderQuality({score:0,issues:error.data?.issues||[{message:error.message}]});$('#editor-status').textContent=error.message;}});
$('#retire-btn').addEventListener('click',async()=>{if(!state.editing||!confirm('أرشفة السؤال وإيقافه عن الجولات الجديدة؟'))return;await request('/api/admin/question-status',{method:'POST',body:JSON.stringify({questionId:state.editing.questionId,status:'retired'})});switchTab('questions');await refreshAll();});
async function initializeAdmin(){
  if(location.protocol==='file:'){
    $('#file-guidance').hidden=false;showSetupMode(true);showAuthenticated(false);return;
  }
  try{
    const [session,setup]=await Promise.all([request('/api/admin/session'),request('/api/admin/setup-status')]);
    if(session.authenticated){showAuthenticated(true);return;}
    showAuthenticated(false);showSetupMode(!setup.configured&&setup.localSetupAllowed);
    if(!setup.configured&&!setup.localSetupAllowed)$('#login-status').textContent='يجب ضبط ADMIN_SECRET في إعدادات الخادم.';
  }catch(error){showAuthenticated(false);showSetupMode(false);$('#login-status').textContent='تعذر الاتصال بخادم لوحة الجودة.';}
}
initializeAdmin();
