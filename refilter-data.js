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
const { canonicalVariantRowsFromMarketData } = require('./canonical-variant-rows');
const { buildRescuePriceGuard } = require('./rescue-price-guard');
const {
  applyCodexSemanticReview,
  applyCodexSemanticReviewExclusion,
  buildCodexSemanticReviewCandidates,
  loadCodexSemanticReview,
  REVIEW_STANDARD,
  writeCodexSemanticReviewRequest
} = require('./codex-semantic-review');
const {
  TARGET_CATEGORY_REVIEW_STANDARD,
  applyTargetCategoryCodexReview,
  buildTargetCategoryCodexReviewRequest,
  loadTargetCategoryCodexReview,
  requestFromExistingTargetCategoryReview,
  writeTargetCategoryCodexReviewRequest
} = require('./target-category-codex-review');
const {
  applySalesFloorFilter,
  salesFloorMinFromEnv
} = require('./sales-floor-filter');
const {
  buildInputProductContext
} = require('./input-product-context');

const inputPath = process.argv[2];
const outputPath = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : inputPath;
const referenceCategoriesFromArgs = parseReferenceCategoryArgs(process.argv.slice(2));

if (!inputPath) {
  console.error('Usage: node refilter-data.js <market-data.json> [output.json]');
  process.exit(1);
}

function categorySelectionRows(parents) {
  return parents.flatMap(parent => {
    if (Array.isArray(parent.variantRows) && parent.variantRows.length) {
      return parent.variantRows.map(row => ({
        ...row,
        sourceKeyword: parent.sourceKeyword,
        parentAsin: parent.parentAsin || parent.pasin || parent.asin
      }));
    }
    return [parent];
  });
}

