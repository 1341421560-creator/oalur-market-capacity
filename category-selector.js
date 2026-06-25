const SHAPE_ALIASES = {
  spoon: ['spoon', 'scoop', 'teaspoon'],
  scoop: ['scoop', 'spoon'],
  mold: ['mold', 'mould', 'pan'],
  mould: ['mould', 'mold', 'pan'],
  cutter: ['cutter', 'cuter', 'cut', 'stamp'],
  brush: ['brush', 'applicator'],
  holder: ['holder', 'stand', 'rack', 'organizer'],
  bag: ['bag', 'pouch', 'sack'],
  cup: ['cup', 'mug'],
  bottle: ['bottle', 'flask'],
  tray: ['tray', 'plate'],
  mat: ['mat', 'pad'],
  case: ['case', 'cover', 'shell'],
  clip: ['clip', 'clamp'],
  hook: ['hook', 'hanger'],
  rack: ['rack', 'holder', 'stand'],
  pan: ['pan', 'mold', 'mould']
};

const ACCESSORY_LEAF_TOKENS = new Set(['rest', 'holder', 'stand', 'rack', 'organizer', 'case', 'cover']);
const PRODUCT_SHAPE_TOKENS = new Set([...Object.keys(SHAPE_ALIASES), 'candle', 'torch', 'lantern']);

const MODIFIER_ALIASES = {
  coffee: ['coffee', 'espresso', 'demitasse', 'cappuccino', 'latte', 'moka', 'tea', 'teaspoon'],
  espresso: ['espresso', 'coffee', 'demitasse', 'cappuccino', 'latte', 'moka', 'tea', 'teaspoon'],
  chocolate: ['chocolate', 'candy', 'gummy', 'caramel', 'fondant', 'bonbon', 'truffle'],
  candy: ['candy', 'chocolate', 'gummy', 'caramel', 'fondant', 'bonbon', 'truffle']
};

const CONTEXT_ALIASES = {
  garden: ['garden', 'gardening', 'lawn', 'watering', 'yard', 'outdoor', 'patio'],
  hose: ['hose', 'hoses', 'watering'],
  pressure: ['pressure', 'power'],
  washer: ['washer', 'wash', 'washing'],
  car: ['car', 'auto', 'automotive', 'vehicle'],
  wash: ['wash', 'washing', 'washer', 'cleaning'],
  kitchen: ['kitchen', 'dining', 'dishwashing', 'dish', 'cleaning', 'household', 'house'],
  coffee: ['coffee', 'espresso', 'demitasse', 'cappuccino', 'latte', 'moka', 'tea', 'teaspoon'],
  espresso: ['espresso', 'coffee', 'demitasse', 'cappuccino', 'latte', 'moka'],
  chocolate: ['chocolate', 'candy', 'gummy', 'caramel', 'fondant', 'bonbon', 'truffle'],
  candy: ['candy', 'chocolate', 'gummy', 'caramel', 'fondant', 'bonbon', 'truffle']
};

function stemToken(token) {
  const t = String(token || '').toLowerCase();
  if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.length > 4 && t.endsWith('les')) return t.slice(0, -1);
  if (t.length > 3 && t.endsWith('es')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s')) return t.slice(0, -1);
  return t;
}

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .match(/[a-z0-9]+/g) || [];
}

function keywordTokens(value) {
  return [...new Set(tokenize(value).map(stemToken).filter(t => t.length >= 2))];
}

function tokenSet(value) {
  return new Set(tokenize(value).map(stemToken));
}

