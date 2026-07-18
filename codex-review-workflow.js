const fs = require('fs');
const path = require('path');
const {
  reviewFileForDataFile,
  REVIEW_STANDARD
} = require('./codex-semantic-review');
const {
  TARGET_CATEGORY_REVIEW_STANDARD,
  keywordLeafExactMatch,
  targetCategoryReviewFileForDataFile
} = require('./target-category-codex-review');

function readJsonIfExists(filePath, fallback = null) {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeDecision(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function isFinalCategoryDecision(value) {
  return ['target', 'include', 'included', 'yes', 'true', 'exclude', 'excluded', 'non_target', 'not_target', 'no', 'false', 'reject', 'rejected', 'review', 'manual_review', 'uncertain', 'pending'].includes(normalizeDecision(value));
}

function isTargetCategoryDecision(value) {
  return ['target', 'include', 'included', 'yes', 'true'].includes(normalizeDecision(value));
}

function isAutoResolvedEntry(entry) {
  const reviewedBy = String(entry?.reviewedBy || '').trim().toLowerCase();
  const reason = String(entry?.reason || '').trim();
  return reviewedBy === 'local-codex-auto-gate' ||
    reason.startsWith('Auto-resolved by local Codex gate:');
}

function reviewEntries(review) {
  return [
    ...(Array.isArray(review?.products) ? review.products : []),
    ...(Array.isArray(review?.decisions) ? review.decisions : []),
    ...(Array.isArray(review?.items) ? review.items : [])
  ].filter(entry => entry && typeof entry === 'object');
}

function reviewEntryIdentifiers(entry) {
  return [
    entry?.asin,
    entry?.parentAsin,
    entry?.pasin,
    ...(Array.isArray(entry?.asins) ? entry.asins : []),
    ...(Array.isArray(entry?.childAsins) ? entry.childAsins : [])
  ].map(value => String(value || '').trim()).filter(Boolean);
}

function listingIdentifiers(item) {
  return [...new Set([
    item?.asin,
    item?.parentAsin,
    item?.pasin,
    ...(Array.isArray(item?.childAsins) ? item.childAsins : []),
    ...(Array.isArray(item?.variantRows) ? item.variantRows.flatMap(row => [row?.asin, row?.parentAsin, row?.pasin]) : [])
  ].map(value => String(value || '').trim()).filter(Boolean))];
}

function listingCategories(item) {
  return Array.isArray(item?.categories) && item.categories.length
    ? item.categories.filter(Boolean)
    : [item?.category].filter(Boolean);
}

function normalizeCategory(category) {
  return String(category || '')
    .replace(/&amp;/gi, '&')
    .split('>')
    .map(part => part.trim().replace(/\s+/g, ' ').toLowerCase())
    .filter(Boolean)
    .join(' > ');
}

function resolveRelative(dataFile, relativeOrAbsolute, fallback) {
  if (!relativeOrAbsolute) return fallback;
  return path.isAbsolute(relativeOrAbsolute)
    ? relativeOrAbsolute
    : path.resolve(path.dirname(path.resolve(dataFile)), relativeOrAbsolute);
}

function targetReviewStatus(dataFile, marketData) {
  const reviewFile = resolveRelative(
    dataFile,
    marketData?.targetCategoryCodexReviewFile,
    targetCategoryReviewFileForDataFile(dataFile)
  );
  const review = readJsonIfExists(reviewFile, {});
  const requestCategories = [
    ...(Array.isArray(marketData?.targetCategoryCodexReviewRequest?.categories)
      ? marketData.targetCategoryCodexReviewRequest.categories
      : []),
    ...(Array.isArray(review?.categories) ? review.categories : [])
  ];
  const requestSet = new Map();
  for (const row of requestCategories) {
    const category = typeof row === 'string' ? row : row?.category;
    const key = normalizeCategory(category);
    if (key && !requestSet.has(key)) requestSet.set(key, category);
  }
  // Put request rows first so an explicit reviewer decision always wins for the same category.
  const decisionEntries = [
    ...(Array.isArray(review?.categories) ? review.categories : []),
    ...(Array.isArray(review?.decisions) ? review.decisions : [])
  ];
  const decidedSet = new Set(
    decisionEntries
      .filter(entry => entry && typeof entry === 'object' && entry.category)
      .filter(entry => !isAutoResolvedEntry(entry))
      .filter(entry => isFinalCategoryDecision(entry.decision || entry.status))
      .map(entry => normalizeCategory(entry.category))
      .filter(Boolean)
  );
  const decisionIndex = new Map(
    decisionEntries
      .filter(entry => entry && typeof entry === 'object' && entry.category && !isAutoResolvedEntry(entry))
      .map(entry => [normalizeCategory(entry.category), entry])
      .filter(([category]) => Boolean(category))
  );
  const autoResolvedCount = [
    ...(Array.isArray(review?.decisions) ? review.decisions : []),
    ...(Array.isArray(review?.categories) ? review.categories : [])
  ].filter(entry => entry && typeof entry === 'object' && entry.category && isAutoResolvedEntry(entry)).length;
  const missing = [...requestSet.entries()]
    .filter(([key]) => !decidedSet.has(key))
    .map(([, category]) => category);
  const reviewKeywords = Array.isArray(review?.keywords) && review.keywords.length
    ? review.keywords
    : (Array.isArray(marketData?.keywords) ? marketData.keywords : [marketData?.keyword].filter(Boolean));
  const exactTargetViolations = requestCategories
    .filter(row => row && typeof row === 'object' && row.category)
    .filter(row => row.mandatoryTarget || (
      row.referenceCategoryMatchType === 'exact'
      && keywordLeafExactMatch(row.category, reviewKeywords)
    ))
    .filter(row => {
      const decision = decisionIndex.get(normalizeCategory(row.category));
      return !decision || !isTargetCategoryDecision(decision.decision || decision.status);
    })
    .map(row => row.category)
    .filter((category, index, categories) => categories.indexOf(category) === index);
  return {
    ok: missing.length === 0 && exactTargetViolations.length === 0,
    skipped: requestSet.size === 0,
    reviewFile,
    requestedCategoryCount: requestSet.size,
    reviewDecisionCount: decidedSet.size,
    autoResolvedIgnoredCount: autoResolvedCount,
    missingCount: missing.length,
    missingCategories: missing,
    exactTargetViolationCount: exactTargetViolations.length,
    exactTargetViolationCategories: exactTargetViolations
  };
}

function semanticReviewStatus(dataFile, marketData) {
  const candidateCategories = new Set((marketData?.codexSemanticReviewCandidates || [])
    .map(candidate => candidate.category)
    .map(normalizeCategory)
    .filter(Boolean));
  if (!candidateCategories.size) {
    return { ok: true, skipped: true, reason: 'no semantic review candidates' };
  }

  const targetCategories = new Set((marketData?.targetCategories || [])
    .map(normalizeCategory)
    .filter(Boolean));
  const candidateListings = [...(marketData.data || []), ...(marketData.excluded || [])]
    .filter(item => !listingCategories(item).some(category => targetCategories.has(normalizeCategory(category))))
    .filter(item => listingCategories(item).some(category => candidateCategories.has(normalizeCategory(category))));
  if (!candidateListings.length) {
    return { ok: true, skipped: true, reason: 'no candidate listings' };
  }

  const reviewFile = resolveRelative(
    dataFile,
    marketData?.codexSemanticReviewFile,
    reviewFileForDataFile(dataFile)
  );
  const review = readJsonIfExists(reviewFile, {});
  const entries = reviewEntries(review);
  const validEntries = entries.filter(entry => !isAutoResolvedEntry(entry));
  const reviewedIds = new Set(validEntries.flatMap(reviewEntryIdentifiers));
  const missing = candidateListings.filter(item => {
    const ids = listingIdentifiers(item);
    return ids.length && !ids.some(id => reviewedIds.has(id));
  });

  return {
    ok: missing.length === 0,
    skipped: false,
    reviewFile,
    candidateCategoryCount: candidateCategories.size,
    candidateListingCount: candidateListings.length,
    reviewEntryCount: entries.length,
    validReviewEntryCount: validEntries.length,
    autoResolvedIgnoredCount: entries.length - validEntries.length,
    missingCount: missing.length,
    sampleMissing: missing.slice(0, 10).map(item => ({
      asin: item.asin || '',
      parentAsin: item.parentAsin || item.pasin || '',
      title: item.title || '',
      category: item.category || '',
      categories: listingCategories(item),
      sales: item.sales || '',
      bsr: item.bsr || '',
      price: item.price || '',
      brand: item.brand || ''
    })),
    missingListings: missing.map(item => ({
      asin: item.asin || '',
      parentAsin: item.parentAsin || item.pasin || '',
      asins: listingIdentifiers(item),
      title: item.title || '',
      category: item.category || '',
      categories: listingCategories(item),
      sales: item.sales || '',
      bsr: item.bsr || '',
      price: item.price || '',
      brand: item.brand || ''
    }))
  };
}

function codexReviewStatus(dataFile) {
  const marketData = readJsonIfExists(dataFile, null);
  if (!marketData) {
    return {
      ok: true,
      skipped: true,
      dataFile,
      reason: 'market data file not found'
    };
  }
  const target = targetReviewStatus(dataFile, marketData);
  const semantic = semanticReviewStatus(dataFile, marketData);
  return {
    ok: target.ok && semantic.ok,
    dataFile,
    keyword: marketData.keyword || '',
    target,
    semantic
  };
}

function main() {
  const dataFile = process.argv[2];
  if (!dataFile) {
    console.error('Usage: node codex-review-workflow.js <market-data.json>');
    process.exit(1);
  }
  const status = codexReviewStatus(dataFile);
  const output = {
    ...status,
    target: {
      ...status.target,
      reviewFile: status.target?.reviewFile ? path.relative(process.cwd(), status.target.reviewFile) : ''
    },
    semantic: {
      ...status.semantic,
      reviewFile: status.semantic?.reviewFile ? path.relative(process.cwd(), status.semantic.reviewFile) : ''
    }
  };
  console.log(JSON.stringify(output, null, 2));
  if (!status.ok) process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  codexReviewStatus
};
