const puppeteer = require('puppeteer-core');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const asin = process.argv[2] || 'B091FBB2KW';

function summarizeJson(value, depth = 0) {
  if (depth > 3) return typeof value;
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      first: value.length ? summarizeJson(value[0], depth + 1) : null
    };
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).slice(0, 30);
    const out = { type: 'object', keys };
    for (const key of keys.slice(0, 10)) out[key] = summarizeJson(value[key], depth + 1);
    return out;
  }
  return value;
}

async function main() {
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
  const page = await browser.newPage();
  const captured = [];

  page.on('response', async response => {
    const req = response.request();
    const url = response.url();
    const type = req.resourceType();
    if (!['xhr', 'fetch'].includes(type)) return;
    if (!/oalur|api|trend|history|rank|asin|product|goods|bsr/i.test(url)) return;
    try {
      const contentType = response.headers()['content-type'] || '';
      const text = await response.text();
      if (!text || text.length < 20) return;
      let parsed = null;
      if (contentType.includes('json') || /^[\[{]/.test(text.trim())) {
        try { parsed = JSON.parse(text); } catch {}
      }
      captured.push({
        status: response.status(),
        type,
        url,
        contentType,
        textSample: parsed ? undefined : text.slice(0, 300),
        summary: parsed ? summarizeJson(parsed) : undefined
      });
    } catch {}
  });

  await page.goto('https://vip.oalur.com/insight/product/search?site=US', {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });
  await sleep(3000);

  await page.evaluate((value) => {
    const input =
      document.querySelector('input[placeholder*="2000"]') ||
      document.querySelector('input[placeholder*="支持"]');
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
  await sleep(8000);

  console.log(JSON.stringify({
    asin,
    capturedCount: captured.length,
    captured: captured.slice(-30)
  }, null, 2));

  await page.close();
  await browser.disconnect();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
