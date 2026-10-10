import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from './config.js';
import { assertLegacyCCSwitchModel } from './legacy-cc-switch.js';
import type { CCSwitchCatalog, CCSwitchModel, ModelProtocol, Settings } from '../shared/types.js';

type ResolvedModel = { option: CCSwitchModel; headers: Record<string, string> };

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === 'string' && Boolean(value.trim()))?.trim() || '';
}

function quotedSetting(source: string, key: string): string {
  const match = source.match(new RegExp(`^\\s*${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')\\s*(?:#.*)?$`, 'm'));
  if (!match) return '';
  try { return match[1].startsWith('"') ? JSON.parse(match[1]) : match[1].slice(1, -1); } catch { return ''; }
}

function protocolFor(format: string, appType: string): ModelProtocol | undefined {
  const aliases: Record<string, ModelProtocol> = {
    responses: 'responses', openai_responses: 'responses', 'openai-responses': 'responses',
    chat: 'chat', openai: 'chat', openai_chat: 'chat', 'openai-chat': 'chat', 'openai-completions': 'chat', chat_completions: 'chat',
    anthropic: 'anthropic', messages: 'anthropic', 'anthropic-messages': 'anthropic',
    gemini: 'gemini', 'gemini-native': 'gemini', 'google-generative-ai': 'gemini',
  };
  if (format) return aliases[format];
  return ({ claude: 'anthropic', 'claude-desktop': 'anthropic', codex: 'responses', grokbuild: 'responses', gemini: 'gemini' } as Record<string, ModelProtocol>)[appType];
}

function endpointFor(base: string, protocol: ModelProtocol, model: string): string {
  const url = new URL(base);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) throw new Error('Unsafe endpoint');
  const path = url.pathname.replace(/\/+$/, '');
  if (protocol === 'gemini') {
    if (path.endsWith(':generateContent')) {
      if (!path.endsWith(`/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`)) throw new Error('Model endpoint mismatch');
    } else url.pathname = `${path}${/\/v1(?:beta)?$/.test(path) ? '' : '/v1beta'}/models/${encodeURIComponent(model.replace(/^models\//, ''))}:generateContent`;
  } else {
    const suffix = protocol === 'responses' ? '/responses' : protocol === 'chat' ? '/chat/completions' : '/messages';
    if (!path.endsWith(suffix)) url.pathname = `${path}${!path || (protocol === 'anthropic' && !path.endsWith('/v1')) ? '/v1' : ''}${suffix}`;
  }
  return url.toString();
}

function configuredNames(config: Record<string, unknown>, env: Record<string, unknown>, source: string, appType: string): string[] {
  const root = source.split(/^\s*\[/m)[0];
  const nested = object(config.config);
  const main = text(config.model, object(config.model).name, quotedSetting(root, 'model'), nested.model, object(nested.model).name);
  const values: unknown[] = [];
  if (appType === 'claude' || appType === 'claude-desktop') {
    values.push(text(env.ANTHROPIC_MODEL, main));
    values.push(...Object.entries(env).filter(([key]) => /^ANTHROPIC_DEFAULT_[A-Z0-9_]+_MODEL$/.test(key)).map(([, value]) => value));
  } else values.push(main, env.GEMINI_MODEL, env.GOOGLE_GEMINI_MODEL, env.OPENAI_MODEL);
  for (const catalog of [config.models, object(config.modelCatalog).models]) {
    if (Array.isArray(catalog)) values.push(...catalog.map(entry => typeof entry === 'string' ? entry : text(object(entry).model, object(entry).id)));
    else values.push(...Object.keys(object(catalog)));
  }
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= 150 && !/[\r\n]/.test(value)).map(value => value.trim()))];
}

