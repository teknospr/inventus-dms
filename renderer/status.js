const connDot    = document.getElementById('connDot');
const connLabel  = document.getElementById('connLabel');
const wsName     = document.getElementById('wsName');
const serverUrlEl = document.getElementById('serverUrl');
const lastCheckedEl = document.getElementById('lastChecked');
const statsAgeEl = document.getElementById('statsAge');
const checkBtn   = document.getElementById('checkBtn');
const refreshBtn = document.getElementById('refreshBtn');

const cpuVal = document.getElementById('cpuVal');
const cpuSub = document.getElementById('cpuSub');
const cpuBar = document.getElementById('cpuBar');
const ramVal = document.getElementById('ramVal');
const ramSub = document.getElementById('ramSub');
const ramBar = document.getElementById('ramBar');
const diskVal = document.getElementById('diskVal');
const diskSub = document.getElementById('diskSub');
const diskBar = document.getElementById('diskBar');
const drivesCard = document.getElementById('drivesCard');
const drivesList = document.getElementById('drivesList');

function fmt(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtBytes(bytes) {
  if (bytes >= 1e12) return (bytes / 1e12).toFixed(1) + ' TB';
  if (bytes >= 1e9)  return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes >= 1e6)  return (bytes / 1e6).toFixed(0) + ' MB';
  return bytes + ' B';
}

function barClass(pct) {
  if (pct >= 90) return 'danger';
  if (pct >= 70) return 'warn';
  return '';
}

function setBar(el, pct) {
  el.style.width = Math.min(100, pct).toFixed(1) + '%';
  el.className = 'bar-fill ' + barClass(pct);
}

function applyConnection(s) {
  wsName.textContent = s.workstationName || '—';
  serverUrlEl.textContent = s.serverUrl || '—';
  lastCheckedEl.textContent = fmt(s.lastChecked);

  connDot.className = 'conn-dot';
  if (s.checking) {
    connDot.classList.add('checking');
    connLabel.textContent = 'Checking';
    checkBtn.disabled = true;
    checkBtn.textContent = 'Checking…';
  } else if (s.online) {
    connDot.classList.add('online');
    connLabel.textContent = 'Connected';
    checkBtn.disabled = false;
    checkBtn.textContent = 'Check Server';
  } else {
    connDot.classList.add('offline');
    connLabel.textContent = 'Offline';
    checkBtn.disabled = false;
    checkBtn.textContent = 'Check Server';
  }
}

function applySystemStats(s) {
  if (!s) return;

  // CPU
  const cpu = Math.round(s.cpuLoad);
  cpuVal.textContent = cpu + '%';
  cpuSub.textContent = s.cpuModel ? s.cpuModel.split(' ').slice(-2).join(' ') : 'usage';
  setBar(cpuBar, cpu);

  // RAM
  const ramUsedGB = (s.ramUsed / 1e9).toFixed(1);
  const ramTotalGB = (s.ramTotal / 1e9).toFixed(1);
  const ramPct = Math.round((s.ramUsed / s.ramTotal) * 100);
  ramVal.textContent = ramUsedGB + ' GB';
  ramSub.textContent = `of ${ramTotalGB} GB (${ramPct}%)`;
  setBar(ramBar, ramPct);

  // Primary disk
  if (s.disks && s.disks.length > 0) {
    const primary = s.disks[0];
    const diskPct = Math.round(primary.use);
    const usedGB = (primary.used / 1e9).toFixed(0);
    const totalGB = (primary.size / 1e9).toFixed(0);
    diskVal.textContent = usedGB + ' GB';
    diskSub.textContent = `of ${totalGB} GB (${diskPct}%)`;
    setBar(diskBar, diskPct);

    // All drives
    drivesCard.style.display = s.disks.length > 1 ? '' : 'none';
    if (s.disks.length > 1) {
      drivesList.innerHTML = s.disks.map(d => `
        <div class="drive-row">
          <div class="drive-header">
            <span class="drive-mount">${d.mount || d.fs}</span>
            <span class="drive-size">${(d.used/1e9).toFixed(0)} / ${(d.size/1e9).toFixed(0)} GB</span>
          </div>
          <div class="bar-track"><div class="bar-fill ${barClass(d.use)}" style="width:${Math.min(100,d.use).toFixed(1)}%"></div></div>
        </div>`).join('');
    }
  }

  statsAgeEl.textContent = fmt(s.collectedAt);
}

