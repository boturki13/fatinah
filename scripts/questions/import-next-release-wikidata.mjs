#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT=path.resolve(import.meta.dirname,'../..');
const OUT=path.join(ROOT,'content/questions/structured-sources/next-release-wikidata.json');
const endpoint='https://query.wikidata.org/sparql';
const queries={
  kuwait:`SELECT DISTINCT ?item ?itemLabel ?kindLabel WHERE {
    ?item wdt:P17 wd:Q817; wdt:P31 ?kind. FILTER(?kind != wd:Q5)
    ?article schema:about ?item; schema:isPartOf <https://ar.wikipedia.org/>.
    SERVICE wikibase:label { bd:serviceParam wikibase:language "ar". }
  } LIMIT 220`,
  airports:`SELECT DISTINCT ?item ?itemLabel ?countryLabel ?iata WHERE {
    ?item wdt:P31/wdt:P279* wd:Q1248784; wdt:P17 ?country; wdt:P238 ?iata.
    ?article schema:about ?item; schema:isPartOf <https://ar.wikipedia.org/>.
    SERVICE wikibase:label { bd:serviceParam wikibase:language "ar". }
  } LIMIT 240`,
  organizations:`SELECT DISTINCT ?item ?itemLabel ?hqLabel ?inception WHERE {
    VALUES ?class { wd:Q484652 wd:Q245065 wd:Q7210356 }
    ?item wdt:P31/wdt:P279* ?class; wdt:P159 ?hq.
    OPTIONAL { ?item wdt:P571 ?inception. }
    ?article schema:about ?item; schema:isPartOf <https://ar.wikipedia.org/>.
    SERVICE wikibase:label { bd:serviceParam wikibase:language "ar". }
  } LIMIT 240`,
  technology:`SELECT DISTINCT ?item ?itemLabel ?developerLabel ?inception WHERE {
    VALUES ?class { wd:Q7397 wd:Q166142 wd:Q35127 wd:Q9143 }
    ?item wdt:P31/wdt:P279* ?class; wdt:P178 ?developer.
    OPTIONAL { ?item wdt:P571 ?inception. }
    ?article schema:about ?item; schema:isPartOf <https://ar.wikipedia.org/>.
    SERVICE wikibase:label { bd:serviceParam wikibase:language "ar". }
  } LIMIT 260`,
  scientists:`SELECT DISTINCT ?item ?itemLabel ?fieldLabel ?countryLabel WHERE {
    ?item wdt:P31 wd:Q5; wdt:P101 ?field; wdt:P27 ?country.
    VALUES ?field { wd:Q413 wd:Q2329 wd:Q18362 wd:Q25276 }
    ?article schema:about ?item; schema:isPartOf <https://ar.wikipedia.org/>.
    SERVICE wikibase:label { bd:serviceParam wikibase:language "ar". }
  } LIMIT 260`,
  historicalPeople:`SELECT DISTINCT ?item ?itemLabel ?countryLabel ?occupationLabel WHERE {
    ?item wdt:P31 wd:Q5; wdt:P106 ?occupation; wdt:P27 ?country.
    VALUES ?occupation { wd:Q82955 wd:Q372436 wd:Q189290 wd:Q49757 wd:Q1930187 }
    ?article schema:about ?item; schema:isPartOf <https://ar.wikipedia.org/>.
    SERVICE wikibase:label { bd:serviceParam wikibase:language "ar". }
  } LIMIT 260`,
  events:`SELECT DISTINCT ?item ?itemLabel ?date ?countryLabel WHERE {
    ?item wdt:P31/wdt:P279* wd:Q1190554; wdt:P585 ?date.
    OPTIONAL { ?item wdt:P17 ?country. }
    ?article schema:about ?item; schema:isPartOf <https://ar.wikipedia.org/>.
    SERVICE wikibase:label { bd:serviceParam wikibase:language "ar". }
  } LIMIT 260`,
};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function run(name,query){
  const url=`${endpoint}?${new URLSearchParams({query,format:'json'})}`;
  for(let attempt=1;attempt<=6;attempt++){
    const response=await fetch(url,{signal:AbortSignal.timeout(25000),headers:{Accept:'application/sparql-results+json','User-Agent':'FatinahQuestionBank/2.0 (source audit)'}}).catch(()=>null);
    if(!response){ await sleep(attempt*1500); continue; }
    if(response.ok){
      const body=await response.json();
      return body.results.bindings.map(binding=>Object.fromEntries(Object.entries(binding).map(([key,value])=>[key,value.value])));
    }
    if(response.status!==429&&response.status<500) throw new Error(`${name}: HTTP ${response.status}`);
    await sleep(attempt*1500);
  }
  throw new Error(`${name}: exhausted retries`);
}
const previous=fs.existsSync(OUT)?JSON.parse(fs.readFileSync(OUT,'utf8')):null;
const datasets=previous?.datasets||{};
for(const [name,query] of Object.entries(queries)){
  if(Array.isArray(datasets[name])&&datasets[name].length>=90){console.log(`${name}: ${datasets[name].length} (cached)`);continue;}
  datasets[name]=await run(name,query);
  console.log(`${name}: ${datasets[name].length}`);
  fs.writeFileSync(OUT,JSON.stringify({schemaVersion:1,endpoint,retrievedAt:new Date().toISOString(),datasets},null,2)+'\n');
  await sleep(500);
}
fs.writeFileSync(OUT,JSON.stringify({schemaVersion:1,endpoint,retrievedAt:new Date().toISOString(),datasets},null,2)+'\n');
