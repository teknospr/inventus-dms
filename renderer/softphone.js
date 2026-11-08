const $ = (id) => document.getElementById(id);

let callActive = false;      // a call is on screen (dialing/ringing/connected/incoming)
let callConnected = false;
let timerInt = null;
let connectedAt = 0;

// ── Audio (Web Audio @ 8 kHz, matching G.711) ────────────────────────────────────
let capCtx = null, playCtx = null, micStream = null, capNode = null, playTime = 0;

async function startAudio() {
  if (capCtx) return;
  try {
    capCtx = new AudioContext({ sampleRate: 8000 });
    playCtx = new AudioContext({ sampleRate: 8000 });
    playTime = 0;
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const src = capCtx.createMediaStreamSource(micStream);
    capNode = capCtx.createScriptProcessor(512, 1, 1); // ~64ms chunks; RTP re-packetizes to 20ms
    capNode.onaudioprocess = (e) => {
      const f32 = e.inputBuffer.getChannelData(0);
      const i16 = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        let s = Math.max(-1, Math.min(1, f32[i]));
        i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      window.dms.softphoneSendMic(i16.buffer);
    };
    src.connect(capNode);
    capNode.connect(capCtx.destination); // output buffer left silent → no local echo
  } catch (e) {
    $('phoneError').textContent = 'Microphone unavailable: ' + (e.message || e);
  }
}

function stopAudio() {
  if (capNode) { try { capNode.disconnect(); } catch {} capNode = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  if (capCtx) { try { capCtx.close(); } catch {} capCtx = null; }
  if (playCtx) { try { playCtx.close(); } catch {} playCtx = null; }
}

// Far-end decoded PCM (Int16 LE, 8 kHz) arrives as a byte buffer over IPC.
window.dms.onSoftphoneAudio((buf) => {
  if (!playCtx) return;
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const samples = bytes.byteLength >> 1;
  const ab = playCtx.createBuffer(1, samples, 8000);
  const ch = ab.getChannelData(0);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < samples; i++) ch[i] = dv.getInt16(i * 2, true) / 32768;
  const node = playCtx.createBufferSource();
  node.buffer = ab;
  node.connect(playCtx.destination);
  const now = playCtx.currentTime;
  if (playTime < now) playTime = now + 0.06; // 60ms jitter cushion after an underrun
  node.start(playTime);
  playTime += ab.duration;
});

// ── View state ────────────────────────────────────────────────────────────────
function render(status) {
  const loggedIn = status && status.loggedIn;
  $('loginView').classList.toggle('hidden', !!loggedIn);
  $('phoneView').classList.toggle('hidden', !loggedIn);
  if (!loggedIn) return;
  $('extLabel').textContent = status.extension || '—';
  $('nameLabel').textContent = status.displayName || '';
  const dot = $('regDot'), txt = $('regText');

  // When the PBX is on WSS, this desktop softphone is disabled in favor of the
  // browser (floating) softphone. Show a clear message and hide the dialer/call UI.
  if (status.disabledByServer) {
    dot.classList.remove('on');
    txt.textContent = 'Disabled (using web softphone)';
    $('dialer').classList.add('hidden');
    $('inCall').classList.add('hidden');
    $('incomingBox').classList.add('hidden');
    $('phoneError').textContent = '';
    $('extLabel').textContent = status.extension || '—';
    $('nameLabel').innerHTML = 'This PBX uses WSS, so calls are handled by the <b>browser softphone</b> in the CRM.<br>The desktop softphone is turned off to avoid a double registration.';
    return;
  }

  if (status.registered) { dot.classList.add('on'); txt.textContent = 'Registered'; }
  else { dot.classList.remove('on'); txt.textContent = status.error ? 'Not registered' : 'Registering…'; }
  if (!callActive) $('phoneError').textContent = status.error || '';
}

function showView(which) {
  $('dialer').classList.toggle('hidden', which !== 'dialer');
  $('inCall').classList.toggle('hidden', which !== 'incall');
  $('incomingBox').classList.toggle('hidden', which !== 'incoming');
}

