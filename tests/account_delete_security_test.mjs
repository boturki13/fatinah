import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const url=`file://${path.join(root,'www/index.html')}`;
const uid='delete-security-user';

function installDeleteHarness({uid,provider}){
  window.__FATINAH_GAME_FLOW_UI_TEST__=true;
  localStorage.setItem('fatinah_authUid',JSON.stringify(uid));
  localStorage.setItem('fatinah_authProvider',JSON.stringify(provider));
  localStorage.setItem('fatinah_authEmail',JSON.stringify('delete@example.invalid'));
  localStorage.setItem('fatinah_onbDone',JSON.stringify(true));
  window.__firebaseUser={
    uid,email:'delete@example.invalid',isAnonymous:provider==='anonymous',
    providerData:[{providerId:provider==='password'?'password':provider}],
  };
  window.__reauthResultUid=uid;
  window.__holdPasswordReauth=false;
  window.__completePasswordReauth=null;
  window.__deleteCalls={
    order:[],reauthPasswordPresent:false,reauthEmails:[],deleteCount:0,
    googleSignIn:0,appleSignIn:0,
  };
  const ok=()=>Promise.resolve({});
  window.Capacitor={
    isNativePlatform:()=>true,
    Plugins:{
      FirebaseAuthentication:{
        getCurrentUser:()=>Promise.resolve({user:window.__firebaseUser}),
        getIdToken:({forceRefresh}={})=>{
          if(forceRefresh) window.__deleteCalls.order.push('token:force');
          return Promise.resolve({token:'fresh-delete-token'});
        },
        signInWithEmailAndPassword:({email,password})=>{
          window.__deleteCalls.order.push('reauth');
          window.__deleteCalls.reauthEmails.push(email);
          window.__deleteCalls.reauthPasswordPresent=typeof password==='string'&&password.length>0;
          const result={user:{...window.__firebaseUser,uid:window.__reauthResultUid}};
          if(!window.__holdPasswordReauth) return Promise.resolve(result);
          return new Promise((resolve,reject)=>{
            window.__completePasswordReauth=shouldReject=>{
              window.__holdPasswordReauth=false;
              window.__completePasswordReauth=null;
              if(shouldReject) reject(new Error('auth/wrong-password'));
              else resolve(result);
            };
          });
        },
        signInWithGoogle:()=>{
          window.__deleteCalls.googleSignIn++;
          window.__deleteCalls.order.push('google-signin');
          return Promise.resolve({user:{...window.__firebaseUser,uid:'silently-switched-google'}});
        },
        signInWithApple:()=>{
          window.__deleteCalls.appleSignIn++;
          window.__deleteCalls.order.push('apple-signin');
          return Promise.resolve({user:{...window.__firebaseUser,uid:'silently-switched-apple'}});
        },
        deleteUser:()=>{
          window.__deleteCalls.order.push('firebase-delete');
          window.__deleteCalls.deleteCount++;
          window.__firebaseUser=null;
          return Promise.resolve();
        },
        signOut:()=>{ window.__deleteCalls.order.push('signout'); return Promise.resolve(); },
      },
      RevenueCatKeyStore:{get:()=>Promise.resolve({value:''}),set:ok,clear:ok},
      FirebaseCrashlytics:{setEnabled:ok,recordException:ok,setUserId:ok},
      SplashScreen:{hide:ok},
      Preferences:{keys:()=>Promise.resolve({keys:[]}),get:()=>Promise.resolve({value:null}),set:ok,remove:ok,clear:ok},
    },
  };
}

async function preparePage(browser,provider,serverMode='success'){
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const deletePayloads=[];
  await page.addInitScript({path:path.join(root,'tests/fixtures/game-flow-server.js')});
  await page.addInitScript(installDeleteHarness,{uid,provider});
  await page.route('**/*',async route=>{
    const request=route.request();
    if(request.url().startsWith('file://')) return route.continue();
    if(request.url().includes('/api/v2/account/delete')){
      deletePayloads.push(JSON.parse(request.postData()||'{}'));
      await page.evaluate(()=>window.__deleteCalls.order.push('server'));
      if(serverMode==='recent-auth'){
        return route.fulfill({
          status:401,contentType:'application/json',
          body:JSON.stringify({error:'يلزم تسجيل الدخول مجدداً قبل حذف الحساب',code:'recent_auth_required'}),
        });
      }
      return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'});
    }
    return route.fulfill({status:200,contentType:'application/json',body:'{}'});
  });
  await page.goto(url);
  await page.waitForFunction(()=>document.body.dataset.gameFlowUiTest==='ready');
  await page.evaluate(({uid,provider})=>{
    window._currentUid=uid;
    storeSet('authUid',uid);
    storeSet('authProvider',provider);
    storeSet('authEmail','delete@example.invalid');
    window.confirm=()=>true;
    go('s-account');
  },{uid,provider});
  await page.locator('#s-account.active').waitFor({state:'visible'});
  return {page,deletePayloads};
}

