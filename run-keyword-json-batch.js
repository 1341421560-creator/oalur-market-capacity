const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  appendReferenceCategoryArgs,
  normalizeReferenceCategories
} = require('./reference-categories');

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

function runNode(scriptName, args, label) {
  const scriptPath = path.join(__dirname, scriptName);
  console.log(`\n[${label}] node ${scriptName} ${args.map(a => JSON.stringify(String(a))).join(' ')}`);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: __dirname,
    stdio: 'inherit',
    shell: false,
    env: process.env
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
    cpcFile: path.join(dataDir, `${keywordFile}-cpc-opportunity.json`)
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

function runStep({ item, paths, progress, progressFile, resume, step, label, scriptName, args, skipWhenDone = true }) {
  if (resume && skipWhenDone && stepAlreadyDone(step, paths)) {
    markStep(progressFile, progress, item, step, 'completed', { skipped: true });
    console.log(`[${label}] skipped, output already exists`);
    return;
  }
  markStep(progressFile, progress, item, step, 'running', { skipped: false });
  runNode(scriptName, args, label);
  markStep(progressFile, progress, item, step, 'completed', { skipped: false });
}

function runOne(item, batchRoot, bsr, progress, progressFile, resume) {
  if (!item.keyword) {
    throw new Error(`Product #${item.index} is missing keyword`);
  }

  const paths = buildPaths(batchRoot, item, bsr);
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.mkdirSync(paths.reportsDir, { recursive: true });
  fs.mkdirSync(paths.excelDir, { recursive: true });

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
    args: referenceArgs([item.keyword, String(bsr), paths.dataFile])
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
    args: [item.keyword, paths.dataFile, paths.seasonalityFile]
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
    args: referenceArgs([item.keyword, String(bsr), paths.historicalFile, '--survival-baseline', 'auto'])
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
      args: [lifecycleFile, paths.dataFile, paths.cpcFile]
    });
    cpcFile = fileIfExists(paths.cpcFile);
  } else {
    markStep(progressFile, progress, item, 'cpcOpportunity', 'skipped', { reason: 'lifecycle file not found' });
    console.warn(`Lifecycle file not found, skipping CPC: ${path.relative(process.cwd(), paths.lifecycleFile)}`);
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
    skipWhenDone: false
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
    skipWhenDone: false
  });

  markItemStatus(progressFile, progress, item, {
    status: 'completed',
    currentStep: null,
    completedAt: new Date().toISOString(),
    error: null
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
  progress.status = 'running';
  progress.selected = { start: opts.start, limit: opts.limit || null, count: targets.length };
  saveProgress(progressFile, progress);
  console.log(`Progress: ${path.relative(process.cwd(), progressFile)}`);

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
      outputs.push(runOne(item, batchRoot, opts.bsr, progress, progressFile, opts.resume));
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
      throw error;
    }
  }

  progress.status = 'completed';
  progress.completedAt = new Date().toISOString();
  saveProgress(progressFile, progress);

  console.log('\n' + '='.repeat(70));
  console.log('Batch completed. Output roots:');
  outputs.forEach(paths => console.log(`  - ${path.relative(process.cwd(), paths.itemRoot)}`));
}

main();
