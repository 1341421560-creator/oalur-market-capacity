const fs = require('fs');
const path = require('path');
const { safeSegment } = require('./run-log');
const { codexReviewStatus } = require('./codex-review-workflow');

const LABELS = {
  module: '\u6a21\u5757',
  finalDecision: '\u6700\u7ec8\u7ed3\u8bba',
  totalScore: '\u5e02\u573a\u9a8c\u8bc1\u603b\u5206',
  provisionalScore: '\u6682\u5b9a\u5e02\u573a\u9a8c\u8bc1\u5206',
  scoreRange: '\u7f3a\u5931\u6570\u636e\u53ef\u80fd\u533a\u95f4',
  dataCompleteness: '\u5173\u952e\u8bc1\u636e\u5b8c\u6574\u5ea6',
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
  const reportFiles = listFiles(reportsDir, file => file.toLowerCase().endsWith('.html'))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const filePath of reportFiles) {
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

function parseMetricNumber(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[$,%\s]/g, '').trim();
  if (!cleaned || cleaned === '--') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseFbaMarginValue(value) {
  const text = String(value || '').trim();
  if (!text || text === '--') return { fbaFee: null, marginPct: null };
  const fbaMatch = text.match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/);
  const marginMatch = text.match(/([0-9]+(?:\.[0-9]+)?)\s*%/);
  return {
    fbaFee: fbaMatch ? parseFloat(fbaMatch[1]) : null,
    marginPct: marginMatch ? parseFloat(marginMatch[1]) : null
  };
}

function normalizeCategory(category) {
  return String(category || '')
    .replace(/&amp;/gi, '&')
    .split('>')
    .map(part => part.trim().replace(/\s+/g, ' ').toLowerCase())
    .filter(Boolean)
    .join(' > ');
}

function uniqueRequestCategoryCount(request) {
  return new Set(
    (Array.isArray(request?.categories) ? request.categories : [])
      .map(row => normalizeCategory(row.category))
      .filter(Boolean)
  ).size;
}

function monthlySalesValue(item) {
  return parseNumber(item?.salesNumAggregated ?? item?.sales);
}

function hasAnyMetric(item, fields) {
  return fields.some(field => parseMetricNumber(item?.[field]) != null);
}

