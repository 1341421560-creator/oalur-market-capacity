const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  appendReferenceCategoryArgs,
  normalizeReferenceCategories
} = require('./reference-categories');
const { createRunLogger } = require('./run-log');
const {
  codexReviewStatus
} = require('./codex-review-workflow');
const {
  buildInputProductContext
} = require('./input-product-context');
const {
  evaluateBatchTurnCompletion,
  REQUIRED_COMPLETED_STEPS,
  REQUIRED_TERMINAL_STEPS,
  TERMINAL_ITEM_STATUSES
} = require('./verify-batch-turn-completion');
const { isConfirmedHardSkip } = require('./oalur-query-guard');

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function safeSegment(value) {
  return String(value || 'unknown')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown';
}

function titleSegment(value) {
  return safeSegment(value)
    .split('-')
    .filter(Boolean)
    .map(part => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join('-');
}

function parseArgs(argv) {
  const positional = argv.filter(arg => !arg.startsWith('--'));
  const opts = {
    jsonFile: positional[0],
    bsr: '25000',
    start: 1,
    outputStart: null,
    limit: null,
    resume: true,
    batchRoot: null
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--bsr') opts.bsr = String(argv[++i] || opts.bsr);
    else if (arg === '--start') opts.start = Math.max(1, Number(argv[++i] || 1));
    else if (arg === '--output-start') opts.outputStart = Math.max(1, Number(argv[++i] || 1));
    else if (arg === '--limit') {
      const raw = Number(argv[++i]);
      opts.limit = Number.isFinite(raw) && raw > 0 ? raw : null;
    } else if (arg === '--batch-root') {
      opts.batchRoot = argv[++i] || null;
    } else if (arg === '--no-resume') {
      opts.resume = false;
    }
  }

  return opts;
}

function usage() {
  console.error('Usage: node run-keyword-json-batch.js <keywords-agent-same.json> [--bsr 25000] [--start 1] [--output-start N] [--limit N] [--batch-root output/YYYY-MM-DD-automated-market] [--no-resume]');
}

function readBatchProducts(jsonFile) {
  const resolved = path.resolve(jsonFile);
  const payload = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!Array.isArray(payload.products)) {
    throw new Error(`JSON does not contain products[]: ${jsonFile}`);
  }
  return payload.products.map((item, index) => {
    const keyword = String(item.keyword || '').trim();
    const inputProductContext = buildInputProductContext(item, { keyword });
    return {
      index: index + 1,
      asin: item.asin || '',
      keyword,
      inputProductContext,
      referenceCategories: normalizeReferenceCategories([
        inputProductContext.category,
        ...(Array.isArray(inputProductContext.categories) ? inputProductContext.categories : [])
      ])
    };
  });
}

function runNode(scriptName, args, label, envExtra = {}) {
  const scriptPath = path.join(__dirname, scriptName);
  console.log(`\n[${label}] node ${scriptName} ${args.map(a => JSON.stringify(String(a))).join(' ')}`);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: __dirname,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, ...envExtra }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.warn(`Progress file is unreadable, starting with empty progress: ${path.relative(process.cwd(), filePath)} (${error.message})`);
    return fallback;
  }
}

function sameJsonValue(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

function upsertInputProductContext(dataFile, context, referenceCategories = [], logger) {
  if (!context || !fs.existsSync(dataFile)) return false;
  const payload = readJsonIfExists(dataFile, null);
  if (!payload || typeof payload !== 'object') return false;
  const contexts = Array.isArray(payload.inputProductContexts) ? payload.inputProductContexts : [];
  const nextContexts = contexts.length ? contexts : [context];
  const nextReferenceCategories = Array.isArray(referenceCategories) ? referenceCategories : [];
  const changed = !sameJsonValue(payload.inputProductContext, context) ||
    !sameJsonValue(nextContexts[0], context) ||
    !sameJsonValue(payload.referenceCategories, nextReferenceCategories) ||
    Array.isArray(payload.inputProductContexts);
  if (!changed) return false;
  payload.inputProductContext = context;
  delete payload.inputProductContexts;
  payload.referenceCategories = nextReferenceCategories;
  if (payload.marketRunSummary && typeof payload.marketRunSummary === 'object') {
    payload.marketRunSummary.inputProductContext = {
      asin: context.asin || '',
      hasTitle: Boolean(context.title),
      categoryCount: Array.isArray(context.categories) ? context.categories.length : 0,
      bulletPointCount: Array.isArray(context.bulletPoints) ? context.bulletPoints.length : 0,
      hasDescription: Boolean(context.description)
    };
  }
  fs.writeFileSync(dataFile, JSON.stringify(payload, null, 2), 'utf8');
  logger?.info('batch.input_product_context_upserted', {
    dataFile: path.relative(process.cwd(), dataFile),
    asin: context.asin || '',
    referenceCategoryCount: nextReferenceCategories.length,
    bulletPointCount: Array.isArray(context.bulletPoints) ? context.bulletPoints.length : 0
  });
  return true;
}

function createProgress(batchRoot, opts, products) {
  return {
    version: 1,
    batchRoot: path.relative(process.cwd(), batchRoot),
    jsonFile: path.resolve(opts.jsonFile),
    bsr: String(opts.bsr),
    totalProducts: products.length,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'running',
    items: {}
  };
}

function loadProgress(progressFile, batchRoot, opts, products) {
  const fallback = createProgress(batchRoot, opts, products);
  const progress = readJsonIfExists(progressFile, fallback);
  progress.version = progress.version || 1;
  progress.batchRoot = progress.batchRoot || path.relative(process.cwd(), batchRoot);
  progress.jsonFile = progress.jsonFile || path.resolve(opts.jsonFile);
  progress.bsr = String(progress.bsr || opts.bsr);
  progress.totalProducts = products.length;
  progress.startedAt = progress.startedAt || new Date().toISOString();
  progress.items = progress.items && typeof progress.items === 'object' ? progress.items : {};
  return progress;
}

function saveProgress(progressFile, progress) {
  progress.updatedAt = new Date().toISOString();
  fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2), 'utf8');
}

function itemNumber(item) {
  return Number.isFinite(Number(item?.outputIndex)) ? Number(item.outputIndex) : Number(item?.index);
}

function itemKey(item) {
  return String(itemNumber(item)).padStart(3, '0');
}