function startTimer() {
  connectedAt = Date.now();
  clearInterval(timerInt);
  timerInt = setInterval(() => {
    const s = Math.floor((Date.now() - connectedAt) / 1000);
    $('callTimer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
}
function stopTimer() { clearInterval(timerInt); timerInt = null; $('callTimer').textContent = ''; }

// ── Call events from main ───────────────────────────────────────────────────────
window.dms.onSoftphoneCall((info) => {
  const state = info.state;
  if (state === 'calling' || state === 'ringing') {
    callActive = true; showView('incall');
    $('callStateLabel').textContent = state === 'ringing' ? 'Ringing…' : 'Calling…';
    $('callNum').textContent = info.number || '';
    startAudio();
  } else if (state === 'incoming') {
    callActive = true; showView('incoming');
    $('incomingNum').textContent = info.number || 'Unknown';
  } else if (state === 'connected') {
    callActive = true; callConnected = true; showView('incall');
    $('callStateLabel').textContent = held ? 'Resuming…' : 'Connected';
    if (held) { held = false; $('holdBtn').classList.remove('on'); $('holdBtn').textContent = '⏸️'; }
    $('callNum').textContent = info.number || '';
    startAudio(); if (!timerInt) startTimer();
  } else if (state === 'held') {
    $('callStateLabel').textContent = 'On hold';
  } else if (state === 'transferring') {
    $('callStateLabel').textContent = `Transferring to ${info.number || ''}…`;
  } else if (state === 'ended') {
    callActive = false; callConnected = false; stopTimer(); stopAudio(); showView('dialer');
    // Reset in-call controls for the next call.
    muted = false; held = false;
    $('muteBtn').classList.remove('on'); $('muteBtn').textContent = '🎙️';
    $('holdBtn').classList.remove('on'); $('holdBtn').textContent = '⏸️';
    $('dtmfPad').classList.add('hidden'); $('padBtn').classList.remove('on');
    $('xferRow').classList.add('hidden'); $('xferBtn').classList.remove('on');
    if (info.reason) { $('phoneError').textContent = String(info.reason); setTimeout(() => { if (!callActive) $('phoneError').textContent = ''; }, 3000); }
  }
});

// ── UI wiring ───────────────────────────────────────────────────────────────────
document.querySelectorAll('.keypad button').forEach((b) => {
  b.addEventListener('click', () => { $('dialInput').value += b.textContent; });
});

$('callBtn').addEventListener('click', async () => {
  const num = $('dialInput').value.trim();
  if (!num) return;
  $('phoneError').textContent = '';
  const res = await window.dms.softphoneDial(num);
  if (!res.success) $('phoneError').textContent = res.error || 'Call failed';
});
$('dialInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('callBtn').click(); });

$('hangupBtn').addEventListener('click', () => window.dms.softphoneHangup());
$('declineBtn').addEventListener('click', () => window.dms.softphoneHangup());
$('answerBtn').addEventListener('click', () => window.dms.softphoneAnswer());

// Mute toggle.
let muted = false;
$('muteBtn').addEventListener('click', async () => {
  muted = !muted;
  await window.dms.softphoneMute(muted);
  $('muteBtn').classList.toggle('on', muted);
  $('muteBtn').textContent = muted ? '🔇' : '🎙️';
});

// In-call keypad toggle + DTMF.
$('padBtn').addEventListener('click', () => {
  const shown = $('dtmfPad').classList.toggle('hidden') === false;
  $('padBtn').classList.toggle('on', shown);
});
document.querySelectorAll('#dtmfPad button').forEach((b) => {
  b.addEventListener('click', () => window.dms.softphoneDtmf(b.textContent));
});

// Hold toggle.
let held = false;
$('holdBtn').addEventListener('click', async () => {
  held = !held;
  await window.dms.softphoneHold(held);
  $('holdBtn').classList.toggle('on', held);
  $('holdBtn').textContent = held ? '▶️' : '⏸️';
});

// Transfer (blind).
$('xferBtn').addEventListener('click', () => {
  const shown = $('xferRow').classList.toggle('hidden') === false;
  $('xferBtn').classList.toggle('on', shown);
  if (shown) $('xferInput').focus();
});
$('xferGo').addEventListener('click', () => {
  const target = $('xferInput').value.trim();
  if (target) { window.dms.softphoneTransfer(target); $('xferInput').value = ''; $('xferRow').classList.add('hidden'); }
});
$('xferInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('xferGo').click(); });

// ── Login / logout ───────────────────────────────────────────────────────────────
$('loginBtn').addEventListener('click', async () => {
  const email = $('email').value.trim();
  const password = $('password').value;
  const statusEl = $('loginStatus');
  if (!email || !password) { statusEl.className = 'status error'; statusEl.textContent = 'Enter email and password.'; return; }
  $('loginBtn').disabled = true;
  statusEl.className = 'status'; statusEl.textContent = 'Signing in…';
  try {
    const res = await window.dms.softphoneLogin(email, password);
    if (res.success) { statusEl.className = 'status success'; statusEl.textContent = 'Registered.'; $('password').value = ''; await refresh(); }
    else { statusEl.className = 'status error'; statusEl.textContent = res.error || 'Login failed.'; }
  } catch (e) { statusEl.className = 'status error'; statusEl.textContent = e.message || 'Login failed.'; }
  finally { $('loginBtn').disabled = false; }
});
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loginBtn').click(); });

$('logoutBtn').addEventListener('click', async () => {
  await window.dms.softphoneLogout();
  $('email').value = ''; $('password').value = '';
  await refresh();
});

async function refresh() { try { render(await window.dms.softphoneGetStatus()); } catch {} }
window.dms.onSoftphoneStatus((status) => render(status));
showView('dialer');
refresh();
