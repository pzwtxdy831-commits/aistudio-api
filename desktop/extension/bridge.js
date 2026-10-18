// Isolated-world relay between the page script and the extension service worker.
(() => {
  const FLAG = '__ais_worker';
  let isWorker = false;
  try {
    isWorker = location.hash.includes('ais-worker') || sessionStorage.getItem(FLAG) === '1';
  } catch (e) { /* ignore */ }
  if (!isWorker) return;

  let port = null;
  const connect = () => {
    try {
      port = chrome.runtime.connect({ name: 'ais-worker' });
    } catch (e) {
      setTimeout(connect, 2000); // extension reloaded
      return;
    }
    port.onMessage.addListener((msg) => window.postMessage({ __aisIn: msg }, location.origin));
    port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 1000); });
  };
  connect();

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !e.data.__aisOut) return;
    if (port) port.postMessage(e.data.__aisOut);
  });
})();