function getItemProgress(progress, item) {
  const key = itemKey(item);
  const existing = progress.items[key];
  if (existing) {
    const expectedSourceIndex = Number(item.index);
    const existingSourceIndex = Number(existing.sourceIndex);
    const sameSource = existingSourceIndex === expectedSourceIndex;
    const sameKeyword = String(existing.keyword || '').trim() === String(item.keyword || '').trim();
    const sameAsin = !existing.asin || !item.asin || String(existing.asin).trim() === String(item.asin).trim();
    if (!sameSource || !sameKeyword || !sameAsin) {
      throw new Error(
        `Output item ${key} belongs to a different input product. ` +
        `Existing source=${existing.sourceIndex}, keyword=${existing.keyword}, asin=${existing.asin || ''}; ` +
        `requested source=${item.index}, keyword=${item.keyword}, asin=${item.asin || ''}. ` +
        'Use a new output index or rerun the selected range with --no-resume.'
      );
    }
  }
  if (!progress.items[key]) {
    progress.items[key] = {
      index: itemNumber(item),
      sourceIndex: item.index,
      keyword: item.keyword,
      asin: item.asin || '',
      status: 'pending',
      steps: {}
    };
  }
  return progress.items[key];
}

function markItemStatus(progressFile, progress, item, patch) {
  const entry = getItemProgress(progress, item);
  Object.assign(entry, patch, { updatedAt: new Date().toISOString() });
  saveProgress(progressFile, progress);
}

function markStep(progressFile, progress, item, step, status, extra = {}) {
  const entry = getItemProgress(progress, item);
  entry.currentStep = status === 'running' ? step : entry.currentStep;
  const nextStep = {
    ...(entry.steps[step] || {}),
    ...extra,
    status,
    updatedAt: new Date().toISOString()
  };
  if ((status === 'running' || status === 'completed') && !Object.hasOwn(extra, 'reason')) {
    delete nextStep.reason;
  }
  if ((status === 'running' || status === 'completed') && !Object.hasOwn(extra, 'error')) {
    delete nextStep.error;
  }
  if (status === 'completed' && !Object.hasOwn(extra, 'pausedAt')) {
    delete nextStep.pausedAt;
  }
  entry.steps[step] = nextStep;
  saveProgress(progressFile, progress);
}

function fileIfExists(filePath) {
  return fs.existsSync(filePath) ? filePath : null;
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
    ? item.categories
    : [item?.category].filter(Boolean);
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

function semanticReviewFileForData(dataFile, marketData) {
  const explicit = marketData?.codexSemanticReviewFile;
  if (explicit) {
    return path.isAbsolute(explicit)
      ? explicit
      : path.resolve(path.dirname(path.resolve(dataFile)), explicit);
  }
  const resolved = path.resolve(dataFile);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved).replace(/-data\.json$/i, '').replace(/\.json$/i, '');
  return path.join(dir, `${base}-codex-semantic-review.json`);
}

function semanticReviewCoverageStatus(dataFile) {
  const marketData = readJsonIfExists(dataFile, null);
  if (!marketData) return { ok: true, skipped: true, reason: 'market data file not found' };
  const candidateCategories = new Set((marketData.codexSemanticReviewCandidates || []).map(candidate => candidate.category).filter(Boolean));
  if (!candidateCategories.size) return { ok: true, skipped: true, reason: 'no semantic review candidates' };

  const candidateListings = (marketData.excluded || []).filter(item =>
    listingCategories(item).some(category => candidateCategories.has(category))
  );
  if (!candidateListings.length) return { ok: true, skipped: true, reason: 'no excluded candidate listings' };

  const reviewFile = semanticReviewFileForData(dataFile, marketData);
  const review = readJsonIfExists(reviewFile, null);
  const reviewedIds = new Set(reviewEntries(review).flatMap(reviewEntryIdentifiers));
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
    reviewEntryCount: reviewEntries(review).length,
    missingCount: missing.length,
    sampleMissing: missing.slice(0, 5).map(item => ({
      asin: item.asin || '',
      parentAsin: item.parentAsin || item.pasin || '',
      title: item.title || '',
      category: item.category || ''
    }))
  };
}

function selectedProducts(products, start, limit) {
  const offset = Math.max(0, start - 1);
  return products.slice(offset, limit == null ? undefined : offset + limit);
}

function batchDateFromRoot(batchRoot) {
  const match = path.basename(path.resolve(batchRoot)).match(/^(\d{4}-\d{2}-\d{2})(?:-|$)/);
  return match ? match[1] : localDateString();
}

function buildPaths(batchRoot, item, bsr) {
  const date = batchDateFromRoot(batchRoot);
  const keywordTitle = titleSegment(item.keyword);
  const keywordFile = safeSegment(item.keyword).toLowerCase();
  const itemRoot = path.join(batchRoot, `${date}-${String(itemNumber(item)).padStart(3, '0')}-${keywordTitle}-${bsr}`);
  const dataDir = path.join(itemRoot, 'data');
  const reportsDir = path.join(itemRoot, 'reports');
  const excelDir = path.join(itemRoot, 'excel');
  return {
    itemRoot,
    dataDir,
    reportsDir,
    excelDir,
    dataFile: path.join(dataDir, `${keywordFile}-data.json`),
    seasonalityFile: path.join(dataDir, `${keywordFile}-seasonality.json`),
    historicalFile: path.join(dataDir, `${keywordFile}-historical.json`),
    lifecycleFile: path.join(dataDir, `${keywordFile}-asin-lifecycle.json`),
    cpcFile: path.join(dataDir, `${keywordFile}-cpc-opportunity.json`),
    logFile: path.join(itemRoot, `${keywordFile}-run.log`),
    resultLogFile: path.join(itemRoot, `${keywordFile}-result.log`)
  };
}

function findReportFile(reportsDir, suffix) {
  if (!fs.existsSync(reportsDir)) return null;
  return fs.readdirSync(reportsDir)
    .filter(file => file.endsWith(suffix))
    .map(file => path.join(reportsDir, file))
    .find(file => fs.statSync(file).isFile()) || null;
}

function fileMtime(filePath) {
  return filePath && fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : 0;
}

function nonEmptyFile(filePath) {
  return !!filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
}

function outputIsCurrent(outputFile, dependencyFiles) {
  if (!nonEmptyFile(outputFile)) return false;
  const outputMtime = fs.statSync(outputFile).mtimeMs;
  return dependencyFiles
    .filter(filePath => filePath && fs.existsSync(filePath))
    .every(filePath => outputMtime >= fileMtime(filePath));
}

