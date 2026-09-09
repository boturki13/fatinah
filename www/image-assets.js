(function(root){
  'use strict';

  const TRUSTED_ORIGIN='https://ata20.com';
  const ASSET_PATH_PREFIX='/assets/question-images/';
  const CACHE_NAME='fatinah-question-images-v1';
  const MAX_IMAGE_BYTES=450*1024;
  const IMAGE_FETCH_TIMEOUT_MS=12000;
  const IMAGE_RENDER_TIMEOUT_MS=12000;
  const CATEGORY_PREPARE_TIMEOUT_MS=28000;
  const HEX_SHA256=/^[a-f0-9]{64}$/;
  const VERSION_SEGMENT='v[1-9][0-9]{0,2}';
  const MAX_PREPARE_CONCURRENCY=3;
  // الحد يغطي أقصى جولة (8 فئات × 6 مستويات × سؤالين) دون إبقاء
  // بنك الصور كله في ذاكرة WebView. الحد بالبايت يستوعب 96 ملفاً
  // بالحجم الأقصى المسموح مع هامش بسيط.
  const MAX_READY_ASSET_COUNT=96;
  const MAX_READY_ASSET_BYTES=48*1024*1024;
  const MAX_PERSISTENT_CACHE_ENTRIES=96;
  const IMAGE_PATH=new RegExp(`^${ASSET_PATH_PREFIX}(${VERSION_SEGMENT})/([A-Za-z0-9][A-Za-z0-9._-]*)\\.(avif|webp)$`);
  const IMAGE_QUESTION_ID=/^img-v([1-9][0-9]{0,2})-([a-z0-9][a-z0-9_-]{0,119})$/;
  const readyUrls=new Map();
  let readyBytes=0;

  function cancellationController(){
    const Controller=root.AbortController||(typeof AbortController!=='undefined'?AbortController:null);
    if(typeof Controller==='function'){
      const controller=new Controller();
      return {signal:controller.signal,requestSignal:controller.signal,abort:()=>controller.abort()};
    }
    // الإشارة البديلة تضمن أن المهلة توقف التجهيز حتى في بيئات
    // الاختبار القديمة؛ لا تُمرر لـ fetch لأنها ليست AbortSignal أصلية.
    const listeners=new Set();
    const signal={
      aborted:false,
      addEventListener(type,listener){ if(type==='abort'&&typeof listener==='function') listeners.add(listener); },
      removeEventListener(type,listener){ if(type==='abort') listeners.delete(listener); },
    };
    return {
      signal,requestSignal:null,
      abort(){
        if(signal.aborted) return;
        signal.aborted=true;
        for(const listener of [...listeners]) listener.call(signal,{type:'abort',target:signal});
        listeners.clear();
      },
    };
  }

  function abortError(code='image_prepare_aborted'){
    return new Error(code);
  }

  function throwIfAborted(signal,code='image_prepare_aborted'){
    if(signal?.aborted) throw abortError(code);
  }

  function waitWithSignal(value,signal,{onAbort,code='image_prepare_aborted'}={}){
    if(!signal) return Promise.resolve(value);
    if(signal.aborted){
      try{ onAbort?.(); }catch(_){ }
      return Promise.reject(abortError(code));
    }
    return new Promise((resolve,reject)=>{
      let settled=false;
      const cleanup=()=>signal.removeEventListener?.('abort',abort);
      const finish=(callback,result)=>{
        if(settled) return;
        settled=true;
        cleanup();
        callback(result);
      };
      const abort=()=>{
        try{ onAbort?.(); }catch(_){ }
        finish(reject,abortError(code));
      };
      signal.addEventListener?.('abort',abort,{once:true});
      Promise.resolve(value).then(result=>finish(resolve,result),error=>finish(reject,error));
    });
  }

  function urlApi(){
    const api=root.URL||(typeof URL!=='undefined'?URL:null);
    if(!api||typeof api.createObjectURL!=='function'||typeof api.revokeObjectURL!=='function'){
      throw new Error('image_decoder_unavailable');
    }
    return api;
  }

  function validateAsset(asset){
    if(!asset||typeof asset!=='object') throw new Error('image_asset_missing');
    const url=new URL(asset.url);
    const pathMatch=url.pathname.match(IMAGE_PATH);
    if(url.origin!==TRUSTED_ORIGIN||url.protocol!=='https:'||url.username||url.password||url.port
      ||url.search||url.hash||!pathMatch){
      throw new Error('image_asset_untrusted_url');
    }
    if(!['image/avif','image/webp'].includes(asset.mimeType)) throw new Error('image_asset_unsupported_type');
    if(asset.mimeType!==`image/${pathMatch[3]}`) throw new Error('image_asset_type_mismatch');
    if(!Number.isInteger(asset.bytes)||asset.bytes<1||asset.bytes>MAX_IMAGE_BYTES) throw new Error('image_asset_too_large');
    if(!HEX_SHA256.test(asset.sha256||'')) throw new Error('image_asset_invalid_hash');
    return true;
  }

  function requestUrlForAsset(asset){
    validateAsset(asset);
    const canonical=new URL(asset.url);
    const location=root.location;
    const loopbackHosts=new Set(['127.0.0.1','localhost','::1','[::1]']);
    const localWeb=location&&['http:','https:'].includes(location.protocol)
      &&loopbackHosts.has(location.hostname)
      &&root.Capacitor?.isNativePlatform?.()!==true;
    // خادم المعاينة يقدّم نفس أصول server-assets على نفس المصدر.
    // نغيّر مكان الطلب فقط، وتبقى الحجم/النوع/SHA-256 الموثقة مطلوبة كاملة.
    return localWeb?new URL(canonical.pathname,location.origin).href:canonical.href;
  }

  function uiTestFixtureResponse(asset){
    if(root.__FATINAH_IMAGE_FLOW_UI_TEST__!==true) return null;
    const fixtures=root.__FATINAH_IMAGE_FLOW_UI_TEST_ASSETS__;
    if(!fixtures) return null;
    const encoded=fixtures[asset.url]||fixtures[asset.mimeType];
    if(!encoded) return null;
    if(typeof encoded!=='string') throw new Error('image_test_fixture_invalid');
    const decode=root.atob||(typeof atob==='function'?atob:null);
    if(typeof decode!=='function') throw new Error('image_test_fixture_invalid');
    const binary=decode(encoded);
    const bytes=Uint8Array.from(binary,char=>char.charCodeAt(0));
    return new Response(bytes,{
      status:200,
      headers:{'Content-Type':asset.mimeType,'Content-Length':String(bytes.byteLength)},
    });
  }

  function validateQuestion(question){
    const image=question&&question.image;
    if(question?.o!==undefined||question?.a!==undefined){
      const concealed=question.a===undefined&&question.answer===undefined;
      if(!Array.isArray(question.o)||question.o.length!==4||new Set(question.o).size!==4
        ||(!concealed&&(!Number.isInteger(question.a)||question.a<0||question.a>3||question.o[question.a]!==question.answer))){
        throw new Error('image_choices_invalid');
      }
    }
    if(!image||!String(image.alt||'').trim()) throw new Error('image_alt_missing');
    const idMatch=String(question?.id||'').match(IMAGE_QUESTION_ID);
    if(!idMatch||String(question.id).length>128) throw new Error('image_question_id_invalid');
    if(!String(image.factSource?.title||'').trim()||!/^https:\/\//.test(image.factSource?.url||'')) throw new Error('image_source_missing');
    const rights=image.rights;
    if(!String(rights?.owner||'').trim()||!String(rights?.credit||'').trim()
      ||!String(rights?.provider||'').trim()||!String(rights?.license||'').trim()
      ||!String(rights?.modifications||'').trim()){
      throw new Error('image_rights_missing');
    }
    if(!/^https:\/\//.test(rights.licenseUrl||'')||!/^https:\/\//.test(rights.sourcePage||'')) throw new Error('image_rights_missing');
    if(!Array.isArray(image.assets)||image.assets.length<1) throw new Error('image_asset_missing');
    image.assets.forEach(asset=>{
      validateAsset(asset);
      const assetPath=new URL(asset.url).pathname.match(IMAGE_PATH);
      if(assetPath[1]!==`v${idMatch[1]}`||assetPath[2]!==idMatch[2]){
        throw new Error('image_asset_id_mismatch');
      }
    });
    const assetTypes=new Set(image.assets.map(asset=>asset.mimeType));
    if(!assetTypes.has('image/avif')||!assetTypes.has('image/webp')) throw new Error('image_asset_fallback_missing');
    if(assetTypes.size!==image.assets.length) throw new Error('image_asset_duplicate_type');
    return true;
  }

  async function digestHex(blob,{signal}={}){
    throwIfAborted(signal);
    const bytes=await waitWithSignal(blob.arrayBuffer(),signal);
    const cryptoApi=root.crypto||(typeof crypto!=='undefined'?crypto:null);
    if(!cryptoApi?.subtle) throw new Error('image_hash_unavailable');
    const digest=await waitWithSignal(cryptoApi.subtle.digest('SHA-256',bytes),signal);
    throwIfAborted(signal);
    return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
  }

  async function verifyResponseBody(asset,response,{signal}={}){
    throwIfAborted(signal);
    validateAsset(asset);
    if(!response||response.ok!==true||typeof response.blob!=='function'||!response.headers){
      throw new Error('image_asset_download_failed');
    }
    const rawLength=response.headers.get('content-length');
    const length=rawLength==null||rawLength===''?0:Number(rawLength);
    if(!Number.isFinite(length)||length<0) throw new Error('image_asset_size_mismatch');
    if(length>MAX_IMAGE_BYTES||length>asset.bytes) throw new Error('image_asset_too_large');
    const type=(response.headers.get('content-type')||'').split(';')[0].trim();
    if(type!==asset.mimeType) throw new Error('image_asset_type_mismatch');
    const blob=await waitWithSignal(response.blob(),signal);
    if(blob.size>MAX_IMAGE_BYTES||blob.size!==asset.bytes) throw new Error('image_asset_size_mismatch');
    if(await digestHex(blob,{signal})!==asset.sha256) throw new Error('image_asset_hash_mismatch');
    throwIfAborted(signal);
    return new Response(blob,{headers:{'Content-Type':asset.mimeType,'Content-Length':String(blob.size),'X-Fatinah-SHA256':asset.sha256}});
  }

  async function verifiedResponse(asset,fetcher,{signal}={}){
    throwIfAborted(signal);
    validateAsset(asset);
    // XCUITest receives immutable fixture bytes from the DEBUG-only native
    // bridge. They still pass the production size/type/SHA-256 verification,
    // so the test is deterministic without creating a validation bypass.
    const fixtureResponse=uiTestFixtureResponse(asset);
    if(fixtureResponse) return verifyResponseBody(asset,fixtureResponse,{signal});
    const request=fetcher||root.fetch?.bind(root)||(typeof fetch==='function'?fetch:null);
    if(typeof request!=='function') throw new Error('image_fetch_unavailable');
    const schedule=root.setTimeout?.bind(root)||(typeof setTimeout==='function'?setTimeout:null);
    const cancel=root.clearTimeout?.bind(root)||(typeof clearTimeout==='function'?clearTimeout:null);
    const controller=cancellationController();
    let timedOut=false;
    const abortFromParent=()=>controller.abort();
    if(signal?.aborted) controller.abort();
    else signal?.addEventListener?.('abort',abortFromParent,{once:true});
    const timeout=schedule?schedule(()=>{ timedOut=true; controller.abort(); },IMAGE_FETCH_TIMEOUT_MS):null;
    try{
      const response=await waitWithSignal(request(requestUrlForAsset(asset),{
        cache:'no-store',credentials:'omit',redirect:'error',
        ...(controller.requestSignal?{signal:controller.requestSignal}:{}),
      }),controller.signal,{code:'image_asset_download_aborted'});
      return await verifyResponseBody(asset,response,{signal:controller.signal});
    }catch(error){
      if(timedOut) throw new Error('image_asset_download_timeout',{cause:error});
      if(signal?.aborted) throw new Error('image_prepare_aborted',{cause:error});
      throw error;
    }finally{
      if(timeout!=null&&cancel) cancel(timeout);
      signal?.removeEventListener?.('abort',abortFromParent);
    }
  }

  async function trimPersistentCache(cache,{signal}={}){
    if(typeof cache?.keys!=='function'||typeof cache?.delete!=='function') return;
    let keys;
    try{ keys=await waitWithSignal(cache.keys(),signal); }
    catch(error){
      if(signal?.aborted) throw error;
      return;
    }
    if(!Array.isArray(keys)||keys.length<=MAX_PERSISTENT_CACHE_ENTRIES) return;
    for(const key of keys.slice(0,keys.length-MAX_PERSISTENT_CACHE_ENTRIES)){
      try{ await waitWithSignal(cache.delete(key),signal); }
      catch(error){ if(signal?.aborted) throw error; }
    }
  }

  async function cacheForAsset(asset,{signal}={}){
    throwIfAborted(signal);
    validateAsset(asset);
    // CacheStorage تحسين للأداء وليس جزءاً من سلسلة الثقة. بعض WebViews
    // والمتصفحات المقيدة لا توفره؛ في هذه الحالة ننزّل الأصل ونتحقق من
    // النوع والحجم وSHA-256 وفك الصورة كالمعتاد، ثم نحتفظ به في ذاكرة الجولة.
    let cache=null;
    try{
      if(typeof root.caches?.open==='function'){
        cache=await waitWithSignal(root.caches.open(CACHE_NAME),signal);
      }
    }catch(error){
      if(signal?.aborted) throw error;
      cache=null;
    }
    if(!cache||typeof cache.match!=='function'||typeof cache.put!=='function'){
      return verifiedResponse(asset,undefined,{signal});
    }
    const cacheKey=requestUrlForAsset(asset);
    let cached=null;
    try{ cached=await waitWithSignal(cache.match(cacheKey),signal); }
    catch(error){
      if(signal?.aborted) throw error;
      return verifiedResponse(asset,undefined,{signal});
    }
    if(cached&&cached.headers.get('X-Fatinah-SHA256')===asset.sha256){
      try{ return await verifyResponseBody(asset,cached,{signal}); }
      catch(error){
        if(signal?.aborted) throw error;
        /* احذف النسخة التالفة ونزّل الأصل الموثق من جديد */
      }
    }
    if(cached&&typeof cache.delete==='function'){
      try{ await waitWithSignal(cache.delete(cacheKey),signal); }
      catch(error){ if(signal?.aborted) throw error; /* التخزين اختياري */ }
    }
    const response=await verifiedResponse(asset,undefined,{signal});
    try{ await waitWithSignal(cache.put(cacheKey,response.clone()),signal); }
    catch(error){ if(signal?.aborted) throw error; /* التخزين اختياري */ }
    await trimPersistentCache(cache,{signal});
    throwIfAborted(signal);
    return response;
  }

  async function evictCachedAsset(asset,{signal}={}){
    try{
      if(typeof root.caches?.open!=='function') return false;
      const cache=await waitWithSignal(root.caches.open(CACHE_NAME),signal);
      if(typeof cache?.delete!=='function') return false;
      return await waitWithSignal(cache.delete(requestUrlForAsset(asset)),signal);
    }catch(_){ return false; }
  }

  function preferredAssets(question){
    validateQuestion(question);
    return [...question.image.assets].sort((a,b)=>Number(b.mimeType==='image/avif')-Number(a.mimeType==='image/avif'));
  }

  function questionAssetFingerprint(question){
    if(!Array.isArray(question?.image?.assets)) return '';
    return JSON.stringify(question.image.assets.map(asset=>({
      url:asset?.url,mimeType:asset?.mimeType,bytes:asset?.bytes,sha256:asset?.sha256,
    })).sort((a,b)=>String(a.url).localeCompare(String(b.url))));
  }

  function deleteReady(questionId){
    const current=readyUrls.get(questionId);
    if(!current) return false;
    readyUrls.delete(questionId);
    readyBytes=Math.max(0,readyBytes-(Number(current.blob?.size)||0));
    return true;
  }

  function touchReady(questionId,current=readyUrls.get(questionId)){
    if(!current) return null;
    readyUrls.delete(questionId);
    readyUrls.set(questionId,current);
    return current;
  }

  function trimReadyCache(){
    while(readyUrls.size>MAX_READY_ASSET_COUNT||readyBytes>MAX_READY_ASSET_BYTES){
      const oldest=readyUrls.keys().next().value;
      if(oldest===undefined) break;
      deleteReady(oldest);
    }
  }

  function storeReady(questionId,item){
    deleteReady(questionId);
    readyUrls.set(questionId,item);
    readyBytes+=Number(item.blob?.size)||0;
    trimReadyCache();
  }

  function readyItem(question,{touch=true}={}){
    const current=question?.id?readyUrls.get(question.id):null;
    if(!current) return null;
    if(current.fingerprint!==questionAssetFingerprint(question)){
      deleteReady(question.id);
      return null;
    }
    return touch?touchReady(question.id,current):current;
  }

  function isReady(question){
    return Boolean(readyItem(question));
  }

  function readyCacheStats(){
    return {
      entries:readyUrls.size,bytes:readyBytes,
      maxEntries:MAX_READY_ASSET_COUNT,maxBytes:MAX_READY_ASSET_BYTES,
    };
  }

  function clearReadyCache(){
    readyUrls.clear();
    readyBytes=0;
  }

  async function decodeImageSource(image,source,{signal}={}){
    throwIfAborted(signal);
    if(typeof image.decode==='function'){
      image.src=source;
      await waitWithSignal(image.decode(),signal,{
        onAbort:()=>image.removeAttribute?.('src'),
      });
      return;
    }
    const decoded=new Promise((resolve,reject)=>{
      const done=callback=>()=>{
        image.onload=null;
        image.onerror=null;
        callback();
      };
      image.onload=done(resolve);
      image.onerror=done(()=>reject(new Error('image_asset_decode_failed')));
      image.src=source;
    });
    await waitWithSignal(decoded,signal,{
      onAbort:()=>{
        image.onload=null;
        image.onerror=null;
        image.removeAttribute?.('src');
      },
    });
  }

  async function dataUrlForBlob(blob,{signal}={}){
    throwIfAborted(signal);
    const Reader=root.FileReader||(typeof FileReader!=='undefined'?FileReader:null);
    if(typeof Reader!=='function') throw new Error('image_data_url_unavailable');
    let reader=null;
    const converted=new Promise((resolve,reject)=>{
      reader=new Reader();
      reader.onload=()=>typeof reader.result==='string'
        ?resolve(reader.result):reject(new Error('image_data_url_failed'));
      reader.onerror=()=>reject(new Error('image_data_url_failed'));
      reader.onabort=()=>reject(new Error('image_data_url_failed'));
      reader.readAsDataURL(blob);
    });
    return waitWithSignal(converted,signal,{onAbort:()=>reader?.abort?.()});
  }

  async function decodedBlob(asset,response,{signal}={}){
    throwIfAborted(signal);
    const ImageCtor=root.Image;
    if(typeof ImageCtor!=='function') throw new Error('image_decoder_unavailable');
    const blob=await response.clone().blob();
    const api=urlApi();
    const objectUrl=api.createObjectURL(blob);
    const image=new ImageCtor();
    image.decoding='async';
    try{
      try{
        await decodeImageSource(image,objectUrl,{signal});
        return blob;
      }catch(blobUrlError){
        throwIfAborted(signal);
        // بعض WebViews تفك WebP/AVIF عند فتحه مباشرة، لكنها ترفض blob:.
        // data: هنا مشتق من البايتات التي اجتازت الحجم والنوع وSHA-256.
        image.removeAttribute?.('src');
        const dataUrl=await dataUrlForBlob(blob,{signal});
        await decodeImageSource(image,dataUrl,{signal});
        return blob;
      }
    }catch(error){
      throw new Error('image_asset_decode_failed',{cause:error});
    }finally{
      image.removeAttribute?.('src');
      api.revokeObjectURL(objectUrl);
    }
  }

  async function prepareQuestion(question,{excludeUrls=[],signal}={}){
    throwIfAborted(signal);
    validateQuestion(question);
    const excluded=excludeUrls instanceof Set?excludeUrls:new Set(excludeUrls);
    const fingerprint=questionAssetFingerprint(question);
    const current=readyItem(question);
    if(current&&current.fingerprint===fingerprint&&!excluded.has(current.asset.url)) return true;
    let lastError;
    for(const asset of preferredAssets(question)){
      throwIfAborted(signal);
      if(excluded.has(asset.url)) continue;
      try{
        const response=await cacheForAsset(asset,{signal});
        let blob;
        try{
          blob=await decodedBlob(asset,response,{signal});
        }catch(error){
          // سلامة البايتات لا تعني أن codec مدعوم على هذا الجهاز. لا نترك
          // AVIF فشل فكّه يزاحم WebP الصالح داخل الكاش المحدود.
          if(!signal?.aborted) await evictCachedAsset(asset,{signal});
          throw error;
        }
        throwIfAborted(signal);
        storeReady(question.id,{asset,blob,fingerprint});
        return true;
      }catch(error){
        if(signal?.aborted) throw error;
        lastError=error;
      }
    }
    deleteReady(question.id);
    throw lastError||new Error('image_asset_unavailable');
  }

  function questionsByDifficulty(questions){
    const groups=new Map();
    for(const question of questions||[]){
      const difficulty=Number(question?.d);
      if(!groups.has(difficulty)) groups.set(difficulty,[]);
      groups.get(difficulty).push(question);
    }
    return [...groups.entries()].sort(([a],[b])=>a-b);
  }

  async function prepareCategory(questions,{
    minimumPerDifficulty=Infinity,
    timeoutMs=CATEGORY_PREPARE_TIMEOUT_MS,
    deadlineAt,
    signal:parentSignal,
  }={}){
    const byDifficulty=new Map();
    const minimum=Number.isInteger(minimumPerDifficulty)&&minimumPerDifficulty>0
      ?minimumPerDifficulty:Infinity;
    const controller=cancellationController();
    const schedule=root.setTimeout?.bind(root)||(typeof setTimeout==='function'?setTimeout:null);
    const cancel=root.clearTimeout?.bind(root)||(typeof clearTimeout==='function'?clearTimeout:null);
    const now=Date.now();
    const relativeTimeout=Number.isFinite(timeoutMs)&&timeoutMs>0?timeoutMs:CATEGORY_PREPARE_TIMEOUT_MS;
    const absoluteTimeout=Number.isFinite(deadlineAt)?Math.max(0,deadlineAt-now):relativeTimeout;
    const effectiveTimeout=Math.min(relativeTimeout,absoluteTimeout);
    let timedOut=effectiveTimeout<=0;
    const abortFromParent=()=>controller.abort();
    if(parentSignal?.aborted||timedOut) controller.abort();
    else parentSignal?.addEventListener?.('abort',abortFromParent,{once:true});
    const timeout=!timedOut&&schedule?schedule(()=>{
      timedOut=true;
      controller.abort();
    },effectiveTimeout):null;
    const signal=controller.signal;
    const waiters=[];
    let active=0;
    const acquireSlot=()=>{
      throwIfAborted(signal);
      if(active<MAX_PREPARE_CONCURRENCY){
        active+=1;
        return Promise.resolve();
      }
      return new Promise((resolve,reject)=>{
        let settled=false;
        const onAbort=()=>{
          if(settled) return;
          settled=true;
          const index=waiters.indexOf(waiter);
          if(index>=0) waiters.splice(index,1);
          signal.removeEventListener?.('abort',onAbort);
          reject(abortError());
        };
        const waiter={grant(){
          if(settled||signal.aborted) return false;
          settled=true;
          signal.removeEventListener?.('abort',onAbort);
          active+=1;
          resolve();
          return true;
        }};
        waiters.push(waiter);
        signal.addEventListener?.('abort',onAbort,{once:true});
        if(signal.aborted) onAbort();
      });
    };
    const releaseSlot=()=>{
      active=Math.max(0,active-1);
      while(waiters.length){
        const next=waiters.shift();
        if(next.grant()) break;
      }
    };
    const withDecodeSlot=async action=>{
      await acquireSlot();
      try{ return await action(); }
      finally{ releaseSlot(); }
    };
    try{
      await Promise.all(questionsByDifficulty(questions).map(async([difficulty,candidates])=>{
        const ready=new Set();
        byDifficulty.set(difficulty,ready);
        for(const question of candidates){
          if(ready.size>=minimum||signal.aborted) break;
          try{
            await withDecodeSlot(()=>prepareQuestion(question,{signal}));
            ready.add(question.id);
          }catch(_){
            if(signal.aborted) break;
          }
        }
      }));
      if(timedOut) throw new Error('image_category_prepare_timeout');
      if(parentSignal?.aborted) throw new Error('image_category_prepare_aborted');
      return byDifficulty;
    }finally{
      if(timeout!=null&&cancel) cancel(timeout);
      parentSignal?.removeEventListener?.('abort',abortFromParent);
    }
  }

  async function objectUrl(question){
    if(!isReady(question)) await prepareQuestion(question);
    const item=readyItem(question);
    if(!item) throw new Error('image_asset_unavailable');
    return urlApi().createObjectURL(item.blob);
  }

  async function loadInto(question,image,{signal:parentSignal,timeoutMs=IMAGE_RENDER_TIMEOUT_MS}={}){
    if(!image) throw new Error('image_element_missing');
    validateQuestion(question);
    const controller=cancellationController();
    const schedule=root.setTimeout?.bind(root)||(typeof setTimeout==='function'?setTimeout:null);
    const cancel=root.clearTimeout?.bind(root)||(typeof clearTimeout==='function'?clearTimeout:null);
    const duration=Number.isFinite(timeoutMs)&&timeoutMs>0?timeoutMs:IMAGE_RENDER_TIMEOUT_MS;
    let timedOut=false;
    const abortFromParent=()=>controller.abort();
    if(parentSignal?.aborted) controller.abort();
    else parentSignal?.addEventListener?.('abort',abortFromParent,{once:true});
    const timeout=schedule?schedule(()=>{ timedOut=true; controller.abort(); },duration):null;
    const signal=controller.signal;
    const excluded=new Set();
    let lastError;
    try{
      while(excluded.size<question.image.assets.length){
        try{
          await prepareQuestion(question,{excludeUrls:excluded,signal});
          const item=readyItem(question);
          if(!item) throw new Error('image_asset_unavailable');
          const objectUrl=urlApi().createObjectURL(item.blob);
          try{
            await decodeImageSource(image,objectUrl,{signal});
            throwIfAborted(signal);
            return objectUrl;
          }catch(blobUrlError){
            urlApi().revokeObjectURL(objectUrl);
            image.removeAttribute?.('src');
            if(signal.aborted) throw blobUrlError;
            try{
              const dataUrl=await dataUrlForBlob(item.blob,{signal});
              await decodeImageSource(image,dataUrl,{signal});
              throwIfAborted(signal);
              return dataUrl;
            }catch(error){
              if(signal.aborted) throw error;
              excluded.add(item.asset.url);
              deleteReady(question.id);
              lastError=new Error('image_asset_decode_failed',{cause:error});
            }
          }
        }catch(error){
          lastError=error;
          break;
        }
      }
      if(timedOut) throw new Error('image_render_timeout',{cause:lastError});
      if(parentSignal?.aborted) throw new Error('image_render_aborted',{cause:lastError});
      throw lastError||new Error('image_asset_unavailable');
    }finally{
      if(timeout!=null&&cancel) cancel(timeout);
      parentSignal?.removeEventListener?.('abort',abortFromParent);
    }
  }

  root.FatinahImageAssets={
    TRUSTED_ORIGIN,MAX_IMAGE_BYTES,CATEGORY_PREPARE_TIMEOUT_MS,IMAGE_RENDER_TIMEOUT_MS,
    MAX_READY_ASSET_COUNT,MAX_READY_ASSET_BYTES,MAX_PERSISTENT_CACHE_ENTRIES,
    validateAsset,validateQuestion,requestUrlForAsset,verifiedResponse,
    prepareQuestion,prepareCategory,objectUrl,loadInto,
    isReady,readyCacheStats,clearReadyCache,
  };
})(typeof window!=='undefined'?window:globalThis);