function referenceCategoryMatchInfo(category, referenceCategories = []) {
  const categoryNorm = normalizeCategoryPath(category);
  if (!categoryNorm || !referenceCategories.length) {
    return {
      referenceCategoryMatch: false,
      referenceScoreBoost: 0,
      referenceCategoryMatchedBy: '',
      referenceCategoryMatchType: '',
      referenceCategoryMatchReason: ''
    };
  }

  const categoryLeafNorm = categoryParts(category).slice(-1)[0] || '';
  const categoryWords = tokenSet(categoryNorm);
  let best = {
    referenceCategoryMatch: false,
    referenceScoreBoost: 0,
    referenceCategoryMatchedBy: '',
    referenceCategoryMatchType: '',
    referenceCategoryMatchReason: ''
  };

  for (const rawReference of referenceCategories) {
    const referenceNorm = normalizeCategoryPath(rawReference);
    if (!referenceNorm) continue;
    const referenceLeafNorm = categoryParts(referenceNorm).slice(-1)[0] || '';
    const referenceWords = tokenSet(referenceNorm);
    const sharedTokens = [...referenceWords].filter(token => categoryWords.has(token));
    let candidate = null;

    if (categoryNorm === referenceNorm) {
      candidate = {
        referenceScoreBoost: 130,
        referenceCategoryMatchType: 'exact',
        referenceCategoryMatchReason: 'reference category exact match'
      };
    } else if (categoryNorm.startsWith(`${referenceNorm} > `) || referenceNorm.startsWith(`${categoryNorm} > `)) {
      candidate = {
        referenceScoreBoost: 70,
        referenceCategoryMatchType: 'path',
        referenceCategoryMatchReason: 'reference category parent/child path match'
      };
    } else if (categoryLeafNorm && categoryLeafNorm === referenceLeafNorm && sharedTokens.length >= 2) {
      candidate = {
        referenceScoreBoost: 35,
        referenceCategoryMatchType: 'leaf',
        referenceCategoryMatchReason: 'reference category leaf and path tokens match'
      };
    }

    if (candidate && candidate.referenceScoreBoost > best.referenceScoreBoost) {
      best = {
        referenceCategoryMatch: true,
        referenceCategoryMatchedBy: rawReference,
        ...candidate
      };
    }
  }

  return best;
}

function categoryLeaf(category) {
  const parts = String(category || '').split('>').map(s => s.trim()).filter(Boolean);
  return parts[parts.length - 1] || String(category || '');
}

function normalizeCategoryPath(category) {
  return String(category || '')
    .replace(/&amp;/gi, '&')
    .split('>')
    .map(part => part.trim().replace(/\s+/g, ' ').toLowerCase())
    .filter(Boolean)
    .join(' > ');
}

function categoryParts(category) {
  return normalizeCategoryPath(category).split(' > ').filter(Boolean);
}

function isUnknownCategory(category) {
  const value = String(category || '');
  return !value || value.includes('未识别') || value.includes('\u93c8\uE046\u7611');
}

function aliasesFor(token) {
  return new Set([token, ...(SHAPE_ALIASES[token] || [])].map(stemToken));
}

function modifierAliasesFor(token) {
  return new Set([token, ...(MODIFIER_ALIASES[token] || [])].map(stemToken));
}

function contextAliasesFor(token) {
  return new Set([token, ...(CONTEXT_ALIASES[token] || MODIFIER_ALIASES[token] || [])].map(stemToken));
}

function anyTokenHit(words, tokens) {
  return [...tokens].some(token => words.has(token));
}

function countHits(words, tokens) {
  return tokens.filter(token => words.has(token)).length;
}

function keywordIntentParts(keyword) {
  const tokens = keywordTokens(keyword);
  if (!tokens.length) return { tokens, shapeToken: '', modifierTokens: [] };
  let shapeIndex = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (PRODUCT_SHAPE_TOKENS.has(tokens[i])) {
      shapeIndex = i;
      break;
    }
  }
  if (shapeIndex < 0) shapeIndex = tokens.length - 1;
  return {
    tokens,
    shapeToken: tokens[shapeIndex],
    modifierTokens: tokens.filter((_, index) => index !== shapeIndex)
  };
}

