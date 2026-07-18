function textValue(value) {
  if (value == null) return '';
  return String(value).trim();
}

function listValues(value) {
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean);
  const text = textValue(value);
  return text ? [text] : [];
}

function uniqueValues(values) {
  const seen = new Set();
  const result = [];
  for (const value of values.map(textValue).filter(Boolean)) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function optionalNumber(value) {
  if (value == null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalBoolean(value) {
  return typeof value === 'boolean' ? value : undefined;
}

function compactObject(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => {
    if (Array.isArray(value)) return value.length > 0;
    return value !== undefined && value !== null && value !== '';
  }));
}

function buildInputProductContext(source = {}, fallback = {}) {
  const keyword = textValue(source.keyword || fallback.keyword);
  const category = textValue(source.category || fallback.category);
  const categories = uniqueValues([
    category,
    ...listValues(source.categories),
    ...listValues(fallback.categories)
  ]);
  const bulletPoints = uniqueValues([
    ...listValues(source.bulletPoints),
    ...listValues(source.bullets),
    ...listValues(source.features),
    ...listValues(fallback.bulletPoints),
    ...listValues(fallback.bullets),
    ...listValues(fallback.features)
  ]);
  const images = uniqueValues([
    ...listValues(source.images),
    ...listValues(source.imageUrls),
    ...listValues(source.mainImage),
    ...listValues(source.image),
    ...listValues(fallback.images),
    ...listValues(fallback.imageUrls),
    ...listValues(fallback.mainImage),
    ...listValues(fallback.image)
  ]);

  return compactObject({
    asin: textValue(source.asin || fallback.asin),
    keyword,
    title: textValue(source.title || source.productTitle || source.productName || fallback.title),
    category,
    categories,
    bulletPoints,
    description: textValue(source.description || source.productDescription || fallback.description || fallback.productDescription),
    images,
    matchType: textValue(source.matchType || fallback.matchType),
    hasExactMatch: optionalBoolean(source.hasExactMatch ?? fallback.hasExactMatch),
    score: optionalNumber(source.score ?? fallback.score),
    jsKeyword: textValue(source.jsKeyword || fallback.jsKeyword)
  });
}

function contextHasContent(context) {
  return Object.values(context || {}).some(value => Array.isArray(value) ? value.length > 0 : Boolean(value));
}

function parseInputProductContextEnv(env = process.env) {
  const raw = env.OALUR_INPUT_PRODUCT_CONTEXT;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const context = buildInputProductContext(parsed);
    return contextHasContent(context) ? context : null;
  } catch (error) {
    console.warn(`Ignoring invalid OALUR_INPUT_PRODUCT_CONTEXT: ${error.message}`);
    return null;
  }
}

function mergeInputProductContexts(values = []) {
  const contexts = values
    .flatMap(value => Array.isArray(value) ? value : [value])
    .map(value => buildInputProductContext(value || {}))
    .filter(contextHasContent);
  const seen = new Set();
  const result = [];
  for (const context of contexts) {
    const key = [
      context.asin || '',
      context.keyword || '',
      context.title || '',
      (context.categories || []).join('|')
    ].join('::').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(context);
  }
  return result;
}

function primaryInputProductContext(values = []) {
  return mergeInputProductContexts(values)[0] || null;
}

module.exports = {
  buildInputProductContext,
  mergeInputProductContexts,
  parseInputProductContextEnv,
  primaryInputProductContext
};
