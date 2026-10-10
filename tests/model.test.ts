import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { callModel, modelDay } from '../server/model.js';

test('Anthropic 与 Gemini 拒绝截断、工具调用、拦截和空响应', async () => {
  const store = new Store(':memory:');
  try {
    for (const [endpoint, payloads] of [
      ['https://model.test/v1/messages', [
        { type: 'message', role: 'assistant', stop_reason: 'max_tokens', content: [{ type: 'text', text: 'partial' }] },
        { type: 'message', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: 'partial' }] },
        { type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [] },
      ]],
      ['https://model.test/v1beta/models/test:generateContent', [
        { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'partial' }] } }] },
        { candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: 'partial' }] } }] },
        { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'hidden' }] } }] },
      ]],
    ] as const) {
      const settings = store.settings();
      settings.model = { ...settings.model, enabled: true, name: 'test', endpoint, dailyBudget: 0 };
      store.set('settings', settings);
      for (const payload of payloads) await assert.rejects(callModel(store, settings, 'system', 'input', 500, async () => Response.json(payload)), /模型没有返回有效文本/);
    }
  } finally { store.close(); }
});

test('Responses 支持本机免 Key 代理与部署别名，只读取助手正文', async () => {
  const store = new Store(':memory:');
  try {
    const settings = store.settings();
    settings.model = { ...settings.model, enabled: true, name: 'test-deployment', endpoint: 'http://127.0.0.1:15721/v1/responses/' };
    store.set('settings', settings);
    const fetcher: typeof fetch = async (input, init) => {
      assert.equal(input, settings.model.endpoint);
      assert.equal(new Headers(init?.headers).has('Authorization'), false);
      assert.equal(init?.redirect, 'error');
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model: 'test-deployment', stream: false, store: false, reasoning: { effort: 'low' }, max_output_tokens: 6696,
        instructions: 'system', input: [{ role: 'user', content: 'input' }],
      });
      return Response.json({ status: 'completed', output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'not an answer' }] },
        { type: 'message', role: 'user', content: [{ type: 'output_text', text: 'not assistant' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: ' first' }, { type: 'output_text', text: ' second ' }] },
      ] });
    };
    assert.equal(await callModel(store, settings, 'system', 'input', 2600, fetcher), 'first second');
    assert.equal(store.get(`modelUsage:${modelDay()}`, 0), 1);
  } finally { store.close(); }
});

test('Responses 拒绝截断、失败、拒答、空正文和非法输出，不把部分内容当作成功', async () => {
  const store = new Store(':memory:');
  try {
    const settings = store.settings();
    settings.model = { ...settings.model, enabled: true, name: 'test-deployment', endpoint: 'http://127.0.0.1:15721/v1/responses', dailyBudget: 0 };
    store.set('settings', settings);
    const output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] }];
    for (const payload of [
      { status: 'incomplete', output },
      { status: 'failed', output },
      { status: 'completed', error: { message: 'private provider error' }, output },
      { status: 'completed', output: [] },
      { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] }] },
      { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 123 }] }] },
      { choices: [{ message: { content: 'wrong protocol' } }] },
    ]) {
      await assert.rejects(callModel(store, settings, 'system', 'input', 500, async () => Response.json(payload)), /模型没有返回有效文本/);
    }
  } finally { store.close(); }
});

for (const name of ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra-2026-09-29', 'local-model']) {
  test(`model request parameters: ${name}`, async () => {
    const store = new Store(':memory:');
    try {
      const settings = store.settings();
      settings.model = { ...settings.model, enabled: true, name, endpoint: 'https://model.test/v1/chat/completions' };
      store.set('settings', settings);
      store.saveSecrets({ modelKey: 'test-only-key' });
      const fetcher: typeof fetch = async (input, init) => {
        assert.equal(input, settings.model.endpoint);
        assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-only-key');
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, name);
        assert.equal(body.stream, false);
        assert.deepEqual(body.messages, [{ role: 'system', content: 'system' }, { role: 'user', content: 'input' }]);
        if (name === 'local-model') {
          assert.equal(body.temperature, 0.2);
          assert.equal(body.max_tokens, 2600);
          assert.equal(body.reasoning_effort, undefined);
          assert.equal(body.max_completion_tokens, undefined);
        } else {
          assert.equal(body.temperature, undefined);
          assert.equal(body.max_tokens, undefined);
          assert.equal(body.reasoning_effort, 'low');
          assert.equal(body.max_completion_tokens, 6696);
        }
        return Response.json({ choices: [{ message: { content: ' result ' } }] });
      };
      assert.equal(await callModel(store, settings, 'system', 'input', 2600, fetcher), 'result');
    } finally { store.close(); }
  });
}
