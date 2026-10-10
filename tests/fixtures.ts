import { channelIds, type Repo } from '../shared/types.js';
import { defaultSettings } from '../server/config.js';

export function fixtureRepo(id = 1, patch: Partial<Repo> = {}): Repo {
  const now = new Date().toISOString();
  const channel = channelIds[(id - 1) % 4];
  return {
    id, fullName: `test-org/project-${id}`, description: `A useful ${defaultSettings.channels[channel].topics[0]} project for developers`,
    url: `https://github.com/test-org/project-${id}`, language: 'TypeScript', stars: 1250, forks: 15,
    topics: [defaultSettings.channels[channel].topics[0]], channel, createdAt: now, pushedAt: now,
    firstSeenAt: now, fetchedAt: now, archived: false, fork: false, readme: '# Project\nPublic project documentation',
    license: 'MIT', favorite: false, followed: false, ignored: false, read: false, notes: '', baseline: false,
    releaseBaselineAt: null, summary: '', score: 75, reasons: ['匹配开发方向'], ...patch,
  };
}
export function githubFixture(id = 1) {
  const repo = fixtureRepo(id);
  return { id, full_name: repo.fullName, description: repo.description, language: repo.language, stargazers_count: repo.stars, forks_count: repo.forks, topics: repo.topics, created_at: repo.createdAt, pushed_at: repo.pushedAt, archived: false, fork: false, private: false, license: { spdx_id: 'MIT' } };
}