function categoryContextInfo(category, keyword) {
  const words = tokenSet(category);
  const tokens = keywordTokens(keyword);
  const contextTokens = tokens.slice(0, -1);
  if (!contextTokens.length) {
    return {
      contextMatch: true,
      contextHits: 0,
      contextTokenCount: 0,
      contextScore: 1,
      contextTokens: [],
      contextMatchedTokens: []
    };
  }
  const matchedTokens = [];
  const matchedGroups = [];
  let hits = 0;
  for (const token of contextTokens) {
    const aliases = contextAliasesFor(token);
    const matched = [...aliases].filter(alias => words.has(alias));
    if (matched.length) {
      hits++;
      matchedGroups.push(token);
      matchedTokens.push(...matched);
    }
  }
  const competingContextTokens = Object.keys(CONTEXT_ALIASES).filter(token => {
    if (contextTokens.includes(token)) return false;
    return [...contextAliasesFor(token)].some(alias => words.has(alias));
  });
  const contextScore = hits / contextTokens.length;
  const allContextTokensMatched = hits === contextTokens.length;
  const primaryContextMatched = contextTokens.length > 1 && matchedGroups.includes(contextTokens[0]);
  const contextMatch = allContextTokensMatched || (primaryContextMatched && competingContextTokens.length === 0);
  return {
    contextMatch,
    contextHits: hits,
    contextTokenCount: contextTokens.length,
    contextScore: Math.round(contextScore * 1000) / 1000,
    contextTokens,
    contextMatchedTokens: [...new Set(matchedTokens)],
    competingContextTokens
  };
}

function categoryMatchesKeywordContext(category, keyword) {
  return categoryContextInfo(category, keyword).contextMatch;
}

function scoreCategoryForKeyword(category, items, keyword) {
  const { tokens, shapeToken, modifierTokens } = keywordIntentParts(keyword);
  if (!tokens.length) {
    return { score: 0, reason: 'empty keyword', tokenHits: [], titleAllRate: 0, titleAnyRate: 0 };
  }

  const shapeAliases = aliasesFor(shapeToken);
  const categoryWords = tokenSet(category);
  const leafWords = tokenSet(categoryLeaf(category));
  const accessoryLeaf = [...ACCESSORY_LEAF_TOKENS].some(token => leafWords.has(token));
  const categoryTokenHits = tokens.filter(token => categoryWords.has(token));
  const leafTokenHits = tokens.filter(token => leafWords.has(token));
  const modifierHits = countHits(categoryWords, modifierTokens);
  const leafModifierHits = countHits(leafWords, modifierTokens);
  const shapeHit = anyTokenHit(categoryWords, shapeAliases);
  const leafShapeHit = anyTokenHit(leafWords, shapeAliases);
  const allKeywordHit = tokens.every(token => categoryWords.has(token));

  let titleAll = 0;
  let titleAny = 0;
  for (const item of items) {
    const titleWords = tokenSet(item.title || item.productTitle || item.productName || '');
    const titleShapeHit = anyTokenHit(titleWords, shapeAliases);
    const titleModifierHits = countHits(titleWords, modifierTokens);
    if (titleShapeHit && (modifierTokens.length === 0 || titleModifierHits === modifierTokens.length)) titleAll++;
    if (titleShapeHit || titleModifierHits > 0) titleAny++;
  }
  const titleAllRate = items.length ? titleAll / items.length : 0;
  const titleAnyRate = items.length ? titleAny / items.length : 0;
  const functionalEquivalent = !accessoryLeaf && shapeHit && modifierTokens.length > 0 && modifierHits === 0 && titleAllRate >= 0.35 && titleAnyRate >= 0.7;

  let score = 0;
  if (allKeywordHit) score += 85;
  if (shapeHit) score += 35;
  if (leafShapeHit) score += 20;
  score += modifierHits * 24;
  score += leafModifierHits * 10;
  score += titleAllRate * 45;
  score += titleAnyRate * 12;
  score += Math.min(14, Math.log(items.length + 1) * 4);
  if (shapeHit && modifierTokens.length && modifierHits === 0 && titleAllRate < 0.35) score -= 35;
  if (!shapeHit && modifierHits > 0 && titleAllRate < 0.2) score -= 16;
  if (!shapeHit && modifierHits === 0) score -= 60;

  const reasons = [];
  if (allKeywordHit) reasons.push('category contains all keyword tokens');
  if (shapeHit) reasons.push(leafShapeHit ? 'leaf matches product form' : 'path matches product form');
  if (modifierHits) reasons.push(`path matches ${modifierHits} modifier token(s)`);
  if (titleAllRate >= 0.35) reasons.push(`category titles strongly match keyword (${Math.round(titleAllRate * 100)}%)`);
  if (functionalEquivalent) reasons.push('functional equivalent category candidate; requires ASIN title match');
  if (!reasons.length) reasons.push('low keyword relevance');

  return {
    score: Math.round(score * 10) / 10,
    reason: reasons.join('; '),
    tokenHits: [...new Set([...categoryTokenHits, ...leafTokenHits])],
    shapeHit,
    leafShapeHit,
    modifierHits,
    leafModifierHits,
    allKeywordHit,
    functionalEquivalent,
    titleAllCount: titleAll,
    titleAnyCount: titleAny,
    titleAllRate: Math.round(titleAllRate * 1000) / 1000,
    titleAnyRate: Math.round(titleAnyRate * 1000) / 1000
  };
}

