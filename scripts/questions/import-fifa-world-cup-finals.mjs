#!/usr/bin/env node
import crypto from 'node:crypto';
import path from 'node:path';
import { CONTENT_DIR, writeJsonAtomic } from './lib.mjs';

const write = process.argv.includes('--write');
const output = path.join(CONTENT_DIR, 'structured-sources', 'fifa-world-cup-finals.json');
const retrievedAt = new Date().toISOString();
const apiBase = 'https://api.fifa.com/api/v3';
const competitionId = '17';
const seasonsUrl = `${apiBase}/seasons?idCompetition=${competitionId}&language=ar&count=100`;
const officialHistoryUrl = 'https://www.fifa.com/es/articles/todos-los-mundiales-de-la-historia-campeones-sedes-y-mejores-jugadores';

async function fetchJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'FatinahQuestionBank/1.3 (https://ata20.com)' },
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`${new URL(url).hostname}: HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, attempt * 750));
    }
  }
  throw lastError;
}

function description(value) {
  if (!Array.isArray(value)) return '';
  const arabic = value.find(item => /^ar(?:-|$)/i.test(String(item?.Locale || '')));
  return String(arabic?.Description || value[0]?.Description || '').replace(/\s+/g, ' ').trim();
}

function teamName(team) {
  return description(team?.TeamName) || String(team?.ShortClubName || '').trim();
}

const arabicMonths = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
function arabicDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getUTCDate()} ${arabicMonths[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function factRecord(final, season, sourceUrl, factType, answer) {
  const canonical = {
    competitionId,
    seasonId: String(season.IdSeason),
    year: Number(String(season.StartDate).slice(0, 4)),
    matchId: String(final.IdMatch),
    factType,
    answer: String(answer),
    homeTeam: teamName(final.Home),
    awayTeam: teamName(final.Away),
    homeScore: Number(final.Home.Score),
    awayScore: Number(final.Away.Score),
    homePenaltyScore: Number.isInteger(final.HomeTeamPenaltyScore) ? final.HomeTeamPenaltyScore : null,
    awayPenaltyScore: Number.isInteger(final.AwayTeamPenaltyScore) ? final.AwayTeamPenaltyScore : null,
    stage: description(final.StageName),
    date: String(final.Date),
  };
  return {
    sourceRecordId: `fifa-world-cup-${canonical.year}-${canonical.matchId}-${factType}`,
    ...canonical,
    sourceUrl,
    sourcePublisher: 'FIFA',
    retrievedAt,
    sourcePayloadHash: crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
  };
}

const seasonsPayload = await fetchJson(seasonsUrl);
const seasons = (seasonsPayload?.Results || []).filter(season => {
  const year = Number(String(season.StartDate || '').slice(0, 4));
  return Number.isInteger(year) && year <= 2018 && year !== 1950;
}).sort((a, b) => String(a.StartDate).localeCompare(String(b.StartDate)));
if (seasons.length !== 20) throw new Error(`عدد نسخ كأس العالم التاريخية المتوقعة 20، والمستلم ${seasons.length}.`);

const matchSets = await Promise.all(seasons.map(season => {
  const url = `${apiBase}/calendar/matches?language=ar&count=500&IdCompetition=${competitionId}&IdSeason=${season.IdSeason}`;
  return fetchJson(url).then(payload => ({ season, url, matches: payload?.Results || [] }));
}));

const records = [];
const finalSummaries = [];
for (const { season, url, matches } of matchSets) {
  const year = Number(String(season.StartDate).slice(0, 4));
  const finals = matches.filter(match => description(match.StageName) === 'المباراة النهائية');
  if (finals.length !== 1) throw new Error(`نسخة ${year}: عدد المباريات النهائية ${finals.length}.`);
  const final = finals[0];
  const home = teamName(final.Home);
  const away = teamName(final.Away);
  const winnerId = String(final.Winner || '');
  const champion = winnerId === String(final.Home?.IdTeam) ? home : winnerId === String(final.Away?.IdTeam) ? away : '';
  const runnerUp = champion === home ? away : champion === away ? home : '';
  const stadium = description(final.Stadium?.Name);
  const city = description(final.Stadium?.CityName);
  const finalDate = arabicDate(final.Date);
  const attendance = final.Attendance == null ? null : Number(final.Attendance);
  if (!home || !away || !champion || !runnerUp || !stadium || !city || !finalDate ||
      !Number.isInteger(final.Home?.Score) || !Number.isInteger(final.Away?.Score)) {
    throw new Error(`نسخة ${year}: بيانات النهائي ناقصة أو غير صالحة.`);
  }
  const score = `${final.Home.Score}–${final.Away.Score}`;
  records.push(
    factRecord(final, season, url, 'champion', champion),
    factRecord(final, season, url, 'runner-up', runnerUp),
    factRecord(final, season, url, 'score', score),
    factRecord(final, season, url, 'stadium', stadium),
    factRecord(final, season, url, 'city', city),
    factRecord(final, season, url, 'date', finalDate),
  );
  finalSummaries.push({
    year, matchId: String(final.IdMatch), home, away, champion, runnerUp, score,
    stadium, city, date: String(final.Date), finalDate, attendance,
    homePenaltyScore: Number.isInteger(final.HomeTeamPenaltyScore) ? final.HomeTeamPenaltyScore : null,
    awayPenaltyScore: Number.isInteger(final.AwayTeamPenaltyScore) ? final.AwayTeamPenaltyScore : null,
  });
}

if (records.length !== 120 || new Set(records.map(record => record.sourceRecordId)).size !== 120) {
  throw new Error('سجل حقائق نهائيات كأس العالم يجب أن يحتوي 120 حقيقة فريدة.');
}

const document = {
  schemaVersion: 1,
  sourceProfile: 'official_dataset_v1',
  competitionId,
  seasonsUrl,
  officialHistoryUrl,
  retrievedAt,
  finals: finalSummaries,
  records,
};
if (write) writeJsonAtomic(output, document);
console.log(JSON.stringify({
  mode: write ? 'write' : 'dry-run', finals: finalSummaries.length, records: records.length,
  output: write ? path.relative(process.cwd(), output) : null, aiCalls: 0, estimatedAiCostUsd: 0,
}, null, 2));
