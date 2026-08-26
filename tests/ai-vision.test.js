'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AI_PROVIDERS,
  DEFAULT_AI_PROMPT,
  buildVisionRequest,
  extractVisionText,
  parseTags,
  requestVision
} = require('../src/ai-vision');

test('every AI provider exposes a usable default model and base url', () => {
  assert.ok(AI_PROVIDERS.length >= 2);
  for (const provider of AI_PROVIDERS) {
    assert.ok(provider.id && provider.label && provider.baseUrl && provider.defaultModel);
  }
});

test('Gemini requests send inline image data and the API key in the query', () => {
  const { url, init } = buildVisionRequest(
    { provider: 'gemini', model: 'gemini-2.0-flash', apiKey: 'AIzaTest' },
    'QUJD', 'image/jpeg'
  );
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=AIzaTest');
  const body = JSON.parse(init.body);
  assert.deepEqual(body.contents[0].parts[1].inline_data, { mime_type: 'image/jpeg', data: 'QUJD' });
  assert.equal(typeof body.contents[0].parts[0].text, 'string');
});

test('custom base url and prompt override the provider defaults', () => {
  const { url, init } = buildVisionRequest({
    provider: 'gemini',
    baseUrl: 'https://gateway.example.com/v1beta/',
    model: 'gemini-lite',
    prompt: '只返回三个标签',
    apiKey: 'k'
  }, 'QUJD', 'image/png');
  assert.ok(url.startsWith('https://gateway.example.com/v1beta/models/gemini-lite:generateContent'));
  assert.equal(JSON.parse(init.body).contents[0].parts[0].text, '只返回三个标签');
  assert.notEqual(DEFAULT_AI_PROMPT, '只返回三个标签');
});

test('OpenAI compatible requests use bearer auth and a data url image', () => {
  const { url, init } = buildVisionRequest(
    { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test' },
    'QUJD', 'image/jpeg'
  );
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(init.headers.Authorization, 'Bearer sk-test');
  const content = JSON.parse(init.body).messages[0].content;
  assert.equal(content[1].image_url.url, 'data:image/jpeg;base64,QUJD');
});

test('third party OpenAI compatible gateways work by changing the base url', () => {
  const { url, init } = buildVisionRequest({
    provider: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-vl',
    apiKey: 'sk-x'
  }, 'QUJD', 'image/jpeg');
  assert.equal(url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(JSON.parse(init.body).model, 'deepseek-vl');
});

test('a missing key fails before any network call', async () => {
  await assert.rejects(
    () => requestVision({ provider: 'openai', apiKey: '' }, 'QUJD', 'image/jpeg', () => {
      throw new Error('should not fetch');
    }),
    /API Key/
  );
});

test('responses are parsed for both provider shapes', () => {
  assert.equal(
    extractVisionText({ provider: 'gemini' }, { candidates: [{ content: { parts: [{ text: ' 海边, 日落 ' }] } }] }),
    '海边, 日落'
  );
  assert.equal(
    extractVisionText({ provider: 'openai' }, { choices: [{ message: { content: '山, 清晨' } }] }),
    '山, 清晨'
  );
  assert.equal(
    extractVisionText({ provider: 'openai' }, { choices: [{ message: { content: [{ text: '森林' }, { text: ', 雾' }] } }] }),
    '森林, 雾'
  );
});

test('tag parsing tolerates markdown, newlines and Chinese separators', () => {
  assert.deepEqual(parseTags('海边、日落, 晴天\n"夏"'), ['海边', '日落', '晴天', '夏']);
  assert.deepEqual(parseTags('## 旅行, 相册'), ['旅行', '相册']);
  assert.deepEqual(parseTags(''), []);
});
