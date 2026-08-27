#!/usr/bin/env node
import crypto from 'node:crypto';
import path from 'node:path';
import { CONTENT_DIR, writeJsonAtomic } from './lib.mjs';

const write = process.argv.includes('--write');
const output = path.join(CONTENT_DIR, 'structured-sources', 'fifa-world-cup-matches.json');
const apiBase = 'https://api.fifa.com/api/v3';
const competitionId = '17';
const retrievedAt = new Date().toISOString();
const seasonsUrl = `${apiBase}/seasons?idCompetition=${competitionId}&language=ar&count=100`;
const excludedQuestionContent = /إسرائيل|اسرائيل|إسرائيلي|اسرائيلي|تل أبيب|تل ابيب/i;

async function fetchJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'FatinahQuestionBank/1.3 (https://ata20.com)' },
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
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

const seasonsPayload = await fetchJson(seasonsUrl);
const seasons = (seasonsPayload?.Results || []).filter(season => {
  const year = Number(String(season.StartDate || '').slice(0, 4));
  return Number.isInteger(year) && year >= 1970 && year <= 2018;
}).sort((a, b) => String(a.StartDate).localeCompare(String(b.StartDate)));
if (seasons.length < 13) throw new Error(`عدد نسخ FIFA التاريخية غير كافٍ: ${seasons.length}.`);

const records = [];
for (const season of seasons) {
  const year = Number(String(season.StartDate).slice(0, 4));
  const sourceUrl = `${apiBase}/calendar/matches?language=ar&count=500&IdCompetition=${competitionId}&IdSeason=${season.IdSeason}`;
  const payload = await fetchJson(sourceUrl);
  for (const match of payload?.Results || []) {
    const home = teamName(match.Home);
    const away = teamName(match.Away);
    if (excludedQuestionContent.test(`${home} ${away}`)) continue;
    const stage = description(match.StageName);
    const stadium = description(match.Stadium?.Name);
    const city = description(match.Stadium?.CityName);
    const homeScore = Number(match.Home?.Score);
    const awayScore = Number(match.Away?.Score);
    const winnerId = String(match.Winner || '');
    const winner = winnerId === String(match.Home?.IdTeam) ? home
      : winnerId === String(match.Away?.IdTeam) ? away : '';
    const loser = winner === home ? away : winner === away ? home : '';
    if (!home || !away || !stage || !stadium || !city || !winner || !loser ||
        !Number.isInteger(homeScore) || !Number.isInteger(awayScore)) continue;
    const canonical = {
      competitionId, seasonId: String(season.IdSeason), year,
      matchId: String(match.IdMatch), home, away, winner, loser,
      homeScore, awayScore, stage, stadium, city, date: String(match.Date || ''),
    };
    records.push({
      sourceRecordId: `fifa-match-${year}-${canonical.matchId}`,
      ...canonical, sourceUrl, sourcePublisher: 'FIFA', retrievedAt,
      sourcePayloadHash: crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
    });
  }
}

const unique = [...new Map(records.map(record => [record.sourceRecordId, record])).values()];
if (unique.length < 500) throw new Error(`عدد مباريات FIFA الصالحة أقل من المتوقع: ${unique.length}.`);
const document = { schemaVersion: 1, sourceProfile: 'official_dataset_v1', competitionId,
  seasonsUrl, retrievedAt, records: unique };
if (write) writeJsonAtomic(output, document);
console.log(JSON.stringify({ mode: write ? 'write' : 'dry-run', seasons: seasons.length,
  records: unique.length, output: write ? path.relative(process.cwd(), output) : null,
  aiCalls: 0, estimatedAiCostUsd: 0 }, null, 2));
