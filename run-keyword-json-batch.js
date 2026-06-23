const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  appendReferenceCategoryArgs,
  normalizeReferenceCategories
} = require('./reference-categories');
const { createRunLogger } = require('./run-log');

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
    bsr: '20000',
    start: 1,
    limit: null,
    resume: true,
    batchRoot: null
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--bsr') opts.bsr = String(argv[++i] || opts.bsr);
    else if (arg === '--start') opts.start = Math.max(1, Number(argv[++i] || 1));
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
  console.error('Usage: node run-keyword-json-batch.js <keywords-agent-same.json> [--bsr 20000] [--start 1] [--limit N] [--batch-root output/YYYY-MM-DD-automated-market] [--no-resume]');
}

function readBatchProducts(jsonFile) {
  const resolved = path.resolve(jsonFile);
  const payload = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!Array.isArray(payload.products)) {
    throw new Error(`JSON does not contain products[]: ${jsonFile}`);
  }
  return payload.products.map((item, index) => ({
    index: index + 1,
    asin: item.asin || '',
    keyword: String(item.keyword || '').trim(),
    referenceCategories: normalizeReferenceCategories([
      item.category,
      ...(Array.isArray(item.categories) ? item.categories : [])
    ])
  }));
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

function createProgress(batchRoot, opts, products) {
  return {
    version: 1,
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

function itemKey(item) {
  return String(item.index).padStart(3, '0');
}

function getItemProgress(progress, item) {
  const key = itemKey(item);
  if (!progress.items[key]) {
    progress.items[key] = {
      index: item.index,
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
  entry.steps[step] = {
    ...(entry.steps[step] || {}),
    ...extra,
    status,
    updatedAt: new Date().toISOString()
  };
  saveProgress(progressFile, progress);
}

function fileIfExists(filePath) {
  return fs.existsSync(filePath) ? filePath : null;
}

function selectedProducts(products, start, limit) {
  const offset = Math.max(0, start - 1);
  return products.slice(offset, limit == null ? undefined : offset + limit);
}

function buildPaths(batchRoot, item, bsr) {
  const date = localDateString();
  const keywordTitle = titleSegment(item.keyword);
  const keywordFile = safeSegment(item.keyword).toLowerCase();
  const itemRoot = path.join(batchRoot, `${date}-${String(item.index).padStart(3, '0')}-${keywordTitle}-${bsr}`);
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
    logFile: path.join(itemRoot, `${keywordFile}-run.log`)
  };
}

function findReportFile(reportsDir, suffix) {
  if (!fs.existsSync(reportsDir)) return null;
  return fs.readdirSync(reportsDir)
    .filter(file => file.endsWith(suffix))
    .map(file => path.join(reportsDir, file))
    .find(file => fs.statSync(file).isFile()) || null;
}

function stepAlreadyDone(step, paths) {
  if (step === 'marketData') return fs.existsSync(paths.dataFile);
  if (step === 'seasonality') return fs.existsSync(paths.seasonalityFile);
  if (step === 'historicalData') return fs.existsSync(paths.historicalFile);
  if (step === 'cpcOpportunity') return !fs.existsSync(paths.lifecycleFile) || fs.existsSync(paths.cpcFile);
  if (step === 'mainReport') return !!findReportFile(paths.reportsDir, '_市场分析.html');
  if (step === 'childAsinReport') return !!findReportFile(paths.reportsDir, '_子ASIN明细.html');
  return false;
}

function runStep({ item, paths, progress, progressFile, resume, step, label, scriptName, args, skipWhenDone = true, logger }) {
  if (resume && skipWhenDone && stepAlreadyDone(step, paths)) {
    markStep(progressFile, progress, item, step, 'completed', { skipped: true });
    console.log(`[${label}] skipped, output already exists`);
    logger?.info('batch.step_skipped', { step, label });
    return;
  }
  markStep(progressFile, progress, item, step, 'running', { skipped: false });
  logger?.info('batch.step_start', { step, label, scriptName, args });
  try {
    runNode(scriptName, args, label, { OALUR_RUN_LOG: paths.logFile });
    markStep(progressFile, progress, item, step, 'completed', { skipped: false });
    logger?.info('batch.step_complete', { step, label });
  } catch (error) {
    logger?.error('batch.step_failed', { step, label, error: error.message });
    throw error;
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
  if (pointCount > 0) {
    return {
      ok: true,
      reason: trends.quality?.ok === false ? trends.quality.reason : 'timeline data extracted',
      points: pointCount,
      queryKeyword: trends.queryKeyword || trends.keyword || payload.googleTrendsRouting?.finalQueryKeyword || ''
    };
  }
  return {
    ok: false,
    reason: trends.error || payload.googleTrendsRouting?.finalStatus || 'Google Trends timeline empty',
    points: 0,
    queryKeyword: trends.queryKeyword || trends.keyword || payload.googleTrendsRouting?.finalQueryKeyword || ''
  };
}

function restartEdgeCdpBrowser(reason, batchLogger, itemLogger) {
  const script = `
$ErrorActionPreference = 'Stop'
$edgeCandidates = @(
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
)
$edge = $edgeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'msedge.exe not found' }
$targets = Get-CimInstance Win32_Process -Filter "name = 'msedge.exe'" |
  Where-Object { $_.CommandLine -match '--remote-debugging-port=9222' }
foreach ($target in $targets) {
  Stop-Process -Id $target.ProcessId -Force
}
Start-Sleep -Seconds 2
Start-Process -FilePath $edge -ArgumentList @('--remote-debugging-port=9222','--no-first-run')
$deadline = (Get-Date).AddSeconds(45)
do {
  try {
    $response = Invoke-WebRequest -Uri 'http://localhost:9222/json/version' -UseBasicParsing -TimeoutSec 2
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

function updateGoogleTrendsBatchHealth({ item, paths, progress, progressFile, batchState, batchLogger, itemLogger }) {
  const status = googleTrendsFetchStatus(paths.seasonalityFile);
  if (status.ok) {
    batchState.googleTrendsConsecutiveFailures = 0;
    progress.googleTrendsConsecutiveFailures = 0;
  } else {
    batchState.googleTrendsConsecutiveFailures = (batchState.googleTrendsConsecutiveFailures || 0) + 1;
    progress.googleTrendsConsecutiveFailures = batchState.googleTrendsConsecutiveFailures;
  }
  progress.lastGoogleTrendsStatus = {
    item: item.index,
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
    const reason = `Google Trends failed for ${batchState.googleTrendsConsecutiveFailures} consecutive products`;
    restartEdgeCdpBrowser(reason, batchLogger, itemLogger);
    batchState.googleTrendsConsecutiveFailures = 0;
    progress.googleTrendsConsecutiveFailures = 0;
    progress.googleTrendsBrowserRestarts = (progress.googleTrendsBrowserRestarts || 0) + 1;
    progress.lastGoogleTrendsBrowserRestart = {
      reason,
      afterItem: item.index,
      restartedAt: new Date().toISOString()
    };
    saveProgress(progressFile, progress);
  }

  return status;
}

function runOne(item, batchRoot, bsr, progress, progressFile, resume, batchState, batchLogger) {
  if (!item.keyword) {
    throw new Error(`Product #${item.index} is missing keyword`);
  }

  const paths = buildPaths(batchRoot, item, bsr);
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.mkdirSync(paths.reportsDir, { recursive: true });
  fs.mkdirSync(paths.excelDir, { recursive: true });
  const logger = createRunLogger({
    logFile: paths.logFile,
    keyword: item.keyword,
    scriptName: 'run-keyword-json-batch.js'
  });
  logger.start({
    item: item.index,
    keyword: item.keyword,
    asin: item.asin || '',
    itemRoot: path.relative(process.cwd(), paths.itemRoot),
    bsr,
    logFile: path.relative(process.cwd(), paths.logFile)
  });

  console.log('\n' + '='.repeat(70));
  console.log(`#${item.index}: ${item.keyword}`);
  if (item.asin) console.log(`Seed ASIN: ${item.asin}`);
  console.log(`BSR: ${bsr}`);
  console.log(`Output: ${path.relative(process.cwd(), paths.itemRoot)}`);
  console.log(`Reference categories: ${item.referenceCategories.length}`);
  item.referenceCategories.forEach(category => console.log(`  - ${category}`));

  const referenceArgs = args => appendReferenceCategoryArgs(args, item.referenceCategories);

  markItemStatus(progressFile, progress, item, {
    status: 'running',
    itemRoot: path.relative(process.cwd(), paths.itemRoot),
    startedAt: getItemProgress(progress, item).startedAt || new Date().toISOString(),
    error: null
  });

  runStep({
    item,
    paths,
    progress,
    progressFile,
    resume,
    step: 'marketData',
    label: `#${item.index} extract market data`,
    scriptName: 'extract-data.js',
    args: referenceArgs([item.keyword, String(bsr), paths.dataFile]),
    logger
  });

  runStep({
    item,
    paths,
    progress,
    progressFile,
    resume,
    step: 'seasonality',
    label: `#${item.index} extract seasonality`,
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

  runStep({
    item,
    paths,
    progress,
    progressFile,
    resume,
    step: 'historicalData',
    label: `#${item.index} extract historical new products`,
    scriptName: 'extract-data.js',
    args: referenceArgs([item.keyword, String(bsr), paths.historicalFile, '--survival-baseline', 'auto']),
    logger
  });

  const lifecycleFile = fileIfExists(paths.lifecycleFile);
  let cpcFile = null;
  if (lifecycleFile) {
    runStep({
      item,
      paths,
      progress,
      progressFile,
      resume,
      step: 'cpcOpportunity',
      label: `#${item.index} extract CPC opportunity`,
      scriptName: 'extract-cpc-opportunity.js',
      args: [lifecycleFile, paths.dataFile, paths.cpcFile],
      logger
    });
    cpcFile = fileIfExists(paths.cpcFile);
  } else {
    markStep(progressFile, progress, item, 'cpcOpportunity', 'skipped', { reason: 'lifecycle file not found' });
    console.warn(`Lifecycle file not found, skipping CPC: ${path.relative(process.cwd(), paths.lifecycleFile)}`);
    logger.warn('batch.step_skipped', {
      step: 'cpcOpportunity',
      reason: 'lifecycle file not found',
      lifecycleFile: path.relative(process.cwd(), paths.lifecycleFile)
    });
  }

  const reportArgs = [paths.dataFile];
  const seasonalityFile = fileIfExists(paths.seasonalityFile);
  const historicalFile = fileIfExists(paths.historicalFile);
  if (seasonalityFile) reportArgs.push('--seasonality', seasonalityFile);
  if (historicalFile) reportArgs.push('--historical', historicalFile);
  if (lifecycleFile) reportArgs.push('--asin-lifecycle', lifecycleFile);
  if (cpcFile) reportArgs.push('--cpc-opportunity', cpcFile);
  runStep({
    item,
    paths,
    progress,
    progressFile,
    resume,
    step: 'mainReport',
    label: `#${item.index} generate main report`,
    scriptName: 'generate-report.js',
    args: reportArgs,
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
    label: `#${item.index} generate child ASIN report`,
    scriptName: 'generate-child-asin-report.js',
    args: [paths.dataFile],
    skipWhenDone: false,
    logger
  });

  markItemStatus(progressFile, progress, item, {
    status: 'completed',
    currentStep: null,
    completedAt: new Date().toISOString(),
    error: null
  });
  logger.end({
    status: 'completed',
    item: item.index,
    keyword: item.keyword,
    dataFile: path.relative(process.cwd(), paths.dataFile),
    seasonalityFile: path.relative(process.cwd(), paths.seasonalityFile)
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
  const targets = selectedProducts(products, opts.start, opts.limit);
  if (!targets.length) {
    throw new Error(`No products selected. products=${products.length}, start=${opts.start}, limit=${opts.limit || 'all'}`);
  }

  console.log(`Batch JSON: ${opts.jsonFile}`);
  console.log(`Batch root: ${path.relative(process.cwd(), batchRoot)}`);
  console.log(`Resume: ${opts.resume ? 'enabled' : 'disabled'}`);
  console.log(`Products: ${products.length}, selected: ${targets.length}, start: ${opts.start}, limit: ${opts.limit || 'all'}, BSR: ${opts.bsr}`);

  const progressFile = path.join(batchRoot, 'batch-progress.json');
  const progress = opts.resume
    ? loadProgress(progressFile, batchRoot, opts, products)
    : createProgress(batchRoot, opts, products);
  const batchState = {
    googleTrendsConsecutiveFailures: Number(progress.googleTrendsConsecutiveFailures || 0)
  };
  progress.status = 'running';
  progress.selected = { start: opts.start, limit: opts.limit || null, count: targets.length };
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
    bsr: opts.bsr
  });

  const outputs = [];
  for (const item of targets) {
    const entry = getItemProgress(progress, item);
    if (opts.resume && entry.status === 'completed') {
      const paths = buildPaths(batchRoot, item, opts.bsr);
      console.log(`\n#${item.index}: ${item.keyword} skipped, already completed`);
      outputs.push(paths);
      continue;
    }
    try {
      outputs.push(runOne(item, batchRoot, opts.bsr, progress, progressFile, opts.resume, batchState, batchLogger));
    } catch (error) {
      markItemStatus(progressFile, progress, item, {
        status: 'failed',
        failedAt: new Date().toISOString(),
        error: error.message
      });
      progress.status = 'failed';
      progress.failedAt = new Date().toISOString();
      progress.lastFailedItem = item.index;
      saveProgress(progressFile, progress);
      batchLogger.error('batch.item_failed', {
        item: item.index,
        keyword: item.keyword,
        error: error.message
      });
      throw error;
    }
  }

  progress.status = 'completed';
  progress.completedAt = new Date().toISOString();
  saveProgress(progressFile, progress);
  batchLogger.end({
    status: 'completed',
    outputRoots: outputs.map(paths => path.relative(process.cwd(), paths.itemRoot)),
    googleTrendsBrowserRestarts: progress.googleTrendsBrowserRestarts || 0
  });

  console.log('\n' + '='.repeat(70));
  console.log('Batch completed. Output roots:');
  outputs.forEach(paths => console.log(`  - ${path.relative(process.cwd(), paths.itemRoot)}`));
}

main();
