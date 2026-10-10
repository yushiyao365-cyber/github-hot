import { resolve } from 'node:path';
import { Store } from './store.js';
import { makeApp } from './app.js';
import { automaticTick } from './automation.js';
import { installRadar } from './radar-config.js';

const port = Number(process.env.PORT || 4310);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT 必须是 1024–65535 的整数');
const store = new Store(resolve(process.env.RADAR_DATA_DIR || 'data'));
installRadar(store);
const { app, sync, analyses, content, captureFeatured } = makeApp(store, { port });
await app.listen({ port, host: '127.0.0.1' });
console.log(`GitHub Radar 已启动：http://127.0.0.1:${port}`);
console.log(`本地数据目录：${resolve(process.env.RADAR_DATA_DIR || 'data')}`);

function scheduled() {
  captureFeatured();
  if (!content.tick() && !content.status().running) automaticTick(store, sync, analyses);
}
const timer = setInterval(scheduled, 60_000);
setTimeout(scheduled, 1500).unref();
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(timer);
  await app.close();
  await sync.idle();
  await analyses.idle();
  await content.idle();
  store.close();
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
