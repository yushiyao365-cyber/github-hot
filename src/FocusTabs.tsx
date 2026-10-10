import { activeFocus } from '../shared/focus.js';
import type { Settings } from '../shared/types.js';

export default function FocusTabs({ settings, value, onChange }: { settings: Settings; value: string; onChange: (value: string) => void }) {
  return <div className="tabs"><button className={value === 'all' ? 'selected' : ''} onClick={() => onChange('all')}>全部专题</button>{activeFocus(settings).map(topic => <button key={topic.id} className={value === topic.id ? 'selected' : ''} onClick={() => onChange(topic.id)}>{topic.name}</button>)}</div>;
}
