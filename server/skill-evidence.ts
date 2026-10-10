import { createHash } from 'node:crypto';
import type { Github } from './github.js';
import type { EvidenceSource, Repo } from '../shared/types.js';
import type { ContentItem } from '../shared/content.js';
import type { Store } from './store.js';
import { ContentStore } from './content-store.js';
import { contentRecord } from './content-reader.js';
import { AppError } from './errors.js';

export interface SkillInventory { paths: string[]; sources: EvidenceSource[]; fetchedAt: string; truncated: boolean; indexed?: boolean }
export function skillId(repoId: number, path: string) { return `skill-${createHash('sha256').update(`${repoId}:${path}`).digest('hex').slice(0, 32)}`; }
export function isSkillRepo(repo: Repo) { return /SKILL\.md|agent[- ]skills?|claude[- ]skills?|codex[- ]skills?/i.test(`${repo.fullName} ${repo.description} ${repo.readme} ${repo.topics.join(' ')}`); }

export async function readSkill(item: ContentItem, client: Github): Promise<ContentItem> {
  if (!item.skill?.active) throw new AppError('Skill 文件已不可用，保留旧报告与收藏');
  const blob = await client.get<{ content: string; encoding: string; size?: number }>(`/repos/${item.skill.repository}/git/blobs/${item.skill.sha}`, 7 * 86400000);
  if (blob.encoding !== 'base64' || typeof blob.content !== 'string' || blob.content.length > 140000 || (blob.size || 0) > 100000) throw new AppError('Skill 文件过大或编码不支持，未读取');
  const text = Buffer.from(blob.content, 'base64').toString('utf8').slice(0, 24000);
  return { ...item, text, coverage: 'excerpt', fetchedAt: new Date().toISOString() };
}

export async function collectSkills(repo: Repo, client: Github, store: Store) {
  if (!store.settings().radar?.modules.skills.enabled || !isSkillRepo(repo) || repo.archived || repo.fork || repo.ignored) return;
  const old = store.get<SkillInventory | null>(`skills:${repo.id}`, null);
  if (old?.indexed && Date.now() - Date.parse(old.fetchedAt) < 6 * 3600000) return;
  const tree = await client.get<{ truncated?: boolean; tree: { path: string; type: string; sha: string; size?: number }[] }>(`/repos/${repo.fullName}/git/trees/HEAD?recursive=1`, 6 * 3600000);
  const files = tree.tree.filter(item => item.type === 'blob' && /(^|\/)SKILL\.md$/.test(item.path) && !item.path.startsWith('/') && !item.path.split('/').some(part => part === '..') && /^[a-f0-9]{40,64}$/i.test(item.sha));
  const fetchedAt = new Date().toISOString();
  const db = new ContentStore(store);
  const existing = new Map(db.items().filter(item => item.skill?.repoId === repo.id).map(item => [item.id, item]));
  const retained = files.slice(0, 1000);
  const truncated = Boolean(tree.truncated) || files.length > retained.length;
  for (const file of retained) {
    const id = skillId(repo.id, file.path);
    const previous = existing.get(id);
    const changed = Boolean(previous?.skill && previous.skill.sha !== file.sha);
    const change = changed ? 'changed' : previous?.skill?.change || (old?.indexed && !old.truncated && !old.paths.includes(file.path) ? 'added' : 'baseline');
    const url = `${repo.url}/blob/HEAD/${file.path.split('/').map(encodeURIComponent).join('/')}`;
    const directory = file.path.split('/').slice(0, -1).join('/') || repo.fullName.split('/')[1];
    const item = contentRecord('practice', url, `${directory} · ${repo.fullName}`, changed ? '' : previous?.text || '', repo.fullName, 'excerpt', {
      id, module: 'skills', version: file.sha, publishedAt: null, updatedAt: null,
      skill: { repoId: repo.id, repository: repo.fullName, path: file.path, sha: file.sha, active: (file.size || 0) <= 100000, firstObservedAt: previous?.skill?.firstObservedAt || fetchedAt, change, observedAt: changed ? fetchedAt : previous?.skill?.observedAt || fetchedAt },
      publication: '独立 Skill 文件；仅静态阅读，不安装、不运行。新增/变更日期为本机观测时间，不是作者发布时间。',
    });
    db.upsert(item);
  }
  if (!truncated) {
    const paths = new Set(files.map(file => file.path));
    for (const item of existing.values()) if (item.skill?.active && !paths.has(item.skill.path)) db.save({ ...item, skill: { ...item.skill, active: false } });
  }
  const sources: EvidenceSource[] = [];
  for (const file of retained.filter(item => (item.size || 0) <= 100000).slice(0, 3)) {
    const item = db.item(skillId(repo.id, file.path))!;
    const hydrated = item.text ? item : await readSkill(item, client);
    if (!item.text) db.save(hydrated);
    sources.push({ id: `skill-${sources.length + 1}`, title: file.path, url: item.url, fetchedAt, text: hydrated.text.slice(0, 6000) });
  }
  store.set(`skills:${repo.id}`, { paths: retained.map(file => file.path), sources, fetchedAt, truncated, indexed: true } satisfies SkillInventory);
}
