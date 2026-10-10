import { Store } from '../server/store.js';
import { makeApp } from '../server/app.js';
import { installRadar } from '../server/radar-config.js';
import { evidenceFor, parseAnalysis } from '../server/analyses.js';
import { contentSettings, fixtureContent, contentReply, articleText } from './content-fixtures.js';
import { fixtureRepo } from './fixtures.js';
import { analysisReply, testReadme } from './analysis-fixtures.js';
import { parseContentReport } from '../server/content-analysis.js';

export function radarFixture(store: Store, port = 4314) {
  store.set('settings', { ...contentSettings(), dailyLimit: 8 }); installRadar(store);
  const settings = store.settings();
  settings.model.autoAnalyze = false; settings.content!.autoAnalyze = false; settings.content!.autoSync = false;
  store.set('settings', settings);
  let externalCalls = 0;
  const services = makeApp(store, { port, fetcher: (async () => { externalCalls++; throw new Error('Fixture must not access network'); }) as typeof fetch });
  const descriptions = ['Apache Paimon integration test fixture', 'Agent skills test fixture with SKILL.md', 'AI workflow automation test fixture'];
  for (const [index, topic] of ['paimon', 'skills', 'workflows'].entries()) {
    const id = index + 1;
    const repo = fixtureRepo(id, { fullName: `test-only/${topic}`, description: descriptions[index], stars: 1500 + id * 100, url: `https://github.com/test-only/${topic}` });
    store.upsertRepo(repo); store.patchRepo(id, { readme: `${testReadme}\n${descriptions[index]}` });
    store.snapshot(id, repo.stars - id * 100, new Date(Date.now() - 2 * 86400000).toISOString());
    if (topic === 'skills') store.set(`skills:${id}`, { paths: ['skills/test/SKILL.md'], sources: [], fetchedAt: repo.fetchedAt, truncated: false });
    const decorated = services.analyses.decorate(store.repo(id)!);
    const sources = evidenceFor(decorated, store); const reply = analysisReply(sources); const finding = reply.capabilities[0];
    store.saveAnalysis(parseAnalysis(JSON.stringify({ ...reply, focusReview: { topicId: topic, relevance: 'direct', task: `fixture-${id}`, relationship: [finding], benefit: [finding], trial: [finding], timeliness: [] } }), decorated, settings, sources));
  }
  const papers = [fixtureContent('paper', 1), fixtureContent('paper', 2)];
  const practice = fixtureContent('practice');
  const paimon = { ...fixtureContent('practice', 2), module: 'paimon' as const, title: 'Paimon test-only release', text: `Apache Paimon test-only capability. ${articleText}` };
  for (const item of [...papers, practice, paimon]) {
    const reply = contentReply(item);
    const finalReply = item === paimon ? { ...reply, contribution: [reply.problem[0]], evidence: [reply.problem[0]] } : reply;
    item.report = parseContentReport(JSON.stringify(finalReply), item, settings); services.content.db.save(item);
  }
  services.captureFeatured();
  return { ...services, papers, practice, paimon, calls: () => externalCalls };
}
