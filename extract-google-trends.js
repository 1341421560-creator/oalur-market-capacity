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

if (!keyword) {
  console.error('用法: node extract-google-trends.js "关键词" [输出文件.json]');
  process.exit(1);
}

// 中文日期 → YYYY-MM-DD
function parseChineseDate(text) {
  const m = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

async function extract(browser, kw) {
  const page = await browser.newPage();
  const url = `https://trends.google.com/trends/explore?geo=US&q=${encodeURIComponent(kw)}`;

  console.log(`🌐 导航至 Google Trends...`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 5000));

  // 切换到"过去 5 年"
  console.log('⏰ 设置时间范围: 过去 5 年...');
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      const t = el.innerText?.trim() || '';
      if (t === '过去 12 个月' || t === 'Past 12 months') { el.click(); break; }
    }
  });
  await new Promise(r => setTimeout(r, 2000));
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      const t = el.innerText?.trim() || '';
      if (t === '过去 5 年' || t === 'Past 5 years') { el.click(); break; }
    }
  });
  await new Promise(r => setTimeout(r, 6000));

  // 提取 CSV 数据（页面内嵌格式: x\ty1 → date\tvalue）
  console.log('📥 提取趋势数据...');
  const data = await page.evaluate(() => {
    const text = document.body.innerText;
    const lines = text.split('\n');
    const result = [];

    const headerIdx = lines.findIndex(l => l.trim() === 'x\ty1');
    if (headerIdx < 0) return result;

    for (let i = headerIdx + 1; i < lines.length; i++) {
      const parts = lines[i].trim().split('\t');
      if (parts.length === 2 && parts[0].includes('年') && !isNaN(parseInt(parts[1]))) {
        result.push({ date: parts[0], value: parseInt(parts[1]) });
      } else if (parts[0] && !parts[0].includes('年')) {
        break; // 数据结束
      }
    }
    return result;
  });

  if (data.length === 0) {
    console.log('⚠️ 未提取到数据');
    const empty = { keyword: kw, error: 'no data extracted' };
    fs.writeFileSync(outFile, JSON.stringify(empty, null, 2));
    await page.close();
    return empty;
  }

  // 转换为标准日期格式
  const parsed = data.map(d => ({
    date: parseChineseDate(d.date),
    value: d.value
  })).filter(d => d.date);

  console.log(`📊 提取到 ${parsed.length} 个数据点`);

  // 截取最近5年
  const now = new Date();
  const fiveYearsAgo = new Date(now);
  fiveYearsAgo.setFullYear(now.getFullYear() - 5);
  const cutoff = fiveYearsAgo.toISOString().substring(0, 10);
  const recent5y = parsed.filter(d => d.date >= cutoff);

  // 找峰谷
  const peak = recent5y.reduce((a, b) => a.value > b.value ? a : b, recent5y[0]);
  const valley = recent5y.reduce((a, b) => a.value < b.value ? a : b, recent5y[0]);

  console.log(`  范围: ${recent5y[0].date} ~ ${recent5y[recent5y.length-1].date}`);
  console.log(`  峰值: ${peak.date}=${peak.value}`);
  console.log(`  低谷: ${valley.date}=${valley.value}`);

  const result = {
    keyword: kw,
    source: 'google-trends',
    geo: 'US',
    period: '过去5年',
    extractedAt: new Date().toISOString(),
    totalPoints: parsed.length,
    data5Years: recent5y,
    peak: { date: peak.date, value: peak.value },
    valley: { date: valley.date, value: valley.value },
  };

  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));
  console.log(`✅ 数据已保存: ${outFile}`);

  await page.close();
  return result;
}

(async () => {
  console.log(`\n${'='.repeat(40)}`);
  console.log(`🔍 Google Trends: "${keyword}"`);
  console.log('='.repeat(40));

  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
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
