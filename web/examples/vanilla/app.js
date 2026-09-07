// A complete two-person call screen on the SDK. The credential comes from the example backend,
// which is the only place that knows the Qencode API key.
import { Call } from '/dist/qencode-calls.esm.bundle.js';   // self-contained build; the npm ESM build expects a bundler

const $ = (id) => document.getElementById(id);
let call = null;

function setStatus(text, cls = '') { $('status').textContent = text; $('status').className = 'status ' + cls; }
function setJoined(joined) {
  for (const id of ['leave', 'mic', 'cam', 'profile', 'mode', 'camera', 'micdev', 'send']) $(id).disabled = !joined;
  $('join').disabled = joined; $('who').disabled = joined;
}

async function fillDevices() {
  const list = await call.devices.list();
  for (const [id, items] of [['camera', list.cameras], ['micdev', list.microphones]]) {
    const sel = $(id); sel.innerHTML = '';
    items.forEach((d) => { const o = document.createElement('option'); o.value = d.id; o.textContent = d.label; sel.appendChild(o); });
  }
}

function renderStats(s) {
  const rows = [
    ['latency est.', s.estimatedLatencyMs, 'ms'], ['rtt', s.recv.rttMs, 'ms'], ['peer rtt', s.peerRttMs, 'ms'],
    ['jitter buffer', s.recv.jitterBufferMs, 'ms'], ['decode', s.recv.decodeMs, 'ms'], ['encode', s.send.encodeMs, 'ms'],
    ['recv', s.recv.width && `${s.recv.width}×${s.recv.height} @ ${s.recv.fps ?? '--'}`, ''], ['recv kbps', s.recv.kbps, ''], ['send kbps', s.send.kbps, ''],
    ['loss', s.recv.lossPct, '%'], ['freezes', s.recv.freezes, ''], ['transport', s.recv.transport, ''], ['codec', s.recv.codec, ''],
    ['region', s.region, ''], ['join', s.joinMs, 'ms'],
  ];
  $('stats').innerHTML = rows.map(([k, v, u]) => `<tr><td>${k}</td><td class="v">${v ?? '--'}${v != null && u ? ' ' + u : ''}</td></tr>`).join('');
}

$('join').onclick = async () => {
  const who = $('who').value;
  setStatus('fetching credential');
  const cred = await fetch(`/api/calls/join?as=${encodeURIComponent(who)}`).then((r) => r.json());
  if (cred.error) { setStatus('backend: ' + cred.error, 'q-poor'); return; }
  call = Call.create(cred, { videoProfile: $('profile').value, latencyMode: $('mode').value });

  call.on('stateChanged', (state, reason) => { setStatus(reason ? `${state} (${reason})` : state); if (state === 'ended') { setJoined(false); $('remote').track = null; $('self').track = null; } });
  call.on('remoteVideo', (t) => { $('remote').track = t; });
  call.on('peerJoined', (p) => setStatus(`connected with ${p.identity}`, 'q-good'));
  call.on('peerLeft', (p) => setStatus(`${p.identity} left`));
  call.on('peerMuted', (kind, muted) => setStatus(`peer ${kind} ${muted ? 'muted' : 'unmuted'}`));
  call.on('qualityChanged', (q, dir) => { if (dir === 'recv') $('status').className = 'status q-' + q; });
  call.on('stats', renderStats);
  call.on('message', (payload) => { $('inbox').textContent = 'peer: ' + (typeof payload === 'string' ? payload : JSON.stringify(payload)); });
  call.on('credentialExpiring', async () => { call.updateCredential(await fetch(`/api/calls/join?as=${encodeURIComponent(who)}`).then((r) => r.json())); });
  call.on('error', (e) => console.warn('call error', e.code, e.message));

  try {
    await call.connect();
    $('self').track = call.localVideo;
    setJoined(true);
    await fillDevices();
  } catch (e) {
    setStatus(`${e.code}: ${e.message}`, 'q-poor');
  }
};

$('leave').onclick = () => call?.leave();
$('mic').onclick = async () => { const on = $('mic').classList.toggle('on'); await call.setMicrophoneEnabled(!on); $('mic').textContent = on ? 'Unmute mic' : 'Mute mic'; };
$('cam').onclick = async () => { const off = $('cam').classList.toggle('on'); await call.setCameraEnabled(!off); $('cam').textContent = off ? 'Camera on' : 'Camera off'; };
$('profile').onchange = () => call?.setVideoProfile($('profile').value);
$('mode').onchange = () => call?.setLatencyMode($('mode').value);
$('camera').onchange = () => call?.devices.setCamera($('camera').value);
$('micdev').onchange = () => call?.devices.setMicrophone($('micdev').value);
$('send').onclick = () => { const t = $('msg').value.trim(); if (t) { call.sendMessage(t); $('msg').value = ''; } };
