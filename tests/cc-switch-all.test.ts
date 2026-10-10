import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readCCSwitch, resolveCCSwitchModel } from '../server/cc-switch.js';
import { readLegacyCCSwitch } from '../server/legacy-cc-switch.js';
import { callModel, modelDay } from '../server/model.js';
import { Store } from '../server/store.js';
import { defaultSettings } from '../server/config.js';
import { makeApp } from '../server/app.js';
import { createCCSwitchFixture } from './cc-switch-fixtures.js';
import type { CCSwitchModel } from '../shared/types.js';

function configured(option: CCSwitchModel) {
  return { ...structuredClone(defaultSettings), model: { ...defaultSettings.model, enabled: true, name: option.model, endpoint: option.endpoint, ccSwitch: { providerId: option.providerId, fingerprint: option.fingerprint, appType: option.appType, mode: 'direct' as const } } };
}

test('读取所有应用的模型并按真实 ID 去重，非当前配置可选，应用间相同 ID 不冲突', () => {
  const directory = mkdtempSync(join(tmpdir(), 'radar-cc-all-'));
  try {
    createCCSwitchFixture(directory);
    const before = readFileSync(join(directory, 'cc-switch.db'));
    const catalog = readCCSwitch(directory);
    for (const appType of ['claude', 'codex', 'gemini', 'openclaw', 'custom']) assert.ok(catalog.models.some(option => option.appType === appType));
    assert.equal(new Set(catalog.models.map(option => option.id)).size, catalog.models.length);
    const claude = catalog.models.filter(option => option.appType === 'claude' && option.providerId === 'default');
    assert.deepEqual(claude.map(option => option.model), ['claude-deployment', 'haiku-deployment']);
    assert.ok(claude.every(option => option.selectable));
    assert.equal(claude[0].endpoint, 'https://claude.test/gateway/v1/messages');
    assert.ok(catalog.models.find(option => option.appType === 'codex' && option.providerId === 'other')?.selectable);
    assert.equal(catalog.models.find(option => option.appType === 'custom')?.selectable, false);
    assert.equal(catalog.models.find(option => option.providerId === 'official')?.selectable, false);
    assert.equal(JSON.stringify(catalog).includes('PRIVATE-'), false);
    assert.equal(JSON.stringify(catalog).includes('Friendly display name'), false);
    assert.deepEqual(readFileSync(join(directory, 'cc-switch.db')), before);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('所选 Claude 独立调用正确地址和凭据，切换 CC Switch 当前卡不影响它，凭据轮换即时读取', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'radar-cc-all-'));
  const store = new Store(':memory:');
  try {
    createCCSwitchFixture(directory);
    const option = readCCSwitch(directory).models.find(option => option.appType === 'claude' && option.model === 'claude-deployment')!;
    const settings = configured(option);
    store.set('settings', settings);
    store.saveSecrets({ modelKey: 'WRONG-PLATFORM-KEY' });
    let expectedKey = 'PRIVATE-CLAUDE-KEY';
    let calls = 0;
    const fetcher: typeof fetch = async (url, init) => {
      calls++;
      assert.equal(url, 'https://claude.test/gateway/v1/messages');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('Authorization'), `Bearer ${expectedKey}`);
      assert.equal(headers.get('anthropic-version'), '2023-06-01');
      assert.equal(init?.redirect, 'error');
      assert.deepEqual(JSON.parse(String(init?.body)), { model: 'claude-deployment', stream: false, max_tokens: 500, system: 'system', messages: [{ role: 'user', content: 'input' }] });
      return Response.json({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'not output' }, { type: 'text', text: 'ok' }] });
    };
    assert.equal(await callModel(store, settings, 'system', 'input', 500, fetcher, directory), 'ok');
    const db = new DatabaseSync(join(directory, 'cc-switch.db'));
    try {
      db.exec("UPDATE providers SET is_current=0; UPDATE proxy_config SET enabled=0, auto_failover_enabled=1");
      writeFileSync(join(directory, 'settings.json'), JSON.stringify({ currentProviderCodex: 'other', currentProviderClaude: 'secondary' }));
      const row = db.prepare("SELECT settings_config FROM providers WHERE app_type='claude' AND id='default'").get()!;
      expectedKey = 'ROTATED-CLAUDE-KEY';
      db.prepare("UPDATE providers SET settings_config=? WHERE app_type='claude' AND id='default'").run(String(row.settings_config).replace('PRIVATE-CLAUDE-KEY', expectedKey));
      assert.equal(await callModel(store, settings, 'system', 'input', 500, fetcher, directory), 'ok');
      db.exec("DELETE FROM providers WHERE app_type='claude' AND id='default'");
      await assert.rejects(callModel(store, settings, 'system', 'input', 500, fetcher, directory), /CC Switch 所选配置/);
    } finally { db.close(); }
    assert.equal(calls, 2);
    assert.equal(store.get(`modelUsage:${modelDay()}`, 0), 2);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Claude API Key、OpenClaw Chat、Gemini 原生协议分别使用对应请求与响应', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'radar-cc-all-'));
  const store = new Store(':memory:');
  try {
    createCCSwitchFixture(directory);
    const catalog = readCCSwitch(directory);
    for (const [appType, model] of [['claude', 'claude-secondary'], ['openclaw', 'kimi-deployment'], ['gemini', 'gemini-fixture']]) {
      const option = catalog.models.find(option => option.appType === appType && option.model === model)!;
      const settings = configured(option);
      store.set('settings', settings);
      const fetcher: typeof fetch = async (url, init) => {
        const headers = new Headers(init?.headers);
        const body = JSON.parse(String(init?.body));
        if (appType === 'claude') {
          assert.equal(headers.get('x-api-key'), 'PRIVATE-SECOND-CLAUDE-KEY');
          assert.equal(headers.has('Authorization'), false);
          return Response.json({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] });
        }
        if (appType === 'openclaw') {
          assert.equal(url, 'https://kimi.test/v1/chat/completions');
          assert.equal(headers.get('Authorization'), 'Bearer PRIVATE-KIMI-KEY');
          assert.equal(body.model, model);
          return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] });
        }
        assert.equal(url, 'https://gemini.test/v1beta/models/gemini-fixture:generateContent');
        assert.equal(headers.get('x-goog-api-key'), 'PRIVATE-GEMINI-KEY');
        assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'input' }] }]);
        assert.deepEqual(body.systemInstruction, { parts: [{ text: 'system' }] });
        return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'not output' }, { text: 'ok' }] } }] });
      };
      assert.equal(await callModel(store, settings, 'system', 'input', 500, fetcher, directory), 'ok');
    }
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('缺少凭据、带密钥 URL、不支持的协议与跨应用伪造绑定不能调用', () => {
  const directory = mkdtempSync(join(tmpdir(), 'radar-cc-all-'));
  try {
    createCCSwitchFixture(directory);
    const option = readCCSwitch(directory).models.find(option => option.appType === 'claude')!;
    const settings = configured(option);
    assert.throws(() => resolveCCSwitchModel({ ...settings, model: { ...settings.model, ccSwitch: { ...settings.model.ccSwitch, appType: 'codex' } } }, directory));
    const db = new DatabaseSync(join(directory, 'cc-switch.db'));
    try {
      const row = db.prepare("SELECT settings_config FROM providers WHERE app_type='claude' AND id='default'").get()!;
      const config = JSON.parse(String(row.settings_config));
      delete config.env.ANTHROPIC_AUTH_TOKEN;
      db.prepare("UPDATE providers SET settings_config=? WHERE app_type='claude' AND id='default'").run(JSON.stringify(config));
      assert.equal(readCCSwitch(directory).models.find(option => option.appType === 'claude' && option.providerId === 'default')?.selectable, false);
      config.env.ANTHROPIC_AUTH_TOKEN = 'RESTORED';
      config.env.ANTHROPIC_BASE_URL = 'https://claude.test/v1?key=PRIVATE-URL-KEY';
      db.prepare("UPDATE providers SET settings_config=? WHERE app_type='claude' AND id='default'").run(JSON.stringify(config));
      assert.equal(JSON.stringify(readCCSwitch(directory)).includes('PRIVATE-URL-KEY'), false);
      assert.throws(() => resolveCCSwitchModel(settings, directory));
    } finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('全应用下拉保存绑定持久化、API 不返回凭据，旧 Codex 代理设置仍可校验', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'radar-cc-all-'));
  const store = new Store(':memory:');
  createCCSwitchFixture(directory);
  const { app } = makeApp(store, { serveStatic: false, ccSwitchDirectory: directory });
  try {
    const option = readCCSwitch(directory).models.find(option => option.appType === 'claude')!;
    const settings = configured(option);
    const response = await app.inject({ method: 'PUT', url: '/api/settings', headers: { host: '127.0.0.1:4310', 'x-radar-client': '1' }, payload: { settings } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(store.settings().model.ccSwitch, settings.model.ccSwitch);
    const dashboard = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { host: '127.0.0.1:4310' } });
    assert.equal(dashboard.body.includes('PRIVATE-'), false);
    const legacy = readLegacyCCSwitch(directory).models[0];
    const old = { ...settings, model: { ...settings.model, endpoint: legacy.endpoint, name: legacy.model, ccSwitch: { providerId: legacy.providerId, fingerprint: legacy.fingerprint } } };
    assert.deepEqual(resolveCCSwitchModel(old, directory), { headers: {}, protocol: 'responses' });
  } finally { await app.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
