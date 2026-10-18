const $ = (id) => document.getElementById(id);
const NAMES = { connected: '已连接', connecting: '连接中', disconnected: '未连接（反代没开？）' };
function refresh() {
  chrome.runtime.sendMessage({ type: 'status' }, (s) => {
    if (!s) return;
    $('ws').textContent = NAMES[s.ws] || s.ws;
    $('ws').className = s.ws === 'connected' ? 'ok' : 'bad';
    $('workers').textContent = s.workers.length ? s.workers.map((n) => 'u/' + n).join(', ') : '无';
    $('pid').textContent = s.profileId;
    $('join').checked = s.autoJoin;
    if (document.activeElement !== $('server')) $('server').value = s.server;
  });
}
$('save').onclick = () => chrome.runtime.sendMessage({ type: 'setServer', server: $('server').value.trim() }, refresh);
$('join').onchange = () => chrome.runtime.sendMessage({ type: 'setAutoJoin', value: $('join').checked }, refresh);
refresh();
setInterval(refresh, 1500);
