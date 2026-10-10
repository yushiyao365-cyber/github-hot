import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { AppError } from './errors.js';
import { readBounded } from './github.js';

export function publicUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new AppError('请输入完整的公网 HTTPS 链接'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  url.hostname = host;
  if (input.length > 2000 || url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || isIP(host.replace(/[\[\]]/g, '')) || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|corp|onion)$/.test(host) || host.endsWith('.corp.kuaishou.com') || /(?:token|key|secret|signature|auth|password)/i.test([...url.searchParams.keys()].join(' '))) throw new AppError('内容来源只支持无凭据的公网 HTTPS 域名，不允许本机、内网或密钥链接');
  url.hash = '';
  return url;
}

export function publicIPv4(address: string) {
  if (isIP(address) !== 4) return false;
  const [first, second, third] = address.split('.').map(Number);
  return !(first === 0 || first === 10 || first === 127 || first >= 224 || first === 100 && second >= 64 && second <= 127 || first === 169 && second === 254 || first === 172 && second >= 16 && second <= 31 || first === 192 && (second === 168 || second === 0 || second === 88 && third === 99) || first === 198 && (second === 18 || second === 19 || second === 51 && third === 100) || first === 203 && second === 0 && third === 113);
}

async function pinnedRequest(url: URL, headers: Record<string, string>): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([lookup(url.hostname, { all: true, family: 4 }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new AppError('来源 DNS 解析超时')), 10000); timer.unref(); })]).finally(() => clearTimeout(timer));
  if (!addresses.length || addresses.some(item => !publicIPv4(item.address))) throw new AppError('内容地址解析到非公网地址，已拒绝访问');
  return new Promise((resolve, reject) => {
    const req = request(url, { headers, family: 4, signal: AbortSignal.timeout(20000), lookup: (_host, _options, callback) => callback(null, addresses[0].address, 4) }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 2_000_000) req.destroy(new Error('内容超过读取上限')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        const resultHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) if (value) resultHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
        const status = response.statusCode || 502;
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: resultHeaders }));
      });
    });
    req.on('error', reject); req.end();
  });
}

export class PublicReader {
  constructor(private transport?: typeof fetch) {}
  async read(input: string, headers: Record<string, string> = {}, allowPdf = false) {
    let url = publicUrl(input);
    for (let redirects = 0; redirects <= 3; redirects++) {
      const safeHeaders = { 'User-Agent': 'PersonalTechRadar/0.1 (local reading assistant)', Accept: 'application/atom+xml, application/rss+xml, application/xml, text/html, text/plain', 'Accept-Encoding': 'identity', ...headers };
      const response = this.transport ? await this.transport(url.toString(), { headers: safeHeaders, redirect: 'manual', signal: AbortSignal.timeout(20000) }) : await pinnedRequest(url, safeHeaders);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) throw new AppError('来源重定向没有目标地址');
        url = publicUrl(new URL(location, url).toString()); continue;
      }
      if (response.status === 304) return { url: url.toString(), text: '', status: 304, etag: response.headers.get('etag') || '', modified: response.headers.get('last-modified') || '' };
      if (!response.ok) { await response.body?.cancel(); throw new AppError(`内容来源返回 ${response.status}；稍后重试，不绕过访问限制`, response.status === 429 ? 429 : 502); }
      if (allowPdf && /application\/pdf/i.test(response.headers.get('content-type') || '')) {
        const { pdfExcerpt } = await import('./pdf-reader.js');
        return { url: url.toString(), text: await pdfExcerpt(response), pdf: true, status: response.status, etag: '', modified: '' };
      }
      if (/pdf|octet-stream|image\//i.test(response.headers.get('content-type') || '')) { await response.body?.cancel(); throw new AppError('来源为不支持的二进制格式；PDF 请在论文 / 白皮书模块导入'); }
      return { url: url.toString(), text: await readBounded(response, 2_000_000), status: response.status, etag: response.headers.get('etag') || '', modified: response.headers.get('last-modified') || '' };
    }
    throw new AppError('来源重定向过多，已停止');
  }
}
