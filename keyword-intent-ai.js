const fs = require('fs');
const path = require('path');
const { keywordTokens } = require('./category-selector');

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');

const LOCAL_SHAPE_HINTS = {
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

const LOCAL_INTENT_HINTS = {
  coffee: ['coffee', 'espresso', 'demitasse', 'cappuccino', 'latte', 'moka'],
  espresso: ['espresso', 'coffee', 'demitasse', 'cappuccino', 'latte', 'moka'],
  chocolate: ['chocolate', 'candy', 'gummy', 'caramel', 'fondant', 'bonbon', 'truffle'],
  candy: ['candy', 'chocolate', 'gummy', 'caramel', 'fondant', 'bonbon', 'truffle']
};

function unique(values) {
  return [...new Set((values || [])
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean))];
}

function normalizeKeyword(keyword) {
  return keywordTokens(keyword).join(' ');
}

function localKeywordIntentAnalysis(keyword, extraNotes = []) {
  const tokens = keywordTokens(keyword);
  const shapeToken = tokens[tokens.length - 1] || '';
  const modifierTokens = tokens.slice(0, -1);
  const shape = unique([shapeToken, ...(LOCAL_SHAPE_HINTS[shapeToken] || [])]);
  const intent = unique(modifierTokens.flatMap(token => [token, ...(LOCAL_INTENT_HINTS[token] || [])]));
  return {
    keyword,
    normalizedKeyword: normalizeKeyword(keyword),
    source: 'local-fallback',
    confidence: 'low',
    shape,
    intent,
    equivalent: [],
    nearButRisky: [],
    exclude: [],
    notes: [
      ...extraNotes,
      'No usable OpenAI keyword intent response was available; this is a local fallback based on current built-in token aliases.',
      'This analysis is advisory only and is not used by product filtering.'
    ]
  };
}

function sanitizeAiAnalysis(keyword, raw) {
  const result = raw && typeof raw === 'object' ? raw : {};
  return {
    keyword,
    normalizedKeyword: normalizeKeyword(keyword),
    source: 'ai',
    confidence: ['high', 'medium', 'low'].includes(result.confidence) ? result.confidence : 'medium',
    shape: unique(result.shape),
    intent: unique(result.intent),
    equivalent: unique(result.equivalent),
    nearButRisky: unique(result.nearButRisky),
    exclude: unique(result.exclude),
    notes: Array.isArray(result.notes) ? result.notes.map(v => String(v)).filter(Boolean).slice(0, 8) : []
  };
}

function extractJsonObject(text) {
  const value = String(text || '').trim();
  if (!value) throw new Error('AI response is empty');
  try {
    return JSON.parse(value);
  } catch (_) {
    const match = value.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AI response did not contain JSON');
    return JSON.parse(match[0]);
  }
}

function buildKeywordIntentPrompt(keyword) {
  return [
    '你是 Amazon 选品过滤系统的关键词意图分析器。',
    '请只生成候选同义词和风险词，不要判断任何 ASIN 是否保留。',
    '返回且只返回 JSON，不要 Markdown，不要解释。',
    'JSON 结构固定为：',
    '{"confidence":"high|medium|low","shape":[],"intent":[],"equivalent":[],"nearButRisky":[],"exclude":[],"notes":[]}',
    '字段含义：',
    '- shape：产品形态词，英文小写，尽量用单数或短词组。',
    '- intent：和目标产品用途强相关的修饰词/场景词。',
    '- equivalent：可能功能等价但需要人工确认的产品词组。',
    '- nearButRisky：相近但容易扩大市场的词。',
    '- exclude：明显不是目标产品的词组。',
    `关键词：${keyword}`
  ].join('\n');
}

async function callOpenAiForKeyword(keyword) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const prompt = buildKeywordIntentPrompt(keyword);

  const response = await fetch(`${OPENAI_BASE_URL}/responses`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      input: prompt,
      text: { format: { type: 'json_object' } }
    })
  });

  if (!response.ok) {
    const message = await response.text().catch(() => '');
    throw new Error(`OpenAI keyword intent request failed: HTTP ${response.status} ${message.slice(0, 300)}`);
  }

  const data = await response.json();
  const text = data.output_text
    || data.output?.flatMap(item => item.content || []).map(part => part.text || '').join('')
    || '';
  return { ...sanitizeAiAnalysis(keyword, extractJsonObject(text)), source: 'openai' };
}

async function analyzeKeywordIntent(keyword) {
  try {
    const openAiResult = await callOpenAiForKeyword(keyword);
    if (openAiResult) return openAiResult;
    return localKeywordIntentAnalysis(keyword);
  } catch (error) {
    return {
      ...localKeywordIntentAnalysis(keyword),
      source: 'local-fallback-after-ai-error',
      notes: [
        `AI analysis failed: ${error.message}`,
        'Fallback is advisory only and is not used by product filtering.'
      ]
    };
  }
}

async function analyzeKeywords(keywords) {
  const list = Array.isArray(keywords) ? keywords : [keywords];
  const results = [];
  for (const keyword of list.map(v => String(v || '').trim()).filter(Boolean)) {
    results.push(await analyzeKeywordIntent(keyword));
  }
  return {
    generatedAt: new Date().toISOString(),
    model: process.env.OPENAI_API_KEY ? DEFAULT_MODEL : null,
    usedOpenAI: Boolean(process.env.OPENAI_API_KEY),
    filteringImpact: 'none',
    warning: 'AI keyword intent analysis is advisory only. It is not used by target category selection or product filtering.',
    keywords: results
  };
}

function outputPathForDataFile(dataOutFile) {
  const dir = path.dirname(dataOutFile || path.join('output', 'keyword-intent-analysis.json'));
  return path.join(dir, 'keyword-intent-analysis.json');
}

async function writeKeywordIntentAnalysis(keywords, dataOutFile) {
  const analysis = await analyzeKeywords(keywords);
  const file = outputPathForDataFile(dataOutFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(analysis, null, 2), 'utf-8');
  return { file, analysis };
}

async function main() {
  const args = process.argv.slice(2);
  const keywordArg = args[0];
  if (!keywordArg) {
    console.error('Usage: node keyword-intent-ai.js "Keyword1,Keyword2" [output-file.json]');
    process.exit(1);
  }
  const keywords = keywordArg.split(',').map(v => v.trim()).filter(Boolean);
  const outputFile = args[1] || path.join('output', 'keyword-intent-analysis', 'keyword-intent-analysis.json');
  const analysis = await analyzeKeywords(keywords);
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(analysis, null, 2), 'utf-8');
  console.log(`Keyword intent analysis saved: ${outputFile}`);
  console.log(JSON.stringify(analysis.keywords.map(item => ({
    keyword: item.keyword,
    source: item.source,
    shape: item.shape,
    intent: item.intent,
    equivalent: item.equivalent,
    exclude: item.exclude
  })), null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  analyzeKeywordIntent,
  analyzeKeywords,
  writeKeywordIntentAnalysis
};