// Initial load
window.addEventListener('DOMContentLoaded', async () => {
  const [conn, stats] = await Promise.all([
    window.dms.getStatus(),
    window.dms.getSystemStats(),
  ]);
  applyConnection(conn);
  applySystemStats(stats);
});

// Live updates pushed from main process
window.dms.onStatusUpdate((s) => applyConnection(s));
window.dms.onSystemStats((s) => applySystemStats(s));

// Buttons
checkBtn.addEventListener('click', async () => {
  checkBtn.disabled = true;
  const s = await window.dms.checkNow();
  applyConnection(s);
});

refreshBtn.addEventListener('click', async () => {
  refreshBtn.disabled = true;
  refreshBtn.textContent = 'Refreshing…';
  const s = await window.dms.refreshSystemStats();
  applySystemStats(s);
  refreshBtn.disabled = false;
  refreshBtn.textContent = 'Refresh Stats';
});

// ── Updates ───────────────────────────────────────────────────────────────────
const updateCard     = document.getElementById('updateCard');
const updateVersion  = document.getElementById('updateVersion');
const updateMsg      = document.getElementById('updateMsg');
const updateCheckBtn = document.getElementById('updateCheckBtn');
const updateBtn      = document.getElementById('updateBtn');

function applyUpdateState(u) {
  if (!u) return;
  updateVersion.textContent = 'Version ' + u.currentVersion;
  updateMsg.className = 'update-msg';
  updateCard.classList.toggle('has-update', u.status === 'available' || u.status === 'ready');
  updateBtn.style.display = 'none';
  updateBtn.disabled = false;
  updateCheckBtn.disabled = false;
  updateCheckBtn.textContent = 'Check for Updates';

  switch (u.status) {
    case 'checking':
      updateMsg.textContent = 'Checking for updates…';
      updateCheckBtn.disabled = true;
      updateCheckBtn.textContent = 'Checking…';
      break;
    case 'none':
      updateMsg.textContent = 'You have the latest version.' + (u.checkedAt ? ' Checked at ' + fmt(u.checkedAt) + '.' : '');
      updateMsg.classList.add('good');
      break;
    case 'available':
      updateMsg.textContent = 'Version ' + u.version + ' is available.';
      updateBtn.style.display = '';
      updateBtn.textContent = 'Update to ' + u.version;
      break;
    case 'downloading':
      updateMsg.textContent = 'Downloading version ' + (u.version || '') + '… ' + (u.percent || 0) + '%. The app restarts when it finishes.';
      updateBtn.style.display = '';
      updateBtn.disabled = true;
      updateBtn.textContent = 'Downloading ' + (u.percent || 0) + '%';
      updateCheckBtn.disabled = true;
      break;
    case 'ready':
      updateMsg.textContent = 'Version ' + u.version + ' is downloaded.';
      updateBtn.style.display = '';
      updateBtn.textContent = 'Restart and Install';
      break;
    case 'error':
      updateMsg.textContent = 'Update failed: ' + (u.error || 'unknown error');
      updateMsg.classList.add('error');
      if (u.version) { updateBtn.style.display = ''; updateBtn.textContent = 'Try Again'; }
      break;
    case 'unsupported':
      updateMsg.textContent = u.error || 'Updates are not available here.';
      updateCheckBtn.disabled = true;
      break;
    default:
      updateMsg.textContent = 'Not checked yet.';
  }
}

window.addEventListener('DOMContentLoaded', async () => applyUpdateState(await window.dms.getUpdateState()));
window.dms.onUpdateState((u) => applyUpdateState(u));

updateCheckBtn.addEventListener('click', async () => {
  updateCheckBtn.disabled = true;
  applyUpdateState(await window.dms.checkForUpdates());
});

updateBtn.addEventListener('click', async () => {
  updateBtn.disabled = true;
  applyUpdateState(await window.dms.installUpdate());
});
