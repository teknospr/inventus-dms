const $ = (id) => document.getElementById(id);

async function showUser() {
  const user = await window.dms.scannerGetUser();
  if (user) {
    $('loginView').classList.add('hidden');
    $('scanView').classList.remove('hidden');
    $('whoami').textContent = `Signed in as ${user.displayName || user.email}`;
    loadDevices();
  } else {
    $('loginView').classList.remove('hidden');
    $('scanView').classList.add('hidden');
  }
}

async function loadDevices() {
  try {
    const driver = $('driver').value;
    const devices = await window.dms.scannerListDevices(driver);
    const sel = $('device');
    sel.innerHTML = '<option value="">Default device</option>';
    (devices || []).forEach((d) => {
      const o = document.createElement('option');
      o.value = d; o.textContent = d; sel.appendChild(o);
    });
  } catch {}
}
$('driver').addEventListener('change', loadDevices);

$('loginBtn').addEventListener('click', async () => {
  const email = $('email').value.trim();
  const password = $('password').value;
  const s = $('loginStatus');
  if (!email || !password) { s.className = 'status error'; s.textContent = 'Enter email and password.'; return; }
  $('loginBtn').disabled = true; s.className = 'status'; s.textContent = 'Signing in…';
  try {
    const res = await window.dms.scannerLogin(email, password);
    if (res.success) { $('password').value = ''; await showUser(); }
    else { s.className = 'status error'; s.textContent = res.error || 'Login failed.'; }
  } catch (e) { s.className = 'status error'; s.textContent = e.message || 'Login failed.'; }
  finally { $('loginBtn').disabled = false; }
});
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loginBtn').click(); });

$('logoutBtn').addEventListener('click', async () => {
  await window.dms.scannerLogout();
  $('email').value = ''; $('password').value = '';
  $('scannedBox').classList.add('hidden'); $('sendBtn').classList.add('hidden');
  await showUser();
});

$('scanBtn').addEventListener('click', async () => {
  const s = $('scanStatus');
  $('scanBtn').disabled = true; s.className = 'status'; s.textContent = 'Scanning… (use the scanner if it prompts)';
  $('scannedBox').classList.add('hidden'); $('sendBtn').classList.add('hidden');
  try {
    const res = await window.dms.scannerScan({
      driver: $('driver').value,
      device: $('device').value,
      source: $('source').value,
      dpi: parseInt($('dpi').value, 10) || 200,
    });
    if (res.success) {
      s.className = 'status success'; s.textContent = 'Scan complete.';
      $('pageCount').textContent = res.pageCount || 1;
      $('scannedBox').classList.remove('hidden');
      $('sendBtn').classList.remove('hidden');
    } else {
      s.className = 'status error'; s.textContent = res.error || 'Scan failed.';
    }
  } catch (e) { s.className = 'status error'; s.textContent = e.message || 'Scan failed.'; }
  finally { $('scanBtn').disabled = false; }
});

$('sendBtn').addEventListener('click', async () => {
  const s = $('scanStatus');
  $('sendBtn').disabled = true; s.className = 'status'; s.textContent = 'Uploading…';
  try {
    const res = await window.dms.scannerSend();
    if (res.success) {
      s.className = 'status success';
      s.textContent = 'Sent. Open the sale splitter and click "Load from Scanner".';
      $('scannedBox').classList.add('hidden'); $('sendBtn').classList.add('hidden');
    } else {
      s.className = 'status error'; s.textContent = res.error || 'Upload failed.';
    }
  } catch (e) { s.className = 'status error'; s.textContent = e.message || 'Upload failed.'; }
  finally { $('sendBtn').disabled = false; }
});

showUser();
