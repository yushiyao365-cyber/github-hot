import type { ReactNode } from 'react';
import type { Dashboard, Repo } from '../shared/types.js';
import { activeFocus } from '../shared/focus.js';
import './focus.css';

export default function FocusFeed({ data, matches, renderCards, onDiscover, selectedTopic = 'all' }: { data: Dashboard; matches: (repo: Repo) => boolean; renderCards: (repos: Repo[]) => ReactNode; onDiscover: () => void; selectedTopic?: string }) {
  const sections = data.focusSections ?? activeFocus(data.settings).map(topic => ({ topicId: topic.id, name: topic.name, goal: topic.goal, repoIds: [], candidates: 0, reviewed: 0 }));
  return <div className="focus-feed compact-feed">
    {sections.filter(section => selectedTopic === 'all' || section.topicId === selectedTopic).map(section => {
      const repos = section.repoIds.map(id => data.repos.find(repo => repo.id === id)).filter((repo): repo is Repo => Boolean(repo)).filter(matches);
      return <section className="pool-section focus-section" data-focus={section.topicId} key={section.topicId}><div className="pool-heading"><h2>{section.name}<span className="count-pill">{repos.length}</span></h2></div>
        {repos.length ? renderCards(repos) : <div className="pool-empty"><p>{data.analysisJob.running ? '正在审核，合格项目将自动出现。' : !data.settings.model.enabled ? '启用模型后可生成专题精选。' : '暂无通过审核的项目，不凑数。'}</p><button className="text-button" onClick={onDiscover}>查看候选 →</button></div>}
      </section>;
    })}</div>;
}