function loadModels(directory: string): { models: ResolvedModel[]; message: string } {
  const path = join(directory, 'cc-switch.db');
  if (!existsSync(path)) return { models: [], message: '未找到 CC Switch 本机配置，可以继续手动填写模型接口。' };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const providers = db.prepare('SELECT id, name, app_type, settings_config, meta FROM providers ORDER BY app_type, sort_index, name').all();
    const models: ResolvedModel[] = [];
    for (const provider of providers) {
      const appType = String(provider.app_type);
      let config: Record<string, unknown>;
      let meta: Record<string, unknown>;
      try { config = object(JSON.parse(String(provider.settings_config))); meta = object(JSON.parse(String(provider.meta || '{}'))); }
      catch {
        models.push({ option: { id: JSON.stringify([appType, provider.id, '']), appType, providerId: String(provider.id), providerName: String(provider.name), model: '', endpoint: '', fingerprint: '', selectable: false, reason: '配置格式损坏，请在 CC Switch 中修复' }, headers: {} });
        continue;
      }
      const source = typeof config.config === 'string' ? config.config : '';
      const root = source.split(/^\s*\[/m)[0];
      const providerKey = quotedSetting(root, 'model_provider');
      const section = source.split(/^\s*\[/m).slice(1).find(value => [`model_providers.${providerKey}`, `model_providers."${providerKey}"`, `model_providers.'${providerKey}'`].includes(value.split(']')[0]))?.split('\n').slice(1).join('\n') || '';
      const env = object(config.env);
      const options = object(config.options);
      const auth = object(config.auth);
      const format = text(meta.apiFormat, config.api, config.apiFormat, quotedSetting(section, 'wire_api'));
      const protocol = protocolFor(format, appType);
      const base = text(config.baseUrl, config.baseURL, config.base_url, options.baseURL, quotedSetting(section, 'base_url'), env.ANTHROPIC_BASE_URL, env.OPENAI_BASE_URL, env.GOOGLE_GEMINI_BASE_URL, env.GEMINI_BASE_URL,
        protocol === 'anthropic' ? 'https://api.anthropic.com' : protocol === 'gemini' ? 'https://generativelanguage.googleapis.com' : '');
      const headers: Record<string, string> = {};
      if (protocol === 'anthropic') {
        headers['anthropic-version'] = '2023-06-01';
        const bearer = text(env.ANTHROPIC_AUTH_TOKEN);
        const key = text(env.ANTHROPIC_API_KEY, config.apiKey, options.apiKey);
        if (bearer) headers.Authorization = `Bearer ${bearer}`;
        else if (key) headers['x-api-key'] = key;
      } else if (protocol === 'gemini') {
        const key = text(env.GEMINI_API_KEY, env.GOOGLE_API_KEY, config.apiKey, options.apiKey);
        if (key) headers['x-goog-api-key'] = key;
      } else {
        const key = text(config.apiKey, options.apiKey, auth.OPENAI_API_KEY, env.OPENAI_API_KEY);
        if (key) headers.Authorization = `Bearer ${key}`;
      }
      const invalidCredential = Object.values(headers).some(value => /[\r\n]|\$\{|\{env:/.test(value));
      const hasCredential = Boolean(headers.Authorization || headers['x-api-key'] || headers['x-goog-api-key']);
      const names = configuredNames(config, env, source, appType);
      for (const model of names.length ? names : ['']) {
        let endpoint = '';
        let reason = '';
        if (!model) reason = '未定义明确模型 ID；登录卡或显示名称不会被当作模型';
        else if (!protocol) reason = '该配置的接口协议暂不支持，请使用手动配置';
        else {
          try { endpoint = endpointFor(base, protocol, model); } catch { reason = '接口地址缺失或不安全，请在 CC Switch 中检查'; }
          if (!reason && invalidCredential) reason = '凭据含无效字符或未解析的环境变量引用';
          const local = endpoint && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname);
          if (!reason && !local && !hasCredential) reason = '未找到可直接调用的 API 凭据；不会复用登录会话或 OAuth Token';
        }
        const fingerprint = createHash('sha256').update(JSON.stringify(['direct-v1', appType, provider.id, model, endpoint, protocol, Object.keys(headers).sort()])).digest('hex');
        models.push({ option: { id: JSON.stringify([appType, provider.id, model]), appType, providerId: String(provider.id), providerName: String(provider.name), model, endpoint, fingerprint, protocol, selectable: !reason, reason }, headers });
      }
    }
    return { models, message: '已读取所有应用类型的已定义模型。按所选配置独立调用，不要求切换 CC Switch 当前模型；配置读取成功不代表上游已连通。' };
  } catch {
    return { models: [], message: '无法读取 CC Switch 配置，可能正在更新或版本不兼容。可刷新重试或手动配置。' };
  } finally { db?.close(); }
}

export function readCCSwitch(directory = join(homedir(), '.cc-switch')): CCSwitchCatalog {
  const result = loadModels(directory);
  return { models: result.models.map(item => item.option), message: result.message };
}

export function resolveCCSwitchModel(settings: Settings, directory = join(homedir(), '.cc-switch')): { headers: Record<string, string>; protocol?: ModelProtocol } | undefined {
  const binding = settings.model.ccSwitch;
  if (!binding) return;
  if (binding.mode !== 'direct') {
    assertLegacyCCSwitchModel(settings, directory);
    return { headers: {}, protocol: 'responses' };
  }
  const selected = loadModels(directory).models.find(item => item.option.appType === binding.appType && item.option.providerId === binding.providerId && item.option.model === settings.model.name);
  if (!selected?.option.selectable || selected.option.fingerprint !== binding.fingerprint || selected.option.endpoint !== settings.model.endpoint) {
    throw new AppError('CC Switch 所选配置已变更、删除或缺少凭据，请刷新下拉框并重新选择保存；本次未调用模型。', 409);
  }
  return { headers: selected.headers, protocol: selected.option.protocol };
}

export function assertCCSwitchModel(settings: Settings, directory?: string) {
  resolveCCSwitchModel(settings, directory);
}