const browser=await chromium.launch();
try{
  const {page,deletePayloads}=await preparePage(browser,'password');
  const deleteButton=page.locator('#delete-account-btn');

  // الإلغاء بـEscape يمحو القيمة، يعيد التركيز، ولا ينفذ أي حذف.
  await deleteButton.click();
  const dialog=page.locator('#reauth-password-modal');
  await dialog.waitFor({state:'visible'});
  const semantics=await page.evaluate(()=>{
    const modal=document.getElementById('reauth-password-modal');
    const input=document.getElementById('reauth-password-input');
    const status=document.getElementById('reauth-password-status');
    const submit=document.getElementById('reauth-password-submit');
    const app=document.getElementById('app');
    return {
      role:modal.getAttribute('role'),modal:modal.getAttribute('aria-modal'),
      labelledby:modal.getAttribute('aria-labelledby'),describedby:modal.getAttribute('aria-describedby'),
      type:input.type,autocomplete:input.autocomplete,focused:document.activeElement===input,
      statusRole:status.getAttribute('role'),statusLive:status.getAttribute('aria-live'),
      submitPrimary:submit.classList.contains('btn-primary'),
      appInert:app.inert,appHidden:app.getAttribute('aria-hidden'),
    };
  });
  assert.deepEqual(semantics,{
    role:'dialog',modal:'true',labelledby:'reauth-password-title',describedby:'reauth-password-sub',
    type:'password',autocomplete:'current-password',focused:true,appInert:true,appHidden:'true',
    statusRole:'status',statusLive:'polite',submitPrimary:true,
  });
  await page.locator('#reauth-password-input').fill('temporary-password');
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'hidden'});
  await page.waitForFunction(()=>!_accountActionPending&&!document.getElementById('app').inert);
  await page.waitForFunction(()=>document.activeElement===document.getElementById('delete-account-btn'));
  assert.equal(await page.locator('#reauth-password-input').inputValue(),'','الإلغاء يمحو كلمة المرور من DOM.');
  assert.deepEqual(await page.evaluate(()=>window.__deleteCalls.order),[]);
  assert.equal(deletePayloads.length,0);

  // أثناء طلب إعادة المصادقة يبقى التركيز على حالة داخل النافذة،
  // وبعد الفشل يُفعّل زر الحذف ثم يعود له التركيز.
  await page.evaluate(()=>{
    window.__holdPasswordReauth=true;
    storeSet('authEmail','attacker@example.invalid');
    window.__deleteCalls.order=[];
  });
  await deleteButton.click();
  await dialog.waitFor({state:'visible'});
  await page.locator('#reauth-password-input').fill('temporary-password');
  await page.locator('#reauth-password-submit').click();
  await page.waitForFunction(()=>document.activeElement===document.getElementById('reauth-password-status'));
  const pendingFocus=await page.evaluate(()=>({
    modalHidden:document.getElementById('reauth-password-modal').getAttribute('aria-hidden'),
    busy:document.getElementById('reauth-password-form').getAttribute('aria-busy'),
    inputDisabled:document.getElementById('reauth-password-input').disabled,
    inputValue:document.getElementById('reauth-password-input').value,
    deleteDisabled:document.getElementById('delete-account-btn').disabled,
    status:document.getElementById('reauth-password-status').textContent,
  }));
  assert.deepEqual(pendingFocus,{
    modalHidden:'false',busy:'true',inputDisabled:true,inputValue:'',deleteDisabled:true,
    status:'جاري التحقق من كلمة المرور…',
  });
  await page.evaluate(()=>window.__completePasswordReauth(true));
  await page.waitForFunction(()=>!_accountActionPending);
  await dialog.waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.activeElement===document.getElementById('delete-account-btn'));
  assert.equal(await deleteButton.isEnabled(),true);
  assert.equal(deletePayloads.length,0,'فشل التحقق لا يرسل طلب حذف.');
  assert.deepEqual(await page.evaluate(()=>window.__deleteCalls.reauthEmails),['delete@example.invalid'],
    'يُستخدم بريد Firebase الحالي، لا البريد المخزّن محلياً.');

  // الدخول بحساب مختلف يفشل قبل ملامسة الخادم.
  await page.evaluate(()=>{
    window.__reauthResultUid='different-user';
    window.__deleteCalls.order=[];
  });
  await deleteButton.click();
  await dialog.waitFor({state:'visible'});
  await page.locator('#reauth-password-input').fill('temporary-password');
  await page.locator('#reauth-password-form button[type="submit"]').click();
  await page.waitForFunction(()=>!_accountActionPending);
  assert.deepEqual(await page.evaluate(()=>window.__deleteCalls.order),['reauth']);
  assert.equal(deletePayloads.length,0,'عدم تطابق UID يمنع طلب الحذف الخادمي.');
  assert.match(await page.locator('#toast-d').textContent(),/حساب ثاني/);

  // في المسار الناجح: reauth ثم token جديد ثم الخادم ثم Firebase delete.
  await page.evaluate(({uid})=>{
    window.__reauthResultUid=uid;
    window.__deleteCalls.order=[];
  },{uid});
  await deleteButton.click();
  await dialog.waitFor({state:'visible'});
  await page.locator('#reauth-password-input').fill('temporary-password');
  await page.locator('#reauth-password-form button[type="submit"]').click();
  await page.waitForFunction(()=>window.__deleteCalls.order.includes('firebase-delete'));
  const successful=await page.evaluate(()=>({
    order:window.__deleteCalls.order,
    passwordPresent:window.__deleteCalls.reauthPasswordPresent,
    passwordValue:document.getElementById('reauth-password-input').value,
    modalHidden:document.getElementById('reauth-password-modal').getAttribute('aria-hidden'),
  }));
  assert.deepEqual(successful.order.slice(0,4),['reauth','token:force','server','firebase-delete']);
  assert.equal(successful.passwordPresent,true);
  assert.equal(successful.passwordValue,'');
  assert.equal(successful.modalHidden,'true');
  assert.deepEqual(deletePayloads.at(-1),{uid,idToken:'fresh-delete-token'});
  await page.close();
  console.log('✓ حذف الحساب يعيد المصادقة قبل أي حذف، ونافذة كلمة المرور مقنّعة وقابلة للإلغاء');

  // دون بريد Firebase موثوق، لا يُفتح المودال ولا يُستخدم بريد localStorage.
  const unavailable=await preparePage(browser,'password');
  await unavailable.page.evaluate(()=>{
    window.__firebaseUser.email=null;
    storeSet('authEmail','other-account@example.invalid');
  });
  await unavailable.page.locator('#delete-account-btn').click();
  await unavailable.page.waitForFunction(()=>!_accountActionPending);
  assert.equal(await unavailable.page.locator('#reauth-password-modal').getAttribute('aria-hidden'),'true');
  assert.deepEqual(await unavailable.page.evaluate(()=>window.__deleteCalls.order),[]);
  assert.equal(unavailable.deletePayloads.length,0);
  assert.match(await unavailable.page.locator('#toast-d').textContent(),/سجّل خروجك/);
  await unavailable.page.waitForFunction(()=>document.activeElement===document.getElementById('delete-account-btn'));
  await unavailable.page.close();

  // Capacitor 8 لا يوفّر reauthenticate لـ Google/Apple. لا نستخدم
  // signIn fallback لأنه قد يبدّل الجلسة؛ الخادم يحكم auth_time فقط.
  for(const provider of ['google','apple']){
    const oauth=await preparePage(browser,provider,'recent-auth');
    await oauth.page.locator('#delete-account-btn').click();
    await oauth.page.waitForFunction(()=>!_accountActionPending);
    const audit=await oauth.page.evaluate(()=>({
      order:window.__deleteCalls.order,
      googleSignIn:window.__deleteCalls.googleSignIn,
      appleSignIn:window.__deleteCalls.appleSignIn,
      uid:window.__firebaseUser?.uid,
      deleteCount:window.__deleteCalls.deleteCount,
    }));
    assert.deepEqual(audit,{
      order:['token:force','server'],googleSignIn:0,appleSignIn:0,uid,deleteCount:0,
    },`${provider}: يجب ألا يستدعي signIn fallback أو يبدّل الحساب.`);
    assert.equal(oauth.deletePayloads.length,1);
    assert.match(await oauth.page.locator('#toast-d').textContent(),/سجّل خروجك/);
    await oauth.page.waitForFunction(()=>document.activeElement===document.getElementById('delete-account-btn'));
    await oauth.page.close();
  }
  console.log('✓ Google/Apple لا يستخدمان signIn fallback ولا يبدّلان الجلسة');

  // الهاتف لا يملك reauth API مباشراً: رفض الخادم يظهر خطوة واضحة ولا يحذف Firebase.
  const phone=await preparePage(browser,'phone','recent-auth');
  await phone.page.locator('#delete-account-btn').click();
  await phone.page.waitForFunction(()=>!_accountActionPending);
  assert.equal(await phone.page.evaluate(()=>window.__deleteCalls.deleteCount),0);
  assert.deepEqual(await phone.page.evaluate(()=>window.__deleteCalls.order),['token:force','server']);
  assert.match(await phone.page.locator('#toast-d').textContent(),/سجّل خروجك.*برقم الهاتف/);
  assert.equal(phone.deletePayloads.length,1);
  await phone.page.close();
  console.log('✓ رفض recent-auth لرقم الهاتف لا يحذف أي هوية ويعطي خطوة استرداد صريحة');
}finally{
  await browser.close();
}
