import { Store } from '../server/store.js';
import { ContentService } from '../server/content-service.js';
import { defaultContent } from '../shared/content.js';
import { parseArticle } from '../server/content-reader.js';

const store = new Store(':memory:');
store.set('settings', { ...store.settings(), content: { ...defaultContent, enabled: true, autoAnalyze: false } });
const content = new ContentService(store);
try {
  content.start('sync'); await content.idle();
  console.log(JSON.stringify({ papers: content.items().filter(item => item.kind === 'paper').length, practices: content.items().filter(item => item.kind === 'practice').length, candidates: content.candidates().length, errors: content.status().errors }, null, 2));
  for (const kind of ['paper', 'practice'] as const) console.log(kind, content.candidates().filter(item => item.kind === kind).slice(0, 3).map(item => ({ title: item.title, source: item.source, coverage: item.coverage })));
  const practice = content.candidates().find(item => item.kind === 'practice');
  if (practice) {
    const page = await content.reader.read(practice.url);
    const article = parseArticle(page.text, page.url, practice.source);
    console.log(JSON.stringify({ excerptTitle: article.title, excerptCharacters: article.text.length, coverage: article.coverage }));
  }
  if (content.status().errors.length) process.exitCode = 1;
} finally { await content.idle(); store.close(); }
