/**
 * Google Trends 数据提取脚本
 * 提取指定关键词最近5年的搜索兴趣趋势数据
 * 
 * 用法: node extract-google-trends.js "关键词" [输出文件.json]
 * 示例: node extract-google-trends.js "Biscuit Cutter" output/日期-Biscuit-Cutter/data/gt-data.json
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { activatePage } = require('./browser-page-utils');

function safeSegment(value) {
  return String(value || 'output').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-');
}

function outputDirs(taskName) {
  const date = new Date().toISOString().split('T')[0];
  const root = path.join(process.cwd(), 'output', `${date}-${safeSegment(taskName)}`);
  return {
    data: path.join(root, 'data')
  };
}

const keyword = process.argv[2];
const defaultOut = keyword ? safeSegment(keyword) + '-google-trends.json' : '';
const outFile = process.argv[3] || path.join(outputDirs(keyword || 'output').data, defaultOut);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const GOOGLE_TRENDS_EXPLORE_BASE = 'https://trends.google.com/trends/explore?date=today%205-y&geo=US&hl=zh-CN';

if (!keyword) {
  console.error('用法: node extract-google-trends.js "关键词" [输出文件.json]');
  process.exit(1);
}

function parseTrendDate(text) {
  const value = String(text || '').trim();
  const chinese = value.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (chinese) {
    return `${chinese[1]}-${chinese[2].padStart(2, '0')}-${chinese[3].padStart(2, '0')}`;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function stripGooglePrefix(text) {
  return String(text || '').replace(/^\)\]\}',?\n/, '');
}

function timelineDataToPoints(timelineData) {
  return (timelineData || [])
    .map(point => ({
      date: new Date(Number(point.time) * 1000).toISOString().slice(0, 10),
      value: Number(Array.isArray(point.value) ? point.value[0] : point.value)
    }))
    .filter(point => point.date && Number.isFinite(point.value));
}

function buildResult(kw, points, extractionMode) {
  const peak = points.reduce((a, b) => a.value > b.value ? a : b, points[0]);
  const valley = points.reduce((a, b) => a.value < b.value ? a : b, points[0]);
  return {
    keyword: kw,
    source: 'google-trends-page',
    extractionMode,
    geo: 'US',
    period: 'past 5 years',
    exploreUrl: `${GOOGLE_TRENDS_EXPLORE_BASE}&q=${encodeURIComponent(kw)}`,
    extractedAt: new Date().toISOString(),
    totalPoints: points.length,
    data5Years: points,
    peak: { date: peak.date, value: peak.value },
    valley: { date: valley.date, value: valley.value },
  };
}

async function extractTextTableData(page) {
  const rows = await page.evaluate(() => {
    const lines = document.body.innerText.split('\n');
    const result = [];
    const headerIdx = lines.findIndex(line => line.trim() === 'x\ty1');
    if (headerIdx < 0) return result;

    for (let i = headerIdx + 1; i < lines.length; i++) {
      const parts = lines[i].trim().split('\t');
      if (parts.length === 2 && Number.isFinite(Number(parts[1]))) {
        result.push({ dateText: parts[0], value: Number(parts[1]) });
      } else if (parts[0] && result.length) {
        break;
      }
    }
    return result;
  });
  return rows
    .map(row => ({ date: parseTrendDate(row.dateText), value: row.value }))
    .filter(row => row.date && Number.isFinite(row.value));
}

async function extract(browser, kw) {
  const page = await browser.newPage();
  let capturedPoints = [];
  page.on('response', async response => {
    try {
      if (!response.url().includes('/trends/api/widgetdata/multiline')) return;
      const json = JSON.parse(stripGooglePrefix(await response.text()));
      const points = timelineDataToPoints(json.default?.timelineData || []);
      if (points.length > capturedPoints.length) capturedPoints = points;
    } catch (error) {
      // Keep page extraction resilient when Google changes response shape.
    }
  });

  try {
    await activatePage(page);
    const url = `${GOOGLE_TRENDS_EXPLORE_BASE}&q=${encodeURIComponent(kw)}`;

    console.log('Opening Google Trends explore page...');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 10000));

    let points = capturedPoints;
    let extractionMode = 'page-network';
    if (points.length === 0) {
      console.log('No timeline response captured from the page; trying page text table extraction...');
      points = await extractTextTableData(page);
      extractionMode = 'page-text';
    }

    if (points.length === 0) {
      console.log('No Google Trends page data extracted');
      const empty = {
        keyword: kw,
        source: 'google-trends-page',
        geo: 'US',
        period: 'past 5 years',
        exploreUrl: url,
        error: 'no page timeline data extracted',
        extractedAt: new Date().toISOString()
      };
      fs.writeFileSync(outFile, JSON.stringify(empty, null, 2));
      return empty;
    }

    const result = buildResult(kw, points, extractionMode);
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf-8');
    console.log(`Page extracted ${points.length} points (${extractionMode})`);
    console.log(`  Range: ${points[0].date} ~ ${points[points.length - 1].date}`);
    console.log(`  Peak: ${result.peak.date}=${result.peak.value}`);
    console.log(`  Valley: ${result.valley.date}=${result.valley.value}`);
    console.log(`Data saved: ${outFile}`);
    return result;
  } finally {
    await page.close().catch(() => {});
  }
}

(async () => {
  console.log(`\n${'='.repeat(40)}`);
  console.log(`🔍 Google Trends: "${keyword}"`);
  console.log('='.repeat(40));

  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null, protocolTimeout: 600000 });
  try {
    await extract(browser, keyword);
  } finally {
    await browser.disconnect();
  }
})().catch(err => {
  console.error('❌ Error:', err.message);
  if (!fs.existsSync(outFile)) {
    fs.writeFileSync(outFile, JSON.stringify({ keyword, error: err.message }, null, 2));
  }
  process.exit(1);
});

