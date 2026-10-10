import { createHash } from 'node:crypto';
import type { ContentItem, ContentKind } from '../shared/content.js';
import { AppError } from './config.js';
import { publicUrl } from './public-reader.js';

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', copy: '©' };
export function decodeText(value: string) {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (!name.startsWith('#')) return entities[name] ?? match;
    const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
}
export function plainText(value: string) {
  return decodeText(value.replace(/<(script|style|noscript|svg|nav|header|footer|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
interface XmlNode { name: string; attrs: Record<string, string>; parts: (string | XmlNode)[]; children: XmlNode[] }
function attrs(input: string) {
  return Object.fromEntries([...input.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(match => [match[1], decodeText(match[2] ?? match[3])]));
}
function xml(input: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(input.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g, ''))) throw new AppError('不支持含 DTD 或实体定义的订阅');
  const root: XmlNode = { name: 'root', attrs: {}, parts: [], children: [] };
  const stack = [root]; let count = 0; let consumed = 0;
  const tokens = input.matchAll(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[\w:.-]+(?:\s+(?:"[^"]*"|'[^']*'|[^'">])*)?\s*\/?>|[^<]+/g);
  for (const match of tokens) {
    if (match.index !== consumed) throw new AppError('订阅 XML 结构不完整');
    const token = match[0]; consumed += token.length;
    const current = stack.at(-1)!;
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    if (token.startsWith('<![CDATA[')) { current.parts.push(token.slice(9, -3)); continue; }
    if (token.startsWith('</')) { if (stack.length < 2 || current.name !== token.slice(2, -1).trim()) throw new AppError('订阅标签未正确闭合'); stack.pop(); continue; }
    if (token.startsWith('<')) {
      if (++count > 20000 || stack.length > 40) throw new AppError('订阅内容过大或嵌套过深');
      const name = /^<([\w:.-]+)/.exec(token)![1];
      const child: XmlNode = { name, attrs: attrs(token), parts: [], children: [] }; current.children.push(child); current.parts.push(child);
      if (!token.endsWith('/>')) stack.push(child);
    } else current.parts.push(decodeText(token));
  }
  if (consumed !== input.length || stack.length !== 1 || root.children.length !== 1) throw new AppError('来源不是完整 RSS/Atom XML');
  return root.children[0];
}
const local = (node: XmlNode) => node.name.split(':').at(-1);
const children = (node: XmlNode, name: string) => node.children.filter(child => local(child) === name);
const value = (node?: XmlNode): string => node ? node.parts.map(part => typeof part === 'string' ? part : value(part)).join(' ') : '';
const childText = (node: XmlNode, name: string) => plainText(value(children(node, name)[0]));
export function dateValue(value: string) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null; }
export function arxivId(input: string): string | null {
  try {
    const url = new URL(input);
    if (!['arxiv.org', 'export.arxiv.org', 'www.arxiv.org'].includes(url.hostname)) return null;
    return /^\/(?:abs|pdf|html)\/((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?)(?:\.pdf)?$/.exec(url.pathname)?.[1] || null;
  } catch { return null; }
}
export function canonicalContentUrl(input: string) {
  const paper = arxivId(input);
  if (paper) return `https://arxiv.org/abs/${paper.replace(/v\d+$/, '')}`;
  const url = publicUrl(input);
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/.test(key)) url.searchParams.delete(key);
  url.searchParams.sort(); return url.toString();
}
export function contentRecord(kind: ContentKind, url: string, title: string, text: string, source: string, coverage: ContentItem['coverage'], patch: Partial<ContentItem> = {}): ContentItem {
  const canonical = canonicalContentUrl(url);
  return { id: createHash('sha256').update(`${kind}:${canonical}`).digest('hex').slice(0, 32), kind, url: canonical, title: title.slice(0, 500), text: text.slice(0, 24000), source: source.slice(0, 150), coverage, authors: [], publishedAt: null, updatedAt: null, fetchedAt: new Date().toISOString(), firstSeenAt: new Date().toISOString(), version: '', publication: kind === 'paper' ? 'arXiv 预印本；录用状态未核实' : '', favorite: false, read: false, ignored: false, report: null, analysisStatus: 'pending', error: '', ...patch };
}
export function parseFeed(input: string, source: string, baseUrl: string, kind: ContentKind): ContentItem[] {
  const root = xml(input.trim());
  const atom = local(root) === 'feed';
  if (!atom && local(root) !== 'rss' && local(root) !== 'RDF') throw new AppError('来源不是 RSS/Atom 订阅');
  const container = children(root, 'channel')[0] || root;
  const items = atom ? children(root, 'entry') : [...children(container, 'item'), ...(container !== root ? children(root, 'item') : [])];
  const records: ContentItem[] = [];
  for (const entry of items.slice(0, 60)) {
    const title = childText(entry, 'title');
    const link = atom ? children(entry, 'link').find(node => (!node.attrs.rel || node.attrs.rel === 'alternate') && node.attrs.href)?.attrs.href || childText(entry, 'id') : childText(entry, 'link');
    if (!title || !link) continue;
    const raw = value(children(entry, 'encoded')[0] || children(entry, 'content')[0] || children(entry, 'summary')[0] || children(entry, 'description')[0]);
    let url: string;
    try { url = new URL(link, baseUrl).toString(); if (kind === 'paper') { if (!arxivId(url)) continue; } else publicUrl(url); } catch { continue; }
    const text = plainText(raw);
    if (!text && kind === 'paper') continue;
    records.push(contentRecord(kind, url, title, text, source, kind === 'paper' ? 'abstract' : 'feed', {
      authors: children(entry, 'author').map(node => childText(node, 'name') || plainText(value(node))).concat(children(entry, 'creator').map(node => plainText(value(node)))).slice(0, 30),
      publishedAt: dateValue(childText(entry, 'published') || childText(entry, 'pubDate') || childText(entry, 'date')),
      updatedAt: dateValue(childText(entry, 'updated')),
      version: kind === 'paper' ? /v\d+$/.exec(arxivId(url) || '')?.[0] || '' : '',
      ...(kind === 'practice' ? { feedFingerprint: createHash('sha256').update(JSON.stringify([title, text])).digest('hex') } : {}),
    }));
  }
  return records;
}
export function parseArticle(input: string, url: string, source: string): ContentItem {
  if (!/<(?:html|article|main|body)\b/i.test(input)) throw new AppError('当前只支持公开 HTML 文章，不支持此内容格式');
  const meta = [...input.matchAll(/<meta\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi)].map(match => attrs(match[0]));
  const getMeta = (name: string) => meta.find(item => item.property === name || item.name === name)?.content || '';
  const title = plainText(getMeta('og:title') || /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(input)?.[1] || '未命名文章');
  const main = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(input)?.[1] || /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(input)?.[1] || /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(input)?.[1] || '';
  const text = plainText(main);
  if (text.length < 160) throw new AppError('公开正文不足；可能需要登录、付费或动态加载，不绕过限制');
  return contentRecord('practice', url, title, text, source, 'excerpt', { publishedAt: dateValue(getMeta('article:published_time')), updatedAt: dateValue(getMeta('article:modified_time')), authors: getMeta('author') ? [getMeta('author')] : [] });
}
