/**
 * Tag fetcher - Bangumi (bgm.tv) API
 * Run: node fetch-tags.js
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'library.db');
const SERIES_FILE = path.join(__dirname, 'series-list.json');
const TAGS_FILE = path.join(__dirname, 'series-tags.json');

const httpGet = (url, redirects = 0) => new Promise((res, rej) => {
  if (redirects > 5) { res(null); return; }
  const mod = url.startsWith('https') ? https : http;
  mod.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120', 'Accept': 'application/json, text/html' }
  }, r => {
    if (r.statusCode === 301 || r.statusCode === 302) {
      let loc = r.headers.location;
      if (loc && !loc.startsWith('http')) loc = 'https://' + url.split('/')[2] + loc;
      httpGet(loc, redirects + 1).then(res).catch(rej); return;
    }
    if (r.statusCode !== 200) { res(null); return; }
    const chunks = []; r.on('data', c => chunks.push(c));
    r.on('end', () => {
      try { res(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { res(null); }
    });
  }).on('error', rej);
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Normalize Bangumi tags to our standard set
function normalizeTags(tags) {
  const STANDARD_TAGS = ['恋爱', '校园', '热血', '奇幻', '科幻', '冒险', '推理', '日常', '百合', '耽美', '后宫', '喜剧', '运动', '音乐', '恐怖', '格斗', '机战', '战争', '治愈', '轻小说', '悬疑', '神魔', '社团'];

  // Remove author names and non-genre tags
  const exclude = ['橘公司', '轻小說', '已完结', '日本', '漫画系列', '川原礫', '丸户史明', '蔗糖', '甘岸', 'lofuse', 'よう uncertainty'];

  const result = new Set();
  for (const t of tags) {
    if (exclude.includes(t)) continue;
    if (STANDARD_TAGS.includes(t)) { result.add(t); continue; }
    // Map related tags
    const map = {
      '后宫向': '后宫', '后宫向作品': '后宫', '恋爱喜剧': '恋爱',
      '青春': '恋爱', '校园恋爱': '恋爱',
      '奇幻': '奇幻', '幻想': '奇幻', '魔法': '奇幻', '异世界': '奇幻',
      '科幻': '科幻', 'SF': '科幻',
      '冒险': '冒险', '战斗': '热血', '动作': '热血',
      '推理': '推理', '侦探': '推理', '破案': '推理',
      '日常': '日常', '生活': '日常', '社团': '社团',
      '百合': '百合', 'GL': '百合', 'Girls Love': '百合',
      '耽美': '耽美', 'BL': '耽美', 'boys love': '耽美', 'BL向': '耽美',
      '喜剧': '喜剧', '搞笑': '喜剧', '欢乐向': '喜剧',
      '运动': '运动', '竞技': '运动', '球类': '运动',
      '音乐': '音乐', '偶像': '偶像',
      '恐怖': '恐怖', '惊悚': '恐怖', '灵异': '恐怖',
      '格斗': '格斗', '武术': '格斗',
      '机战': '机战', '机器人': '机战',
      '战争': '战争', '军事': '战争',
      '治愈': '治愈', '致郁': '治愈',
      '轻小说': '轻小说', 'ラノベ': '轻小说',
      '悬疑': '悬疑', '推理悬疑': '悬疑',
      '神魔': '神魔', '超自然': '神魔', '妖怪': '神魔',
    };
    if (map[t]) result.add(map[t]);
    else if (STANDARD_TAGS.some(std => t.includes(std))) result.add(STANDARD_TAGS.find(std => t.includes(std)));
  }
  return [...result].slice(0, 5);
}

// Extract series name from volume title
function extractSeriesName(title) {
  if (!title) return '';
  return title
    .replace(/\s*\d+$/, '')
    .replace(/\s*[\uff10-\uff19]+$/, '')
    .replace(/\s*\(第?\d+卷?\)$/, '')
    .replace(/\s*第?\d+卷?$/, '')
    .replace(/\s*\(\d+\)$/, '')
    .trim();
}

async function searchAndGetTags(query, options = {}) {
  try {
    const url = `https://api.bgm.tv/search/subject/${encodeURIComponent(query)}?type=1&max_results=5`;
    const data = await httpGet(url);
    if (!data || !data.list || data.list.length === 0) return [];

    // Find best match
    let best = data.list[0];
    if (options.author) {
      // Prefer results where author/artist info might match
      for (const item of data.list) {
        if (item.name && item.name.includes(options.author)) { best = item; break; }
      }
    }

    if (!best || !best.id) return [];

    // Get tags for this subject
    const subjectUrl = `https://api.bgm.tv/v0/subjects/${best.id}`;
    const subject = await httpGet(subjectUrl);
    if (!subject || !subject.tags) return [];

    const tagNames = subject.tags.map(t => t.name);
    return normalizeTags(tagNames);
  } catch (e) { return []; }
}

async function main() {
  let series;
  try {
    series = JSON.parse(fs.readFileSync(SERIES_FILE, 'utf8'));
  } catch (e) {
    console.error('series-list.json not found. Run extraction first.');
    process.exit(1);
  }

  let existingTags = {};
  try {
    existingTags = JSON.parse(fs.readFileSync(TAGS_FILE, 'utf8'));
  } catch (e) { }

  console.log(`Series: ${series.length}, already tagged: ${Object.keys(existingTags).length}`);

  let matched = 0, missed = 0, total = series.length;
  const MISS_THRESHOLD = 50; // After 50 misses, slow down

  for (const s of series) {
    const key = `${s.author_id}_${s.series_id}`;
    if (existingTags[key] && existingTags[key].length > 0 && existingTags[key][0] !== '未知') {
      matched++; continue;
    }

    const seriesName = extractSeriesName(s.title);
    if (!seriesName) { missed++; continue; }

    let tags = [];

    // Strategy 1: exact title search
    tags = await searchAndGetTags(seriesName, { author: s.author_name });

    // Strategy 2: try title + 小说/轻小说
    if (!tags.length) {
      tags = await searchAndGetTags(seriesName + ' 轻小说');
    }

    // Strategy 3: try just main keywords (remove common suffixes)
    if (!tags.length) {
      const keywords = seriesName.split(/\s+/).slice(0, 3).join(' ');
      tags = await searchAndGetTags(keywords);
    }

    if (tags.length > 0) {
      existingTags[key] = tags;
      matched++;
    } else {
      existingTags[key] = ['未知'];
      missed++;
      console.log(`MISS: [${key}] ${seriesName} (${s.author_name})`);
    }

    // Progress save every 10
    if ((matched + missed) % 10 === 0) {
      fs.writeFileSync(TAGS_FILE, JSON.stringify(existingTags, null, 2));
      console.log(`Progress: ${matched + missed}/${total} | Matched: ${matched} | Missed: ${missed}`);
    }

    // Adaptive delay - slow down after many misses
    const delay = missed > MISS_THRESHOLD ? 400 : 250;
    await sleep(delay);
  }

  fs.writeFileSync(TAGS_FILE, JSON.stringify(existingTags, null, 2));

  // Print summary
  const tagCounts = {};
  for (const tags of Object.values(existingTags)) {
    for (const t of tags) {
      tagCounts[t] = (tagCounts[t] || 0) + 1;
    }
  }
  const sorted = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);

  console.log(`\nDone! Matched: ${matched}, Missed: ${missed}`);
  console.log('\nTag distribution:');
  sorted.slice(0, 20).forEach(([t, c]) => console.log(`  ${t}: ${c}`));

  // Print some examples
  console.log('\nSample tagged series:');
  const shown = new Set();
  for (const [k, tags] of Object.entries(existingTags)) {
    if (tags[0] === '未知' || shown.size >= 8) continue;
    const s = series.find(s => `${s.author_id}_${s.series_id}` === k);
    if (s && !shown.has(k)) { shown.add(k); console.log(`  ${s.title}: ${tags.join(', ')}`); }
  }
}

main().catch(console.error);
