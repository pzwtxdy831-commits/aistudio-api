import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rid = (n = 12) => randomBytes(n).toString('base64url').slice(0, n);

const LOG_LIMIT = 300;
export const logBuffer = [];

function stamp() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function write(level, args) {
  const text = args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const line = `[${stamp()}] ${level} ${text}`;
  logBuffer.push(line);
  if (logBuffer.length > LOG_LIMIT) logBuffer.shift();
  (level === 'ERR' ? console.error : console.log)(line);
}

export const log = {
  info: (...a) => write('INF', a),
  warn: (...a) => write('WRN', a),
  error: (...a) => write('ERR', a),
  debug: (...a) => process.env.AIS_DEBUG && write('DBG', a),
};

const DEFAULT_CONFIG = {
  port: 8765,
  mode: 'extension',
  rotation: 'round-robin',
  host: '127.0.0.1',
  apiKey: '',
  browserPath: '',
  debugPort: 9333,
  userDataDir: 'data/browser-profile',
  accounts: [0],
  minimizeBrowser: true,
  safetyOff: true,
  defaultThinkingLevel: 'high',
  includeThoughts: true,
  requestTimeoutSeconds: 600,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
};

export function loadConfig() {
  const file = path.join(ROOT, 'config.json');
  let user = {};
  if (existsSync(file)) {
    user = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } else {
    writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
  }
  const cfg = { ...DEFAULT_CONFIG, ...user };
  cfg.userDataDir = path.resolve(ROOT, cfg.userDataDir);
  cfg.accounts = (Array.isArray(cfg.accounts) ? cfg.accounts : [0]).map((n) => Number(n) || 0);
  return cfg;
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(data), 'utf8');
  renameSync(tmp, file);
}

// Merge a patch into config.json on disk, keeping the user's other fields.
export function saveConfig(patch) {
  const file = path.join(ROOT, 'config.json');
  const cur = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) : {};
  writeFileSync(file, JSON.stringify({ ...cur, ...patch }, null, 2), 'utf8');
}
