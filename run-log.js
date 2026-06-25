const fs = require('fs');
const path = require('path');

function safeSegment(value) {
  return String(value || 'run')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'run';
}

function runRootFromOutput(outputFile) {
  if (!outputFile) return process.cwd();
  const outputDir = path.resolve(path.dirname(outputFile));
  const name = path.basename(outputDir).toLowerCase();
  if (['data', 'excel', 'reports', 'cache'].includes(name)) {
    return path.dirname(outputDir);
  }
  return outputDir;
}

function defaultLogFileForOutput(outputFile, keyword) {
  const root = runRootFromOutput(outputFile);
  const fallback = outputFile
    ? path.basename(outputFile).replace(/\.(json|html|xlsx|csv)$/i, '')
    : 'run';
  const base = safeSegment(keyword || fallback).toLowerCase();
  return path.join(root, `${base}-run.log`);
}

function pad(value, width) {
  return String(value).padStart(width, '0');
}

function localTimestamp(date = new Date()) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1, 2),
    pad(date.getDate(), 2)
  ].join('-') + ' ' + [
    pad(date.getHours(), 2),
    pad(date.getMinutes(), 2),
    pad(date.getSeconds(), 2)
  ].join(':');
}

function jsonSafe(value) {
  return JSON.stringify(value, (key, nestedValue) => {
    if (nestedValue instanceof Error) {
      return { message: nestedValue.message, stack: nestedValue.stack };
    }
    return nestedValue;
  }, 2);
}

function isScalar(value) {
  return value == null || ['string', 'number', 'boolean'].includes(typeof value);
}

function singleLineValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function indentBlock(text, spaces) {
  const prefix = ' '.repeat(spaces);
  return String(text || '')
    .split(/\r?\n/)
    .map(line => `${prefix}${line}`)
    .join('\n');
}

function formatDetailValue(value, indent) {
  const scalar = singleLineValue(value);
  if (scalar != null && !scalar.includes('\n')) return scalar;
  if (scalar != null) return `\n${indentBlock(scalar, indent + 2)}`;
  try {
    return `\n${indentBlock(jsonSafe(value), indent + 2)}`;
  } catch (error) {
    return String(value);
  }
}

function compactDetails(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string') return value.includes('\n')
    ? `\n${indentBlock(value, 2)}`
    : value;
  if (isScalar(value)) return singleLineValue(value);
  if (process.env.OALUR_LOG_FORMAT === 'jsonl') {
    try {
      return jsonSafe(value).replace(/\s+/g, ' ');
    } catch (error) {
      return String(value);
    }
  }
  try {
    return Object.entries(value)
      .map(([key, nestedValue]) => `  ${key}: ${formatDetailValue(nestedValue, 2)}`)
      .join('\n');
  } catch (error) {
    return String(value);
  }
}

const DEFAULT_NOISY_EVENTS = new Set([
  'run.start',
  'keyword_intent.saved',
  'market.parameters',
  'market.multi_keyword_start',
  'market.keyword_start',
  'market.first_page',
  'market.pagination_plan',
  'market.page_extracted',
  'market.keyword_complete',
  'market.sort_listing_date',
  'batch.step_start',
  'batch.step_complete',
  'batch.step_skipped',
  'batch.step_retry',
  'browser.cdp_ready',
  'google_trends.attempt',
  'google_trends.local_keyword_agent'
]);

function logMode() {
  return String(process.env.OALUR_LOG_LEVEL || process.env.OALUR_LOG_MODE || 'summary').toLowerCase();
}

function shouldWrite(level, event) {
  const mode = logMode();
  if (mode === 'debug' || mode === 'verbose' || mode === 'all') return true;
  if (level === 'ERROR' || level === 'WARN') return true;
  if (/failed|error|skip|skipped|restart/i.test(event)) return true;
  if (/final|summary|decision|complete$/i.test(event)) return true;
  if (/run\.end$/i.test(event)) return true;
  if (/google_trends\.batch_status/i.test(event)) return true;
  return !DEFAULT_NOISY_EVENTS.has(event) && mode === 'normal';
}

function createRunLogger(options = {}) {
  const logFile = path.resolve(
    options.logFile ||
    process.env.OALUR_RUN_LOG ||
    defaultLogFileForOutput(options.outputFile, options.keyword)
  );
  const scriptName = options.scriptName || path.basename(process.argv[1] || 'node');

  function write(level, event, details) {
    if (!shouldWrite(level, event)) return;
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const detailText = compactDetails(details);
    const now = new Date();
    const header = `${localTimestamp(now)} | ${level.padEnd(5)} | ${scriptName} | ${event}`;
    const line = detailText
      ? `${header}\n${detailText}\n\n`
      : `${header}\n`;
    fs.appendFileSync(logFile, line, 'utf8');
  }

  return {
    logFile,
    info: (event, details) => write('INFO', event, details),
    warn: (event, details) => write('WARN', event, details),
    error: (event, details) => write('ERROR', event, details),
    start: (details) => write('INFO', 'run.start', details),
    end: (details) => write('INFO', 'run.end', details)
  };
}

module.exports = {
  createRunLogger,
  defaultLogFileForOutput,
  runRootFromOutput,
  safeSegment
};
