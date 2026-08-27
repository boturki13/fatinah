(function(root){
  'use strict';

  const TRUSTED_ORIGIN='https://ata20.com';
  const ASSET_PATH_PREFIX='/assets/question-images/';
  const CACHE_NAME='fatinah-question-images-v1';
  const MAX_IMAGE_BYTES=450*1024;
  const HEX_SHA256=/^[a-f0-9]{64}$/;
  const readyUrls=new Map();

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
    if(url.origin!==TRUSTED_ORIGIN||!url.pathname.startsWith(ASSET_PATH_PREFIX)||url.protocol!=='https:'){
      throw new Error('image_asset_untrusted_url');
    }
    if(!['image/avif','image/webp'].includes(asset.mimeType)) throw new Error('image_asset_unsupported_type');
    if(!Number.isInteger(asset.bytes)||asset.bytes<1||asset.bytes>MAX_IMAGE_BYTES) throw new Error('image_asset_too_large');
    if(!HEX_SHA256.test(asset.sha256||'')) throw new Error('image_asset_invalid_hash');
    return true;
  }

  function validateQuestion(question){
    const image=question&&question.image;
    if(!image||!String(image.alt||'').trim()) throw new Error('image_alt_missing');
    if(!String(image.factSource?.title||'').trim()||!/^https:\/\//.test(image.factSource?.url||'')) throw new Error('image_source_missing');
    const rights=image.rights;
    if(!String(rights?.owner||'').trim()||!String(rights?.credit||'').trim()
      ||!String(rights?.provider||'').trim()||!String(rights?.license||'').trim()
      ||!String(rights?.modifications||'').trim()){
      throw new Error('image_rights_missing');
    }
    if(!/^https:\/\//.test(rights.licenseUrl||'')||!/^https:\/\//.test(rights.sourcePage||'')) throw new Error('image_rights_missing');
    if(!Array.isArray(image.assets)||image.assets.length<1) throw new Error('image_asset_missing');
    image.assets.forEach(validateAsset);
    const assetTypes=new Set(image.assets.map(asset=>asset.mimeType));
    if(!assetTypes.has('image/avif')||!assetTypes.has('image/webp')) throw new Error('image_asset_fallback_missing');
    if(assetTypes.size!==image.assets.length) throw new Error('image_asset_duplicate_type');
    return true;
  }

  async function digestHex(blob){
    const bytes=await blob.arrayBuffer();
    const cryptoApi=root.crypto||(typeof crypto!=='undefined'?crypto:null);
    if(!cryptoApi?.subtle) throw new Error('image_hash_unavailable');
    const digest=await cryptoApi.subtle.digest('SHA-256',bytes);
    return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
  }

  async function verifiedResponse(asset,fetcher){
    validateAsset(asset);
    const request=fetcher||root.fetch?.bind(root)||(typeof fetch==='function'?fetch:null);
    if(typeof request!=='function') throw new Error('image_fetch_unavailable');
    const response=await request(asset.url,{cache:'no-store',credentials:'omit',redirect:'error'});
    if(!response.ok) throw new Error('image_asset_download_failed');
    const length=Number(response.headers.get('content-length')||0);
    if(length>MAX_IMAGE_BYTES||length>asset.bytes) throw new Error('image_asset_too_large');
    const type=(response.headers.get('content-type')||'').split(';')[0].trim();
    if(type!==asset.mimeType) throw new Error('image_asset_type_mismatch');
    const blob=await response.blob();
    if(blob.size>MAX_IMAGE_BYTES||blob.size!==asset.bytes) throw new Error('image_asset_size_mismatch');
    if(await digestHex(blob)!==asset.sha256) throw new Error('image_asset_hash_mismatch');
    return new Response(blob,{headers:{'Content-Type':asset.mimeType,'Content-Length':String(blob.size),'X-Fatinah-SHA256':asset.sha256}});
  }

  async function cacheForAsset(asset){
    validateAsset(asset);
    if(!root.caches) throw new Error('image_cache_unavailable');
    const cache=await root.caches.open(CACHE_NAME);
    const cached=await cache.match(asset.url);
    if(cached&&cached.headers.get('X-Fatinah-SHA256')===asset.sha256) return cached;
    if(cached) await cache.delete(asset.url);
    const response=await verifiedResponse(asset);
    await cache.put(asset.url,response.clone());
    return response;
  }

  function preferredAssets(question){
    validateQuestion(question);
    return [...question.image.assets].sort((a,b)=>Number(b.mimeType==='image/avif')-Number(a.mimeType==='image/avif'));
  }

  async function decodeImageSource(image,source){
    if(typeof image.decode==='function'){
      image.src=source;
      await image.decode();
      return;
    }
    await new Promise((resolve,reject)=>{
      const done=callback=>()=>{
        image.onload=null;
        image.onerror=null;
        callback();
      };
      image.onload=done(resolve);
      image.onerror=done(()=>reject(new Error('image_asset_decode_failed')));
      image.src=source;
    });
  }

  async function decodedBlob(asset,response){
    const ImageCtor=root.Image;
    if(typeof ImageCtor!=='function') throw new Error('image_decoder_unavailable');
    const blob=await response.clone().blob();
    const api=urlApi();
    const objectUrl=api.createObjectURL(blob);
    const image=new ImageCtor();
    image.decoding='async';
    try{
      await decodeImageSource(image,objectUrl);
      return blob;
    }catch(error){
      throw new Error('image_asset_decode_failed',{cause:error});
    }finally{
      image.removeAttribute?.('src');
      api.revokeObjectURL(objectUrl);
    }
  }

  async function prepareQuestion(question,{excludeUrls=[]}={}){
    validateQuestion(question);
    const excluded=excludeUrls instanceof Set?excludeUrls:new Set(excludeUrls);
    const current=readyUrls.get(question.id);
    if(current&&!excluded.has(current.asset.url)) return true;
    let lastError;
    for(const asset of preferredAssets(question)){
      if(excluded.has(asset.url)) continue;
      try{
        const response=await cacheForAsset(asset);
        const blob=await decodedBlob(asset,response);
        readyUrls.set(question.id,{asset,blob});
        return true;
      }catch(error){ lastError=error; }
    }
    readyUrls.delete(question.id);
    throw lastError||new Error('image_asset_unavailable');
  }

  async function prepareCategory(questions){
    const byDifficulty=new Map();
    await Promise.all((questions||[]).map(async question=>{
      try{
        await prepareQuestion(question);
        if(!byDifficulty.has(question.d)) byDifficulty.set(question.d,new Set());
        byDifficulty.get(question.d).add(question.id);
      }catch(_){ }
    }));
    return byDifficulty;
  }

  async function objectUrl(question){
    if(!readyUrls.has(question.id)) await prepareQuestion(question);
    const item=readyUrls.get(question.id);
    return urlApi().createObjectURL(item.blob);
  }

  async function loadInto(question,image){
    if(!image) throw new Error('image_element_missing');
    validateQuestion(question);
    const excluded=new Set();
    let lastError;
    while(excluded.size<question.image.assets.length){
      try{
        await prepareQuestion(question,{excludeUrls:excluded});
        const item=readyUrls.get(question.id);
        const objectUrl=urlApi().createObjectURL(item.blob);
        try{
          await decodeImageSource(image,objectUrl);
          return objectUrl;
        }catch(error){
          urlApi().revokeObjectURL(objectUrl);
          image.removeAttribute?.('src');
          excluded.add(item.asset.url);
          readyUrls.delete(question.id);
          lastError=new Error('image_asset_decode_failed',{cause:error});
        }
      }catch(error){
        lastError=error;
        break;
      }
    }
    throw lastError||new Error('image_asset_unavailable');
  }

  root.FatinahImageAssets={
    TRUSTED_ORIGIN,MAX_IMAGE_BYTES,validateAsset,validateQuestion,verifiedResponse,
    prepareQuestion,prepareCategory,objectUrl,loadInto,
    isReady:question=>Boolean(question?.id&&readyUrls.has(question.id)),
  };
})(typeof window!=='undefined'?window:globalThis);
