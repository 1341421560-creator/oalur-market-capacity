const fs = require('fs');
const path = require('path');
const { selectTargetCategories } = require('./category-selector');
const {
  buildReferenceCategorySelectionSummary,
  normalizeReferenceCategories,
  parseReferenceCategoryArgs
} = require('./reference-categories');
const {
  aggregateParentListings,
  applyTargetCategoryMatch,
  listingMatchesTargetCategories
} = require('./parent-listing-aggregate');
const { buildRescuePriceGuard } = require('./rescue-price-guard');
const {
  applyCodexSemanticReview,
  applyCodexSemanticReviewExclusion,
  buildCodexSemanticReviewCandidates,
  loadCodexSemanticReview,
  REVIEW_STANDARD
} = require('./codex-semantic-review');
const {
  TARGET_CATEGORY_REVIEW_STANDARD,
  applyTargetCategoryCodexReview,
  buildTargetCategoryCodexReviewRequest,
  loadTargetCategoryCodexReview,
  writeTargetCategoryCodexReviewRequest
} = require('./target-category-codex-review');

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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function autoOutFile() {
  return path.join(outputDirs('merged-data').data, 'merged-data.json');
}

// 用法: node merge-data.js file1.json file2.json [...] [--output 输出文件.json]
const rawArgs = process.argv.slice(2);
const referenceCategoriesFromArgs = parseReferenceCategoryArgs(rawArgs);
const args = [];
let explicitOutFile = null;
for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === '--reference-categories' || arg === '--reference-categories-file') {
    i++;
    continue;
  }
  if (arg === '--output' || arg === '--out') {
    explicitOutFile = rawArgs[++i] || null;
    continue;
  }
  args.push(arg);
}

if (args.length < 1) {
  console.error('用法: node merge-data.js <数据文件1.json> <数据文件2.json> [...] [--output 输出文件.json]');
  console.error('示例: node merge-data.js cookie-data.json biscuit-data.json --output merged-data.json');
  process.exit(1);
}

const maybeOutFile = args[args.length - 1];
const positionalOutput = !explicitOutFile && args.length > 1 && !fs.existsSync(maybeOutFile) ? maybeOutFile : null;
const inputFiles = explicitOutFile
  ? args
  : (positionalOutput ? args.slice(0, -1) : args);
const outFile = explicitOutFile || positionalOutput || autoOutFile();

if (positionalOutput) {
  console.warn('⚠️ 检测到最后一个参数不存在，按兼容模式作为输出文件。建议改用 --output 明确输出路径。');
}
if (!explicitOutFile && !positionalOutput && args.length > 1 && fs.existsSync(maybeOutFile)) {
  console.warn('⚠️ 最后一个参数已存在，按输入文件处理；如需覆盖输出文件，请使用 --output。');
}

console.log('📁 输入文件:');
inputFiles.forEach(f => console.log('  ' + f));
console.log('📤 输出文件: ' + outFile);

// 读取所有文件
let allRawData = [];
let keywords = [];
const keywordStats = {};
let inheritedReferenceCategories = [];

for (const file of inputFiles) {
  if (!fs.existsSync(file)) {
    console.error('❌ 文件不存在:', file);
    process.exit(1);
  }
  const json = readJson(file);
  inheritedReferenceCategories.push(...(Array.isArray(json.referenceCategories) ? json.referenceCategories : []));
  const kw = json.keyword || path.basename(file, '.json').replace(/-/g, ' ');
  keywords.push(kw);
  
  // 合并 data 和 excluded 数组中的所有产品
  const items = [...(json.data || []), ...(json.excluded || [])];
  items.forEach(d => { d.sourceKeyword = kw; });
  keywordStats[kw] = items.length;
  allRawData = allRawData.concat(items);
  
  console.log(`  ${kw}: ${items.length} 条`);
}
const referenceCategories = normalizeReferenceCategories([
  ...inheritedReferenceCategories,
  ...referenceCategoriesFromArgs
]);
// ASIN 去重
const seenAsin = new Set();
allRawData = allRawData.filter(item => {
  if (!item.asin || seenAsin.has(item.asin)) return false;
  seenAsin.add(item.asin);
  return true;
});
console.log(`ASIN 去重后: ${allRawData.length} 条`);

const categorySelectionSource = allRawData;
const initialCategorySelectionResult = selectTargetCategories(categorySelectionSource, keywords, { referenceCategories });
const targetCategoryCodexReview = loadTargetCategoryCodexReview(outFile, {});
const targetCategoryCodexApplication = applyTargetCategoryCodexReview(initialCategorySelectionResult, targetCategoryCodexReview.review);
const categorySelectionResult = targetCategoryCodexApplication.categorySelectionResult;
const targetCategory = categorySelectionResult.targetCategory;
const targetCategories = categorySelectionResult.targetCategories;
const targetCategoryCodexReviewRequest = buildTargetCategoryCodexReviewRequest({
  keywords,
  categorySelection: categorySelectionResult.categorySelection,
  targetCategories,
  referenceCategories,
  items: categorySelectionSource
});
const targetCategoryCodexReviewWrite = writeTargetCategoryCodexReviewRequest(
  outFile,
  targetCategoryCodexReviewRequest,
  targetCategoryCodexReview.review,
  targetCategoryCodexReview.reviewFile
);
const referenceCategorySelection = buildReferenceCategorySelectionSummary(
  referenceCategories,
  categorySelectionResult.categorySelection
);
const targetCategorySet = new Set(targetCategories);
const codexSemanticReview = loadCodexSemanticReview(outFile, {});
const equivalentCategorySet = new Set(
  categorySelectionResult.categorySelection
    .filter(d => d.titleIntentRescueCandidate || d.functionalEquivalent)
    .filter(d => !targetCategorySet.has(d.category))
    .map(d => d.category)
);

