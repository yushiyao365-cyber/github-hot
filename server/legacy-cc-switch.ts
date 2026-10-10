import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from './config.js';
import type { CCSwitchCatalog, CCSwitchModel, Settings } from '../shared/types.js';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function quotedSetting(source: string, key: string): string {
  const match = source.match(new RegExp(`^\\s*${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')\\s*(?:#.*)?$`, 'm'));
  if (!match) return '';
  try { return match[1].startsWith('"') ? JSON.parse(match[1]) : match[1].slice(1, -1); } catch { return ''; }
}

export function readLegacyCCSwitch(directory = join(homedir(), '.cc-switch')): CCSwitchCatalog {
  const path = join(directory, 'cc-switch.db');
  if (!existsSync(path)) return { models: [], message: '未找到 CC Switch 本机配置，可以继续手动填写模型接口。' };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const proxy = db.prepare("SELECT listen_address, listen_port, enabled, proxy_enabled, auto_failover_enabled FROM proxy_config WHERE app_type='codex'").get();
    const settingsPath = join(directory, 'settings.json');
    const local = existsSync(settingsPath) ? object(JSON.parse(readFileSync(settingsPath, 'utf8'))) : {};
    const providers = db.prepare("SELECT id, name, settings_config, meta, is_current FROM providers WHERE app_type='codex' ORDER BY is_current DESC, sort_index, name").all();
    const active = providers.filter(provider => provider.is_current === 1);
    const currentId = active.length === 1 ? String(active[0].id) : '';
    const selectionKnown = Boolean(currentId) && (!local.currentProviderCodex || local.currentProviderCodex === currentId);
    const address = String(proxy?.listen_address || '');
    const host = ['0.0.0.0', '127.0.0.1', 'localhost'].includes(address) ? '127.0.0.1' : ['::', '::1', '[::1]'].includes(address) ? '[::1]' : '';
    const port = Number(proxy?.listen_port);
    const endpoint = host && Number.isInteger(port) && port > 0 && port <= 65535 ? `http://${host}:${port}/v1/responses` : '';
    const models: CCSwitchModel[] = [];
    for (const provider of providers) {
      let config: Record<string, unknown>;
      let meta: Record<string, unknown>;
      try { config = object(JSON.parse(String(provider.settings_config))); meta = object(JSON.parse(String(provider.meta || '{}'))); } catch { continue; }
      const source = typeof config.config === 'string' ? config.config : '';
      const root = source.split(/^\s*\[/m)[0];
      const configuredModel = typeof config.model === 'string' ? config.model : quotedSetting(root, 'model');
      const providerKey = quotedSetting(root, 'model_provider');
      const sections = source.split(/^\s*\[/m).slice(1);
      const section = sections.find(value => [`model_providers.${providerKey}`, `model_providers."${providerKey}"`, `model_providers.'${providerKey}'`].includes(value.split(']')[0]))?.split('\n').slice(1).join('\n') || '';
      const catalog = object(config.modelCatalog).models;
      const names = [...new Set([configuredModel, ...(Array.isArray(catalog) ? catalog.map(entry => object(entry).model) : [])].filter((name): name is string => typeof name === 'string' && Boolean(name.trim()) && name.length <= 150).map(name => name.trim()))];
      const fingerprint = createHash('sha256').update(JSON.stringify([provider.id, endpoint, providerKey, quotedSetting(section, 'base_url'), quotedSetting(section, 'wire_api'), meta.apiFormat, names])).digest('hex');
      let reason = '';
      if (!names.length) reason = '未配置明确的模型 ID，请先在 CC Switch 中配置';
      else if (!selectionKnown) reason = '无法确认 CC Switch 当前配置，请在 CC Switch 中确认后刷新';
      else if (provider.id !== currentId) reason = '请先在 CC Switch 的 Codex 页切换到此配置，再刷新';
      else if (!endpoint || !proxy?.enabled || !proxy?.proxy_enabled) reason = '请先开启 CC Switch 的 Codex 本机代理';
      else if (proxy.auto_failover_enabled) reason = '请先关闭 CC Switch 自动故障转移，避免实际模型与所选配置不一致';
      for (const model of names.length ? names : ['']) models.push({ id: JSON.stringify([provider.id, model]), providerId: String(provider.id), providerName: String(provider.name), model, endpoint, fingerprint, selectable: !reason, reason });
    }
    return { models, message: '仅列出 Codex 代理配置；非当前配置需先在 CC Switch 切换。读取配置不代表已验证服务连通。' };
  } catch {
    return { models: [], message: '无法读取 CC Switch 配置，可能正在更新或版本不兼容。可刷新重试或手动配置。' };
  } finally { db?.close(); }
}

export function assertLegacyCCSwitchModel(settings: Settings, directory?: string) {
  const binding = settings.model.ccSwitch;
  if (!binding) return;
  const option = readLegacyCCSwitch(directory).models.find(model => model.providerId === binding.providerId && model.model === settings.model.name);
  if (!option?.selectable || option.fingerprint !== binding.fingerprint || option.endpoint !== settings.model.endpoint) {
    throw new AppError('CC Switch 当前配置与所选模型不一致或代理已关闭。请刷新模型下拉框，重新选择并保存；本次未调用模型。', 409);
  }
}
