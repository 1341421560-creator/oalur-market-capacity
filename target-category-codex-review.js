const fs = require('fs');
const path = require('path');
const {
  buildInputProductContext,
  mergeInputProductContexts,
  primaryInputProductContext
} = require('./input-product-context');

const TARGET_CATEGORY_REVIEW_STANDARD = {
  version: 2,
  triggerRule: 'Create a local Codex target-category review request for every scraped Amazon category, including manually provided reference categories when they match scraped rows.',
  decisionRule: 'Local Codex must mark a category target when the scraped full path exactly matches an input reference category and the input keyword core product terms exactly match the category leaf; otherwise decide whether the input product context core product belongs in each scraped Amazon category on the Amazon US marketplace.',
  includeRule: 'Exact full-path reference match plus exact keyword-to-leaf product-term match is a mandatory target decision. For all other categories, mark target only when the input product context core product type and core buying/usage intent naturally belong to that Amazon category.',
  excludeRule: 'Mark exclude when the category is a different product type, different function, or only matches generic words through parent-path terms.',
  requiredContext: 'Local Codex must read the input keyword, input title, input reference categories, input bullet points/description, JS-scraped category paths, scoring evidence, and sample listing titles/bullets. When the full path exactly matches an input reference category and the keyword core product terms exactly match the leaf, sample contamination, commercial or industrial listings, scoring evidence, and category share must not downgrade target to review or exclude.',
  outputSchema: {
    decisions: [
      {
        category: 'Amazon category path',
        decision: 'target|exclude|review',
        sameAmazonCategoryFit: true,
        sameProductCore: true,
        reason: 'short reason',
        confidence: 'high|medium|low'
      }
    ]
  }
};

function targetCategoryReviewFileForDataFile(dataFile) {
  const resolved = path.resolve(dataFile);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved).replace(/-data\.json$/i, '').replace(/\.json$/i, '');
  return path.join(dir, `${base}-target-category-codex-review.json`);
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveTargetCategoryReviewFile(dataFile, marketData = {}) {
  const explicit = marketData.targetCategoryCodexReviewFile;
  if (explicit) {
    return path.isAbsolute(explicit)
      ? explicit
      : path.resolve(path.dirname(path.resolve(dataFile)), explicit);
  }
  return targetCategoryReviewFileForDataFile(dataFile);
}

function normalizeCategory(category) {
  return String(category || '')
    .replace(/&amp;/gi, '&')
    .split('>')
    .map(part => part.trim().replace(/\s+/g, ' ').toLowerCase())
    .filter(Boolean)
    .join(' > ');
}