function stepAlreadyDone(step, paths) {
  if (step === 'marketData') {
    if (!fs.existsSync(paths.dataFile)) return false;
    const marketData = readJsonIfExists(paths.dataFile, null);
    if (marketData?.skippedOver500) {
      return isConfirmedHardSkip(marketData.skipDetails, 100, 800);
    }
    return true;
  }
  if (step === 'seasonality') return fs.existsSync(paths.seasonalityFile);
  if (step === 'historicalData') return fs.existsSync(paths.historicalFile);
  if (step === 'cpcOpportunity') {
    if (!fs.existsSync(paths.dataFile)) return false;
    if (!fs.existsSync(paths.cpcFile)) return false;
    const cpcMtime = fs.statSync(paths.cpcFile).mtimeMs;
    const dataMtime = fs.statSync(paths.dataFile).mtimeMs;
    const lifecycleMtime = fs.existsSync(paths.lifecycleFile) ? fs.statSync(paths.lifecycleFile).mtimeMs : 0;
    return cpcMtime >= dataMtime && (!lifecycleMtime || cpcMtime >= lifecycleMtime);
  }
  if (step === 'mainReport') {
    return outputIsCurrent(findReportFile(paths.reportsDir, '_市场分析.html'), [
      paths.dataFile,
      paths.seasonalityFile,
      paths.historicalFile,
      paths.lifecycleFile,
      paths.cpcFile
    ]);
  }
  if (step === 'childAsinReport') return nonEmptyFile(findReportFile(paths.reportsDir, '_子ASIN明细.html'));
  if (step === 'resultLog') {
    return outputIsCurrent(paths.resultLogFile, [
      paths.dataFile,
      paths.seasonalityFile,
      paths.historicalFile,
      paths.lifecycleFile,
      paths.cpcFile,
      findReportFile(paths.reportsDir, '_市场分析.html'),
      findReportFile(paths.reportsDir, '_子ASIN明细.html')
    ]);
  }
  return false;
}

function completedItemArtifactsReady(paths) {
  return ['mainReport', 'childAsinReport', 'resultLog']
    .every(step => stepAlreadyDone(step, paths));
}

function completedItemProgressReady(entry) {
  return REQUIRED_TERMINAL_STEPS.every(step => TERMINAL_ITEM_STATUSES.has(entry.steps?.[step]?.status)) &&
    REQUIRED_COMPLETED_STEPS.every(step => entry.steps?.[step]?.status === 'completed') &&
    entry.currentStep == null &&
    entry.codexReviewGate == null &&
    !entry.error;
}

function skippedItemProgressReady(entry) {
  return String(entry.skipReason || '').trim() !== '' &&
    entry.steps?.resultLog?.status === 'completed' &&
    isConfirmedHardSkip(entry.skipDetails, 100, 800);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runStep({ item, paths, progress, progressFile, resume, step, label, scriptName, args, skipWhenDone = true, logger, maxAttempts = 1, envExtra = {} }) {
  if (resume && skipWhenDone && stepAlreadyDone(step, paths)) {
    markStep(progressFile, progress, item, step, 'completed', { skipped: true });
    console.log(`[${label}] skipped, output already exists`);
    logger?.info('batch.step_skipped', { step, label });
    return;
  }
  markStep(progressFile, progress, item, step, 'running', { skipped: false });
  logger?.info('batch.step_start', { step, label, scriptName, args });
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      runNode(scriptName, args, label, { OALUR_RUN_LOG: paths.logFile, ...envExtra });
      markStep(progressFile, progress, item, step, 'completed', { skipped: false, attempt });
      logger?.info('batch.step_complete', { step, label, attempt });
      return;
    } catch (error) {
      const canRetry = attempt < maxAttempts;
      logger?.[canRetry ? 'warn' : 'error'](canRetry ? 'batch.step_retry' : 'batch.step_failed', {
        step,
        label,
        attempt,
        maxAttempts,
        error: error.message
      });
      if (!canRetry) throw error;
      console.warn(`[${label}] attempt ${attempt}/${maxAttempts} failed: ${error.message}; retrying...`);
      sleepMs(5000);
    }
  }
}

function googleTrendsFetchStatus(seasonalityFile) {
  const payload = readJsonIfExists(seasonalityFile, null);
  if (!payload) {
    return { ok: false, reason: 'seasonality file missing or unreadable', points: 0 };
  }
  const trends = payload.googleTrendsData;
  const points = trends?.data5Years || trends?.data || [];
  const pointCount = Array.isArray(points) ? points.length : 0;
  if (!trends) {
    return { ok: false, reason: 'googleTrendsData missing', points: 0 };
  }
  const quality = trends.quality || payload.googleTrendsRouting?.finalQuality || null;
  const queryKeyword = trends.queryKeyword || trends.keyword || payload.googleTrendsRouting?.finalQueryKeyword || '';
  if (trends.error || quality?.ok === false) {
    return {
      ok: false,
      reason: trends.error || quality.reason || 'Google Trends quality check failed',
      points: pointCount,
      queryKeyword
    };
  }
  if (pointCount > 0) {
    return {
      ok: true,
      reason: 'timeline data extracted',
      points: pointCount,
      queryKeyword
    };
  }
  return {
    ok: false,
    reason: trends.error || payload.googleTrendsRouting?.finalStatus || 'Google Trends timeline empty',
    points: 0,
    queryKeyword
  };
}

function marketDataSkipStatus(dataFile) {
  const payload = readJsonIfExists(dataFile, null);
  if (!payload?.skippedOver500) return null;
  return {
    skippedOver500: true,
    reason: payload.skipReason || 'estimated product count exceeds hard limit',
    details: payload.skipDetails || {},
    dataFile: path.relative(process.cwd(), dataFile)
  };
}

function isEdgeCdpReady() {
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json/version' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
  ], {
    cwd: __dirname,
    encoding: 'utf8',
    shell: false
  });
  return !result.error && result.status === 0;
}