function titleMatchesKeywordIntent(title, keyword) {
  const { tokens, shapeToken, modifierTokens } = keywordIntentParts(keyword);
  if (!tokens.length) return false;
  const shapeAliases = aliasesFor(shapeToken);
  const titleWords = tokenSet(title);
  const shapeHit = anyTokenHit(titleWords, shapeAliases);
  const modifierHit = modifierTokens.every(token => anyTokenHit(titleWords, modifierAliasesFor(token)));
  return shapeHit && (modifierTokens.length === 0 || modifierHit);
}

function listingMatchesKeywordIntent(item, keywords) {
  const keywordList = Array.isArray(keywords) && keywords.length ? keywords : [''];
  const titles = [
    item.title,
    item.productTitle,
    item.productName,
    ...(Array.isArray(item.variantRows) ? item.variantRows.map(row => row.title) : [])
  ].filter(Boolean);
  return titles.some(title => keywordList.some(keyword => titleMatchesKeywordIntent(title, keyword)));
}

function hasTargetCategoryEvidence(detail) {
  return Boolean(detail && detail.category);
}

function isReferenceConfirmedTarget(detail) {
  return false;
}

function isReferenceSemanticReviewCategory(detail) {
  return false;
}

function isTargetCategoryCandidate(detail) {
  return (
    detail.category &&
    !isUnknownCategory(detail.category) &&
    !detail.leafModifierMismatch &&
    !isReferenceSemanticReviewCategory(detail) &&
    (!detail.functionalEquivalent || isReferenceConfirmedTarget(detail)) &&
    hasTargetCategoryEvidence(detail)
  );
}