function normalizeProductToken(token) {
  const value = String(token || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (value.length > 4 && value.endsWith('ies')) return `${value.slice(0, -3)}y`;
  if (value.length > 3 && value.endsWith('s') && !value.endsWith('ss')) return value.slice(0, -1);
  return value;
}

function normalizedProductPhrase(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(normalizeProductToken)
    .filter(Boolean)
    .join(' ');
}

function keywordLeafExactMatch(category, keywords) {
  const leaf = String(category || '').split('>').pop() || '';
  const normalizedLeaf = normalizedProductPhrase(leaf);
  const keywordList = Array.isArray(keywords) ? keywords : [keywords];
  return Boolean(normalizedLeaf) && keywordList.some(keyword => normalizedProductPhrase(keyword) === normalizedLeaf);
}

function categoryMatchesReference(category, referenceCategory) {
  const categoryNorm = normalizeCategory(category);
  const referenceNorm = normalizeCategory(referenceCategory);
  if (!categoryNorm || !referenceNorm) return false;
  return categoryNorm === referenceNorm ||
    categoryNorm.startsWith(`${referenceNorm} > `) ||
    referenceNorm.startsWith(`${categoryNorm} > `);
}

function normalizeDecision(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function isTargetDecision(value) {
  return ['target', 'include', 'included', 'yes', 'true'].includes(normalizeDecision(value));
}

function isExcludeDecision(value) {
  return ['exclude', 'excluded', 'non_target', 'not_target', 'no', 'false', 'reject', 'rejected'].includes(normalizeDecision(value));
}

function isReviewDecision(value) {
  return ['review', 'manual_review', 'uncertain', 'pending'].includes(normalizeDecision(value));
}

function reviewDecisionEntries(review) {
  return [
    ...(Array.isArray(review?.decisions) ? review.decisions : []),
    ...(Array.isArray(review?.categories) ? review.categories : [])
  ].filter(entry => entry && typeof entry === 'object' && entry.category);
}

function reviewHasDecisions(review) {
  return reviewDecisionEntries(review).some(entry =>
    isTargetDecision(entry.decision || entry.status) ||
    isExcludeDecision(entry.decision || entry.status) ||
    isReviewDecision(entry.decision || entry.status)
  );
}

function reviewedDecisionEntries(review) {
  return reviewDecisionEntries(review).filter(entry => {
    const value = entry.decision || entry.status;
    return isTargetDecision(value) || isExcludeDecision(value) || isReviewDecision(value);
  });
}

function uniqueReviewedDecisionEntries(review) {
  const byCategory = new Map();
  for (const entry of reviewedDecisionEntries(review)) {
    const key = normalizeCategory(entry.category);
    if (key) byCategory.set(key, entry);
  }
  return [...byCategory.values()];
}

function categoryHasDecision(entry) {
  if (!entry || !entry.category) return false;
  const value = entry.decision || entry.status;
  return isTargetDecision(value) || isExcludeDecision(value) || isReviewDecision(value);
}

function reviewHasDecisionsForRequest(review, request) {
  const requestSet = new Set(
    (Array.isArray(request?.categories) ? request.categories : [])
      .map(row => normalizeCategory(row.category))
      .filter(Boolean)
  );
  if (!requestSet.size) return false;
  const decidedSet = new Set(
    reviewDecisionEntries(review)
      .filter(categoryHasDecision)
      .map(entry => normalizeCategory(entry.category))
      .filter(Boolean)
  );
  return [...requestSet].every(category => decidedSet.has(category));
}

function indexTargetCategoryReview(review) {
  const index = new Map();
  for (const entry of uniqueReviewedDecisionEntries(review)) {
    const key = normalizeCategory(entry.category);
    if (key) index.set(key, entry);
  }
  return index;
}

function loadTargetCategoryCodexReview(dataFile, marketData = {}) {
  const reviewFile = resolveTargetCategoryReviewFile(dataFile, marketData);
  const review = readJsonIfExists(reviewFile);
  return {
    reviewFile,
    review,
    reviewLoaded: reviewHasDecisions(review),
    reviewIndex: indexTargetCategoryReview(review || {})
  };
}

function categoryValues(item) {
  return Array.isArray(item?.categories) && item.categories.length
    ? item.categories.filter(Boolean)
    : [item?.category].filter(Boolean);
}

function sampleProductsForCategory(items, category, limit = 8) {
  const normalized = normalizeCategory(category);
  const seen = new Set();
  return (items || [])
    .filter(item => categoryValues(item).some(value => normalizeCategory(value) === normalized))
    .filter(item => {
      const id = item.asin || item.parentAsin || item.pasin || item.title;
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, limit)
    .map(item => ({
      asin: item.asin || '',
      parentAsin: item.parentAsin || item.pasin || '',
      title: item.title || item.productTitle || item.productName || '',
      category: item.category || '',
      categories: item.categories || [],
      description: item.description || item.productDescription || '',
      bulletPoints: item.bulletPoints || item.bullets || item.features || [],
      images: item.images || item.imageUrls || item.mainImage || item.image || [],
      brand: item.brand || '',
      price: item.price || '',
      sales: item.sales || '',
      bsr: item.bsr || ''
    }));
}

function categoryRiskFlags(row) {
  const flags = [];
  if (row.selected) flags.push('selected-by-rule');
  if (row.referenceCategoryMatch) flags.push(`reference-${row.referenceCategoryMatchType || 'match'}`);
  if (row.contextMatch === false || Number(row.contextConflictPenalty || 0) > 0) flags.push('context-conflict');
  if (row.leafModifierMismatch) flags.push('leaf-modifier-mismatch');
  if (row.allKeywordHit) flags.push('all-keyword-token-hit');
  if (row.shapeHit && Number(row.leafModifierHits || 0) === 0 && Number(row.modifierHits || 0) > 0) flags.push('modifier-only-in-parent-path');
  if (row.highShareTitleRescueCandidate) flags.push('high-share-review');
  if (row.titleIntentRescueCandidate) flags.push('title-intent-review');
  return [...new Set(flags)];
}

function buildTargetCategoryCodexReviewRequest({ keywords, inputProductContext, inputProductContexts, categorySelection, targetCategories, referenceCategories, items }) {
  const keywordList = Array.isArray(keywords) ? keywords.filter(Boolean) : [keywords].filter(Boolean);
  const contextList = mergeInputProductContexts([
    ...(Array.isArray(inputProductContexts) ? inputProductContexts : []),
    inputProductContext || buildInputProductContext({}, {
      keyword: keywordList[0] || keywordList.join(' + '),
      category: Array.isArray(referenceCategories) ? referenceCategories[0] : '',
      categories: referenceCategories
    })
  ]);
  const primaryContext = primaryInputProductContext(contextList);
  const rows = Array.isArray(categorySelection) ? categorySelection : [];
  const referenceReviewCategories = Array.isArray(referenceCategories)
    ? [...new Set(referenceCategories.map(category => String(category || '').trim()).filter(Boolean))]
    : [];
  const missingReferenceRows = referenceReviewCategories
    .filter(referenceCategory => !rows.some(row => categoryMatchesReference(row.category, referenceCategory)))
    .map(referenceCategory => ({
      category: referenceCategory,
      missingFromScrapedRows: true,
      count: 0,
      categoryShare: 0,
      score: 0,
      baseScore: 0,
      contextConflictPenalty: 0,
      leafModifierMismatch: false,
      allKeywordHit: false,
      shapeHit: false,
      leafShapeHit: false,
      modifierHits: 0,
      leafModifierHits: 0,
      titleAllRate: 0,
      titleAnyRate: 0,
      referenceCategoryMatch: true,
      referenceCategoryMatchType: 'provided-reference',
      reason: 'provided reference category with no scraped listing rows'
    }));
  const reviewRows = [...rows, ...missingReferenceRows];
  return {
    version: TARGET_CATEGORY_REVIEW_STANDARD.version,
    status: 'pending-local-codex-review',
    generatedAt: new Date().toISOString(),
    reviewStandard: TARGET_CATEGORY_REVIEW_STANDARD,
    inputProductContext: primaryContext,
    ...(contextList.length > 1 ? { inputProductContexts: contextList } : {}),
    keywords: keywordList,
    keyword: keywordList.join(' + '),
    targetCategoriesBeforeCodexReview: Array.isArray(targetCategories) ? targetCategories : [],
    referenceCategories: Array.isArray(referenceCategories) ? referenceCategories : [],
    referenceReviewCategories,
    referenceSemanticReviewCategories: [],
    referenceCategoryPolicy: 'an exact scraped-full-path reference match combined with an exact keyword-to-leaf product-term match must be target; non-exact reference matches remain Codex context and may trigger product-level semantic rescue when judged non-target',
    reviewQuestion: TARGET_CATEGORY_REVIEW_STANDARD.decisionRule,
    categories: reviewRows.map(row => ({
      category: row.category,
      selectedByRule: Boolean(row.selected),
      missingFromScrapedRows: Boolean(row.missingFromScrapedRows),
      count: row.count,
      categoryShare: row.categoryShare,
      score: row.score,
      baseScore: row.baseScore,
      contextConflictPenalty: row.contextConflictPenalty,
      leafModifierMismatch: Boolean(row.leafModifierMismatch),
      allKeywordHit: Boolean(row.allKeywordHit),
      shapeHit: Boolean(row.shapeHit),
      leafShapeHit: Boolean(row.leafShapeHit),
      modifierHits: row.modifierHits,
      leafModifierHits: row.leafModifierHits,
      titleAllRate: row.titleAllRate,
      titleAnyRate: row.titleAnyRate,
      referenceCategoryMatch: Boolean(row.referenceCategoryMatch),
      referenceCategoryMatchType: row.referenceCategoryMatchType || '',
      keywordLeafExactMatch: keywordLeafExactMatch(row.category, keywordList),
      mandatoryTarget: row.referenceCategoryMatchType === 'exact' && keywordLeafExactMatch(row.category, keywordList),
      reason: row.reason || '',
      riskFlags: categoryRiskFlags(row),
      sampleProducts: sampleProductsForCategory(items, row.category)
    }))
  };
}

function requestFromExistingTargetCategoryReview(review, fallbackRequest = null) {
  if (!review || !Array.isArray(review.categories)) return fallbackRequest;
  const { decisions, ...request } = review;
  return {
    ...request,
    categories: review.categories
  };
}

function applyTargetCategoryCodexReview(categorySelectionResult, review) {
  const selection = categorySelectionResult || { targetCategories: [], categorySelection: [] };
  const reviewedEntries = uniqueReviewedDecisionEntries(review || {});
  const index = new Map();
  for (const entry of reviewedEntries) {
    const key = normalizeCategory(entry.category);
    if (key) index.set(key, entry);
  }
  const selectionRows = Array.isArray(selection.categorySelection) ? selection.categorySelection : [];
  const reviewedExtraRows = reviewedEntries
    .filter(entry => !selectionRows.some(row => normalizeCategory(row.category) === normalizeCategory(entry.category)))
    .map(entry => ({
      category: entry.category,
      count: 0,
      categoryShare: 0,
      score: 0,
      baseScore: 0,
      contextConflictPenalty: 0,
      leafModifierMismatch: false,
      selectedKeyword: '',
      reason: entry.reason || 'Codex-reviewed category without scraped listing rows',
      tokenHits: [],
      shapeHit: false,
      leafShapeHit: false,
      modifierHits: 0,
      leafModifierHits: 0,
      allKeywordHit: false,
      contextMatch: null,
      contextHits: 0,
      contextTokenCount: 0,
      contextScore: 0,
      contextTokens: [],
      contextMatchedTokens: [],
      competingContextTokens: [],
      functionalEquivalent: false,
      titleIntentRescueCandidate: false,
      highShareTitleRescueCandidate: false,
      highShareTitleRescueReason: '',
      titleAllCount: 0,
      titleAnyCount: 0,
      titleAllRate: 0,
      titleAnyRate: 0,
      referenceCategoryMatch: true,
      referenceScoreBoost: 0,
      referenceCategoryMatchedBy: entry.category,
      referenceCategoryMatchType: 'provided-reference',
      referenceCategoryMatchReason: 'provided reference category with no scraped listing rows',
      missingFromScrapedRows: true
    }));
  const allRows = [...selectionRows, ...reviewedExtraRows];
  const totalCategoryCount = new Set(allRows.map(row => normalizeCategory(row.category)).filter(Boolean)).size;
  if (!index.size) {
    return {
      categorySelectionResult: selection,
      applied: false,
      mode: 'rule-provisional-pending-codex',
      decisionCount: 0,
      reviewedCategoryCount: 0,
      totalCategoryCount,
      complete: false,
      excludedCategories: [],
      includedCategories: []
    };
  }

  const targetSet = new Set();
  const includedCategories = [];
  const excludedCategories = [];
  const reviewedCategories = [];

  const reviewedRows = allRows.map(row => {
    const decision = index.get(normalizeCategory(row.category));
    if (!decision) return row;
    const value = decision.decision || decision.status;
    const isTarget = isTargetDecision(value);
    const isExclude = isExcludeDecision(value);
    const isReview = isReviewDecision(value);
    if (isTarget || isExclude || isReview) reviewedCategories.push(row.category);
    if (isTarget) {
      targetSet.add(row.category);
      includedCategories.push(row.category);
    } else if (isExclude || isReview) {
      targetSet.delete(row.category);
      if (isExclude) excludedCategories.push(row.category);
    }
    return {
      ...row,
      targetCategoryCodexDecision: {
        decision: value || '',
        sameAmazonCategoryFit: decision.sameAmazonCategoryFit,
        sameProductCore: decision.sameProductCore,
        reason: decision.reason || '',
        confidence: decision.confidence || '',
        reviewedBy: decision.reviewedBy || '',
        reviewedAt: decision.reviewedAt || ''
      }
    };
  });

  for (const decision of reviewedEntries) {
    if (isTargetDecision(decision.decision || decision.status)) {
      const existing = allRows.find(row => normalizeCategory(row.category) === normalizeCategory(decision.category));
      if (existing) targetSet.add(existing.category);
    }
  }

  const orderedTargets = [
    ...reviewedRows
    .filter(row => targetSet.has(row.category))
    .map(row => row.category)
  ].filter((category, index, arr) => category && arr.indexOf(category) === index);
  const finalTargetSet = new Set(orderedTargets);
  const decisionCount = reviewedEntries.length;
  const reviewedCategoryCount = new Set(reviewedCategories.map(normalizeCategory).filter(Boolean)).size;
  const complete = totalCategoryCount > 0 && reviewedCategoryCount >= totalCategoryCount;

  return {
    categorySelectionResult: {
      ...selection,
      targetCategory: orderedTargets[0] || '',
      targetCategories: orderedTargets,
      categorySelection: reviewedRows.map(row => ({
        ...row,
        selected: finalTargetSet.has(row.category)
      }))
    },
    applied: true,
    mode: complete ? 'codex-final' : 'codex-provisional-pending-codex',
    decisionCount,
    reviewedCategoryCount,
    totalCategoryCount,
    complete,
    excludedCategories: [...new Set(excludedCategories)],
    includedCategories: [...new Set(includedCategories)]
  };
}

function writeTargetCategoryCodexReviewRequest(dataFile, request, existingReview = null, reviewFileOverride = null) {
  const reviewFile = reviewFileOverride || resolveTargetCategoryReviewFile(dataFile, {});
  const current = existingReview || readJsonIfExists(reviewFile);
  const payload = {
    ...request,
    decisions: Array.isArray(current?.decisions) ? current.decisions : []
  };
  if (current && reviewHasDecisionsForRequest(current, request)) {
    const comparablePayload = value => {
      const clone = {
        ...value,
        decisions: Array.isArray(value?.decisions) ? value.decisions : []
      };
      delete clone.generatedAt;
      return JSON.stringify(clone);
    };
    const currentComparable = comparablePayload(current);
    const nextComparable = comparablePayload(payload);
    if (currentComparable === nextComparable) {
      return { reviewFile, written: false, reason: 'existing review decisions preserved' };
    }
  }
  fs.mkdirSync(path.dirname(reviewFile), { recursive: true });
  fs.writeFileSync(reviewFile, JSON.stringify(payload, null, 2), 'utf8');
  return {
    reviewFile,
    written: true,
    reason: current && reviewHasDecisionsForRequest(current, request)
      ? 'review request context refreshed; existing decisions preserved'
      : (current ? 'pending review request refreshed' : 'pending review request created')
  };
}

module.exports = {
  TARGET_CATEGORY_REVIEW_STANDARD,
  applyTargetCategoryCodexReview,
  buildTargetCategoryCodexReviewRequest,
  keywordLeafExactMatch,
  loadTargetCategoryCodexReview,
  requestFromExistingTargetCategoryReview,
  targetCategoryReviewFileForDataFile,
  writeTargetCategoryCodexReviewRequest
};
