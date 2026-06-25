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

const inputPath = process.argv[2];
const outputPath = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : inputPath;
const referenceCategoriesFromArgs = parseReferenceCategoryArgs(process.argv.slice(2));

if (!inputPath) {
  console.error('Usage: node refilter-data.js <market-data.json> [output.json]');
  process.exit(1);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function listingKey(item) {
  return item.parentAsin || item.pasin || item.asin;
}

function sourceRowsFromListing(item) {
  const parentKey = listingKey(item);
  if (Array.isArray(item.variantRows) && item.variantRows.length) {
    return item.variantRows.map(row => ({
      ...row,
      sourceKeyword: row.sourceKeyword || item.sourceKeyword,
      parentAsin: row.parentAsin || parentKey,
      pasin: row.pasin || (row.asin && row.asin !== parentKey ? parentKey : row.pasin),
      brand: row.brand || item.brand,
      sellerType: row.sellerType || item.sellerType,
      variants: row.variants || item.variants,
      sellerCount: row.sellerCount || item.sellerCount
    }));
  }
  return [clone(item)];
}

function allSourceRows(marketData) {
  const byAsin = new Map();
  for (const item of [...(marketData.data || []), ...(marketData.excluded || [])]) {
    for (const row of sourceRowsFromListing(item)) {
      if (!row.asin) continue;
      if (!byAsin.has(row.asin)) byAsin.set(row.asin, row);
    }
  }
  return [...byAsin.values()];
}

function allParentListings(marketData) {
  return aggregateParentListings(allSourceRows(marketData));
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
  const parents = allParentListings(marketData);
  const categorySelectionSource = categorySelectionRows(parents);
  const initialCategorySelectionResult = selectTargetCategories(categorySelectionSource, keywords, { referenceCategories });
  const targetCategoryCodexReview = loadTargetCategoryCodexReview(inputPath, marketData);
  const targetCategoryCodexApplication = applyTargetCategoryCodexReview(initialCategorySelectionResult, targetCategoryCodexReview.review);
  const categorySelectionResult = targetCategoryCodexApplication.categorySelectionResult;
  const targetCategories = categorySelectionResult.targetCategories;
  const targetCategoryCodexReviewRequest = buildTargetCategoryCodexReviewRequest({
    keywords,
    categorySelection: categorySelectionResult.categorySelection,
    targetCategories,
    referenceCategories,
    items: categorySelectionSource
  });
  const targetCategoryCodexReviewWrite = writeTargetCategoryCodexReviewRequest(
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
  const data = matched;
  const matchedSet = new Set(matched);
  const excluded = prepared.filter(item => !matchedSet.has(item));
  const codexSemanticReviewCandidates = buildCodexSemanticReviewCandidates({
    keywords,
    categorySelection: categorySelectionResult.categorySelection,
    targetCategories,
    items: prepared,
    referenceCategories
  });
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
    codexSemanticReviewLoaded: Boolean(codexSemanticReview.review),
    codexSemanticReviewStandard: REVIEW_STANDARD,
    codexSemanticReviewCandidates,
    categorySelection: categorySelectionResult.categorySelection,
    rescuePriceGuard,
    categoryDistribution,
    filteredCount: data.length,
    excludedCount: excluded.length,
    targetMatchedCount: matched.length,
    salesFloorExcludedCount: 0,
    rawTotal: parents.length,
    total: parents.length,
    allCount: parents.length,
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
console.log(`Target categories: ${result.targetCategories.join(' | ')}`);
