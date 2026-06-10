const SHAPE_ALIASES = {
  spoon: ['spoon', 'scoop'],
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

const MODIFIER_ALIASES = {
  coffee: ['coffee', 'espresso', 'demitasse', 'cappuccino', 'latte', 'moka'],
  espresso: ['espresso', 'coffee', 'demitasse', 'cappuccino', 'latte', 'moka'],
  chocolate: ['chocolate', 'candy', 'gummy', 'caramel', 'fondant', 'bonbon', 'truffle'],
  candy: ['candy', 'chocolate', 'gummy', 'caramel', 'fondant', 'bonbon', 'truffle']
};

function stemToken(token) {
  const t = String(token || '').toLowerCase();
  if (t.length > 4 && t.endsWith('ies')) return t.slice(0, -3) + 'y';
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

function categoryLeaf(category) {
  const parts = String(category || '').split('>').map(s => s.trim()).filter(Boolean);
  return parts[parts.length - 1] || String(category || '');
}

function aliasesFor(token) {
  return new Set([token, ...(SHAPE_ALIASES[token] || [])].map(stemToken));
}

function modifierAliasesFor(token) {
  return new Set([token, ...(MODIFIER_ALIASES[token] || [])].map(stemToken));
}

function anyTokenHit(words, tokens) {
  return [...tokens].some(token => words.has(token));
}

function countHits(words, tokens) {
  return tokens.filter(token => words.has(token)).length;
}

function scoreCategoryForKeyword(category, items, keyword) {
  const tokens = keywordTokens(keyword);
  if (!tokens.length) {
    return { score: 0, reason: 'empty keyword', tokenHits: [], titleAllRate: 0, titleAnyRate: 0 };
  }

  const shapeToken = tokens[tokens.length - 1];
  const shapeAliases = aliasesFor(shapeToken);
  const modifierTokens = tokens.slice(0, -1);
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
    modifierHits,
    functionalEquivalent,
    titleAllRate: Math.round(titleAllRate * 1000) / 1000,
    titleAnyRate: Math.round(titleAnyRate * 1000) / 1000
  };
}

function titleMatchesKeywordIntent(title, keyword) {
  const tokens = keywordTokens(keyword);
  if (!tokens.length) return false;
  const shapeToken = tokens[tokens.length - 1];
  const shapeAliases = aliasesFor(shapeToken);
  const modifierTokens = tokens.slice(0, -1);
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

function selectTargetCategories(products, keywords) {
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
      ...scoreCategoryForKeyword(category, items, keyword)
    }));
    const best = perKeyword.reduce((a, b) => (b.score > a.score ? b : a), perKeyword[0]);
    return {
      category,
      count: items.length,
      score: best.score,
      selectedKeyword: best.keyword,
      reason: best.reason,
      tokenHits: best.tokenHits,
      shapeHit: best.shapeHit,
      modifierHits: best.modifierHits,
      functionalEquivalent: best.functionalEquivalent,
      titleAllRate: best.titleAllRate,
      titleAnyRate: best.titleAnyRate,
      perKeyword
    };
  }).sort((a, b) => b.score - a.score || b.count - a.count);

  const selected = details.filter(d => (
    d.category !== '未识别' &&
    d.score >= 110 &&
    (d.count >= 3 || d.score >= 180)
  ));

  const fallback = selected.length ? selected : details.filter(d => d.category !== '未识别').slice(0, 1);
  const selectedCategories = fallback.map(d => d.category);
  const selectedSet = new Set(selectedCategories);

  return {
    targetCategory: selectedCategories[0] || '',
    targetCategories: selectedCategories,
    categorySelection: details.map(d => ({
      category: d.category,
      count: d.count,
      score: d.score,
      selected: selectedSet.has(d.category),
      selectedKeyword: d.selectedKeyword,
      reason: d.reason,
      tokenHits: d.tokenHits,
      functionalEquivalent: d.functionalEquivalent,
      titleAllRate: d.titleAllRate,
      titleAnyRate: d.titleAnyRate
    }))
  };
}

module.exports = {
  selectTargetCategories,
  stemToken,
  tokenize,
  keywordTokens,
  titleMatchesKeywordIntent,
  listingMatchesKeywordIntent
};
