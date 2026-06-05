const puppeteer = require('puppeteer-core');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const asin = process.argv[2] || 'B091FBB2KW';

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
  const page = await browser.newPage();
  let bsr = null;

  page.on('response', async response => {
    const url = response.url();
    if (!url.includes(asin) || !url.includes('bsrTrends')) return;
    try {
      bsr = JSON.parse(await response.text()).data;
    } catch {}
  });

  await page.goto('https://vip.oalur.com/insight/product/search?site=US', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);
  await page.evaluate(value => {
    const input = document.querySelector('input[placeholder*="2000"]') || document.querySelector('input[placeholder*="支持"]');
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, asin);
  await sleep(500);
  await page.evaluate(() => {
    for (const button of document.querySelectorAll('button')) {
      if (button.innerText.trim() === '立即查询') {
        button.click();
        return;
      }
    }
  });
  await sleep(6000);
  await page.evaluate(() => {
    for (const button of document.querySelectorAll('button')) {
      if (button.innerText.trim() === '数据趋势') {
        button.click();
        return;
      }
    }
  });
  await sleep(8000);
  await page.evaluate(() => {
    const dialog = document.querySelector('.el-dialog');
    if (!dialog) return;
    for (const item of dialog.querySelectorAll('.el-tabs__item')) {
      if (item.innerText.trim() === '价格&排名趋势') {
        item.click();
        return;
      }
    }
  });
  for (let i = 0; i < 15 && !bsr; i++) await sleep(1000);

  const history = bsr?.bsrAllHistory || {};
  const dates = history.dates || [];
  const keys = Object.keys(history).filter(k => k !== 'dates' && Array.isArray(history[k]));
  const keySummary = keys.map(key => ({
    key,
    length: history[key].length,
    first: history[key].find(v => v != null),
    last: [...history[key]].reverse().find(v => v != null),
    topMatch: bsr?.top?.find(c => c.categoryId === key) || null,
    lastMatch: bsr?.last?.find(c => c.categoryId === key) || null
  }));

  console.log(JSON.stringify({
    asin,
    top: bsr?.top,
    last: bsr?.last,
    dateCount: dates.length,
    keys: keySummary,
    categoryDataTopKeys: Object.keys(bsr?.categoryData?.top || {}),
    categoryDataFullPathKeys: Object.keys(bsr?.categoryData?.fullPath || {})
  }, null, 2));

  await page.close();
  await browser.disconnect();
})().catch(error => {
  console.error(error);
  process.exit(1);
});