function reapplyFilter(marketData) {
  const keywords = Array.isArray(marketData.keywords) && marketData.keywords.length
    ? marketData.keywords
    : [marketData.keyword].filter(Boolean);
  const referenceCategories = normalizeReferenceCategories(
    referenceCategoriesFromArgs.length ? referenceCategoriesFromArgs : (marketData.referenceCategories || [])
  );
  const inputProductContext = buildInputProductContext(marketData.inputProductContext || {}, {
    keyword: keywords[0] || keywords.join(' + '),
    category: referenceCategories[0] || '',
    categories: referenceCategories
  });
  const inputProductContexts = Array.isArray(marketData.inputProductContexts) && marketData.inputProductContexts.length > 1
    ? marketData.inputProductContexts
    : [];
  const salesFloorMin = Number(marketData.analysisSalesFloor || salesFloorMinFromEnv());
  const canonicalRawVariantRows = canonicalVariantRowsFromMarketData(marketData);
  const parents = aggregateParentListings(canonicalRawVariantRows);
  const categorySelectionSource = categorySelectionRows(parents);
  const initialCategorySelectionResult = selectTargetCategories(categorySelectionSource, keywords, { referenceCategories });
  const targetCategoryCodexReview = loadTargetCategoryCodexReview(inputPath, marketData);
  const targetCategoryCodexApplication = applyTargetCategoryCodexReview(initialCategorySelectionResult, targetCategoryCodexReview.review);
  const categorySelectionResult = targetCategoryCodexApplication.categorySelectionResult;
  const targetCategories = categorySelectionResult.targetCategories;
  const generatedTargetCategoryCodexReviewRequest = buildTargetCategoryCodexReviewRequest({
    keywords,
    inputProductContext,
    inputProductContexts,
    categorySelection: categorySelectionResult.categorySelection,
    targetCategories,
    referenceCategories,
    items: categorySelectionSource
  });
  const usesSharedCurrentMarketCategoryReview = Boolean(marketData.historicalNewOnly);
  const targetCategoryCodexReviewRequest = usesSharedCurrentMarketCategoryReview
    ? requestFromExistingTargetCategoryReview(
      targetCategoryCodexReview.review,
      generatedTargetCategoryCodexReviewRequest
    )
    : generatedTargetCategoryCodexReviewRequest;
  const targetCategoryCodexReviewWrite = usesSharedCurrentMarketCategoryReview
    ? {
      reviewFile: targetCategoryCodexReview.reviewFile,
      written: false,
      reason: 'historical data reuses the current-market category review request'
    }
    : writeTargetCategoryCodexReviewRequest(
      outputPath,
      targetCategoryCodexReviewRequest,
      targetCategoryCodexReview.review,
      targetCategoryCodexReview.reviewFile
    );
  const referenceCategorySelection = buildReferenceCategorySelectionSummary(
    referenceCategories,
    categorySelectionResult.categorySelection
  );
  const targetCategorySet = new Set(targetCategories);
  const codexSemanticReview = loadCodexSemanticReview(inputPath, marketData);
  const equivalentCategorySet = new Set(
    categorySelectionResult.categorySelection
      .filter(d => d.titleIntentRescueCandidate || d.functionalEquivalent)
      .filter(d => !targetCategorySet.has(d.category))
      .map(d => d.category)
  );

  const prepared = parents.map(parent => {
    const item = applyTargetCategoryMatch(parent, targetCategorySet);
    delete item.keywordIntentRescued;
    delete item.keywordIntentRescuePrice;
    delete item.keywordIntentRescuePriceCheck;
    delete item.keywordIntentRescueRejected;
    delete item.keywordIntentRescueRejectedReason;
    delete item.codexSemanticReviewExcluded;
    delete item.codexSemanticReviewRescued;
    delete item.codexSemanticReviewDecision;
    delete item.targetCategoryTitleIntentRequired;
    delete item.targetCategoryTitleIntentRejected;
    return item;
  });
  const rescuePriceGuard = buildRescuePriceGuard(
    prepared,
    item => listingMatchesTargetCategories(item, targetCategorySet)
  );

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

  const matched = prepared.filter(listingMatchesFilter);
  const matchedSet = new Set(matched);
  const salesFloorFilter = applySalesFloorFilter(matched, { salesFloorMin });
  const data = salesFloorFilter.included;
  const excluded = [
    ...prepared.filter(item => !matchedSet.has(item)),
    ...salesFloorFilter.excluded
  ];
  const codexSemanticReviewCandidates = buildCodexSemanticReviewCandidates({
    keywords,
    inputProductContext,
    inputProductContexts,
    categorySelection: categorySelectionResult.categorySelection,
    targetCategories,
    items: prepared,
    referenceCategories
  });
  const codexSemanticReviewWrite = writeCodexSemanticReviewRequest(
    outputPath,
    codexSemanticReviewCandidates,
    codexSemanticReview.review,
    codexSemanticReview.reviewFile
  );
  const categoryDistribution = Object.entries(categorySelectionSource.reduce((acc, row) => {
    const category = row.category || 'unknown';
    acc[category] = (acc[category] || 0) + 1;
    return acc;
  }, {})).sort((a, b) => b[1] - a[1]);

  return {
    ...marketData,
    targetCategory: targetCategories[0] || '',
    targetCategories,
    equivalentCandidateCategories: [...equivalentCategorySet],
    inputProductContext,
    ...(inputProductContexts.length > 1 ? { inputProductContexts } : {}),
    referenceCategories,
    referenceCategorySelection,
    targetCategoryCodexReviewFile: path.relative(path.dirname(path.resolve(outputPath)), targetCategoryCodexReview.reviewFile),
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
    targetCategoryCodexReviewRequestFile: path.relative(path.dirname(path.resolve(outputPath)), targetCategoryCodexReviewWrite.reviewFile),
    targetCategoryCodexReviewRequestWritten: Boolean(targetCategoryCodexReviewWrite.written),
    targetCategoryCodexReviewRequest,
    codexSemanticReviewFile: path.relative(path.dirname(path.resolve(outputPath)), codexSemanticReview.reviewFile),
    codexSemanticReviewLoaded: Boolean(codexSemanticReview.reviewLoaded),
    codexSemanticReviewRequestWritten: Boolean(codexSemanticReviewWrite.written),
    codexSemanticReviewStandard: REVIEW_STANDARD,
    codexSemanticReviewCandidates,
    categorySelection: categorySelectionResult.categorySelection,
    rescuePriceGuard,
    categoryDistribution,
    filteredCount: data.length,
    excludedCount: excluded.length,
    targetMatchedCount: matched.length,
    analysisSalesFloor: salesFloorMin,
    salesFloorExcludedCount: salesFloorFilter.summary.count,
    salesFloorExcludedSummary: salesFloorFilter.summary,
    rawTotal: parents.length,
    total: parents.length,
    allCount: parents.length,
    canonicalRawVariantRowsVersion: 1,
    canonicalRawVariantRowCount: canonicalRawVariantRows.length,
    canonicalRawVariantRows,
    refilteredAt: new Date().toISOString(),
    data,
    excluded
  };
}

const marketData = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const result = reapplyFilter(marketData);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf8');

console.log(`Refiltered: ${inputPath} -> ${outputPath}`);
console.log(`Parents: ${result.total}, filtered: ${result.filteredCount}, excluded: ${result.excludedCount}`);
if (result.salesFloorExcludedCount > 0) {
  console.log(`Sales floor: excluded ${result.salesFloorExcludedCount} target-matched listings below ${result.analysisSalesFloor} monthly sales`);
}
console.log(`Target categories: ${result.targetCategories.join(' | ')}`);
