import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertCCSwitchModel } from '../server/cc-switch.js';
import { readLegacyCCSwitch as readCCSwitch } from '../server/legacy-cc-switch.js';
import { defaultSettings } from '../server/config.js';
import { callModel, modelDay } from '../server/model.js';
import { makeApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { createCCSwitchFixture } from './cc-switch-fixtures.js';
import type { CCSwitchModel } from '../shared/types.js';

function settingsFor(option: CCSwitchModel) {
  return { ...structuredClone(defaultSettings), model: { ...defaultSettings.model, enabled: true, endpoint: option.endpoint, name: option.model, ccSwitch: { providerId: option.providerId, fingerprint: option.fingerprint, ...(option.appType ? { appType: option.appType, mode: 'direct' as const } : {}) } } };
}

test('旧代理模式兼容：只读列表、隐藏凭据、保持原路由检查', () => {
  const directory = mkdtempSync(join(tmpdir(), 'radar-cc-'));
  try {
    createCCSwitchFixture(directory);
    const before = readFileSync(join(directory, 'cc-switch.db'));
    const catalog = readCCSwitch(directory);
    assert.deepEqual(catalog.models.filter(option => option.selectable).map(option => option.model), ['fixture-deployment', 'fixture-alternate']);
    assert.ok(catalog.models.find(option => option.providerId === 'other')?.reason.includes('先在 CC Switch'));
    assert.ok(catalog.models.find(option => option.providerId === 'official')?.reason.includes('未配置'));
    assert.equal(catalog.models.some(option => option.providerId === 'claude'), false);
    assert.equal(JSON.stringify(catalog).includes('PRIVATE-'), false);
    assert.equal(JSON.stringify(catalog).includes('https://model.test'), false);
    assert.deepEqual(readFileSync(join(directory, 'cc-switch.db')), before);
    assertCCSwitchModel(settingsFor(catalog.models[0]), directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('CC Switch 缺失、数据库损坏、代理关闭和故障转移均安全提示，不假装模型可选', () => {
  const directory = mkdtempSync(join(tmpdir(), 'radar-cc-'));
  try {
    assert.deepEqual(readCCSwitch(directory).models, []);
    writeFileSync(join(directory, 'cc-switch.db'), 'invalid database');
    assert.deepEqual(readCCSwitch(directory).models, []);
    rmSync(join(directory, 'cc-switch.db'));
    createCCSwitchFixture(directory);
    const db = new DatabaseSync(join(directory, 'cc-switch.db'));
    try {
      db.exec('UPDATE proxy_config SET auto_failover_enabled=1');
      assert.equal(readCCSwitch(directory).models.some(option => option.selectable), false);
      db.exec('UPDATE proxy_config SET auto_failover_enabled=0,enabled=0');
      assert.equal(readCCSwitch(directory).models.some(option => option.selectable), false);
      db.exec("UPDATE proxy_config SET enabled=1,listen_address='external.test'");
      assert.equal(readCCSwitch(directory).models.some(option => option.selectable), false);
    } finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('CC Switch 调用使用所选 ID 且不发送平台密钥；外部切换后不调用、不扣预算', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'radar-cc-'));
  const store = new Store(':memory:');
  try {
    createCCSwitchFixture(directory);
    const settings = settingsFor(readCCSwitch(directory).models[1]);
    store.set('settings', settings);
    store.saveSecrets({ modelKey: 'OLD-PLATFORM-KEY' });
    let calls = 0;
    const fetcher: typeof fetch = async (url, init) => {
      calls++;
      assert.equal(url, settings.model.endpoint);
      assert.equal(JSON.parse(String(init?.body)).model, 'fixture-alternate');
      assert.equal(new Headers(init?.headers).has('Authorization'), false);
      return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] });
    };
    assert.equal(await callModel(store, settings, 'system', 'input', 500, fetcher, directory), 'ok');
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ currentProviderCodex: 'other' }));
    await assert.rejects(callModel(store, settings, 'system', 'input', 500, fetcher, directory), /CC Switch 当前配置/);
    assert.equal(calls, 1);
    assert.equal(store.get(`modelUsage:${modelDay()}`, 0), 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('同名配置修改上游地址也使绑定失效', () => {
  const directory = mkdtempSync(join(tmpdir(), 'radar-cc-'));
  try {
    createCCSwitchFixture(directory);
    const settings = settingsFor(readCCSwitch(directory).models[0]);
    const db = new DatabaseSync(join(directory, 'cc-switch.db'));
    try {
      const row = db.prepare("SELECT settings_config FROM providers WHERE app_type='codex' AND id='default'").get()!;
      db.prepare("UPDATE providers SET settings_config=? WHERE app_type='codex' AND id='default'").run(String(row.settings_config).replace('model.test', 'other.test'));
    } finally { db.close(); }
    assert.throws(() => assertCCSwitchModel(settings, directory), /CC Switch 当前配置/);
    assertCCSwitchModel(settingsFor(readCCSwitch(directory).models[0]), directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('模型列表与保存 API 校验绑定、防伪造、清除平台旧 Key，不修改 CC Switch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'radar-cc-'));
  const store = new Store(':memory:');
  createCCSwitchFixture(directory);
  const { app } = makeApp(store, { serveStatic: false, ccSwitchDirectory: directory });
  const headers = { host: '127.0.0.1:4310', 'x-radar-client': '1' };
  try {
    const list = await app.inject({ method: 'GET', url: '/api/cc-switch/models', headers });
    assert.equal(list.statusCode, 200);
    assert.equal(list.body.includes('PRIVATE-'), false);
    const option = list.json().models.find((item: CCSwitchModel) => item.appType === 'codex' && item.providerId === 'default') as CCSwitchModel;
    const settings = settingsFor(option);
    store.saveSecrets({ modelKey: 'OLD-PLATFORM-KEY' });
    const response = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { settings } });
    assert.equal(response.statusCode, 200);
    assert.equal(store.secret('modelKey'), '');
    assert.deepEqual(store.settings().model.ccSwitch, settings.model.ccSwitch);
    for (const patch of [{ name: 'unknown' }, { endpoint: 'https://other.test/v1/responses' }, { ccSwitch: { ...settings.model.ccSwitch, providerId: 'other' } }]) {
      const rejected = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { settings: { ...settings, model: { ...settings.model, ...patch } } } });
      assert.equal(rejected.statusCode, 409);
      assert.deepEqual(store.settings(), settings);
    }
    const blocked = await app.inject({ method: 'GET', url: '/api/cc-switch/models', headers: { host: 'external.test' } });
    assert.equal(blocked.statusCode, 403);
  } finally { await app.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
