const fs = require('fs');
const file = 'extract-seasonality.js';
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
const start = lines.findIndex(line => line.includes('if (bsrDataFile && fs.existsSync(bsrDataFile)) {'));
const end = lines.findIndex((line, index) => index > start && line.includes('Step 4:'));
if (start < 0 || end < 0) throw new Error(`Could not find Step 3 block: start=${start}, end=${end}`);
const replacement = [
"  if (bsrDataFile && fs.existsSync(bsrDataFile)) {",
"    const bsrData = JSON.parse(fs.readFileSync(bsrDataFile, 'utf-8'));",
"    const oldAsins = pickOldAsins(bsrData);",
"",
"    if (oldAsins.length > 0) {",
"      oldAsins.forEach(a => pickedAsins.push({ asin: a.asin, bsr: a.bsr, brand: a.brand, title: a.title?.substring(0, 60), listingAge: a.listingAge }));",
"      const expectedAsins = oldAsins.map(a => a.asin);",
"      const expectedSet = new Set(expectedAsins);",
"      let cacheUsable = false;",
"",
"      if (fs.existsSync(asinTrendsFile)) {",
"        console.log('\\nStep 3/3: reading existing ASIN trend cache');",
"        asinTrends = JSON.parse(fs.readFileSync(asinTrendsFile, 'utf-8'));",
"        const cachedAsins = (asinTrends.products || []).map(product => product.asin).filter(Boolean);",
"        cacheUsable = cachedAsins.length === expectedAsins.length && cachedAsins.every(asin => expectedSet.has(asin));",
"        if (!cacheUsable) {",
"          console.log('ASIN trend cache does not match current selected ASINs; re-extracting.');",
"          asinTrends = null;",
"        }",
"      }",
"",
"      if (!cacheUsable) {",
"        const asinList = expectedAsins.join(',');",
"        console.log(`\\nStep 3/3: extracting ASIN trends (${oldAsins.length} ASIN, listed >3 years)`);",
"        console.log(`  ASINs: ${oldAsins.map(a => `${a.asin}(BSR#${a.bsr})`).join(', ')}`);",
"",
"        try {",
"          execFileSync(",
"            'node',",
"            [path.join(SKILL_DIR, 'extract-asin-trends.js'), asinList, asinTrendsFile],",
"            { stdio: 'inherit', timeout: 240000 }",
"          );",
"          if (fs.existsSync(asinTrendsFile)) {",
"            asinTrends = JSON.parse(fs.readFileSync(asinTrendsFile, 'utf-8'));",
"          }",
"        } catch (e) {",
"          console.log(`ASIN trend extraction failed: ${e.message}`);",
"        }",
"      }",
"    } else {",
"      console.log('\\nStep 3/3: no ASIN listed >3 years found in BSR data; skipped');",
"    }",
"  } else {",
"    console.log('\\nStep 3/3: BSR data file does not exist; skipped ASIN trend extraction');",
"  }",
""
];
lines.splice(start, end - start, ...replacement);
fs.writeFileSync(file, lines.join('\n'), 'utf8');
console.log(`Replaced lines ${start + 1}-${end}`);
