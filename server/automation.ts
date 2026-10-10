import type { Store } from './store.js';
import type { SyncService } from './sync.js';
import type { Analyses } from './analyses.js';

export function automaticTick(store: Store, sync: SyncService, analyses: Analyses, now = Date.now()) {
  const status = store.status();
  if (status.running || analyses.status().running) return;
  const limited = status.retryAt && Date.parse(status.retryAt) > now;
  const recentlyTried = status.lastAttemptAt && now - Date.parse(status.lastAttemptAt) < 30 * 60_000;
  if (!limited && !recentlyTried) {
    const discoveryDue = store.secret('githubToken') && (!status.lastDiscoveryAt || now - Date.parse(status.lastDiscoveryAt) >= 6 * 3600000);
    const releasesDue = store.repos().some(repo => repo.followed) && (!status.lastReleasesAt || now - Date.parse(status.lastReleasesAt) >= 6 * 3600000);
    if (discoveryDue || releasesDue) {
      try { if (sync.start(discoveryDue ? 'all' : 'releases')) return; } catch { }
    }
  }
  try { analyses.autoStart(); } catch { }
}