function restartEdgeCdpBrowser(reason, batchLogger, itemLogger, options = {}) {
  const forceRestart = options.force ? '$true' : '$false';
  const script = `
$ErrorActionPreference = 'Stop'
$forceRestart = ${forceRestart}
if (-not $forceRestart) {
  try {
    $response = Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json/version' -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -eq 200) { exit 0 }
  } catch {}
}
$edgeCandidates = @(
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
)
$edge = $edgeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'msedge.exe not found' }
$targets = Get-CimInstance Win32_Process -Filter "name = 'msedge.exe'"
foreach ($target in $targets) {
  try {
    Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop
  } catch {
    if ($_.Exception.Message -notmatch 'Cannot find a process') {
      throw
    }
  }
}
Start-Sleep -Seconds 2
Start-Process -FilePath $edge -ArgumentList @('--remote-debugging-port=9222','--no-first-run','https://www.oalur.com/insight/filter')
$deadline = (Get-Date).AddSeconds(45)
do {
  try {
    $response = Invoke-WebRequest -Uri 'http://127.0.0.1:9222/json/version' -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -eq 200) { exit 0 }
  } catch {}
  Start-Sleep -Seconds 1
} while ((Get-Date) -lt $deadline)
throw 'CDP port 9222 did not become ready after browser restart'
`;
  batchLogger?.warn('google_trends.browser_restart_start', { reason });
  itemLogger?.warn('google_trends.browser_restart_start', { reason });
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd: __dirname,
    encoding: 'utf8',
    shell: false
  });
  const details = {
    reason,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim()
  };
  if (result.error || result.status !== 0) {
    details.error = result.error?.message || `PowerShell exited with ${result.status}`;
    batchLogger?.error('google_trends.browser_restart_failed', details);
    itemLogger?.error('google_trends.browser_restart_failed', details);
    throw new Error(`Browser restart failed: ${details.error}${details.stderr ? ` (${details.stderr})` : ''}`);
  }
  batchLogger?.info('google_trends.browser_restart_complete', details);
  itemLogger?.info('google_trends.browser_restart_complete', details);
}

function ensureEdgeCdpBrowser(batchLogger) {
  if (isEdgeCdpReady()) {
    batchLogger?.info('browser.cdp_ready', { browserURL: 'http://127.0.0.1:9222' });
    return;
  }
  restartEdgeCdpBrowser('CDP port 9222 is not ready before batch start', batchLogger, null);
}

function buildMainReportArgs(paths) {
  const reportArgs = [paths.dataFile];
  const seasonalityFile = fileIfExists(paths.seasonalityFile);
  const historicalFile = fileIfExists(paths.historicalFile);
  const lifecycleFile = fileIfExists(paths.lifecycleFile);
  const cpcFile = fileIfExists(paths.cpcFile);
  if (seasonalityFile) reportArgs.push('--seasonality', seasonalityFile);
  if (historicalFile) reportArgs.push('--historical', historicalFile);
  if (lifecycleFile) reportArgs.push('--asin-lifecycle', lifecycleFile);
  if (cpcFile) reportArgs.push('--cpc-opportunity', cpcFile);
  return reportArgs;
}

function relativeFile(filePath) {
  return filePath ? path.relative(process.cwd(), filePath) : '';
}

function codexReviewFiles(status) {
  return [
    status?.target?.reviewFile,
    status?.semantic?.reviewFile
  ].filter(filePath => filePath && fs.existsSync(filePath));
}

function codexReviewGateAlreadyApplied({ item, progress, step, dataFile, status }) {
  const entry = getItemProgress(progress, item);
  const stepState = entry.steps?.[step];
  if (stepState?.status !== 'completed' || !stepState.updatedAt || !fs.existsSync(dataFile)) return false;
  if (!status?.target?.ok || !status?.semantic?.ok) return false;
  const stepTime = Date.parse(stepState.updatedAt);
  if (!Number.isFinite(stepTime)) return false;
  const dependencyTimes = [
    fs.statSync(dataFile).mtimeMs,
    ...codexReviewFiles(status).map(filePath => fs.statSync(filePath).mtimeMs)
  ];
  return dependencyTimes.every(mtime => mtime <= stepTime + 1000);
}

function serializeCodexReviewStatus(status) {
  return {
    targetOk: Boolean(status?.target?.ok),
    targetMissingCount: status?.target?.missingCount || 0,
    targetRequestedCategoryCount: status?.target?.requestedCategoryCount || 0,
    targetAutoResolvedIgnoredCount: status?.target?.autoResolvedIgnoredCount || 0,
    targetReviewFile: relativeFile(status?.target?.reviewFile),
    semanticOk: Boolean(status?.semantic?.ok),
    semanticMissingCount: status?.semantic?.missingCount || 0,
    semanticCandidateCategoryCount: status?.semantic?.candidateCategoryCount || 0,
    semanticCandidateListingCount: status?.semantic?.candidateListingCount || 0,
    semanticAutoResolvedIgnoredCount: status?.semantic?.autoResolvedIgnoredCount || 0,
    semanticReviewFile: relativeFile(status?.semantic?.reviewFile)
  };
}

class CodexReviewGatePause extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'CodexReviewGatePause';
    this.code = 'CODEX_REVIEW_REQUIRED';
    this.details = details;
  }
}

function failCodexReviewGate({ item, progress, progressFile, step, status, logger, phase }) {
  const details = {
    item: itemNumber(item),
    keyword: item.keyword,
    step,
    phase,
    ...serializeCodexReviewStatus(status)
  };
  markStep(progressFile, progress, item, step, 'awaiting_codex_review', {
    ...details,
    error: null,
    pausedAt: new Date().toISOString()
  });
  logger?.warn(`codex_review.${phase}_pending`, details);
  const missingCount = phase === 'target' ? details.targetMissingCount : details.semanticMissingCount;
  const reviewFile = phase === 'target' ? details.targetReviewFile : details.semanticReviewFile;
  throw new CodexReviewGatePause(
    `Codex ${phase} review is incomplete: ${missingCount} decision(s) missing; update review file: ${reviewFile}`,
    details
  );
}

