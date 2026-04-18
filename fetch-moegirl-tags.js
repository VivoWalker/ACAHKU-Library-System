/**
 * Fetch genre tags from moegirl.icu for unknown series
 * Uses curl subprocess to bypass Cloudflare
 * Run: node fetch-moegirl-tags.js
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SERIES_FILE = path.join(__dirname, 'series-list.json');
const TAGS_FILE = path.join(__dirname, 'series-tags.json');
const BACKUP_FILE = path.join(__dirname, 'series-tags-moegirl.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function curlGet(url) {
  try {
    const output = execSync(
      `curl -sL --max-time 10 -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" -H "Accept-Language: zh-CN,zh;q=0.9" -H "Referer: https://moegirl.icu/" "${url}"`,
      { encoding: 'utf8', timeout: 15000 }
    );
    return JSON.parse(output);
  } catch (e) {
    return null;
  }
}

function mapCategoryToTag(cat) {
  const map = {
    '校園題材': '校园', '校园题材': '校园', '学园题材': '校园',
    'GL题材': '百合', '百合题材': '百合', 'GL': '百合',
    'BL题材': '耽美', 'BL向': '耽美', '耽美题材': '耽美',
    '恋爱题材': '恋爱', '恋爱喜剧': '恋爱', '青春恋爱': '恋爱',
    '奇幻题材': '奇幻', '幻想题材': '奇幻', '魔法': '奇幻', '异世界': '奇幻',
    '科幻题材': '科幻', 'SF': '科幻', '虚拟现实题材': '科幻', '近未来题材': '科幻',
    '冒险题材': '冒险', '战斗题材': '热血', '战斗': '热血',
    '推理题材': '推理', '侦探题材': '推理', '悬疑': '推理',
    '日常题材': '日常', '生活': '日常', '社团题材': '社团',
    '后宫题材': '后宫', '后宫向': '后宫',
    '喜剧题材': '喜剧', '搞笑': '喜剧', '欢乐向': '喜剧',
    '运动题材': '运动', '竞技': '运动',
    '音乐题材': '音乐', '偶像题材': '音乐',
    '恐怖题材': '恐怖', '惊悚': '恐怖',
    '格斗题材': '格斗', '武术': '格斗',
    '机战题材': '机战', '机器人': '机战',
    '战争题材': '战争', '军事': '战争',
    '治愈题材': '治愈', '致郁': '治愈',
    '轻小说改编': '轻小说', '轻小说': '轻小说',
    '悬疑题材': '悬疑',
    '神魔题材': '神魔', '妖怪题材': '神魔', '超自然': '神魔',
    '社团题材': '社团',
    '游戏题材': '奇幻', '死亡游戏题材': '热血', '刀剑题材': '奇幻',
    '社会题材': '日常',
  };
  return map[cat] || null;
}

// Generate search variants for a title
function titleVariants(title) {
  const variants = new Set();

  // Clean title (remove volume/series numbers)
  let cleaned = title
    .replace(/\s*\d+$/, '')
    .replace(/\s*第?\d+卷?$/, '')
    .replace(/\s*\(第?\d+卷?\)$/, '')
    .replace(/\s*\(.*?\)$/, '')
    .replace(/第\d+章.*$/, '')
    .replace(/\s*\d+\s*$/, '')
    .trim();

  variants.add(cleaned);

  // Common substitutions
  const subs = [
    ['哪有那么', '哪有这麼', '哪有这么多', '哪有这么多'],
    ['裏', '裡'],
    ['零', '零'],
    ['會', '会'],
    ['學', '学'],
    ['發', '发'],
    ['說', '说'],
    ['與', '与'],
    ['說', '说'],
    ['愛', '爱'],
    ['戀', '恋'],
    ['開', '开'],
    ['開', '开'],
    ['關', '关'],
    ['動', '动'],
    ['畫', '画'],
    ['書', '书'],
    ['経', '经'],
    ['収', '收'],
    ['當', '当'],
    ['適合', '适合'],
    ['BOYS', 'boys'],
    ['COMIC', 'comic'],
    ['PART', 'part'],
    ['TYPE', 'type'],
    ['STAGE', 'stage'],
    ['STORY', 'story'],
    [' chronicle', ' Chronicle'],
    ['THE', 'the'],
    ['‐', '-'], ['–', '-'], ['—', '-'],
  ];

  for (const [from, to] of subs) {
    if (cleaned.includes(from)) {
      variants.add(cleaned.replace(from, to));
    }
  }

  // Try just first meaningful phrase
  const words = cleaned.split(/\s+/).slice(0, 3).join(' ');
  if (words !== cleaned) variants.add(words);

  // Try main keyword (first 4-6 chars usually the series name)
  const mainWord = cleaned.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').slice(0, 6);
  if (mainWord.length >= 4) variants.add(mainWord);

  return [...variants];
}

async function getMoegirlTags(seriesName, originalTitle) {
  // Try multiple search variants
  const variants = titleVariants(seriesName);
  const tried = new Set();

  for (const variant of variants) {
    if (tried.has(variant)) continue;
    tried.add(variant);

    const searchUrl = `https://moegirl.icu/api.php?action=query&list=search&srsearch=${encodeURIComponent(variant)}&format=json`;
    const data = curlGet(searchUrl);
    if (!data?.query?.search?.length) continue;

    // Try top 3 results
    for (const result of data.query.search.slice(0, 3)) {
      const pageTitle = result.title;
      const catUrl = `https://moegirl.icu/api.php?action=parse&page=${encodeURIComponent(pageTitle)}&format=json&prop=categories`;
      const catData = curlGet(catUrl);
      if (!catData?.parse?.categories) continue;

      const cats = catData.parse.categories.map(c => c['*']).filter(Boolean);
      const ourTags = new Set();
      for (const cat of cats) {
        const t = mapCategoryToTag(cat);
        if (t) ourTags.add(t);
      }
      if (ourTags.size > 0) {
        return { tags: [...ourTags], matchedTitle: pageTitle };
      }
    }
  }
  return { tags: [], matchedTitle: null };
}

async function main() {
  let series;
  try {
    series = JSON.parse(fs.readFileSync(SERIES_FILE, 'utf8'));
  } catch (e) {
    console.error('series-list.json not found.'); process.exit(1);
  }

  let existingTags = JSON.parse(fs.readFileSync(TAGS_FILE, 'utf8'));
  let moegirlTags = {};
  try { moegirlTags = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8')); } catch (e) { }

  const unknownList = series.filter(s => {
    const key = `${s.author_id}_${s.series_id}`;
    return !existingTags[key] || existingTags[key][0] === '未知';
  });

  console.log(`Series: ${series.length}, Unknown: ${unknownList.length}`);

  let matched = 0, missed = 0, total = unknownList.length;

  for (const s of unknownList) {
    const key = `${s.author_id}_${s.series_id}`;
    if (moegirlTags[key] && moegirlTags[key][0] !== '未知') { matched++; continue; }

    const seriesName = s.title.replace(/\s*\d+$/, '').replace(/\s*第?\d+卷?$/, '').replace(/\s*\(.*?\)$/, '').trim();
    if (!seriesName) { missed++; continue; }

    const result = await getMoegirlTags(seriesName, s.title);

    if (result.tags.length > 0) {
      moegirlTags[key] = result.tags;
      matched++;
      console.log(`MATCH: [${key}] "${seriesName}" -> "${result.matchedTitle}" | ${result.tags.join(', ')}`);
    } else {
      moegirlTags[key] = ['未知'];
      missed++;
      console.log(`MISS:  [${key}] "${seriesName}"`);
    }

    if ((matched + missed) % 20 === 0) {
      fs.writeFileSync(BACKUP_FILE, JSON.stringify(moegirlTags, null, 2));
      console.log(`Progress: ${matched + missed}/${total} | Matched: ${matched} | Missed: ${missed}`);
    }

    await sleep(250);
  }

  fs.writeFileSync(BACKUP_FILE, JSON.stringify(moegirlTags, null, 2));
  console.log(`\nDone! Matched: ${matched}, Missed: ${missed}`);
}

main().catch(console.error);
