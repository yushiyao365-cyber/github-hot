import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createCCSwitchFixture(directory: string) {
  mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(join(directory, 'cc-switch.db'));
  db.exec(`
    CREATE TABLE providers (id TEXT, name TEXT, app_type TEXT, settings_config TEXT, meta TEXT, is_current INTEGER, sort_index INTEGER);
    CREATE TABLE proxy_config (app_type TEXT, listen_address TEXT, listen_port INTEGER, enabled INTEGER, proxy_enabled INTEGER, auto_failover_enabled INTEGER);
    INSERT INTO proxy_config VALUES ('codex','127.0.0.1',15721,1,1,0);
  `);
  const provider = db.prepare('INSERT INTO providers VALUES (?,?,?,?,?,?,?)');
  const config = {
    config: 'model = "fixture-deployment"\nmodel_provider = "fixture"\n[model_providers.fixture]\nbase_url = "https://model.test/v1"\nwire_api = "responses"',
    auth: { OPENAI_API_KEY: 'PRIVATE-CC-SWITCH-KEY' },
    modelCatalog: { models: [{ model: 'fixture-alternate' }] },
  };
  provider.run('default', 'Fixture GPT', 'codex', JSON.stringify(config), JSON.stringify({ apiFormat: 'responses', privateNote: 'PRIVATE-CC-SWITCH-META' }), 1, 0);
  provider.run('other', 'Other provider', 'codex', JSON.stringify({ ...config, modelCatalog: undefined }), '{}', 0, 1);
  provider.run('official', 'Official without model', 'codex', '{}', '{}', 0, 2);
  provider.run('default', 'Claude fixture', 'claude', JSON.stringify({ model: 'friendly-alias', env: { ANTHROPIC_MODEL: 'claude-deployment', ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-deployment', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku-deployment', ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'Friendly display name', ANTHROPIC_BASE_URL: 'https://claude.test/gateway', ANTHROPIC_AUTH_TOKEN: 'PRIVATE-CLAUDE-KEY' } }), '{}', 0, 0);
  provider.run('secondary', 'Claude secondary', 'claude', JSON.stringify({ model: 'claude-secondary', env: { ANTHROPIC_BASE_URL: 'https://second-claude.test/v1', ANTHROPIC_API_KEY: 'PRIVATE-SECOND-CLAUDE-KEY' } }), '{}', 1, 1);
  provider.run('default', 'Kimi fixture', 'openclaw', JSON.stringify({ baseUrl: 'https://kimi.test/v1', apiKey: 'PRIVATE-KIMI-KEY', api: 'openai-completions', models: [{ id: 'kimi-deployment', name: 'Kimi display' }] }), '{}', 0, 0);
  provider.run('default', 'Gemini fixture', 'gemini', JSON.stringify({ config: { model: { name: 'gemini-fixture' } }, env: { GEMINI_API_KEY: 'PRIVATE-GEMINI-KEY', GOOGLE_GEMINI_BASE_URL: 'https://gemini.test/v1beta' } }), '{}', 0, 0);
  provider.run('unsupported', 'Unknown protocol', 'custom', JSON.stringify({ model: 'custom-model', api: 'unknown', baseUrl: 'https://custom.test', apiKey: 'PRIVATE-CUSTOM-KEY' }), '{}', 0, 0);
  db.close();
  writeFileSync(join(directory, 'settings.json'), JSON.stringify({ currentProviderCodex: 'default' }));
}
