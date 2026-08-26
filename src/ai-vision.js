const PROVIDER_GEMINI = 'gemini';
const PROVIDER_OPENAI = 'openai';

const DEFAULT_AI_PROMPT = [
  'Analyze this photo and return ONLY a comma-separated list of short descriptive tags in Chinese.',
  'Include scene type, weather, time of day, notable objects, and mood. Maximum 8 tags.',
  'No explanations, just the tags.'
].join(' ');

const AI_PROVIDERS = [
  {
    id: PROVIDER_GEMINI,
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-1.5-flash',
    keyPlaceholder: 'AIza...',
    hint: 'Gemini 免费额度足够个人使用，前往 aistudio.google.com 获取 Key。'
  },
  {
    id: PROVIDER_OPENAI,
    label: 'OpenAI 兼容接口',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    keyPlaceholder: 'sk-...',
    hint: '适用于 OpenAI、DeepSeek、通义千问兼容模式、硅基流动、OpenRouter、one-api 等任何 /chat/completions 网关。'
  }
];

function providerById(id) {
  return AI_PROVIDERS.find(item => item.id === id) || AI_PROVIDERS[0];
}

function normalizeBaseUrl(value, fallback) {
  const raw = String(value || '').trim() || fallback;
  return raw.replace(/\/+$/, '');
}

// Builds the HTTP call for a vision request so every provider shares one code path.
function buildVisionRequest(config, base64Image, mimeType) {
  const provider = providerById(config.provider);
  const model = String(config.model || '').trim() || provider.defaultModel;
  const prompt = String(config.prompt || '').trim() || DEFAULT_AI_PROMPT;
  const apiKey = String(config.apiKey || '').trim();
  const baseUrl = normalizeBaseUrl(config.baseUrl, provider.baseUrl);

  if (!apiKey && provider.id !== PROVIDER_GEMINI) {
    throw new Error('请先填写 API Key');
  }
  if (provider.id === PROVIDER_GEMINI && !apiKey) {
    throw new Error('请先填写 Gemini API Key');
  }

  if (provider.id === PROVIDER_OPENAI) {
    return {
      url: `${baseUrl}/chat/completions`,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          temperature: 0.3,
          max_tokens: 200,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
            ]
          }]
        })
      }
    };
  }

  return {
    url: `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: base64Image } }
          ]
        }],
        generationConfig: { maxOutputTokens: 200, temperature: 0.3 }
      })
    }
  };
}

function extractVisionText(config, json) {
  const provider = providerById(config.provider);
  if (provider.id === PROVIDER_OPENAI) {
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      return content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('').trim();
    }
    return '';
  }
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(part => part?.text || '').join('').trim();
}

async function requestVision(config, base64Image, mimeType, fetchImpl = fetch) {
  const { url, init } = buildVisionRequest(config, base64Image, mimeType);
  const provider = providerById(config.provider);
  const res = await fetchImpl(url, init);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${provider.label} 接口 ${res.status}: ${detail.slice(0, 300)}`);
  }
  const json = await res.json();
  const text = extractVisionText(config, json);
  if (!text) throw new Error(`${provider.label} 返回内容为空`);
  return text;
}

function parseTags(text) {
  return String(text || '')
    .replace(/\n+/g, ',')
    .split(/[,，、;；]/)
    .map(value => value.trim().replace(/^[#*\s"']+/, '').replace(/[#*\s"']+$/, ''))
    .filter(Boolean);
}

module.exports = {
  AI_PROVIDERS,
  DEFAULT_AI_PROMPT,
  PROVIDER_GEMINI,
  PROVIDER_OPENAI,
  providerById,
  normalizeBaseUrl,
  buildVisionRequest,
  extractVisionText,
  requestVision,
  parseTags
};
