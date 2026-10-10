import { repoTitle, contentTitle } from '../shared/titles.js';
import { entryKey, type RadarBoard, type RadarEntry } from '../shared/radar.js';

export default function RadarDigest({ board, onOpen }: { board: RadarBoard; onOpen: (entry: RadarEntry) => void }) {
  const leads = board.groups.filter(group => group.entries.length).map(group => ({ group, entry: group.entries[0] }));
  if (!leads.length) return null;
  return <aside className="radar-digest" aria-label="今日速览">
    <header><h2><span />今日速览</h2><span>各方向先看这一条 · 非跨模块热度排行</span></header>
    <ul>{leads.map(({ group, entry }) => <li key={entryKey(entry)}>
      <span className="digest-module" data-module={group.id}>{group.name}</span>
      <button onClick={() => onOpen(entry)}>{entry.type === 'repo' ? repoTitle(entry.repo) : contentTitle(entry.item)}</button>
      <span className="digest-action" aria-hidden="true">查看亮点 →</span>
    </li>)}</ul>
  </aside>;
}