function selectTargetCategories(products, keywords, options = {}) {
  const referenceCategories = Array.isArray(options.referenceCategories) ? options.referenceCategories.filter(Boolean) : [];
  const referenceReviewCategories = [...new Set(referenceCategories.map(category => String(category || '').trim()).filter(Boolean))];
  const totalProductCount = Array.isArray(products) ? products.length : 0;
  const grouped = new Map();
  for (const item of products) {
    const category = item.category || '未识别';
    if (!grouped.has(category)) grouped.set(category, []);
    grouped.get(category).push(item);
  }

  const keywordList = Array.isArray(keywords) && keywords.length ? keywords : [''];
  const details = [...grouped.entries()].map(([category, items]) => {
    const perKeyword = keywordList.map(keyword => ({
      keyword,
      ...categoryContextInfo(category, keyword),
      ...scoreCategoryForKeyword(category, items, keyword)
    }));
    const best = perKeyword.reduce((a, b) => (b.score > a.score ? b : a), perKeyword[0]);
    const referenceMatch = referenceCategoryMatchInfo(category, referenceCategories);
    const contextConflictPenalty = best.contextMatch === false && !best.allKeywordHit
      ? Math.round(((best.modifierHits || 0) * 20 + (best.leafModifierHits || 0) * 8) * 10) / 10
      : 0;
    const leafModifierMismatch = best.shapeHit &&
      best.leafShapeHit &&
      best.modifierHits > 0 &&
      best.leafModifierHits === 0 &&
      best.titleAllRate < 0.35;
    const score = Math.round((best.score - contextConflictPenalty) * 10) / 10;
    let scoreReason = contextConflictPenalty
      ? `${best.reason}; context conflict penalty -${contextConflictPenalty}`
      : best.reason;
    if (leafModifierMismatch) {
      scoreReason = `${scoreReason}; leaf modifier mismatch block`;
    }
    return {
      category,
      count: items.length,
      categoryShare: totalProductCount ? Math.round((items.length / totalProductCount) * 1000) / 1000 : 0,
      score,
      baseScore: best.score,
      contextConflictPenalty,
      leafModifierMismatch,
      selectedKeyword: best.keyword,
      reason: [scoreReason, referenceMatch.referenceCategoryMatchReason].filter(Boolean).join('; '),
      tokenHits: best.tokenHits,
      shapeHit: best.shapeHit,
      leafShapeHit: best.leafShapeHit,
      modifierHits: best.modifierHits,
      leafModifierHits: best.leafModifierHits,
      allKeywordHit: best.allKeywordHit,
      contextMatch: best.contextMatch,
      contextHits: best.contextHits,
      contextTokenCount: best.contextTokenCount,
      contextScore: best.contextScore,
      contextTokens: best.contextTokens,
      contextMatchedTokens: best.contextMatchedTokens,
      competingContextTokens: best.competingContextTokens,
      functionalEquivalent: best.functionalEquivalent,
      titleAllCount: best.titleAllCount,
      titleAnyCount: best.titleAnyCount,
      titleAllRate: best.titleAllRate,
      titleAnyRate: best.titleAnyRate,
      ...referenceMatch,
      referenceScoreBoost: 0,
      perKeyword
    };
  }).sort((a, b) => b.score - a.score || b.count - a.count);

  const selected = details.filter(d => (
    isTargetCategoryCandidate(d) &&
    !d.leafModifierMismatch &&
    !isReferenceSemanticReviewCategory(d) &&
    (
      (d.score >= 110 && (d.count >= 3 || d.score >= 180) && (
        d.contextMatch !== false ||
        d.allKeywordHit
      )) ||
      (d.shapeHit && d.contextMatch !== false && d.count >= 20 && d.titleAllRate >= 0.5)
    )
  ));
  const functionalEquivalentRescueSelected = details.filter(d => (
    d.category &&
    !isUnknownCategory(d.category) &&
    d.functionalEquivalent
  ));
  const broadTitleIntentSelected = details.filter(d => (
    d.category &&
    !isUnknownCategory(d.category) &&
    !d.shapeHit &&
    d.score >= 70 &&
    d.count >= 20 &&
    d.titleAllRate >= 0.35
  ));
  const offContextShapeRescueSelected = details.filter(d => (
    d.category &&
    !isUnknownCategory(d.category) &&
    d.shapeHit &&
    d.contextMatch === false &&
    d.score >= 110 &&
    d.count >= 3 &&
    d.titleAllRate >= 0.2
  ));
  const highTitleIntentRescueSelected = details.filter(d => (
    d.category &&
    !isUnknownCategory(d.category) &&
    !selected.some(item => item.category === d.category) &&
    d.count >= 5 &&
    d.titleAllRate >= 0.35 &&
    d.titleAnyRate >= 0.85 &&
    d.score >= 20
  ));
  const highShareTitleRescueSelected = details.filter(d => (
    d.category &&
    !isUnknownCategory(d.category) &&
    !selected.some(item => item.category === d.category) &&
    d.categoryShare > 0.05
  ));
  const titleIntentRescueSet = new Set([
    ...functionalEquivalentRescueSelected.map(d => d.category),
    ...broadTitleIntentSelected.map(d => d.category),
    ...offContextShapeRescueSelected.map(d => d.category),
    ...highTitleIntentRescueSelected.map(d => d.category)
  ]);
  const highShareTitleRescueSet = new Set(highShareTitleRescueSelected.map(d => d.category));

  const fallback = selected.length
    ? selected
    : (broadTitleIntentSelected.filter(isTargetCategoryCandidate).length
      ? broadTitleIntentSelected.filter(isTargetCategoryCandidate).slice(0, 5)
      : details.filter(isTargetCategoryCandidate).slice(0, 1));
  const expandedFallback = selected.length ? fallback : (() => {
    const validDetails = details.filter(isTargetCategoryCandidate);
    const top = validDetails[0];
    if (!top) return fallback;
    const closeMatches = validDetails.filter(d => (
      d.score >= Math.max(70, top.score - 8) &&
      d.count >= 3 &&
      d.titleAllRate >= 0.35
    )).slice(0, 5);
    return closeMatches.length ? closeMatches : fallback;
  })();
  const selectedCategories = expandedFallback
    .filter(d => !d.functionalEquivalent || isReferenceConfirmedTarget(d))
    .map(d => d.category);
  const selectedSet = new Set(selectedCategories);

  return {
    targetCategory: selectedCategories[0] || '',
    targetCategories: selectedCategories,
    referenceReviewCategories,
    referenceSemanticReviewCategories: [],
    categorySelection: details.map(d => ({
      category: d.category,
      count: d.count,
      categoryShare: d.categoryShare,
      score: d.score,
      baseScore: d.baseScore,
      contextConflictPenalty: d.contextConflictPenalty,
      leafModifierMismatch: d.leafModifierMismatch,
      selected: selectedSet.has(d.category),
      selectedKeyword: d.selectedKeyword,
      reason: d.reason,
      tokenHits: d.tokenHits,
      shapeHit: d.shapeHit,
      leafShapeHit: d.leafShapeHit,
      modifierHits: d.modifierHits,
      leafModifierHits: d.leafModifierHits,
      allKeywordHit: d.allKeywordHit,
      contextMatch: d.contextMatch,
      contextHits: d.contextHits,
      contextTokenCount: d.contextTokenCount,
      contextScore: d.contextScore,
      contextTokens: d.contextTokens,
      contextMatchedTokens: d.contextMatchedTokens,
      competingContextTokens: d.competingContextTokens,
      functionalEquivalent: d.functionalEquivalent,
      titleIntentRescueCandidate: titleIntentRescueSet.has(d.category),
      highShareTitleRescueCandidate: highShareTitleRescueSet.has(d.category),
      highShareTitleRescueReason: highShareTitleRescueSet.has(d.category)
        ? `high-share non-target category: category share ${(d.categoryShare * 100).toFixed(1)}% > 5%; local Codex must decide whether listings are the same product/function attributes as the input keyword`
        : '',
      titleAllCount: d.titleAllCount,
      titleAnyCount: d.titleAnyCount,
      titleAllRate: d.titleAllRate,
      titleAnyRate: d.titleAnyRate,
      referenceCategoryMatch: d.referenceCategoryMatch,
      referenceScoreBoost: d.referenceScoreBoost,
      referenceCategoryMatchedBy: d.referenceCategoryMatchedBy,
      referenceCategoryMatchType: d.referenceCategoryMatchType,
      referenceCategoryMatchReason: d.referenceCategoryMatchReason
    }))
  };
}

module.exports = {
  selectTargetCategories,
  stemToken,
  tokenize,
  keywordTokens,
  categoryContextInfo,
  referenceCategoryMatchInfo,
  titleMatchesKeywordIntent,
  listingMatchesKeywordIntent
};