function profitCoverageSummary(market) {
  const products = Array.isArray(market?.data) ? market.data : [];
  const total = products.length;
  const marginFields = ['marginPct', 'grossMargin', 'profitMargin'];
  const fbaFields = ['fba', 'fbaFee', 'fbaFeeNum', 'fbaCost'];
  const unitProfitFields = ['unitGrossProfit', 'grossProfit', 'profit'];
  const effectiveCostFields = ['effectiveCostRate', 'effectiveCostRatio'];
  const counts = {
    margin: products.filter(item => parseFbaMarginValue(item?.margin).marginPct != null || hasAnyMetric(item, marginFields)).length,
    fba: products.filter(item => parseFbaMarginValue(item?.margin).fbaFee != null || hasAnyMetric(item, fbaFields)).length,
    fbaSellerType: products.filter(item => String(item?.sellerType || '').includes('FBA')).length,
    unitProfit: products.filter(item => hasAnyMetric(item, unitProfitFields)).length,
    effectiveCost: products.filter(item => hasAnyMetric(item, effectiveCostFields)).length
  };
  return {
    total,
    ...counts,
    marginCoveragePct: total ? counts.margin / total * 100 : null,
    fbaCoveragePct: total ? counts.fba / total * 100 : null,
    fbaSellerTypeCoveragePct: total ? counts.fbaSellerType / total * 100 : null,
    unitProfitCoveragePct: total ? counts.unitProfit / total * 100 : null,
    effectiveCostCoveragePct: total ? counts.effectiveCost / total * 100 : null
  };
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
  const reviewedListings = [
    ...(Array.isArray(market.data) ? market.data : []),
    ...(Array.isArray(market.excluded) ? market.excluded : [])
  ];
  const normalizedCategory = value => String(value || '').trim() || '未识别';
  const listingHasSemanticDecision = listing => Boolean(
    listing?.codexSemanticReviewRescued
    || listing?.codexSemanticReviewExcluded
    || listing?.codexSemanticReviewDecision?.decision
  );
  return (market.categorySelection || [])
    .filter(row => row && row.category && !targetSet.has(row.category) && !existingSet.has(row.category))
    .filter(row => {
      const categoryListings = reviewedListings.filter(listing =>
        normalizedCategory(listing?.category || listing?.categoryPath) === normalizedCategory(row.category)
      );
      return categoryListings.length === 0 || categoryListings.some(listing => !listingHasSemanticDecision(listing));
    })
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

function seriesPointCount(series) {
  if (Array.isArray(series)) return series.length;
  if (series && typeof series === 'object') {
    return Object.values(series).filter(value => parseMetricNumber(value) != null).length;
  }
  return 0;
}

function googleTrendsPointCount(trends, seasonality) {
  const source = trends || seasonality?.googleTrendsData || {};
  if (Number.isFinite(Number(source.totalPoints))) return Number(source.totalPoints);
  return Math.max(
    seriesPointCount(source.data5Years),
    seriesPointCount(source.data),
    seriesPointCount(source.timeline)
  );
}

function googleTrendsStatus(trends, seasonality) {
  const points = googleTrendsPointCount(trends, seasonality);
  const source = trends || seasonality?.googleTrendsData || null;
  const quality = trends?.quality || seasonality?.googleTrendsData?.quality || seasonality?.googleTrendsRouting?.finalQuality || null;
  return {
    loaded: Boolean(source),
    points,
    quality,
    error: source?.error || seasonality?.googleTrendsRouting?.finalStatus || '',
    query: source?.queryKeyword || source?.keyword || seasonality?.googleTrendsRouting?.finalQueryKeyword || ''
  };
}

function oalurVolumeStatus(seasonality) {
  const volume = seasonality?.oalurVolumeData || {};
  const counts = {
    searchesTrend: seriesPointCount(volume.searchesTrend),
    oppIndexTrend: seriesPointCount(volume.oppIndexTrend),
    productTotalNumTrend: seriesPointCount(volume.productTotalNumTrend),
    topClickRatioTrend: seriesPointCount(volume.topClickRatioTrend),
    topConvertRatioTrend: seriesPointCount(volume.topConvertRatioTrend)
  };
  return {
    loaded: Object.values(counts).some(count => count > 0),
    counts
  };
}

function buildLog(root) {
  const dataDir = path.join(root, 'data');
  const reportsDir = path.join(root, 'reports');
  const dataFile = findDataFile(dataDir);
  if (!dataFile) throw new Error(`Data file not found under ${dataDir}`);

  const market = readJsonIfExists(dataFile, {});
  const liveCodexStatus = codexReviewStatus(dataFile);
  const keyword = market.keyword || market.keywords?.[0] || path.basename(dataFile).replace(/-data\.json$/i, '');
  const keywordFile = safeSegment(keyword).toLowerCase();
  const outPath = path.join(root, `${keywordFile}-result.log`);
  const marketReport = findMarketReport(reportsDir);
  const html = marketReport?.html || '';
  const metrics = extractMetrics(html);
  const scoreRows = extractScoreRows(html);
  const scoreMetric = metrics.find(metric => metric.label.includes(LABELS.provisionalScore) || metric.label.includes(LABELS.totalScore)) || metrics[0] || {};
  const scoreRangeMetric = metrics.find(metric => metric.label === LABELS.scoreRange) || {};
  const dataCompletenessMetric = metrics.find(metric => metric.label === LABELS.dataCompleteness) || {};
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
  const profitCoverage = profitCoverageSummary(market);
  const gtStatus = googleTrendsStatus(trends, seasonality);
  const oalurStatus = oalurVolumeStatus(seasonality);

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
  const missingGoogleTrendsCoreReview = googleTrendsCoreReviewMissing(seasonality, trends);
  const targetCategoryReviewRequest = market.targetCategoryCodexReviewRequest || {};
  const targetCategoryReviewCategories = uniqueRequestCategoryCount(targetCategoryReviewRequest);
  const targetCategoryReviewReferenceCategories = Array.isArray(targetCategoryReviewRequest.referenceReviewCategories)
    ? targetCategoryReviewRequest.referenceReviewCategories.length
    : Number(targetCategoryReviewRequest.referenceReviewCategories || 0);
  const targetCategoryReviewLoaded = Boolean(market.targetCategoryCodexReviewLoaded);
  const targetCategoryReviewDecisionCount = Number(market.targetCategoryCodexReviewDecisionCount || 0);
  const targetCategoryReviewReviewedCount = Number(market.targetCategoryCodexReviewReviewedCategoryCount || targetCategoryReviewDecisionCount || 0);
  const targetCategoryReviewAppliedTotalCount = Number(market.targetCategoryCodexReviewTotalCategoryCount || 0);
  const targetCategoryReviewDisplayTotalCount = Math.max(
    targetCategoryReviewAppliedTotalCount,
    targetCategoryReviewCategories,
    targetCategoryReviewReviewedCount,
    targetCategoryReviewDecisionCount
  );
  const targetCategorySelectionMode = market.targetCategorySelectionMode || (targetCategoryReviewLoaded ? 'codex-final' : 'rule-provisional-pending-codex');
  const salesFloorMin = Number(market.analysisSalesFloor || market.salesFloorExcludedSummary?.salesFloorMin || 200);
  const salesFloorExcludedCount = Number(market.salesFloorExcludedCount || market.salesFloorExcludedSummary?.count || 0);
  const salesFloorExcludedAsins = Array.isArray(market.salesFloorExcludedSummary?.asins)
    ? market.salesFloorExcludedSummary.asins.slice(0, 10).join(', ')
    : '';

  const lines = [];
  lines.push(`${keyword} result log`);
  lines.push(`Generated at: ${new Date().toISOString()}`);
  lines.push(`Product folder: ${root}`);
  lines.push('');
  lines.push('[Result]');
  lines.push(`Keyword: ${keyword}`);
  lines.push(`Score: ${valueOrNA(scoreMetric.value)} / 150`);
  lines.push(`Score range: ${valueOrNA(scoreRangeMetric.value)}`);
  lines.push(`Critical evidence completeness: ${valueOrNA(dataCompletenessMetric.value)}`);
  lines.push(`Decision: ${valueOrNA(decisionMetric.value)}`);
  lines.push(`Veto: ${veto}`);
  lines.push(`Market data: filtered ${valueOrNA(filtered)}, excluded ${valueOrNA(excluded)}, total ${valueOrNA(total)}, keep rate ${keepRate}`);
  lines.push(`Sales floor exclusions: threshold <${salesFloorMin}, excluded=${salesFloorExcludedCount}${salesFloorExcludedAsins ? `, sample ASINs=${salesFloorExcludedAsins}` : ''}`);
  lines.push(`Codex semantic review: loaded=${Boolean(market.codexSemanticReviewLoaded)}, candidates=${codexCandidates}`);
  lines.push(`Codex review gate: targetOk=${Boolean(liveCodexStatus.target?.ok)}, targetMissing=${liveCodexStatus.target?.missingCount || 0}, targetAutoIgnored=${liveCodexStatus.target?.autoResolvedIgnoredCount || 0}, semanticOk=${Boolean(liveCodexStatus.semantic?.ok)}, semanticMissing=${liveCodexStatus.semantic?.missingCount || 0}, semanticAutoIgnored=${liveCodexStatus.semantic?.autoResolvedIgnoredCount || 0}`);
  lines.push(`Target-category Codex review: mode=${targetCategorySelectionMode}, loaded=${targetCategoryReviewLoaded}, decisions=${targetCategoryReviewDecisionCount}, reviewed=${targetCategoryReviewReviewedCount}/${targetCategoryReviewDisplayTotalCount || targetCategoryReviewCategories}, requestCategories=${targetCategoryReviewCategories}, appliedSummaryCategories=${targetCategoryReviewAppliedTotalCount}, referenceReviewCategories=${targetCategoryReviewReferenceCategories}, complete=${Boolean(market.targetCategoryCodexReviewComplete)}, file=${valueOrNA(market.targetCategoryCodexReviewFile || market.targetCategoryCodexReviewRequestFile)}`);
  lines.push(`Codex decisions applied: rescued=${codexRescuedCount}, explicitly excluded=${codexExcludedCount}`);
  lines.push(`Profit/FBA data coverage: margin=${profitCoverage.margin}/${profitCoverage.total}, FBA fee=${profitCoverage.fba}/${profitCoverage.total}, sellerType FBA=${profitCoverage.fbaSellerType}/${profitCoverage.total}, unitProfit=${profitCoverage.unitProfit}/${profitCoverage.total}, effectiveCost=${profitCoverage.effectiveCost}/${profitCoverage.total}`);
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
  if (gtStatus.loaded) {
    lines.push(`Google Trends: completed, period=${valueOrNA(trends?.period || seasonality?.googleTrendsData?.period)}, points=${gtStatus.points}, query=${valueOrNA(gtStatus.query || keyword)}`);
    if (gtStatus.quality) {
      lines.push(`Google Trends quality: ok=${gtStatus.quality.ok}, nonzero=${valueOrNA(gtStatus.quality.nonzero)}, max=${valueOrNA(gtStatus.quality.max)}, avg=${Number(gtStatus.quality.avg || 0).toFixed(2)}`);
    }
    if (seasonality?.googleTrendsRouting?.codexCoreReview) {
      const review = seasonality.googleTrendsRouting.codexCoreReview;
      lines.push(`Google Trends Codex core review: loaded=${Boolean(review.loaded)}, selected=${valueOrNA(review.selectedQuery)}`);
    }
  } else {
    lines.push('Google Trends: N/A');
  }
  lines.push(`Oalur volume trends: searches=${oalurStatus.counts.searchesTrend}, opportunity=${oalurStatus.counts.oppIndexTrend}, products=${oalurStatus.counts.productTotalNumTrend}, topClick=${oalurStatus.counts.topClickRatioTrend}, topConvert=${oalurStatus.counts.topConvertRatioTrend}`);
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
  lines.push(`Main report: ${marketReport ? marketReport.filePath : 'N/A'}`);

  const errors = [];
  const warnings = [];
  if (market.skippedOver500) {
    const hardLimit = market.skipDetails?.hardSkipRows || market.hardSkipRows || 500;
    warnings.push(`Skipped because product count exceeded hard limit (${hardLimit}): ${valueOrNA(market.skipReason || market.skipDetails?.reason)}`);
  }
  if (Number(filtered) < 30) warnings.push('Filtered target parent listings are below 30; analysis sample is small.');
  if (minMonthlySales != null && minMonthlySales < 300) warnings.push(`Minimum monthly sales is below 300; current minimum monthly sales is ${minMonthlySales.toLocaleString()}.`);
  if (!gtStatus.loaded || gtStatus.points === 0) {
    warnings.push(`Google Trends data is missing or empty; seasonality and search-demand lifecycle conclusions are low-confidence.`);
  } else if (gtStatus.quality && !gtStatus.quality.ok) {
    warnings.push(`Google Trends quality is not ok: ${valueOrNA(gtStatus.quality.reason || gtStatus.error)}`);
  }
  if (!oalurStatus.loaded) {
    warnings.push('Oalur in-site trend data is missing; opportunity index, search-demand lifecycle, and TOP3 traffic concentration are low-confidence.');
  } else {
    const missingOalurSeries = Object.entries(oalurStatus.counts)
      .filter(([, count]) => count === 0)
      .map(([key]) => key);
    if (missingOalurSeries.length) {
      warnings.push(`Oalur in-site trend data is incomplete; missing series: ${missingOalurSeries.join(', ')}.`);
    }
  }
  if (!historical && !market.skippedOver500) {
    warnings.push('Historical new-products data is missing; 6-month pure-new parent survival cannot be validated.');
  }
  if (!cpc && !market.skippedOver500) {
    warnings.push('CPC opportunity data is missing; advertising cost score is low-confidence.');
  } else if (cpc && !currentFilteredCpc.summary) {
    warnings.push('CPC opportunity data has no usable ASIN after filtering to current listings; advertising cost score is low-confidence.');
  } else if (currentFilteredCpc.summary && Number(currentFilteredCpc.summary.asinCount || 0) < 10) {
    warnings.push(`CPC opportunity usable sample is small (${currentFilteredCpc.summary.asinCount}); advertising cost score is low-confidence.`);
  }
  if (profitCoverage.total > 0 && profitCoverage.margin === 0 && profitCoverage.fba === 0 && profitCoverage.unitProfit === 0) {
    warnings.push(`Profit quick-screen data is missing for all filtered listings (${profitCoverage.total}/${profitCoverage.total}); Oalur seller type may still show FBA, but FBA fee, margin, and unit-profit scores are fallback estimates and must not be treated as validated profit evidence.`);
  } else if (profitCoverage.total > 0 && (profitCoverage.marginCoveragePct ?? 0) < 50) {
    warnings.push(`Profit quick-screen coverage is low: margin=${profitCoverage.margin}/${profitCoverage.total}, FBA fee=${profitCoverage.fba}/${profitCoverage.total}. Treat margin and FBA-pressure conclusions as low-confidence until Oalur profit columns are supplemented.`);
  }
  if (codexCandidates > 0 && !market.codexSemanticReviewLoaded && liveCodexStatus.semantic && !liveCodexStatus.semantic.ok) warnings.push(`Codex product-category semantic review candidates exist (${codexCandidates}), but no Codex decision file was loaded yet; local Codex must judge whether listings are the same product/function attributes as the input keyword before rescue.`);
  if ((liveCodexStatus.target?.autoResolvedIgnoredCount || 0) > 0) {
    errors.push(`Target-category Codex review contains ${liveCodexStatus.target.autoResolvedIgnoredCount} auto-resolved decision(s), which are ignored. Replace them with real local Codex category decisions.`);
  }
  if ((liveCodexStatus.semantic?.autoResolvedIgnoredCount || 0) > 0) {
    errors.push(`Listing semantic Codex review contains ${liveCodexStatus.semantic.autoResolvedIgnoredCount} auto-resolved decision(s), which are ignored. Replace them with real local Codex listing decisions.`);
  }
  if (liveCodexStatus.target && !liveCodexStatus.target.ok) {
    errors.push(`Target-category Codex review is incomplete under strict gate: ${liveCodexStatus.target.missingCount || 0} missing category decision(s); file=${valueOrNA(path.relative(root, liveCodexStatus.target.reviewFile || ''))}.`);
  }
  if (liveCodexStatus.semantic && !liveCodexStatus.semantic.ok) {
    errors.push(`Listing semantic Codex review is incomplete under strict gate: ${liveCodexStatus.semantic.missingCount || 0} missing listing decision(s); file=${valueOrNA(path.relative(root, liveCodexStatus.semantic.reviewFile || ''))}.`);
  }
  if (targetCategoryReviewDisplayTotalCount > 0 && targetCategoryReviewReviewedCount < targetCategoryReviewDisplayTotalCount) {
    const reviewProgress = `${targetCategoryReviewReviewedCount}/${targetCategoryReviewDisplayTotalCount} categories reviewed`;
    const countDetails = `request categories=${targetCategoryReviewCategories}, applied-summary categories=${targetCategoryReviewAppliedTotalCount}`;
    if (!targetCategoryReviewLoaded || targetCategoryReviewDecisionCount === 0) {
      errors.push(`Target-category Codex review has no loaded decisions; current target categories are rule/reference provisional, not Codex-final (${reviewProgress}; ${countDetails}).`);
    } else {
      errors.push(`Target-category Codex review is incomplete; only Codex-confirmed target/include/yes categories should be treated as final target categories (${reviewProgress}; ${countDetails}).`);
    }
    if (targetCategoryReviewReferenceCategories > 0) {
      warnings.push(`Reference-matched categories can only become product-level semantic rescue sources after category-level Codex judges them as non-target/review (${targetCategoryReviewReferenceCategories} reference review categories present).`);
    }
  }
  for (const candidate of missingCodexCandidates) {
    warnings.push(`Codex product-category semantic review may be missing: non-target category "${candidate.category}" has count ${candidate.count}, share ${formatPct(candidate.share * 100)}, score ${Number.isFinite(candidate.score) ? candidate.score : 'N/A'}, but no review candidate was generated.`);
  }
  if (missingGoogleTrendsCoreReview.missing) {
    warnings.push(`Google Trends data was sparse, but no Codex core-query review decision file was loaded; local Codex must choose the replacement Google Trends core term before retry. Reason: ${valueOrNA(missingGoogleTrendsCoreReview.sparseReason)}`);
  }

  lines.push('');
  lines.push('[Errors]');
  if (errors.length) errors.forEach(error => lines.push(`- ${error}`));
  else lines.push('- None.');

  lines.push('');
  lines.push('[Warnings / exceptions]');
  if (warnings.length) warnings.forEach(warning => lines.push(`- ${warning}`));
  else lines.push('- None.');

  fs.writeFileSync(outPath, `\ufeff${lines.join('\n')}\n`, 'utf8');
  buildLog.lastCriticalErrors = errors;
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
  if (buildLog.lastCriticalErrors?.length) {
    console.error(`Result log contains ${buildLog.lastCriticalErrors.length} critical error(s):`);
    buildLog.lastCriticalErrors.forEach(error => console.error(`- ${error}`));
    process.exit(2);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildLog,
  resolveRoot
};
