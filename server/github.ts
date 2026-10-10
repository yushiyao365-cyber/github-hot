import { AppError } from './errors.js';
import type { Repo, Release } from '../shared/types.js';
import { createHash } from 'node:crypto';
import type { Store } from './store.js';

interface CachedResponse { checkedAt: number; etag: string; modified: string; value: unknown }

export async function readBounded(response: Response, maxBytes = 2_000_000): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.length;
      if (size > maxBytes) throw new AppError('远程响应过大，已停止读取', 502);
      chunks.push(result.value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString('utf8');
}

export class GithubError extends AppError {
  constructor(message: string, public retryAt: string | null = null, status = 502) { super(message, status); }
}

export class Github {
  constructor(private token: string, private onRequest: () => void = () => {}, private fetcher: typeof fetch = fetch, private store?: Store) {}
  async get<Type>(path: string, maxAgeMs = 0): Promise<Type> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new AppError('无效的 GitHub 请求路径');
    const key = `githubHttp:${createHash('sha256').update(JSON.stringify([this.token, path])).digest('hex')}`;
    const cached = this.store?.get<CachedResponse | null>(key, null);
    if (cached && maxAgeMs > 0 && Date.now() - cached.checkedAt < maxAgeMs) return structuredClone(cached.value) as Type;
    this.onRequest();
    let response: Response;
    try {
      response = await this.fetcher(`https://api.github.com${path}`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'github-radar-local', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(cached?.etag ? { 'If-None-Match': cached.etag } : cached?.modified ? { 'If-Modified-Since': cached.modified } : {}) },
        signal: AbortSignal.timeout(20_000), redirect: 'error',
      });
    } catch { throw new GithubError('无法连接 GitHub，请检查网络或稍后重试；已缓存数据不受影响'); }
    const resource = response.headers.get('x-ratelimit-resource') || (path.startsWith('/search/') ? 'search' : 'core');
    if (response.headers.has('x-ratelimit-remaining')) this.store?.set(`githubRate:${resource}`, {
      resource, remaining: Number(response.headers.get('x-ratelimit-remaining')), limit: Number(response.headers.get('x-ratelimit-limit')),
      resetAt: Number(response.headers.get('x-ratelimit-reset')) * 1000, observedAt: Date.now(),
    });
    if (response.status === 304 && cached) {
      await response.body?.cancel();
      this.store?.set(key, { ...cached, checkedAt: Date.now() });
      return structuredClone(cached.value) as Type;
    }
    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after');
      if (response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || retryAfter))) {
        const seconds = retryAfter ? Number(retryAfter) : 0;
        const reset = Number(response.headers.get('x-ratelimit-reset'));
        const time = retryAfter ? (Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(retryAfter)) : reset * 1000;
        const retryAt = new Date(Number.isFinite(time) && time > Date.now() ? time : Date.now() + 60_000).toISOString();
        await response.body?.cancel();
        throw new GithubError(`GitHub 资料采集受限，可在 ${new Date(retryAt).toLocaleString('zh-CN')} 后重试；已有缓存仍可用于分析`, retryAt, 429);
      }
      await response.body?.cancel();
      if (response.status === 401) throw new GithubError('GitHub Token 无效或已过期，请在设置中更新', null, 401);
      if (response.status === 403) throw new GithubError('GitHub 暂时拒绝请求（权限或访问频率限制），请稍后重试', new Date(Date.now() + 60_000).toISOString(), 403);
      if (response.status === 404) throw new GithubError('仓库或资料不存在，或当前无法公开访问', null, 404);
      throw new GithubError(`GitHub 返回 ${response.status}，本轮请求未完成`);
    }
    try {
      const value = JSON.parse(await readBounded(response)) as Type;
      if (this.store) {
        this.store.set(key, { value, checkedAt: Date.now(), etag: response.headers.get('etag') || '', modified: response.headers.get('last-modified') || '' });
        this.store.db.prepare("DELETE FROM kv WHERE key LIKE 'githubHttp:%' AND json_extract(value, '$.checkedAt') < ?").run(Date.now() - 7 * 86400000);
      }
      return value;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new GithubError('GitHub 响应无法解析，本地数据未被覆盖');
    }
  }
}

export interface GithubRepo {
  id: number; full_name: string; description: string | null; language: string | null;
  stargazers_count: number; forks_count: number; topics?: string[]; created_at: string;
  pushed_at: string; archived: boolean; fork: boolean; private: boolean; license?: { spdx_id?: string } | null;
}
export interface GithubRelease { id: number; tag_name: string; name: string | null; body: string | null; published_at: string | null; prerelease: boolean; draft: boolean; html_url: string }

export function mapRepo(value: GithubRepo): Partial<Repo> & { id: number } {
  if (!Number.isSafeInteger(value.id) || typeof value.full_name !== 'string' || value.private) throw new AppError('只支持公开 GitHub 仓库');
  return { id: value.id, fullName: value.full_name, description: value.description || '', url: `https://github.com/${value.full_name}`, language: value.language || '', stars: value.stargazers_count, forks: value.forks_count, topics: value.topics || [], channel: 'devtools', createdAt: value.created_at, pushedAt: value.pushed_at, fetchedAt: new Date().toISOString(), archived: value.archived, fork: value.fork, license: value.license?.spdx_id || '' };
}
export function mapRelease(value: GithubRelease, repoId: number): Partial<Release> & { id: number; repoId: number } {
  return { id: value.id, repoId, tag: value.tag_name, name: value.name || value.tag_name, body: (value.body || '').slice(0, 30000), url: value.html_url.startsWith('https://github.com/') ? value.html_url : '', publishedAt: value.published_at || '', prerelease: value.prerelease };
}