const beforeParentAggregate = allRawData.length;
allRawData = aggregateParentListings(allRawData).map(item => applyTargetCategoryMatch(item, targetCategorySet));
console.log(`父体 Listing 聚合: ${beforeParentAggregate} 条 ASIN/变体 → ${allRawData.length} 个父体 Listing`);

const rescuePriceGuard = buildRescuePriceGuard(
  allRawData,
  item => listingMatchesTargetCategories(item, targetCategorySet)
);
if (rescuePriceGuard.enabled) {
  console.log(`救回价格守卫: 目标样本 ${rescuePriceGuard.targetSampleSize} 个，允许 $${rescuePriceGuard.lowerLimit}-$${rescuePriceGuard.upperLimit}`);
} else {
  console.log(`救回价格守卫未启用: ${rescuePriceGuard.reason}`);
}

const catCount = {};
categorySelectionSource.forEach(d => {
  const cat = d.category || '未识别';
  catCount[cat] = (catCount[cat] || 0) + 1;
});
const sortedCats = Object.entries(catCount).sort((a, b) => b[1] - a[1]);
console.log('\\n📊 类目分布（ASIN/变体明细 Top 10）:');
sortedCats.slice(0, 10).forEach(([cat, count]) => console.log(`  [${count}] ${cat}`));

const listingMatchesFilter = (item) => {
  const categories = Array.isArray(item.categories) && item.categories.length ? item.categories : [item.category].filter(Boolean);
  if (listingMatchesTargetCategories(item, targetCategorySet)) {
    item.targetCategoryDirectMatched = true;
    delete item.codexSemanticReviewExcluded;
    delete item.codexSemanticReviewRescued;
    delete item.codexSemanticReviewDecision;
    delete item.targetCategoryTitleIntentRejected;
    return true;
  }
  if (applyCodexSemanticReviewExclusion(item, codexSemanticReview.reviewIndex)) {
    return false;
  }
  if (applyCodexSemanticReview(item, codexSemanticReview.reviewIndex)) {
    item.targetMatchedCategories = [...new Set([...(item.targetMatchedCategories || []), ...categories])];
    return true;
  }
  return false;
};
const filtered = [];
const excluded = [];
allRawData.forEach(item => {
  if (listingMatchesFilter(item)) filtered.push(item);
  else excluded.push(item);
});
const codexSemanticReviewCandidates = buildCodexSemanticReviewCandidates({
  keywords,
  categorySelection: categorySelectionResult.categorySelection,
  targetCategories,
  items: allRawData,
  referenceCategories
});
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
  referenceCategories,
  referenceCategorySelection,
  targetCategoryCodexReviewFile: path.relative(path.dirname(path.resolve(outFile)), targetCategoryCodexReview.reviewFile),
  targetCategoryCodexReviewLoaded: targetCategoryCodexApplication.decisionCount > 0,
  targetCategoryCodexReviewApplied: Boolean(targetCategoryCodexApplication.applied),
  targetCategorySelectionMode: targetCategoryCodexApplication.mode,
  targetCategoryCodexReviewDecisionCount: targetCategoryCodexApplication.decisionCount,
  targetCategoryCodexReviewReviewedCategoryCount: targetCategoryCodexApplication.reviewedCategoryCount,
  targetCategoryCodexReviewTotalCategoryCount: targetCategoryCodexApplication.totalCategoryCount,
  targetCategoryCodexReviewComplete: Boolean(targetCategoryCodexApplication.complete),
  targetCategoryCodexReviewIncludedCategories: targetCategoryCodexApplication.includedCategories,
  targetCategoryCodexReviewExcludedCategories: targetCategoryCodexApplication.excludedCategories,
  targetCategoryCodexReviewStandard: TARGET_CATEGORY_REVIEW_STANDARD,
  targetCategoryCodexReviewRequestFile: path.relative(path.dirname(path.resolve(outFile)), targetCategoryCodexReviewWrite.reviewFile),
  targetCategoryCodexReviewRequestWritten: Boolean(targetCategoryCodexReviewWrite.written),
  targetCategoryCodexReviewRequest,
  codexSemanticReviewFile: path.relative(path.dirname(path.resolve(outFile)), codexSemanticReview.reviewFile),
  codexSemanticReviewLoaded: Boolean(codexSemanticReview.review),
  codexSemanticReviewStandard: REVIEW_STANDARD,
  codexSemanticReviewCandidates,
  rescuePriceGuard,
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
