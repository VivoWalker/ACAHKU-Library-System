/**
 * Fetch series aliases from moegirl.icu
 * Run: node fetch-aliases.js
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SERIES_FILE = path.join(__dirname, 'series-list.json');
const ALIASES_FILE = path.join(__dirname, 'series-aliases.json');

function log(msg) {
  const line = new Date().toISOString().slice(11, 19) + ' ' + msg;
  console.log(line);
  fs.appendFileSync('aliases-fetch.log', line + '\n');
}

function curlGet(url) {
  try {
    return JSON.parse(execSync(
      `curl -sL --max-time 10 -A "Mozilla/5.0" -H "Referer: https://moegirl.icu/" "${url}"`,
      { encoding: 'utf8', timeout: 15000 }
    ));
  } catch (e) { return null; }
}

function extractAlias(text) {
  if (!text) return [];
  const aliases = new Set();
  let m;

  // Clean wikitext markers
  const clean = s => s
    .replace(/\{\{[^}]+\}\}/g, '')   // remove {{ }} templates
    .replace(/\[\[([^|\]]+?\|)?(.+?)\]\]/g, '$2')  // [[link|text]] -> text
    .replace(/<[^>]+>/g, '')          // remove HTML tags
    .replace(/'''/g, '')              // remove bold
    .replace(/''/g, '')              // remove italic
    .replace(/[《》『』「」]/g, '')    // remove quotes
    .trim();

  // Pattern 1: 【别名】xxx (exactly in infobox)
  const pat1 = /【别名】\s*([^【\n]{2,50})/g;
  while ((m = pat1.exec(text)) !== null) {
    const a = clean(m[1]);
    if (a.length >= 2 && a.length <= 30) aliases.add(a);
  }

  // Pattern 2: 位于 infobox section, looking for "别名" field
  // Match lines like: | 别名 = xxx
  const pat2 = /(?:^|[|])[ 　]*别名[为:：]?[  ]*([^\n|]{2,30})/gm;
  while ((m = pat2.exec(text)) !== null) {
    const a = clean(m[1]);
    if (a.length >= 2 && a.length <= 30 && !a.includes('{{')) aliases.add(a);
  }

  // Pattern 3: 简称：xxx (standalone lines)
  const pat3 = /(?:^|[，,\n])[ 　]*(?:简称|缩写)[为:：]?[  ]*([^\n，,]{2,20})/gm;
  while ((m = pat3.exec(text)) !== null) {
    const a = clean(m[1]);
    if (a.length >= 2 && a.length <= 20 && !a.includes('{{') && !a.includes('[[')) aliases.add(a);
  }

  return [...aliases];
}

async function getAliases(seriesName) {
  const searchUrl = `https://moegirl.icu/api.php?action=query&list=search&srsearch=${encodeURIComponent(seriesName)}&format=json`;
  const data = curlGet(searchUrl);
  if (!data?.query?.search?.length) return [];

  for (const result of data.query.search.slice(0, 3)) {
    const title = result.title;
    const wikitextUrl = `https://moegirl.icu/api.php?action=parse&page=${encodeURIComponent(title)}&format=json&prop=wikitext`;
    const wData = curlGet(wikitextUrl);
    const text = wData?.parse?.wikitext?.['*'] || '';
    const found = extractAlias(text);
    if (found.length > 0) return { aliases: found, matchedTitle: title };
  }
  return { aliases: [], matchedTitle: null };
}

async function main() {
  fs.writeFileSync('aliases-fetch.log', '');

  let series;
  try {
    series = JSON.parse(fs.readFileSync(SERIES_FILE, 'utf8'));
  } catch (e) {
    log('Error: series-list.json not found'); process.exit(1);
  }

  const uniqueSeries = [];
  const seen = new Set();
  for (const s of series) {
    const key = `${s.author_id}_${s.series_id}`;
    if (!seen.has(key)) { seen.add(key); uniqueSeries.push(s); }
  }

  let aliases = {};
  try { aliases = JSON.parse(fs.readFileSync(ALIASES_FILE, 'utf8')); } catch (e) { }

  const alreadyDone = Object.values(aliases).filter(a => a && typeof a === 'object' && Array.isArray(a) && a.length > 0).length;
  log(`Start: ${uniqueSeries.length} series, done: ${alreadyDone}`);

  let done = 0, found = 0;

  for (const s of uniqueSeries) {
    const key = `${s.author_id}_${s.series_id}`;
    if (aliases[key] && typeof aliases[key] === 'object' && Array.isArray(aliases[key]) && aliases[key].length > 0) { done++; continue; }

    const seriesName = s.title
      .replace(/\s*\d+$/, '').replace(/\s*第?\d+卷?$/, '')
      .replace(/\s*\(.*?\)$/, '').replace(/第\d+章.*$/, '').trim();

    if (!seriesName) { done++; continue; }

    let result;
    try {
      result = await getAliases(seriesName);
    } catch(e) {
      log('ERROR getAliases for ' + key + ': ' + e.message);
      result = { aliases: [], matchedTitle: null };
    }
    if (!result || !result.aliases) {
      aliases[key] = [];
    } else if (result.aliases.length > 0) {
      aliases[key] = result.aliases;
      found++;
      log(`ALIAS: [${key}] "${seriesName}" <- "${result.matchedTitle}": ${result.aliases.join(', ')}`);
    } else {
      aliases[key] = [];
    }

    done++;
    if (done % 20 === 0) {
      fs.writeFileSync(ALIASES_FILE, JSON.stringify(aliases, null, 2));
      log(`Progress: ${done}/${uniqueSeries.length}, found: ${found}`);
    }

    await new Promise(r => setTimeout(r, 300));
  }

  fs.writeFileSync(ALIASES_FILE, JSON.stringify(aliases, null, 2));
  log(`Done! Aliases found for ${found}/${uniqueSeries.length} series`);
}

main().catch(e => { log('ERROR: ' + e.message); process.exit(1); });
