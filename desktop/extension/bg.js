// Service worker: holds the WebSocket to the local proxy and routes commands to worker tabs.
// Every Chrome profile that has this extension installed is a separate account for the proxy,
// identified by a random profileId kept in this profile's chrome.storage.local.
const DEFAULT_SERVER = 'ws://127.0.0.1:8765/ext';
const workers = new Map(); // authUser -> { port, tabId }
let ws = null;
let wsState = 'disconnected';
let retryTimer = null;
let connecting = false;
const opening = new Set(); // authUser values with a tab being created

const workerUrl = (n) => `https://aistudio.google.com/u/${n}/prompts/new_chat#ais-worker`;
const send = (obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };

async function settings() {
  const s = await chrome.storage.local.get(['server', 'profileId', 'autoJoin']);
  if (!s.profileId) {
    s.profileId = crypto.randomUUID().slice(0, 8);
    await chrome.storage.local.set({ profileId: s.profileId });
  }
  return { server: s.server || DEFAULT_SERVER, profileId: s.profileId, autoJoin: s.autoJoin !== false };
}

async function tabMap() {
  const { tabs } = await chrome.storage.session.get('tabs');
  return tabs || {};
}

async function saveTab(authUser, tabId) {
  const tabs = await tabMap();
  if (tabId === null) delete tabs[authUser];
  else tabs[authUser] = tabId;
  await chrome.storage.session.set({ tabs });
}

async function connect() {
  clearTimeout(retryTimer);
  if (connecting || (ws && (ws.readyState === 0 || ws.readyState === 1))) return;
  connecting = true;
  let sock;
  let cfg;
  try {
    cfg = await settings();
    // probe first: a refused WebSocket is reported as an extension error every retry
    const probe = await fetch(cfg.server.replace(/^ws/, 'http').replace(/\/ext$/, '/api/ping'), { cache: 'no-store' }).catch(() => null);
    if (!probe || !probe.ok) throw new Error('proxy offline');
    sock = new WebSocket(cfg.server);
  } catch (e) {
    wsState = 'disconnected';
    retryTimer = setTimeout(connect, 3000);
    return;
  } finally {
    connecting = false;
  }
  ws = sock;
  wsState = 'connecting';
  sock.onopen = () => {
    wsState = 'connected';
    send({ type: 'hello', version: chrome.runtime.getManifest().version, profileId: cfg.profileId, autoJoin: cfg.autoJoin });
    for (const [authUser] of workers) send({ type: 'worker', authUser, state: 'connected' });
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    wsState = 'disconnected';
    ws = null;
    retryTimer = setTimeout(connect, 3000);
  };
  sock.onerror = () => {};
  sock.onmessage = (e) => onServer(JSON.parse(e.data));
}

async function ensureTab(authUser) {
  if (workers.has(authUser) || opening.has(authUser)) return;
  opening.add(authUser);
  setTimeout(() => opening.delete(authUser), 20000);
  const tabs = await tabMap();
  const known = tabs[authUser];
  if (known !== undefined) {
    try {
      const t = await chrome.tabs.get(known);
      if (t && t.url && t.url.includes('aistudio.google.com')) {
        await chrome.tabs.reload(known); // content scripts reconnect after reload
        return;
      }
    } catch (e) { /* tab gone */ }
  }
  const tab = await chrome.tabs.create({ url: workerUrl(authUser), active: false, pinned: true });
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  await saveTab(authUser, tab.id);
}

async function closeWorkers() {
  const tabs = await tabMap();
  for (const [authUser, id] of Object.entries(tabs)) {
    chrome.tabs.remove(id).catch(() => {});
    await saveTab(authUser, null);
  }
}

async function onServer(msg) {
  if (msg.type === 'ping') return send({ type: 'pong' });
  if (msg.type === 'reload-ext') {
    // proxy has newer extension files on disk: reload ourselves and the worker tabs
    const tabs = await tabMap();
    setTimeout(() => {
      for (const id of Object.values(tabs)) chrome.tabs.reload(id).catch(() => {});
      chrome.runtime.reload();
    }, 200);
    return;
  }
  if (msg.type === 'ensure') {
    const { autoJoin } = await settings();
    if (autoJoin) ensureTab(0).catch((e) => send({ type: 'log', message: 'open tab failed: ' + e.message }));
    return;
  }
  if (msg.type === 'reload') {
    const tabs = await tabMap();
    const id = workers.get(msg.authUser)?.tabId ?? tabs[msg.authUser];
    // same URL apart from the #fragment would not reload the page, so force a real reload
    if (id !== undefined) chrome.tabs.update(id, { url: workerUrl(msg.authUser) }).then(() => chrome.tabs.reload(id)).catch(() => ensureTab(msg.authUser));
    else ensureTab(msg.authUser);
    return;
  }
  if (msg.type === 'show') {
    const tabs = await tabMap();
    const id = workers.get(msg.authUser)?.tabId ?? tabs[msg.authUser];
    if (id !== undefined) {
      const t = await chrome.tabs.update(id, { active: true }).catch(() => null);
      if (t) chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
    }
    return;
  }
  if (msg.type === 'cmd') {
    const w = workers.get(msg.authUser);
    if (!w) return send({ type: 'reply', id: msg.id, ok: false, error: 'worker tab not connected' });
    w.port.postMessage({ id: msg.id, cmd: msg.cmd, arg: msg.arg });
  }
}

chrome.runtime.onConnect.addListener(async (port) => {
  if (port.name !== 'ais-worker' || !port.sender?.tab) return;
  const tab = port.sender.tab;
  const m = (tab.url || '').match(/\/u\/(\d+)\//);
  const authUser = m ? Number(m[1]) : 0;
  const prev = workers.get(authUser);
  if (prev && prev.tabId !== tab.id) {
    // a duplicate worker tab for the same account: keep the existing one, close this one
    port.disconnect();
    chrome.tabs.remove(tab.id).catch(() => {});
    return;
  }
  workers.set(authUser, { port, tabId: tab.id });
  opening.delete(authUser);
  saveTab(authUser, tab.id);
  chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  port.onMessage.addListener((msg) => {
    if (msg.ev) send({ type: 'ev', authUser, ev: msg.ev });
    else send({ type: 'reply', ...msg });
  });
  port.onDisconnect.addListener(() => {
    if (workers.get(authUser)?.port === port) {
      workers.delete(authUser);
      send({ type: 'worker', authUser, state: 'gone' });
    }
  });
  connect();
  send({ type: 'worker', authUser, state: 'connected' });
});

// worker tab bounced to the Google sign-in page
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url) return;
  const tabs = await tabMap();
  const entry = Object.entries(tabs).find(([, id]) => id === tabId);
  if (entry && /accounts\.google\.com/.test(info.url)) send({ type: 'worker', authUser: Number(entry[0]), state: 'login' });
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'status') {
    settings().then((s) => reply({ ws: wsState, server: s.server, profileId: s.profileId, autoJoin: s.autoJoin, workers: [...workers.keys()] }));
    return true;
  }
  if (msg.type === 'setServer') {
    chrome.storage.local.set({ server: msg.server }).then(() => {
      if (ws) ws.close();
      ws = null;
      connect();
      reply({ ok: true });
    });
    return true;
  }
  if (msg.type === 'setAutoJoin') {
    chrome.storage.local.set({ autoJoin: !!msg.value }).then(async () => {
      if (msg.value) ensureTab(0).catch(() => {});
      else await closeWorkers();
      reply({ ok: true });
    });
    return true;
  }
  return false;
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
