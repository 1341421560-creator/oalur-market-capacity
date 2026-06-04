/**
 * Oalur ASIN 数据趋势提取 + 价格排名趋势导出（合并版）
 * 
 * 流程（多标签页并行）：
 * 1. 为每个 ASIN 打开新标签页 → 搜索 ASIN → 点击"数据趋势"
 * 2. 提取月度销量/销售额数据（阶段四）
 * 3. 不关弹窗 → 切换到"价格&排名趋势"tab → 点击"导出"（阶段五）
 * 4. 重命名导出的 Excel（加 ASIN 前缀）
 * 5. 关闭弹窗和标签页
 * 
 * 用法: node extract-asin-trends.js "ASIN1,ASIN2,..." [输出文件.json]
 * 示例: node extract-asin-trends.js "B074W66D85,B083QLRBLK" output/日期-B074W66D85-B083QLRBLK/data/trends.json
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function safeSegment(value) {
  return String(value || 'output').trim().toLowerCase().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-');
}

function outputDirs(taskName) {
  const date = new Date().toISOString().split('T')[0];
  const root = path.join(process.cwd(), 'output', `${date}-${safeSegment(taskName)}`);
  return {
    root,
    data: path.join(root, 'data'),
    reports: path.join(root, 'reports'),
    excel: path.join(root, 'excel')
  };
}

const asinArg = process.argv[2];
const taskName = asinArg ? asinArg.split(',').slice(0, 3).join('-') : 'asin-trends';
const dirs = outputDirs(taskName);
const outFile = process.argv[3] || path.join(dirs.data, 'asin-trends.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });

if (!asinArg) {
  console.error('用法: node extract-asin-trends.js "ASIN1,ASIN2,..." [输出文件.json]');
  process.exit(1);
}

const asins = asinArg.split(',').map(s => s.trim()).filter(Boolean);
const DOWNLOAD_DIR = process.env.OALUR_DOWNLOAD_DIR || dirs.excel;
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

// 全局已认领文件集（避免并行 ASIN 抢夺彼此的文件）
const claimedFiles = new Set();

// 获取 excel 输出目录中的所有价格排名趋势 Excel 文件
function getExportFiles() {
  return fs.readdirSync(DOWNLOAD_DIR)
    .filter(f => f.startsWith('价格&排名趋势') && f.endsWith('.xlsx'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(DOWNLOAD_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

async function extractAndExport(browser, asin, index, total) {
  const page = await browser.newPage();
  try {
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOAD_DIR }).catch(() => {});
    console.log(`\n📊 [${index + 1}/${total}] ASIN: ${asin}`);
    
    // ─── 阶段四：提取销量数据 ───
    await page.goto('https://vip.oalur.com/insight/product/search?site=US', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    await page.evaluate((asin) => {
      const input = document.querySelector('input[placeholder*="2000"]') ||
                    document.querySelector('input[placeholder*="支持"]');
      if (input) {
        const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        s.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        s.call(input, asin);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, asin);
    await new Promise(r => setTimeout(r, 500));
    await page.evaluate(() => {
      for (const btn of document.querySelectorAll('button'))
        if (btn.innerText.trim() === '立即查询') { btn.click(); return; }
    });
    await new Promise(r => setTimeout(r, 6000));

    const basicInfo = await page.evaluate(() => {
      const body = document.body.innerText;
      const asinMatch = body.match(/ASIN[：:]\s*([A-Z0-9]{10})/);
      const brandMatch = body.match(/品牌[：:]\s*([^\n]+)/);
      const titleEl = document.querySelector('.el-table__body tr td:nth-child(2)');
      return {
        asin: asinMatch?.[1] || '',
        title: (titleEl?.innerText?.split('\n')[0] || '').substring(0, 120),
        brand: brandMatch?.[1]?.trim() || ''
      };
    });

    console.log(`  [${index + 1}/${total}] 📈 打开数据趋势...`);
    await page.evaluate(() => {
      for (const btn of document.querySelectorAll('button'))
        if (btn.innerText.trim() === '数据趋势') { btn.click(); return; }
    });
    await new Promise(r => setTimeout(r, 8000));

    // 提取月度销量/销售额
    const trendData = await page.evaluate(() => {
      const dialog = document.querySelector('.el-dialog');
      if (!dialog) return null;
      const result = { months: [], monthlySales: [], monthlyRevenue: [], avgPrice: [] };
      const totalMatch = dialog.innerText.match(/全部\s*\(?\s*(\d+)\s*个月/);
      result.totalMonths = totalMatch ? parseInt(totalMatch[1]) : 0;
      const rows = dialog.querySelectorAll('table tr, .el-table__body tr');
      rows.forEach(row => {
        const cells = row.querySelectorAll('td, th');
        if (cells.length < 2) return;
        const fc = cells[0]?.innerText?.trim() || '';
        if (fc === '月份' || (!fc && cells[1]?.innerText?.match(/\d{4}/))) {
          for (let i = 1; i < cells.length; i++) {
            const m = cells[i]?.innerText?.trim() || '';
            if (m && /\d{4}/.test(m)) result.months.push(m);
          }
        }
        if (fc === '月销量') {
          for (let i = 1; i < cells.length; i++) {
            const v = cells[i]?.innerText?.trim() || '';
            if (v) result.monthlySales.push(v);
          }
        }
        if (fc === '月销售额') {
          for (let i = 1; i < cells.length; i++) {
            const v = cells[i]?.innerText?.trim() || '';
            if (v) result.monthlyRevenue.push(v);
          }
        }
      });
      return result;
    });

    const hasData = trendData && trendData.monthlySales.length > 0;
    console.log(`  [${index + 1}/${total}] ${hasData ? '✅' : '⚠️'} 销量趋势: ${hasData ? trendData.monthlySales.length + ' 个月' : '暂无数据'}`);

    // ─── 阶段五：导出价格排名趋势 ───
    console.log(`  [${index + 1}/${total}] 🔄 切换到价格&排名趋势...`);
    
    const tabClicked = await page.evaluate(() => {
      const dialog = document.querySelector('.el-dialog');
      if (!dialog) return false;
      for (const item of dialog.querySelectorAll('.el-tabs__item')) {
        if (item.innerText?.trim() === '价格&排名趋势') {
          item.click();
          return true;
        }
      }
      return false;
    });
    
    if (tabClicked) {
      await new Promise(r => setTimeout(r, 6000)); // 等待图表加载
      
      console.log(`  [${index + 1}/${total}] 📥 点击导出...`);
      await page.evaluate(() => {
        for (const btn of document.querySelectorAll('button')) {
          if (btn.innerText?.trim() === '导出') { btn.click(); return; }
        }
      });
      
      // 等待下载完成
      await new Promise(r => setTimeout(r, 4000 + Math.random() * 3000));
      
      // 找到新下载的文件并认领 + 重命名（全局 claimedFiles 防止并行 ASIN 互相抢文件）
      let newFile, renameRetry = 0;
      let afterFiles = [];
      while (renameRetry < 8) {
        afterFiles = getExportFiles();
        newFile = afterFiles.find(f => !claimedFiles.has(f.name) && !/_B0[A-Z0-9]{8}_/.test(f.name));
        if (newFile) {
          claimedFiles.add(newFile.name);
          break;
        }
        await new Promise(r => setTimeout(r, 2000));
        renameRetry++;
      }
      if (newFile) {
        const oldPath = path.join(DOWNLOAD_DIR, newFile.name);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        const newName = `价格&排名趋势_${asin}_${timestamp}.xlsx`;
        const newPath = path.join(DOWNLOAD_DIR, newName);
        try {
          fs.renameSync(oldPath, newPath);
          console.log(`  [${index + 1}/${total}] ✅ 导出文件: ${newName}`);
        } catch (e) {
          console.log(`  [${index + 1}/${total}] ⚠️ 重命名失败: ${e.message}，文件保留为 ${newFile.name}`);
        }
      } else {
        console.log(`  [${index + 1}/${total}] ⚠️ 未检测到新导出文件（可能已被其他标签页下载）`);
        // 尝试匹配时间最近的文件
        const recentUnknown = afterFiles.filter(f => !beforeFiles.has(f.name));
        if (recentUnknown.length > 0) {
          console.log(`  [${index + 1}/${total}]   候选文件: ${recentUnknown.map(f => f.name).join(', ')}`);
        }
      }
    } else {
      console.log(`  [${index + 1}/${total}] ⚠️ 未找到价格&排名趋势 tab`);
    }

    // 关闭弹窗
    await page.evaluate(() => {
      const cb = document.querySelector('.el-dialog__headerbtn, .el-dialog [aria-label*="Close"]');
      if (cb) cb.click();
    });
    await new Promise(r => setTimeout(r, 1500));

    return {
      asin: basicInfo.asin || asin,
      title: basicInfo.title,
      brand: basicInfo.brand,
      trendData: hasData ? trendData : null,
      totalMonths: trendData?.totalMonths || 0
    };
  } finally {
    await page.close().catch(() => {});
  }
}

(async () => {
  console.log(`\n${'='.repeat(40)}`);
  console.log(`📊 ASIN 数据趋势提取 + 价格排名导出: ${asins.length} 个 ASIN`);
  console.log('='.repeat(40));

  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });

  // 多标签页并行（错峰 1 秒启动）
  console.log(`📑 打开 ${asins.length} 个并行标签页（错峰启动）...`);
  const promises = asins.map((asin, i) => new Promise(async (resolve) => {
    await new Promise(r => setTimeout(r, i * 1000));
    const result = await extractAndExport(browser, asin, i, asins.length);
    resolve(result);
  }));
  let results = await Promise.all(promises);

  // 重试失败的 ASIN
  const failed = results.filter(r => !r.trendData);
  if (failed.length > 0) {
    console.log(`\n🔄 ${failed.length} 个 ASIN 无销量数据，逐一重试...`);
    for (const f of failed) {
      const idx = asins.indexOf(f.asin);
      if (idx > -1) {
        console.log(`\n🔁 重试: ${f.asin}`);
        const retryResult = await extractAndExport(browser, f.asin, idx + 0.5, asins.length);
        results[idx] = retryResult;
      }
    }
  }

  await browser.disconnect();

  const output = {
    asins,
    extractedAt: new Date().toISOString(),
    products: results
  };
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
  
  console.log(`\n✅ 数据已保存: ${outFile}`);
  console.log(`📊 销量数据: ${results.filter(r => r.trendData).length}/${results.length} 个`);
  
  // 列出导出的 Excel 文件
  const finalFiles = getExportFiles();
  const withAsin = finalFiles.filter(f => /\d{4}-\d{2}-\d{2}T/.test(f.name));
  console.log(`📥 价格排名导出: ${withAsin.length} 个 Excel`);
  withAsin.forEach(f => console.log(`   ${f.name}`));

  // 生成合并 ASIN 趋势图 HTML
  const combinedScript = path.join(__dirname, 'generate-asin-trends-combined.js');
  const lifecycleJsonPath = outFile.endsWith('-asin-trends.json')
    ? outFile.replace(/-asin-trends\.json$/, '-asin-lifecycle.json')
    : path.join(path.dirname(outFile), 'asin-lifecycle.json');
  if (fs.existsSync(combinedScript)) {
    console.log(`\n📊 生成合并 ASIN 趋势报告...`);
    try {
      execSync(
        `node "${combinedScript}" "${asinArg}" --json-out "${lifecycleJsonPath}"`,
        { stdio: 'inherit', timeout: 60000 }
      );
    } catch (e) {
      console.log(`⚠️ 合并趋势报告生成失败: ${e.message.substring(0, 80)}`);
    }
  } else {
    console.log(`⚠️ 未找到 generate-asin-trends-combined.js，跳过趋势报告生成`);
  }
})().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
