import { mkdirSync } from 'node:fs';
import { loadConfig, log, DATA_DIR } from './util.js';
import { Engine } from './engine.js';
import { createServer } from './server.js';
import { attachWs } from './wsserver.js';

process.on('unhandledRejection', (e) => log.error('未处理的异常: ' + (e?.stack || e)));

const cfg = loadConfig();
mkdirSync(DATA_DIR, { recursive: true });

const engine = new Engine(cfg);
const server = createServer(engine, cfg);
const listen = () => server.listen(cfg.port, cfg.host, () => {
  const base = `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${cfg.port}`;
  log.info(`AIS 反代已启动  控制面板: ${base}/`);
  log.info(`OpenAI 接口: ${base}/v1   Gemini 接口: ${base}  (v1beta)`);
});

// the extension may connect the instant the port opens, so the /ext route must exist first
await engine.init();
attachWs(server, '/ext', (conn) => engine.hub.attach(conn));
listen();

const shutdown = () => {
  engine.sigs.flush();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