function ensureCodexReviewReady({ item, paths, progress, progressFile, dataFile, step, label, resume, logger }) {
  if (!fs.existsSync(dataFile)) {
    markStep(progressFile, progress, item, step, 'skipped', {
      reason: 'data file not found',
      dataFile: relativeFile(dataFile)
    });
    logger?.warn('codex_review.skipped', { step, reason: 'data file not found', dataFile: relativeFile(dataFile) });
    return;
  }

  let status = codexReviewStatus(dataFile);
  if (resume && codexReviewGateAlreadyApplied({ item, progress, step, dataFile, status })) {
    markStep(progressFile, progress, item, step, 'completed', {
      skipped: true,
      ...serializeCodexReviewStatus(status)
    });
    logger?.info('codex_review.skipped_already_applied', { step, ...serializeCodexReviewStatus(status) });
    return;
  }

  markStep(progressFile, progress, item, step, 'running', {
    skipped: false,
    dataFile: relativeFile(dataFile),
    error: null
  });

  if (!status.target.ok) {
    failCodexReviewGate({ item, progress, progressFile, step, status, logger, phase: 'target' });
  }

  runNode('refilter-data.js', [dataFile], `${label} apply target-category decisions`, { OALUR_RUN_LOG: paths.logFile });

  status = codexReviewStatus(dataFile);
  if (!status.target.ok) {
    failCodexReviewGate({ item, progress, progressFile, step, status, logger, phase: 'target' });
  }

  if (!status.semantic.ok) {
    failCodexReviewGate({ item, progress, progressFile, step, status, logger, phase: 'semantic' });
  }

  runNode('refilter-data.js', [dataFile], `${label} apply semantic decisions`, { OALUR_RUN_LOG: paths.logFile });

  const finalStatus = codexReviewStatus(dataFile);
  markStep(progressFile, progress, item, step, 'completed', {
    skipped: false,
    error: null,
    ...serializeCodexReviewStatus(finalStatus)
  });
  logger?.info('codex_review.completed', { step, ...serializeCodexReviewStatus(finalStatus) });
}

function serializeGoogleTrendsFailureRecord(record, status) {
  const finalStatus = status || record.status || {};
  return {
    item: record.item.index,
    keyword: record.item.keyword,
    seasonalityFile: path.relative(process.cwd(), record.paths.seasonalityFile),
    reason: finalStatus.reason || '',
    points: finalStatus.points || 0,
    queryKeyword: finalStatus.queryKeyword || ''
  };
}

function regenerateMainReportIfAlreadyBuilt({ record, progress, progressFile }) {
  const entry = getItemProgress(progress, record.item);
  if (entry.steps?.mainReport?.status !== 'completed') return;

  runStep({
    item: record.item,
    paths: record.paths,
    progress,
    progressFile,
    resume: false,
    step: 'mainReport',
    label: `#${record.item.index} regenerate main report after Google Trends retry`,
    scriptName: 'generate-report.js',
    args: buildMainReportArgs(record.paths),
    skipWhenDone: false,
    logger: record.logger
  });
}

function retryGoogleTrendsFailureWindow({ records, progress, progressFile, batchLogger, itemLogger }) {
  const reason = `Google Trends failed for ${records.length} consecutive products`;
  restartEdgeCdpBrowser(reason, batchLogger, itemLogger, { force: true });
  progress.googleTrendsBrowserRestarts = (progress.googleTrendsBrowserRestarts || 0) + 1;
  progress.lastGoogleTrendsBrowserRestart = {
    reason,
    afterItem: records[records.length - 1]?.item.index || null,
    restartedAt: new Date().toISOString()
  };
  saveProgress(progressFile, progress);

  const retryStatuses = [];
  const stillFailed = [];
  for (const record of records) {
    runStep({
      item: record.item,
      paths: record.paths,
      progress,
      progressFile,
      resume: false,
      step: 'seasonality',
      label: `#${record.item.index} retry seasonality after browser restart`,
      scriptName: 'extract-seasonality.js',
      args: [record.item.keyword, record.paths.dataFile, record.paths.seasonalityFile],
      skipWhenDone: false,
      logger: record.logger
    });
    const retryStatus = googleTrendsFetchStatus(record.paths.seasonalityFile);
    const serialized = serializeGoogleTrendsFailureRecord(record, retryStatus);
    retryStatuses.push({ ...serialized, ok: retryStatus.ok });
    batchLogger?.[retryStatus.ok ? 'info' : 'error']('google_trends.retry_after_restart', retryStatuses[retryStatuses.length - 1]);
    record.logger?.[retryStatus.ok ? 'info' : 'error']('google_trends.retry_after_restart', retryStatuses[retryStatuses.length - 1]);
    if (retryStatus.ok) {
      regenerateMainReportIfAlreadyBuilt({ record, progress, progressFile });
    } else {
      stillFailed.push(serialized);
    }
  }

  progress.lastGoogleTrendsRestartRetry = {
    checkedAt: new Date().toISOString(),
    statuses: retryStatuses
  };
  saveProgress(progressFile, progress);

  if (stillFailed.length) {
    const details = stillFailed.map(item => `#${item.item} ${item.keyword}: ${item.reason}`).join('; ');
    throw new Error(`Google Trends still failed after browser restart; stopping batch. ${details}`);
  }
}

function updateGoogleTrendsBatchHealth({ item, paths, progress, progressFile, batchState, batchLogger, itemLogger }) {
  const status = googleTrendsFetchStatus(paths.seasonalityFile);
  if (status.ok) {
    batchState.googleTrendsConsecutiveFailures = 0;
    batchState.googleTrendsFailureWindow = [];
    progress.googleTrendsConsecutiveFailures = 0;
    progress.googleTrendsFailureWindow = [];
  } else {
    batchState.googleTrendsFailureWindow = [
      ...(batchState.googleTrendsFailureWindow || []),
      { item, paths, logger: itemLogger, status }
    ].slice(-3);
    batchState.googleTrendsConsecutiveFailures = batchState.googleTrendsFailureWindow.length;
    progress.googleTrendsConsecutiveFailures = batchState.googleTrendsConsecutiveFailures;
    progress.googleTrendsFailureWindow = batchState.googleTrendsFailureWindow.map(record =>
      serializeGoogleTrendsFailureRecord(record)
    );
  }
  progress.lastGoogleTrendsStatus = {
    item: itemNumber(item),
    keyword: item.keyword,
    ...status,
    consecutiveFailures: batchState.googleTrendsConsecutiveFailures,
    checkedAt: new Date().toISOString()
  };
  saveProgress(progressFile, progress);
  const eventName = status.ok ? 'google_trends.batch_status_ok' : 'google_trends.batch_status_failed';
  batchLogger?.[status.ok ? 'info' : 'warn'](eventName, progress.lastGoogleTrendsStatus);
  itemLogger?.[status.ok ? 'info' : 'warn'](eventName, progress.lastGoogleTrendsStatus);

  if (!status.ok && batchState.googleTrendsConsecutiveFailures >= 3) {
    retryGoogleTrendsFailureWindow({
      records: batchState.googleTrendsFailureWindow,
      progress,
      progressFile,
      batchLogger,
      itemLogger
    });
    batchState.googleTrendsConsecutiveFailures = 0;
    batchState.googleTrendsFailureWindow = [];
    progress.googleTrendsConsecutiveFailures = 0;
    progress.googleTrendsFailureWindow = [];
    saveProgress(progressFile, progress);
  }

  return status;
}

