const fs = require('fs');
const path = require('path');
const { safeSegment } = require('./run-log');

const LABELS = {
  module: '\u6a21\u5757',
  finalDecision: '\u6700\u7ec8\u7ed3\u8bba',
  totalScore: '\u5e02\u573a\u9a8c\u8bc1\u603b\u5206',
  veto: '\u4e00\u7968\u5426\u51b3\u9879',
  relatedReports: '\u76f8\u5173\u62a5\u544a',
  notEnter: '\u4e0d\u8fdb\u5165',
  noTrigger: '\u672a\u89e6\u53d1'
};

function usage() {
  console.error('Usage: node generate-result-log.js <product-root-or-data-json>');
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function textFromHtml(value) {
  return decodeHtml(String(value || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function tableCells(rowHtml) {
  return [...String(rowHtml || '').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
    .map(match => textFromHtml(match[1]));
}

function readJsonIfExists(filePath, fallback = null) {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveRoot(inputPath) {
  const resolved = path.resolve(inputPath);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    const parent = path.basename(path.dirname(resolved)).toLowerCase();
    return parent === 'data'
      ? path.dirname(path.dirname(resolved))
      : path.dirname(resolved);
  }
  return resolved;
}

function firstExisting(files) {
  return files.find(file => file && fs.existsSync(file)) || null;
}

function listFiles(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(predicate)
    .map(file => path.join(dir, file))
    .filter(file => fs.statSync(file).isFile());
}

function findBySuffix(dir, suffix) {
  return listFiles(dir, file => file.endsWith(suffix))[0] || null;
}

function findDataFile(dataDir) {
  const files = listFiles(dataDir, file => file.endsWith('-data.json'));
  return files.find(file => !file.endsWith('-historical.json')) || files[0] || null;
}

function findMarketReport(reportsDir) {
  for (const filePath of listFiles(reportsDir, file => file.toLowerCase().endsWith('.html'))) {
    const html = fs.readFileSync(filePath, 'utf8');
    const firstTable = (html.match(/<table[\s\S]*?<\/table>/g) || [])[0] || '';
    const firstRow = (firstTable.match(/<tr>([\s\S]*?)<\/tr>/) || [, ''])[1];
    const header = tableCells(firstRow);
    if (header[0] === LABELS.module) return { filePath, html };
  }
  return null;
}

function extractMetrics(html) {
  return [...String(html || '').matchAll(/<div class="metric"><div class="value"[^>]*>([\s\S]*?)<\/div><div class="label">([\s\S]*?)<\/div><\/div>/g)]
    .map(match => ({ value: textFromHtml(match[1]), label: textFromHtml(match[2]) }));
}

function extractScoreRows(html) {
  const table = (String(html || '').match(/<table[\s\S]*?<\/table>/g) || [])[0] || '';
  return [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map(match => tableCells(match[1]))
    .filter(cells => cells.length >= 6 && cells[0] !== LABELS.module)
    .map(cells => ({
      module: cells[0],
      weight: cells[1],
      score: cells[2],
      current: cells[3]
    }));
}

function extractVeto(html) {
  const plainText = textFromHtml(html);
  const start = plainText.indexOf(LABELS.veto);
  if (start < 0) return 'N/A';
  const rest = plainText.slice(start);
  const end = rest.indexOf(LABELS.relatedReports);
  return (end >= 0 ? rest.slice(0, end) : rest.slice(0, 120)).replace(/\s+/g, ' ').trim();
}

function formatPct(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : 'N/A';
}

function valueOrNA(value) {
  return value == null || value === '' ? 'N/A' : String(value);
}

function parseNumber(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[$,\s]/g, '').trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function monthlySalesValue(item) {
  return parseNumber(item?.salesNumAggregated ?? item?.sales);
}

function medianNumber(values) {
  const nums = values.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function averageNumber(values) {
  const nums = values.filter(v => typeof v === 'number' && Number.isFinite(v));
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : null;
}

function listingAsinIdentifiers(item) {
  return [...new Set([
    item?.asin,
    item?.pasin,
    item?.parentAsin,
    ...(Array.isArray(item?.childAsins) ? item.childAsins : []),
    ...(Array.isArray(item?.targetMatchedChildAsins) ? item.targetMatchedChildAsins : []),
    ...(Array.isArray(item?.variantRows) ? item.variantRows.map(row => row?.asin) : [])
  ].filter(Boolean))];
}

function cpcSummaryForCurrentFilteredListings(cpc, market) {
  const products = Array.isArray(cpc?.products) ? cpc.products : [];
  if (!products.length) return { summary: cpc?.summary || null, products: [], removed: [] };
  const currentAsins = new Set((Array.isArray(market?.data) ? market.data : []).flatMap(listingAsinIdentifiers));
  const kept = [];
  const removed = [];
  for (const product of products) {
    if (product?.asin && currentAsins.has(product.asin)) kept.push(product);
    else if (product?.asin) removed.push(product.asin);
  }
  if (!kept.length) return { summary: null, products: [], removed };
  const ratios = kept.map(item => item.cpcPriceRatioPct).filter(v => typeof v === 'number' && Number.isFinite(v));
  const cpcs = kept.map(item => item.avgCpc).filter(v => typeof v === 'number' && Number.isFinite(v));
  return {
    summary: {
      ...(cpc.summary || {}),
      asinCount: kept.length,
      avgCpc: averageNumber(cpcs),
      avgCpcPriceRatioPct: averageNumber(ratios),
      medianCpc: medianNumber(cpcs),
      medianCpcPriceRatioPct: medianNumber(ratios)
    },
    products: kept,
    removed
  };
}

function likelyMissingCodexCategoryCandidates(market) {
  const targetSet = new Set(Array.isArray(market.targetCategories) ? market.targetCategories : []);
  const existingSet = new Set((market.codexSemanticReviewCandidates || []).map(candidate => candidate.category).filter(Boolean));
  return (market.categorySelection || [])
    .filter(row => row && row.category && !targetSet.has(row.category) && !existingSet.has(row.category))
    .filter(row => {
      const count = Number(row.count || 0);
      const share = Number(row.categoryShare || 0);
      const score = Number(row.score);
      return share > 0.05
        || row.titleIntentRescueCandidate
        || row.functionalEquivalent
        || (Number.isFinite(score) && (score >= 110 || (score >= 70 && count >= 3)));
    })
    .map(row => ({
      category: row.category,
      count: Number(row.count || 0),
      share: Number(row.categoryShare || 0),
      score: Number(row.score),
      reason: row.reason || ''
    }));
}

function contextConflictBlockedCategories(market) {
  const targetSet = new Set(Array.isArray(market.targetCategories) ? market.targetCategories : []);
  return (market.categorySelection || [])
    .filter(row => row && row.category && !targetSet.has(row.category))
    .filter(row => {
      const count = Number(row.count || 0);
      const share = Number(row.categoryShare || 0);
      const score = Number(row.score);
      const penalty = Number(row.contextConflictPenalty || 0);
      return (penalty > 0 || row.contextMatch === false || row.leafModifierMismatch) &&
        (share >= 0.05 || count >= 10 || (Number.isFinite(score) && score >= 35));
    })
    .sort((a, b) => {
      const leafDiff = Number(Boolean(b.leafModifierMismatch)) - Number(Boolean(a.leafModifierMismatch));
      if (leafDiff) return leafDiff;
      const penaltyDiff = Number(b.contextConflictPenalty || 0) - Number(a.contextConflictPenalty || 0);
      if (penaltyDiff) return penaltyDiff;
      return Number(b.score || -999) - Number(a.score || -999);
    })
    .slice(0, 8)
    .map(row => ({
      category: row.category,
      count: Number(row.count || 0),
      share: Number(row.categoryShare || 0),
      score: Number(row.score),
      baseScore: Number(row.baseScore),
      penalty: Number(row.contextConflictPenalty || 0),
      guardType: row.leafModifierMismatch ? 'leaf modifier mismatch' : 'context conflict',
      reason: row.reason || ''
    }));
}

function googleTrendsCoreReviewMissing(seasonality, trends) {
  const routing = seasonality?.googleTrendsRouting || {};
  const review = routing.codexCoreReview || {};
  const sparseReason = [
    routing.fallbackReason,
    trends?.keywordFallbackReason,
    trends?.previousError,
    trends?.quality?.reason
  ].filter(Boolean).join(' | ');
  const sparseTriggered = /sparse|too sparse|稀疏/i.test(sparseReason);
  const finalQualityBad = trends?.quality && !trends.quality.ok;
  const shouldHaveReview = sparseTriggered || finalQualityBad;
  const reviewLoaded = Boolean(review.loaded && review.selectedQuery);
  return {
    missing: shouldHaveReview && !reviewLoaded,
    sparseReason,
    review
  };
}

function buildLog(root) {
  const dataDir = path.join(root, 'data');
  const reportsDir = path.join(root, 'reports');
  const dataFile = findDataFile(dataDir);
  if (!dataFile) throw new Error(`Data file not found under ${dataDir}`);

  const market = readJsonIfExists(dataFile, {});
  const keyword = market.keyword || market.keywords?.[0] || path.basename(dataFile).replace(/-data\.json$/i, '');
  const keywordFile = safeSegment(keyword).toLowerCase();
  const outPath = path.join(root, `${keywordFile}-result.log`);
  const marketReport = findMarketReport(reportsDir);
  const html = marketReport?.html || '';
  const metrics = extractMetrics(html);
  const scoreRows = extractScoreRows(html);
  const scoreMetric = metrics.find(metric => metric.label.includes(LABELS.totalScore)) || metrics[0] || {};
  const decisionMetric = metrics.find(metric => metric.label === LABELS.finalDecision) || {};
  const veto = html ? extractVeto(html) : 'N/A';

  const trends = readJsonIfExists(firstExisting([
    findBySuffix(dataDir, '-google-trends.json')
  ]), null);
  const seasonality = readJsonIfExists(firstExisting([
    path.join(dataDir, `${keywordFile}-seasonality.json`),
    findBySuffix(dataDir, '-seasonality.json')
  ]), null);
  const historical = readJsonIfExists(firstExisting([
    path.join(dataDir, `${keywordFile}-historical.json`),
    findBySuffix(dataDir, '-historical.json')
  ]), null);
  const cpc = readJsonIfExists(firstExisting([
    path.join(dataDir, `${keywordFile}-cpc-opportunity.json`),
    findBySuffix(dataDir, '-cpc-opportunity.json')
  ]), null);
  const currentFilteredCpc = cpcSummaryForCurrentFilteredListings(cpc, market);

  const total = market.total ?? market.allCount ?? market.rawTotal;
  const filtered = market.filteredCount ?? (Array.isArray(market.data) ? market.data.length : null);
  const excluded = market.excludedCount ?? (Array.isArray(market.excluded) ? market.excluded.length : null);
  const keepRate = total ? formatPct((Number(filtered || 0) / Number(total)) * 100) : 'N/A';
  const monthlySalesValues = Array.isArray(market.data)
    ? market.data.map(monthlySalesValue).filter(value => value != null && value > 0)
    : [];
  const minMonthlySales = monthlySalesValues.length ? Math.min(...monthlySalesValues) : null;
  const codexCandidates = Array.isArray(market.codexSemanticReviewCandidates)
    ? market.codexSemanticReviewCandidates.length
    : 0;
  const codexRescuedCount = Array.isArray(market.data)
    ? market.data.filter(item => item && item.codexSemanticReviewRescued).length
    : 0;
  const codexExcludedCount = Array.isArray(market.excluded)
    ? market.excluded.filter(item => item && item.codexSemanticReviewExcluded).length
    : 0;
  const codexReviewStandard = market.codexSemanticReviewStandard || null;
  const missingCodexCandidates = likelyMissingCodexCategoryCandidates(market);
  const contextConflictRows = contextConflictBlockedCategories(market);
  const missingGoogleTrendsCoreReview = googleTrendsCoreReviewMissing(seasonality, trends);
  const targetCategoryReviewCategories = Array.isArray(market.targetCategoryCodexReviewRequest?.categories)
    ? market.targetCategoryCodexReviewRequest.categories.length
    : 0;
  const targetCategoryReviewLoaded = Boolean(market.targetCategoryCodexReviewLoaded);
  const targetCategoryReviewDecisionCount = Number(market.targetCategoryCodexReviewDecisionCount || 0);
  const targetCategoryReviewReviewedCount = Number(market.targetCategoryCodexReviewReviewedCategoryCount || targetCategoryReviewDecisionCount || 0);
  const targetCategoryReviewTotalCount = Number(market.targetCategoryCodexReviewTotalCategoryCount || targetCategoryReviewCategories || 0);
  const targetCategorySelectionMode = market.targetCategorySelectionMode || (targetCategoryReviewLoaded ? 'codex-final' : 'rule-provisional-pending-codex');

  const lines = [];
  lines.push(`${keyword} result log`);
  lines.push(`Generated at: ${new Date().toISOString()}`);
  lines.push(`Product folder: ${root}`);
  lines.push('');
  lines.push('[Result]');
  lines.push(`Keyword: ${keyword}`);
  lines.push(`Score: ${valueOrNA(scoreMetric.value)} / 150`);
  lines.push(`Decision: ${valueOrNA(decisionMetric.value)}`);
  lines.push(`Veto: ${veto}`);
  lines.push(`Market data: filtered ${valueOrNA(filtered)}, excluded ${valueOrNA(excluded)}, total ${valueOrNA(total)}, keep rate ${keepRate}`);
  lines.push(`Codex semantic review: loaded=${Boolean(market.codexSemanticReviewLoaded)}, candidates=${codexCandidates}`);
  lines.push(`Target-category Codex review: mode=${targetCategorySelectionMode}, loaded=${targetCategoryReviewLoaded}, decisions=${targetCategoryReviewDecisionCount}, reviewed=${targetCategoryReviewReviewedCount}/${targetCategoryReviewTotalCount || targetCategoryReviewCategories}, complete=${Boolean(market.targetCategoryCodexReviewComplete)}, file=${valueOrNA(market.targetCategoryCodexReviewFile || market.targetCategoryCodexReviewRequestFile)}`);
  lines.push(`Codex decisions applied: rescued=${codexRescuedCount}, explicitly excluded=${codexExcludedCount}`);
  lines.push(`Category guard blocks: ${contextConflictRows.length}`);
  if (codexReviewStandard) {
    lines.push(`Codex review standard: ${codexReviewStandard.decisionRule}`);
    lines.push(`Codex rescue rule: ${codexReviewStandard.rescueMechanism}`);
  }

  lines.push('');
  lines.push('[Score breakdown]');
  if (scoreRows.length) {
    for (const row of scoreRows) {
      lines.push(`- ${row.module}: ${row.score}/${row.weight}`);
      lines.push(`  Current: ${row.current}`);
    }
  } else {
    lines.push('- N/A');
  }

  lines.push('');
  lines.push('[Important process]');
  if (trends) {
    const points = trends.totalPoints || (Array.isArray(trends.data5Years) ? trends.data5Years.length : 'N/A');
    lines.push(`Google Trends: completed, period=${valueOrNA(trends.period)}, points=${points}, query=${valueOrNA(trends.queryKeyword || trends.keyword || keyword)}`);
    if (trends.quality) {
      lines.push(`Google Trends quality: ok=${trends.quality.ok}, nonzero=${valueOrNA(trends.quality.nonzero)}, max=${valueOrNA(trends.quality.max)}, avg=${Number(trends.quality.avg || 0).toFixed(2)}`);
    }
    if (seasonality?.googleTrendsRouting?.codexCoreReview) {
      const review = seasonality.googleTrendsRouting.codexCoreReview;
      lines.push(`Google Trends Codex core review: loaded=${Boolean(review.loaded)}, selected=${valueOrNA(review.selectedQuery)}`);
    }
  } else {
    lines.push('Google Trends: N/A');
  }
  if (historical) {
    lines.push(`Historical new-products data: filtered ${valueOrNA(historical.filteredCount)}, excluded ${valueOrNA(historical.excludedCount)}, total ${valueOrNA(historical.total)}`);
  } else {
    lines.push('Historical new-products data: N/A');
  }
  if (currentFilteredCpc.summary) {
    lines.push(`CPC opportunity: samples=${valueOrNA(currentFilteredCpc.summary.asinCount)}, median CPC=${valueOrNA(currentFilteredCpc.summary.medianCpc)}, median CPC/price=${valueOrNA(currentFilteredCpc.summary.medianCpcPriceRatioPct)}%`);
    if (currentFilteredCpc.removed.length) {
      lines.push(`CPC opportunity sample filter: removed ${currentFilteredCpc.removed.length} ASIN not present in current filtered listings (${currentFilteredCpc.removed.slice(0, 10).join(', ')})`);
    }
  } else {
    lines.push('CPC opportunity: N/A');
  }
  if (contextConflictRows.length) {
    lines.push('Category guard blocks:');
    for (const row of contextConflictRows) {
      lines.push(`- ${row.category}: guard=${row.guardType}, final score=${Number.isFinite(row.score) ? row.score.toFixed(1) : 'N/A'}, base=${Number.isFinite(row.baseScore) ? row.baseScore.toFixed(1) : 'N/A'}, penalty=-${row.penalty.toFixed(1)}, count=${row.count}, share=${formatPct(row.share * 100)}`);
      lines.push(`  Reason: ${valueOrNA(row.reason)}`);
    }
  }
  lines.push(`Main report: ${marketReport ? marketReport.filePath : 'N/A'}`);

  lines.push('');
  lines.push('[Warnings / exceptions]');
  const warnings = [];
  if (market.skippedOver500) warnings.push(`Skipped because product count exceeded 500: ${valueOrNA(market.skipReason || market.skipDetails?.reason)}`);
  if (Number(filtered) < 30) warnings.push('Filtered target parent listings are below 30; analysis sample is small.');
  if (minMonthlySales != null && minMonthlySales < 300) warnings.push(`Minimum monthly sales is below 300; current minimum monthly sales is ${minMonthlySales.toLocaleString()}.`);
  if (decisionMetric.value && decisionMetric.value.includes(LABELS.notEnter)) warnings.push('Final decision is not to enter product deep-dive.');
  if (codexCandidates > 0 && !market.codexSemanticReviewLoaded) warnings.push(`Codex product-category semantic review candidates exist (${codexCandidates}), but no Codex decision file was loaded yet; local Codex must judge whether listings are the same product/function attributes as the input keyword before rescue.`);
  if (contextConflictRows.length) warnings.push(`Category guard rule blocked ${contextConflictRows.length} high-share/high-count/high-score non-target categories from direct target selection.`);
  if (targetCategoryReviewTotalCount > 0 && targetCategoryReviewReviewedCount < targetCategoryReviewTotalCount) warnings.push(`Target-category Codex review is pending: manually provided reference categories must also be judged as target/non-target categories; only reference-matched categories not judged target can later become product-level semantic rescue sources (${targetCategoryReviewReviewedCount}/${targetCategoryReviewTotalCount} categories reviewed).`);
  for (const candidate of missingCodexCandidates) {
    warnings.push(`Codex product-category semantic review may be missing: non-target category "${candidate.category}" has count ${candidate.count}, share ${formatPct(candidate.share * 100)}, score ${Number.isFinite(candidate.score) ? candidate.score : 'N/A'}, but no review candidate was generated.`);
  }
  if (trends?.quality && !trends.quality.ok) warnings.push(`Google Trends quality is not ok: ${valueOrNA(trends.quality.reason)}`);
  if (missingGoogleTrendsCoreReview.missing) {
    warnings.push(`Google Trends data was sparse, but no Codex core-query review decision file was loaded; local Codex must choose the replacement Google Trends core term before retry. Reason: ${valueOrNA(missingGoogleTrendsCoreReview.sparseReason)}`);
  }
  if (warnings.length) warnings.forEach(warning => lines.push(`- ${warning}`));
  else lines.push('- None.');

  fs.writeFileSync(outPath, `\ufeff${lines.join('\n')}\n`, 'utf8');
  return outPath;
}

function main() {
  const input = process.argv[2];
  if (!input) {
    usage();
    process.exit(1);
  }
  const outPath = buildLog(resolveRoot(input));
  console.log(`Result log saved: ${outPath}`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildLog,
  resolveRoot
};
