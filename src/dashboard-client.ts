import type { Dashboard } from '../shared/types.js';

export function createDashboardClient(fetcher: typeof fetch = fetch) {
  let etag = '';
  let current: Dashboard | null = null;
  let active: Promise<Dashboard | null> | null = null;
  async function load() {
    const response = await fetcher('/api/dashboard', { headers: etag ? { 'If-None-Match': etag } : {}, cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (response.status === 304) {
      if (!current) throw new Error('本地数据缓存未就绪，请刷新页面');
      return current;
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '无法读取本地数据');
    current = data as Dashboard;
    etag = response.headers.get('etag') || '';
    return current;
  }
  const refresh = (afterMutation = false): Promise<Dashboard | null> => {
    if (active) return afterMutation ? active.catch(() => null).then(() => refresh(true)) : active;
    active = load().finally(() => { active = null; });
    return active;
  };
  return { refresh };
}