function runOne(item, batchRoot, bsr, progress, progressFile, resume, batchState, batchLogger, options = {}) {
  if (!item.keyword) {
    throw new Error(`Product #${itemNumber(item)} is missing keyword`);
  }

  const paths = buildPaths(batchRoot, item, bsr);
  const inputContextEnv = item.inputProductContext
    ? { OALUR_INPUT_PRODUCT_CONTEXT: JSON.stringify(item.inputProductContext) }
    : {};
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.mkdirSync(paths.reportsDir, { recursive: true });
  fs.mkdirSync(paths.excelDir, { recursive: true });
  const logger = createRunLogger({
    logFile: paths.logFile,
    keyword: item.keyword,
    scriptName: 'run-keyword-json-batch.js'
  });
  logger.start({
    item: itemNumber(item),
    sourceIndex: item.index,
    keyword: item.keyword,
    asin: item.asin || '',
    inputProductContext: {
      hasTitle: Boolean(item.inputProductContext?.title),
      categoryCount: Array.isArray(item.inputProductContext?.categories) ? item.inputProductContext.categories.length : 0,
      bulletPointCount: Array.isArray(item.inputProductContext?.bulletPoints) ? item.inputProductContext.bulletPoints.length : 0,
      hasDescription: Boolean(item.inputProductContext?.description)
    },
    itemRoot: path.relative(process.cwd(), paths.itemRoot),
    bsr,
    logFile: path.relative(process.cwd(), paths.logFile)
  });

  console.log('\n' + '='.repeat(70));
  console.log(`#${itemNumber(item)} (source #${item.index}): ${item.keyword}`);
  if (item.asin) console.log(`Seed ASIN: ${item.asin}`);
  console.log(`BSR: ${bsr}`);
  console.log(`Output: ${path.relative(process.cwd(), paths.itemRoot)}`);
  console.log(`Reference categories: ${item.referenceCategories.length}`);
  item.referenceCategories.forEach(category => console.log(`  - ${category}`));
  if (item.inputProductContext?.title) console.log(`Input title: ${item.inputProductContext.title}`);
  if (Array.isArray(item.inputProductContext?.bulletPoints) && item.inputProductContext.bulletPoints.length) {
    console.log(`Input bullet points: ${item.inputProductContext.bulletPoints.length}`);
  }

  const referenceArgs = args => appendReferenceCategoryArgs(args, item.referenceCategories);

  markItemStatus(progressFile, progress, item, {
    status: 'running',
    itemRoot: path.relative(process.cwd(), paths.itemRoot),
    startedAt: getItemProgress(progress, item).startedAt || new Date().toISOString(),
    pausedAt: null,
    failedAt: null,
    codexReviewGate: null,
    skippedAt: null,
    skipReason: null,
    skipDetails: null,
    error: null
  });

  runStep({
    item,
    paths,
    progress,
    progressFile,
    resume,
    step: 'marketData',
    label: `#${itemNumber(item)} extract market data`,
    scriptName: 'extract-data.js',
    args: referenceArgs([item.keyword, String(bsr), paths.dataFile]),
    logger,
    maxAttempts: 2,
    envExtra: inputContextEnv
  });
  upsertInputProductContext(paths.dataFile, item.inputProductContext, item.referenceCategories, logger);

  const marketSkip = marketDataSkipStatus(paths.dataFile);
  if (marketSkip) {
    markStep(progressFile, progress, item, 'seasonality', 'skipped', { reason: 'market data skipped over hard product limit' });
    markStep(progressFile, progress, item, 'historicalData', 'skipped', { reason: 'market data skipped over hard product limit' });
    markStep(progressFile, progress, item, 'cpcOpportunity', 'skipped', { reason: 'market data skipped over hard product limit' });
    markStep(progressFile, progress, item, 'mainReport', 'skipped', { reason: 'market data skipped over hard product limit' });
    markStep(progressFile, progress, item, 'childAsinReport', 'skipped', { reason: 'market data skipped over hard product limit' });
    markItemStatus(progressFile, progress, item, {
      status: 'skipped',
      currentStep: null,
      skippedAt: new Date().toISOString(),
      skipReason: marketSkip.reason,
      skipDetails: marketSkip.details,
      error: null
    });
    logger.warn('batch.item_skipped_over_500', marketSkip);
    batchLogger?.warn('batch.item_skipped_over_500', {
      item: itemNumber(item),
      keyword: item.keyword,
      ...marketSkip
    });
    try {
      markStep(progressFile, progress, item, 'resultLog', 'running', { skipped: false });
      runNode('generate-result-log.js', [paths.itemRoot], `#${itemNumber(item)} generate result log`, { OALUR_RUN_LOG: paths.logFile });
      markStep(progressFile, progress, item, 'resultLog', 'completed', { skipped: false });
    } catch (error) {
      markStep(progressFile, progress, item, 'resultLog', 'failed', { skipped: false, error: error.message });
      logger.warn('batch.result_log_failed', { error: error.message });
    }
    markItemStatus(progressFile, progress, item, { currentStep: null });
    logger.end({
      status: 'skipped',
      item: itemNumber(item),
      keyword: item.keyword,
      ...marketSkip
    });
    return paths;
  }

  runStep({
    item,
    paths,
    progress,
    progressFile,
    resume,
    step: 'historicalData',
    label: `#${itemNumber(item)} extract historical new products`,
    scriptName: 'extract-data.js',
    args: referenceArgs([item.keyword, String(bsr), paths.historicalFile, '--survival-baseline', 'auto']),
    logger,
    maxAttempts: 2,
    envExtra: inputContextEnv
  });
  upsertInputProductContext(paths.historicalFile, item.inputProductContext, item.referenceCategories, logger);

  ensureCodexReviewReady({
    item,
    paths,
    progress,
    progressFile,
    dataFile: paths.dataFile,
    step: 'marketCodexReview',
    label: `#${itemNumber(item)} market Codex review`,
    resume,
    logger
  });

  ensureCodexReviewReady({
    item,
    paths,
    progress,
    progressFile,
    dataFile: paths.historicalFile,
    step: 'historicalCodexReview',
    label: `#${itemNumber(item)} historical Codex review`,
    resume,
    logger
  });

  runStep({
    item,
    paths,
    progress,
    progressFile,
    resume,
    step: 'seasonality',
    label: `#${itemNumber(item)} extract seasonality`,
    scriptName: 'extract-seasonality.js',
    args: [item.keyword, paths.dataFile, paths.seasonalityFile],
    logger
  });
  updateGoogleTrendsBatchHealth({
    item,
    paths,
    progress,
    progressFile,
    batchState,
    batchLogger,
    itemLogger: logger
  });

  const lifecycleFile = fileIfExists(paths.lifecycleFile);
  let cpcFile = null;
  const cpcArgs = lifecycleFile
    ? [lifecycleFile, paths.dataFile, paths.cpcFile]
    : ['--market-only', paths.dataFile, paths.cpcFile];
  if (!lifecycleFile) {
    console.warn(`Lifecycle file not found, using market data for CPC sample: ${path.relative(process.cwd(), paths.lifecycleFile)}`);
    logger.warn('batch.cpc_lifecycle_missing_market_only', {
      step: 'cpcOpportunity',
      lifecycleFile: path.relative(process.cwd(), paths.lifecycleFile),
      marketDataFile: path.relative(process.cwd(), paths.dataFile)
    });
  }
  runStep({
    item,
    paths,
    progress,
    progressFile,
    resume,
    step: 'cpcOpportunity',
    label: `#${itemNumber(item)} extract CPC opportunity`,
    scriptName: 'extract-cpc-opportunity.js',
    args: cpcArgs,
    logger
  });
  cpcFile = fileIfExists(paths.cpcFile);

  runStep({
    item,
    paths,
    progress,
    progressFile,
    resume,
    step: 'mainReport',
    label: `#${itemNumber(item)} generate main report`,
    scriptName: 'generate-report.js',
    args: buildMainReportArgs(paths),
    skipWhenDone: false,
    logger
  });

  runStep({
    item,
    paths,
    progress,
    progressFile,
    resume,
    step: 'childAsinReport',
    label: `#${itemNumber(item)} generate child ASIN report`,
    scriptName: 'generate-child-asin-report.js',
    args: [paths.dataFile],
    skipWhenDone: false,
    logger
  });

  runStep({
    item,
    paths,
    progress,
    progressFile,
    resume,
    step: 'resultLog',
    label: `#${itemNumber(item)} generate result log`,
    scriptName: 'generate-result-log.js',
    args: [paths.itemRoot],
    skipWhenDone: false,
    logger
  });

  markItemStatus(progressFile, progress, item, {
    status: 'completed',
    currentStep: null,
    completedAt: new Date().toISOString(),
    pausedAt: null,
    failedAt: null,
    codexReviewGate: null,
    skippedAt: null,
    skipReason: null,
    skipDetails: null,
    error: null
  });
  logger.end({
    status: 'completed',
    item: itemNumber(item),
    keyword: item.keyword,
    dataFile: path.relative(process.cwd(), paths.dataFile),
    seasonalityFile: path.relative(process.cwd(), paths.seasonalityFile),
    resultLogFile: path.relative(process.cwd(), paths.resultLogFile)
  });

  return paths;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.jsonFile) {
    usage();
    process.exit(1);
  }
  if (!fs.existsSync(opts.jsonFile)) {
    throw new Error(`JSON file not found: ${opts.jsonFile}`);
  }

  const date = localDateString();
  const batchRoot = path.resolve(opts.batchRoot || path.join(process.cwd(), 'output', `${date}-automated-market`));
  fs.mkdirSync(batchRoot, { recursive: true });
  const batchLogger = createRunLogger({
    logFile: path.join(batchRoot, 'batch-run.log'),
    keyword: 'batch',
    scriptName: 'run-keyword-json-batch.js'
  });

  const products = readBatchProducts(opts.jsonFile);
  const selected = selectedProducts(products, opts.start, opts.limit);
  const outputStart = opts.outputStart == null ? opts.start : opts.outputStart;
  const targets = selected.map((item, offset) => ({ ...item, outputIndex: outputStart + offset }));
  if (!targets.length) {
    throw new Error(`No products selected. products=${products.length}, start=${opts.start}, limit=${opts.limit || 'all'}`);
  }

  console.log(`Batch JSON: ${opts.jsonFile}`);
  console.log(`Batch root: ${path.relative(process.cwd(), batchRoot)}`);
  console.log(`Resume: ${opts.resume ? 'enabled' : 'disabled'}`);
  console.log(`Products: ${products.length}, selected: ${targets.length}, source start: ${opts.start}, output start: ${outputStart}, limit: ${opts.limit || 'all'}, BSR: ${opts.bsr}`);

  const progressFile = path.join(batchRoot, 'batch-progress.json');
  const progress = opts.resume
    ? loadProgress(progressFile, batchRoot, opts, products)
    : createProgress(batchRoot, opts, products);
  const batchState = {
    googleTrendsConsecutiveFailures: Number(progress.googleTrendsConsecutiveFailures || 0)
  };
  progress.status = 'running';
  progress.pausedAt = null;
  progress.awaitingCodexReviewItem = null;
  progress.selected = { start: opts.start, outputStart, limit: opts.limit || null, count: targets.length };
  progress.codexCanSendFinal = false;
  progress.finalResponseGate = {
    status: 'blocked',
    reason: 'selected batch is still running'
  };
  saveProgress(progressFile, progress);
  console.log(`Progress: ${path.relative(process.cwd(), progressFile)}`);
  console.log(`Batch log: ${path.relative(process.cwd(), batchLogger.logFile)}`);
  batchLogger.start({
    jsonFile: path.relative(process.cwd(), path.resolve(opts.jsonFile)),
    batchRoot: path.relative(process.cwd(), batchRoot),
    progressFile: path.relative(process.cwd(), progressFile),
    resume: opts.resume,
    totalProducts: products.length,
    selectedCount: targets.length,
    outputStart,
    bsr: opts.bsr
  });
  ensureEdgeCdpBrowser(batchLogger);

  const outputs = [];
  for (const item of targets) {
    const entry = getItemProgress(progress, item);
    const paths = buildPaths(batchRoot, item, opts.bsr);
    const terminalEntryReady = (entry.status === 'skipped' && skippedItemProgressReady(entry)) ||
      (
        entry.status === 'completed' &&
        completedItemProgressReady(entry) &&
        completedItemArtifactsReady(paths)
      );
    if (opts.resume && terminalEntryReady) {
      if (!stepAlreadyDone('resultLog', paths) && fs.existsSync(paths.dataFile)) {
        try {
          markStep(progressFile, progress, item, 'resultLog', 'running', { skipped: false, backfilled: true });
          runNode('generate-result-log.js', [paths.itemRoot], `#${itemNumber(item)} generate result log`, { OALUR_RUN_LOG: paths.logFile });
          markStep(progressFile, progress, item, 'resultLog', 'completed', { skipped: false, backfilled: true });
        } catch (error) {
          markStep(progressFile, progress, item, 'resultLog', 'failed', { skipped: false, backfilled: true, error: error.message });
          batchLogger.warn('batch.result_log_failed', {
            item: itemNumber(item),
            keyword: item.keyword,
            error: error.message
          });
        }
        markItemStatus(progressFile, progress, item, { currentStep: null });
      }
      console.log(`\n#${itemNumber(item)} (source #${item.index}): ${item.keyword} skipped, already ${entry.status}`);
      outputs.push(paths);
      continue;
    }
    if (opts.resume && entry.status === 'completed') {
      console.warn(`\n#${itemNumber(item)}: recorded as completed but progress or final artifacts are incomplete/stale; rerunning required steps.`);
    }
    try {
      outputs.push(runOne(item, batchRoot, opts.bsr, progress, progressFile, opts.resume, batchState, batchLogger));
    } catch (error) {
      if (error instanceof CodexReviewGatePause) {
        const pausedAt = new Date().toISOString();
        markItemStatus(progressFile, progress, item, {
          status: 'awaiting_codex_review',
          currentStep: error.details.step,
          pausedAt,
          failedAt: null,
          error: null,
          codexReviewGate: error.details
        });
        progress.status = 'awaiting_codex_review';
        progress.pausedAt = pausedAt;
        progress.failedAt = null;
        progress.lastFailedItem = null;
        progress.awaitingCodexReviewItem = itemNumber(item);
        progress.codexCanSendFinal = false;
        progress.finalResponseGate = {
          status: 'blocked',
          reason: 'Codex review is required in the current conversation',
          item: itemNumber(item),
          phase: error.details.phase
        };
        saveProgress(progressFile, progress);

        const completionCheck = evaluateBatchTurnCompletion(progress);

        const continuation = {
          event: 'CODEX_REVIEW_REQUIRED',
          terminal: false,
          codexCanSendFinal: false,
          finalResponseBlocked: true,
          autoScriptStatus: 'paused',
          codexTurnStatus: 'must_continue_in_current_conversation',
          item: itemNumber(item),
          keyword: item.keyword,
          phase: error.details.phase,
          missingCount: error.details.phase === 'target'
            ? error.details.targetMissingCount
            : error.details.semanticMissingCount,
          reviewFile: error.details.phase === 'target'
            ? error.details.targetReviewFile
            : error.details.semanticReviewFile,
          requiredActions: [
            'Read every pending candidate and its source evidence.',
            'Show the per-item judgments in the current Codex conversation.',
            'Write concrete local-Codex decisions to the review file.',
            'Run the review coverage validator.',
            'Resume this exact batch command after validation passes.',
            'Do not end the Codex turn or ask the user to continue merely because this gate paused the script.'
          ],
          resumeArgs: process.argv.slice(2),
          completionCheckCommand: `node verify-batch-turn-completion.js "${path.relative(process.cwd(), progressFile)}"`,
          completionBlockers: completionCheck.blockers
        };
        batchLogger.end({
          status: 'awaiting_codex_review',
          item: itemNumber(item),
          keyword: item.keyword,
          phase: error.details.phase,
          reviewFile: continuation.reviewFile
        });
        console.log('\n' + '='.repeat(70));
        console.log('AUTOMATION PAUSED FOR LOCAL CODEX REVIEW — CURRENT CODEX TURN MUST CONTINUE');
        console.log(JSON.stringify(continuation, null, 2));
        console.log('This is a script pause, not a user-action blocker and not task completion.');
        return;
      }
      const failedEntry = getItemProgress(progress, item);
      if (failedEntry.currentStep) {
        markStep(progressFile, progress, item, failedEntry.currentStep, 'failed', { skipped: false, error: error.message });
      }
      markItemStatus(progressFile, progress, item, {
        status: 'failed',
        currentStep: null,
        failedAt: new Date().toISOString(),
        error: error.message
      });
      progress.status = 'failed';
      progress.failedAt = new Date().toISOString();
      progress.lastFailedItem = itemNumber(item);
      progress.codexCanSendFinal = false;
      progress.finalResponseGate = {
        status: 'blocked',
        reason: error.message,
        item: itemNumber(item)
      };
      saveProgress(progressFile, progress);
      batchLogger.error('batch.item_failed', {
        item: itemNumber(item),
        keyword: item.keyword,
        error: error.message
      });
      throw error;
    }
  }

  progress.status = 'completed';
  progress.completedAt = new Date().toISOString();
  progress.pausedAt = null;
  progress.failedAt = null;
  progress.lastFailedItem = null;
  progress.awaitingCodexReviewItem = null;
  progress.codexCanSendFinal = false;
  progress.finalResponseGate = {
    status: 'checking',
    reason: 'verifying every selected item before allowing the final response'
  };
  saveProgress(progressFile, progress);

  const completionCheck = evaluateBatchTurnCompletion(progress, { ignorePersistedFinalGate: true });
  if (!completionCheck.codexCanSendFinal) {
    progress.status = 'completion_check_failed';
    progress.codexCanSendFinal = false;
    progress.finalResponseGate = {
      status: 'blocked',
      reason: 'batch completion verification failed',
      blockers: completionCheck.blockers
    };
    saveProgress(progressFile, progress);
    throw new Error(`Batch completion verification failed: ${completionCheck.blockers.join(' | ')}`);
  }
  progress.codexCanSendFinal = true;
  progress.finalResponseGate = {
    status: 'allowed',
    reason: 'every selected item completed or was business-skipped with a result log'
  };
  saveProgress(progressFile, progress);
  batchLogger.end({
    status: 'completed',
    outputRoots: outputs.map(paths => path.relative(process.cwd(), paths.itemRoot)),
    googleTrendsBrowserRestarts: progress.googleTrendsBrowserRestarts || 0
  });

  console.log('\n' + '='.repeat(70));
  console.log('Batch completed. Output roots:');
  outputs.forEach(paths => console.log(`  - ${path.relative(process.cwd(), paths.itemRoot)}`));
  console.log(JSON.stringify({
    ...completionCheck,
    codexCanSendFinal: true,
    codexTurnStatus: 'final_response_allowed'
  }, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  CodexReviewGatePause,
  failCodexReviewGate,
  serializeCodexReviewStatus
};
