const fs = require('fs');
const path = require('path');
const { selectTargetCategories, listingMatchesKeywordIntent, titleMatchesKeywordIntent } = require('./category-selector');
const {
  aggregateParentListings,
  applyTargetCategoryMatch,
  listingMatchesTargetCategories
} = require('./parent-listing-aggregate');

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

// 用法: node merge-data.js file1.json file2.json [...] [输出文件.json]
const args = process.argv.slice(2);

if (args.length < 2) {
  console.error('用法: node merge-data.js <数据文件1.json> <数据文件2.json> [...] [输出文件.json]');
  console.error('示例: node merge-data.js cookie-data.json biscuit-data.json merged-data.json');
  process.exit(1);
}

// 最后一个参数如果是 .json 结尾，作为输出文件；否则自动生成
const maybeOutFile = args[args.length - 1];
const inputFiles = maybeOutFile.endsWith('.json') ? args.slice(0, -1) : args;
const outFile = maybeOutFile.endsWith('.json') ? maybeOutFile : path.join(outputDirs('merged-data').data, 'merged-data.json');

console.log('📁 输入文件:');
inputFiles.forEach(f => console.log('  ' + f));
console.log('📤 输出文件: ' + outFile);

// 读取所有文件
let allRawData = [];
let keywords = [];
const keywordStats = {};

for (const file of inputFiles) {
  if (!fs.existsSync(file)) {
    console.error('❌ 文件不存在:', file);
    process.exit(1);
  }
  const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const kw = json.keyword || path.basename(file, '.json').replace(/-/g, ' ');
  keywords.push(kw);
  
  // 合并 data 和 excluded 数组中的所有产品
  const items = [...(json.data || []), ...(json.excluded || [])];
  items.forEach(d => { d.sourceKeyword = kw; });
  keywordStats[kw] = items.length;
  allRawData = allRawData.concat(items);
  
  console.log(`  ${kw}: ${items.length} 条`);
}
// ASIN 去重
const seenAsin = new Set();
allRawData = allRawData.filter(item => {
  if (!item.asin || seenAsin.has(item.asin)) return false;
  seenAsin.add(item.asin);
  return true;
});
console.log(`ASIN 去重后: ${allRawData.length} 条`);

const categorySelectionSource = allRawData;
const categorySelectionResult = selectTargetCategories(categorySelectionSource, keywords);
const targetCategory = categorySelectionResult.targetCategory;
const targetCategories = categorySelectionResult.targetCategories;
const targetCategorySet = new Set(targetCategories);
const equivalentCategorySet = new Set(
  categorySelectionResult.categorySelection
    .filter(d => d.functionalEquivalent)
    .map(d => d.category)
);

const beforeParentAggregate = allRawData.length;
allRawData = aggregateParentListings(allRawData).map(item => applyTargetCategoryMatch(item, targetCategorySet));
console.log(`父体 Listing 聚合: ${beforeParentAggregate} 条 ASIN/变体 → ${allRawData.length} 个父体 Listing`);

const catCount = {};
categorySelectionSource.forEach(d => {
  const cat = d.category || '未识别';
  catCount[cat] = (catCount[cat] || 0) + 1;
});
const sortedCats = Object.entries(catCount).sort((a, b) => b[1] - a[1]);
console.log('\\n📊 类目分布（ASIN/变体明细 Top 10）:');
sortedCats.slice(0, 10).forEach(([cat, count]) => console.log(`  [${count}] ${cat}`));

const listingMatchesFilter = (item) => {
  if (listingMatchesTargetCategories(item, targetCategorySet)) return true;
  const categories = Array.isArray(item.categories) && item.categories.length ? item.categories : [item.category].filter(Boolean);
  const equivalentCategoryHit = categories.some(category => equivalentCategorySet.has(category));
  if (!equivalentCategoryHit) return false;
  const rescued = listingMatchesKeywordIntent(item, keywords);
  if (rescued) {
    const rescuedRows = (Array.isArray(item.variantRows) ? item.variantRows : [])
      .filter(row => equivalentCategorySet.has(row.category) && keywords.some(keyword => titleMatchesKeywordIntent(row.title || item.title, keyword)));
    item.targetMatchedCategories = [...new Set([...(item.targetMatchedCategories || []), ...rescuedRows.map(row => row.category).filter(Boolean)])];
    item.targetMatchedChildAsins = [...new Set(rescuedRows.map(row => row.asin).filter(Boolean))];
    item.keywordIntentRescued = true;
  }
  return rescued;
};
const filtered = allRawData.filter(d => listingMatchesFilter(d));
const excluded = allRawData.filter(d => !listingMatchesFilter(d));
console.log(`\n🎯 目标类目组: ${targetCategories.join(' | ')}`);
console.log(`✅ 过滤: ${allRawData.length} → ${filtered.length} 条, 排除 ${excluded.length} 条`);

// BSR 范围
const bsrMax = Math.max(...filtered.map(d => d.bsr), 0);

// 保存
const output = {
  keywords,
  keyword: keywords.join(' + '),
  bsrRange: '1-' + bsrMax,
  rawTotal: Object.values(keywordStats).reduce((a, b) => a + b, 0),
  total: allRawData.length,
  allCount: allRawData.length,
  filteredCount: filtered.length,
  excludedCount: excluded.length,
  targetCategory,
  targetCategories,
  equivalentCandidateCategories: [...equivalentCategorySet],
  categorySelection: categorySelectionResult.categorySelection,
  categoryDistribution: sortedCats,
  keywordStats,
  data: filtered,
  excluded
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
console.log(`\n✅ 合并完成: ${outFile}`);

// 来源摘要
console.log(`\n📋 来源摘要:`);
Object.entries(keywordStats).forEach(([kw, count]) => {
  const finalCount = [...filtered, ...excluded].filter(d => d.sourceKeyword === kw).length;
  console.log(`  "${kw}": 原始 ${count} → 合并后 ${finalCount} 条`);
});
