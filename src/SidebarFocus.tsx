import { Layers3 } from 'lucide-react';
import type { Settings } from '../shared/types.js';
import { activeFocus } from '../shared/focus.js';

export default function SidebarFocus({ settings, selected, onSelect }: { settings: Settings; selected: string; onSelect: (id: string) => void }) {
  return <><span className="nav-label">我的专题</span><nav aria-label="专题快捷入口">{activeFocus(settings).map(topic => <button key={topic.id} className={`nav-item topic-nav ${selected === topic.id ? 'selected' : ''}`} aria-current={selected === topic.id ? 'page' : undefined} onClick={() => onSelect(topic.id)}><Layers3 size={17} /><span>{topic.name}</span></button>)}</nav></>;
}
