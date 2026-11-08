const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const Store = require('electron-store');
const si = require('systeminformation');
const { BrowserMonitor } = require('./browser-monitor');
const { ProcessMonitor } = require('./process-monitor');
const { SipClient } = require('./sip-client');
const scanner = require('./scanner');
const fs = require('fs');
const { serverUrl: PROD_SERVER } = require('./config');
const updater = require('./updater');

const store = new Store({ name: 'inventus-dms' });

let mainWindow    = null;
let statusWindow  = null;
let captureWindow = null;
let tray          = null;
let heartbeatTimer      = null;
let statsTimer          = null;
let screenshotTimer     = null;
let browserMonitorTimer = null;
let connectionStatus = { online: false, lastChecked: null, checking: false };
let latestSystemStats = null;
let browserMonitor = null;
let processMonitor = null;
let sipClient = null;
let softphoneWindow = null;
let scannerWindow = null;
let lastScan = null; // { pdfPath, pageCount, size }
let softphoneStatus = { registered: false, extension: null, displayName: null, error: null, loggedIn: false, call: null, disabledByServer: false };

// ── Machine ID ────────────────────────────────────────────────────────────────
function getMachineId() {
  let id = store.get('machineId');
  if (!id) { id = require('crypto').randomUUID(); store.set('machineId', id); }
  return id;
}

// ── Device token ──────────────────────────────────────────────────────────────
// Each workstation gets its own token when it activates its license; the app
// carries no shared key. Installs older than 1.1.0 have a license but no token:
// they activate their own license again on start to get one.
function authHeaders() {
  return { 'x-dms-token': store.get('deviceToken') || '' };
}

let refreshingToken = null;
function refreshDeviceToken() {
  if (refreshingToken) return refreshingToken;
  refreshingToken = (async () => {
    const licenseKey = store.get('licenseKey');
    if (!licenseKey) return false;
    try {
      const res = await httpPost(`${PROD_SERVER}/api/dms/activate-license`, {},
        { licenseKey, machineId: getMachineId() });
      if (res.status === 200 && res.body.success && res.body.deviceToken) {
        store.set('deviceToken', res.body.deviceToken);
        if (res.body.workstationName) store.set('workstationName', res.body.workstationName);
        return true;
      }
      if (res.status === 404 || res.status === 409) {
        // The license was deleted or is now used by another workstation.
        console.error('[DMS] License no longer valid for this workstation:', res.body.message);
        store.delete('licenseKey');
        store.delete('deviceToken');
        if (!mainWindow) createLicenseWindow();
      }
      return false;
    } catch (err) {
      console.error('[DMS] Token refresh failed:', err.message);
      return false;
    } finally {
      // At most one refresh a minute, however many requests fail.
      setTimeout(() => { refreshingToken = null; }, 60000);
    }
  })();
  return refreshingToken;
}

// A 401 from a workstation route means the token is gone or was revoked.
function noteAuthStatus(urlString, status) {
  if (status === 401 && urlString.includes('/api/dms/') && !urlString.includes('/activate-license')) {
    refreshDeviceToken();
  }
}

// ── Tray icon ─────────────────────────────────────────────────────────────────
// The Inventus emblem with a small green (connected) or red (disconnected) dot.
// The @2x files next to these are picked up automatically on high-DPI screens.
function makeTrayIcon(online) {
  return nativeImage.createFromPath(path.join(__dirname, 'assets', online ? 'tray-online.png' : 'tray-offline.png'));
}
const APP_ICON = path.join(__dirname, 'assets', 'icon.png');

function updateTrayIcon() {
  if (!tray) return;
  tray.setImage(makeTrayIcon(connectionStatus.online));
  const ws = store.get('workstationName') || 'Unknown';
  tray.setToolTip(`Inventus DMS — ${ws} — ${connectionStatus.online ? 'Connected' : 'Disconnected'}`);
}

function updateTrayMenu() {
  if (!tray) return;
  const ws = store.get('workstationName') || 'Unknown';
  const cpu = latestSystemStats ? `CPU ${Math.round(latestSystemStats.cpuLoad)}%` : '';
  const ram = latestSystemStats
    ? `RAM ${(latestSystemStats.ramUsed/1e9).toFixed(1)}/${(latestSystemStats.ramTotal/1e9).toFixed(1)} GB`
    : '';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Inventus DMS ${app.getVersion()} — ${ws}`, enabled: false },
    { label: connectionStatus.online ? '🟢 Connected' : '🔴 Disconnected', enabled: false },
    ...(cpu ? [{ label: `📊 ${cpu}  ${ram}`, enabled: false }] : []),
    { type: 'separator' },
    ...updateMenuItems(),
    { label: 'View Dashboard', click: () => openStatusWindow() },
    { label: softphoneStatus.disabledByServer ? '📞 Softphone (using web)' : (softphoneStatus.registered ? '📞 Softphone (Registered)' : '📞 Softphone'), click: () => openSoftphoneWindow() },
    { label: '🖨️ Scan Document', click: () => openScannerWindow() },
    { type: 'separator' },
    { label: 'Exit', click: () => app.quit() },
  ]));
}

// ── Updates ──────────────────────────────────────────────────────────────────
function updateMenuItems() {
  const u = updater.getState();
  if (u.status === 'available') return [{ label: `⬆️ Update to ${u.version}`, click: () => updater.update() }, { type: 'separator' }];
  if (u.status === 'downloading') return [{ label: `⬇️ Downloading update… ${u.percent}%`, enabled: false }, { type: 'separator' }];
  if (u.status === 'ready') return [{ label: `⬆️ Restart to install ${u.version}`, click: () => updater.update() }, { type: 'separator' }];
  return [];
}

function onUpdateState(state) {
  if (statusWindow && !statusWindow.isDestroyed()) statusWindow.webContents.send('update-state', state);
  updateTrayMenu();
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpGet(urlString) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlString);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET', timeout: 8000,
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function httpPost(urlString, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlString);
    const lib = parsed.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        noteAuthStatus(urlString, res.statusCode);
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: { message: raw } }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpPostBinary(urlString, headers, buffer, contentType = 'image/png') {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlString);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': buffer.length, ...headers },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        noteAuthStatus(urlString, res.statusCode);
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: { message: raw } }); }
      });
    });
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

// ── System stats ──────────────────────────────────────────────────────────────
async function collectSystemStats() {
  try {
    const [load, mem, disks, cpu] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.cpu(),
    ]);

    // Filter to real physical drives only (exclude tmpfs, devtmpfs, etc.)
    const realDisks = disks.filter(d =>
      d.size > 0 &&
      !['tmpfs','devtmpfs','devfs','squashfs','overlay'].includes(d.type)
    );

    latestSystemStats = {
      cpuLoad:    load.currentLoad,
      cpuModel:   `${cpu.manufacturer} ${cpu.brand}`.trim(),
      cpuCores:   cpu.cores,
      ramTotal:   mem.total,
      ramUsed:    mem.active,
      ramFree:    mem.available,
      disks:      realDisks.map(d => ({
        fs:    d.fs,
        mount: d.mount,
        size:  d.size,
        used:  d.used,
        free:  d.available,
        use:   d.use,
      })),
      collectedAt: new Date().toISOString(),
    };

    pushSystemStats();
    updateTrayMenu();
    return latestSystemStats;
  } catch (err) {
    console.error('[DMS] System stats error:', err.message);
    return latestSystemStats;
  }
}

function pushSystemStats() {
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.webContents.send('system-stats', latestSystemStats);
  }
}

function startStatsTimer() {
  collectSystemStats();
  statsTimer = setInterval(collectSystemStats, 5000);
}

// ── Connection heartbeat ──────────────────────────────────────────────────────
async function checkConnection() {
  const serverUrl = store.get('serverUrl');
  if (!serverUrl) return;
  connectionStatus.checking = true;
  notifyStatusWindow();
  try {
    const code = await httpGet(`${serverUrl}/api/health`);
    connectionStatus.online = (code >= 200 && code < 500);
  } catch {
    connectionStatus.online = false;
  }
  connectionStatus.lastChecked = new Date().toISOString();
  connectionStatus.checking = false;
  updateTrayIcon();
  updateTrayMenu();
  notifyStatusWindow();
}

function notifyStatusWindow() {
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.webContents.send('status-update', {
      ...connectionStatus,
      serverUrl: store.get('serverUrl') || '',
      workstationName: store.get('workstationName') || '',
    });
  }
}

function startHeartbeat() {
  checkConnection();
  heartbeatTimer = setInterval(checkConnection, 30000);
}

// ── Screenshot capture ────────────────────────────────────────────────────────
function ensureCaptureWindow() {
  if (captureWindow && !captureWindow.isDestroyed()) return;
  captureWindow = new BrowserWindow({
    icon: APP_ICON,
    width: 1, height: 1, show: false, skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'capture-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
    },
  });
  captureWindow.loadFile(path.join(__dirname, 'renderer', 'capture.html'));
}

function captureAndUpload() {
  return new Promise((resolve, reject) => {
    const serverUrl = store.get('serverUrl');
    const machineId = getMachineId();
    if (!serverUrl) return reject(new Error('No server URL configured'));
    ensureCaptureWindow();
    const timeout = setTimeout(() => reject(new Error('Screenshot capture timed out')), 15000);
    ipcMain.once('capture-result', async (_e, result) => {
      clearTimeout(timeout);
      if (result.error) return reject(new Error(result.error));
      try {
        const pngBuffer = Buffer.from(result.pngArray);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const res = await httpPostBinary(
          `${serverUrl}/api/dms/screenshots`,
          {
            ...authHeaders(),
            'x-machine-id': machineId,
            'x-timestamp': timestamp,
            'x-workstation-name': store.get('workstationName') || machineId,
          },
          pngBuffer
        );
        resolve(res);
      } catch (err) { reject(err); }
    });
    captureWindow.webContents.send('capture-now', { width: 1920, height: 1080 });
  });
}

function startScreenshots() {
  const intervalMinutes = store.get('screenshotIntervalMinutes') || 5;
  if (screenshotTimer) clearInterval(screenshotTimer);
  screenshotTimer = setInterval(() => {
    captureAndUpload().catch(err => console.error('[DMS] Screenshot failed:', err.message));
  }, intervalMinutes * 60 * 1000);
}

function stopScreenshots() {
  if (screenshotTimer) { clearInterval(screenshotTimer); screenshotTimer = null; }
}

function applyScreenshotSettings() {
  if (store.get('screenshotsEnabled')) startScreenshots();
  else stopScreenshots();
}

// ── Browser monitoring ────────────────────────────────────────────────────────
async function runBrowserCollection() {
  const serverUrl = store.get('serverUrl');
  const machineId = getMachineId();
  if (!serverUrl || !machineId) return;
  if (!browserMonitor) browserMonitor = new BrowserMonitor(store);
  try {
    const entries = await browserMonitor.collectAll();
    if (!entries.length) return;
    await httpPost(
      `${serverUrl}/api/dms/browser-history`,
      authHeaders(),
      { machineId, workstationName: store.get('workstationName') || null, entries }
    );
  } catch (err) {
    console.error('[DMS] Browser monitor error:', err.message);
  }
}

function startBrowserMonitor() {
  const intervalSeconds = store.get('browserMonitorIntervalSeconds') || 60;
  if (browserMonitorTimer) clearInterval(browserMonitorTimer);
  runBrowserCollection();
  browserMonitorTimer = setInterval(runBrowserCollection, intervalSeconds * 1000);
}

function stopBrowserMonitor() {
  if (browserMonitorTimer) { clearInterval(browserMonitorTimer); browserMonitorTimer = null; }
}

function applyBrowserMonitorSettings() {
  if (store.get('browserMonitorEnabled')) startBrowserMonitor();
  else stopBrowserMonitor();
}

// ── Process monitoring ────────────────────────────────────────────────────────
let processMonitorTimer = null;

async function runProcessCollection() {
  const serverUrl = store.get('serverUrl');
  const machineId = getMachineId();
  if (!serverUrl || !machineId) return;
  if (!processMonitor) processMonitor = new ProcessMonitor(store);
  try {
    const events = await processMonitor.collect();
    if (!events.length) return;
    await httpPost(
      `${serverUrl}/api/dms/process-events`,
      authHeaders(),
      { machineId, workstationName: store.get('workstationName') || null, events }
    );
  } catch (err) {
    console.error('[DMS] Process monitor error:', err.message);
  }
}

function startProcessMonitor() {
  const intervalSeconds = store.get('processMonitorIntervalSeconds') || 10;
  if (processMonitorTimer) clearInterval(processMonitorTimer);
  runProcessCollection();
  processMonitorTimer = setInterval(runProcessCollection, intervalSeconds * 1000);
}

function stopProcessMonitor() {
  if (processMonitorTimer) { clearInterval(processMonitorTimer); processMonitorTimer = null; }
}

function applyProcessMonitorSettings() {
  if (store.get('processMonitorEnabled')) startProcessMonitor();
  else stopProcessMonitor();
}

// ── Softphone (UDP SIP) ─────────────────────────────────────────────────────────
function notifySoftphone() {
  if (softphoneWindow && !softphoneWindow.isDestroyed()) {
    softphoneWindow.webContents.send('softphone-status', softphoneStatus);
  }
}

// Log in against the CRM, pull this user's SIP extension/secret, then REGISTER over UDP.
async function softphoneLogin(email, password) {
  const serverUrl = store.get('serverUrl');
  if (!serverUrl) return { success: false, error: 'This workstation is not activated yet.' };
  let creds;
  try {
    const res = await httpPost(
      `${serverUrl}/api/dms/sip-credentials`,
      authHeaders(),
      { email: (email || '').trim(), password: password || '' }
    );
    if (res.status !== 200 || !res.body.success) {
      return { success: false, error: res.body.message || 'Login failed.' };
    }
    creds = res.body;
  } catch (err) {
    return { success: false, error: 'Could not reach the server.' };
  }

  // Persist for auto-reconnect (secret stays local to this machine's user store).
  store.set('softphone', {
    email: (email || '').trim(),
    extension: creds.extension,
    secret: creds.secret,
    server: creds.server,
    port: creds.port || 5060,
    domain: creds.domain,
    displayName: creds.displayName,
    webSoftphoneEnabled: !!creds.webSoftphoneEnabled,
  });
  softphoneStatus.loggedIn = true;
  softphoneStatus.extension = creds.extension;
  softphoneStatus.displayName = creds.displayName;

  // If the PBX is on WSS, the browser softphone is the active client — don't also
  // register this desktop softphone against the same extension.
  if (creds.webSoftphoneEnabled) {
    if (sipClient) { try { sipClient.stop(); } catch {} sipClient = null; }
    softphoneStatus.registered = false;
    softphoneStatus.disabledByServer = true;
    softphoneStatus.error = null;
    notifySoftphone();
    updateTrayMenu();
    return { success: true, disabled: true, extension: creds.extension, displayName: creds.displayName };
  }

  softphoneStatus.disabledByServer = false;
  try {
    await startSipRegistration(creds);
    return { success: true, extension: creds.extension, displayName: creds.displayName };
  } catch (err) {
    return { success: false, error: `Registration failed: ${err.message}` };
  }
}

function startSipRegistration(creds) {
  if (sipClient) { try { sipClient.stop(); } catch {} sipClient = null; }
  softphoneStatus.error = null;
  sipClient = new SipClient({
    extension: creds.extension,
    secret: creds.secret,
    server: creds.server,
    port: creds.port || 5060,
    domain: creds.domain,
    displayName: creds.displayName,
  });
  sipClient.on('registered', ({ expires }) => {
    softphoneStatus.registered = true;
    softphoneStatus.error = null;
    console.log(`[DMS] Softphone registered (ext ${creds.extension}, expires ${expires}s)`);
    notifySoftphone();
  });
  sipClient.on('registration-failed', (reason) => {
    softphoneStatus.registered = false;
    softphoneStatus.error = String(reason);
    console.error('[DMS] Softphone registration failed:', reason);
    notifySoftphone();
  });
  sipClient.on('error', (err) => {
    softphoneStatus.error = err.message;
    notifySoftphone();
  });
  // Call state → phone window.
  sipClient.on('call-state', (info) => {
    softphoneStatus.call = info.state === 'ended' ? null : info;
    if (softphoneWindow && !softphoneWindow.isDestroyed()) {
      softphoneWindow.webContents.send('softphone-call', info);
    }
  });
  // Decoded far-end audio (Int16 8 kHz) → renderer for playback.
  sipClient.on('audio', (pcm) => {
    if (softphoneWindow && !softphoneWindow.isDestroyed()) {
      softphoneWindow.webContents.send('softphone-audio', pcm);
    }
  });
  return sipClient.start();
}

function softphoneLogout() {
  if (sipClient) { try { sipClient.stop(); } catch {} sipClient = null; }
  store.delete('softphone');
  softphoneStatus = { registered: false, extension: null, displayName: null, error: null, loggedIn: false, call: null, disabledByServer: false };
  notifySoftphone();
}

// Re-register on app startup if the user already logged in on this machine.
function resumeSoftphone() {
  const saved = store.get('softphone');
  if (saved && saved.extension && saved.server) {
    softphoneStatus.loggedIn = true;
    softphoneStatus.extension = saved.extension;
    softphoneStatus.displayName = saved.displayName;
    // Respect the server's WSS setting captured at login — don't register if the
    // browser softphone owns this extension.
    if (saved.webSoftphoneEnabled) {
      softphoneStatus.disabledByServer = true;
      notifySoftphone();
      return;
    }
    startSipRegistration(saved).catch((err) => {
      softphoneStatus.error = err.message;
      notifySoftphone();
    });
  }
}

function openSoftphoneWindow() {
  if (softphoneWindow && !softphoneWindow.isDestroyed()) { softphoneWindow.focus(); return; }
  softphoneWindow = new BrowserWindow({
    icon: APP_ICON,
    width: 360, height: 560, resizable: false, autoHideMenuBar: true,
    title: 'Inventus DMS — Softphone', center: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  softphoneWindow.loadFile(path.join(__dirname, 'renderer', 'softphone.html'));
  softphoneWindow.on('closed', () => { softphoneWindow = null; });
  softphoneWindow.webContents.once('did-finish-load', () => notifySoftphone());
}

// ── Scanner (Windows document scanning → sale splitter) ──────────────────────────
async function scannerLogin(email, password) {
  const serverUrl = store.get('serverUrl');
  if (!serverUrl) return { success: false, error: 'This workstation is not activated yet.' };
  try {
    const res = await httpPost(`${serverUrl}/api/dms/login`, authHeaders(),
      { email: (email || '').trim(), password: password || '' });
    if (res.status !== 200 || !res.body.success) return { success: false, error: res.body.message || 'Login failed.' };
    store.set('dmsUser', { userId: res.body.userId, email: res.body.email, displayName: res.body.displayName });
    return { success: true, user: store.get('dmsUser') };
  } catch { return { success: false, error: 'Could not reach the server.' }; }
}

// Upload the most recent scan to the server inbox, tagged to the logged-in DMS user.
async function sendScanToSplitter() {
  const serverUrl = store.get('serverUrl');
  const user = store.get('dmsUser');
  if (!serverUrl) return { success: false, error: 'Not activated.' };
  if (!user) return { success: false, error: 'Sign in first.' };
  if (!lastScan || !fs.existsSync(lastScan.pdfPath)) return { success: false, error: 'Nothing scanned yet.' };
  try {
    const buf = fs.readFileSync(lastScan.pdfPath);
    const res = await httpPostBinary(
      `${serverUrl}/api/dms/scan`,
      {
        ...authHeaders(),
        'x-user-id': user.userId,
        'x-machine-id': getMachineId(),
        'x-workstation-name': store.get('workstationName') || getMachineId(),
        'x-filename': `scan-${Date.now()}.pdf`,
        'x-page-count': String(lastScan.pageCount || ''),
      },
      buf,
      'application/pdf'
    );
    if (res.status !== 200 || !res.body.success) return { success: false, error: res.body.message || 'Upload failed.' };
    try { fs.unlinkSync(lastScan.pdfPath); } catch {}
    lastScan = null;
    return { success: true };
  } catch (err) {
    return { success: false, error: 'Upload failed: ' + (err.message || err) };
  }
}

function openScannerWindow() {
  if (scannerWindow && !scannerWindow.isDestroyed()) { scannerWindow.focus(); return; }
  scannerWindow = new BrowserWindow({
    icon: APP_ICON,
    width: 400, height: 600, resizable: false, autoHideMenuBar: true,
    title: 'Inventus DMS — Scan Document', center: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  scannerWindow.loadFile(path.join(__dirname, 'renderer', 'scanner.html'));
  scannerWindow.on('closed', () => { scannerWindow = null; });
}

// ── Windows ───────────────────────────────────────────────────────────────────
function createTray() {
  if (tray) return;
  try {
    tray = new Tray(makeTrayIcon(false));
    tray.on('click', () => openStatusWindow());
    updateTrayMenu();
  } catch (e) { /* tray unavailable */ }
}

function createLicenseWindow() {
  mainWindow = new BrowserWindow({
    icon: APP_ICON,
    width: 480, height: 460, resizable: false, autoHideMenuBar: true,
    title: 'Inventus DMS — Activation', center: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; if (!store.get('licenseKey')) app.quit(); });
}

function openStatusWindow() {
  if (statusWindow && !statusWindow.isDestroyed()) { statusWindow.focus(); return; }
  statusWindow = new BrowserWindow({
    icon: APP_ICON,
    width: 460, height: 640, resizable: false, autoHideMenuBar: true,
    title: 'Inventus DMS — Dashboard', center: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  statusWindow.loadFile(path.join(__dirname, 'renderer', 'status.html'));
  statusWindow.on('closed', () => { statusWindow = null; });
  // Push current stats immediately once window is ready
  statusWindow.webContents.once('did-finish-load', () => {
    notifyStatusWindow();
    pushSystemStats();
  });
}

let backgroundStarted = false;
function goHidden() {
  if (mainWindow) { mainWindow.hide(); mainWindow = null; }
  // A workstation re-activated while running already has its timers going.
  if (backgroundStarted) return;
  backgroundStarted = true;
  createTray();
  startHeartbeat();
  startStatsTimer();
  applyScreenshotSettings();
  applyBrowserMonitorSettings();
  applyProcessMonitorSettings();
  resumeSoftphone();
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  app.on('second-instance', () => {
    if (statusWindow && !statusWindow.isDestroyed()) {
      if (statusWindow.isMinimized()) statusWindow.restore();
      statusWindow.focus();
    } else { openStatusWindow(); }
  });
}

app.whenReady().then(() => {
  // Always pin to production so a workstation can never point at a dev server.
  store.set('serverUrl', PROD_SERVER);
  updater.init(onUpdateState);
  if (store.get('licenseKey')) {
    if (!store.get('deviceToken')) refreshDeviceToken();
    goHidden();
  } else createLicenseWindow();
});

app.on('window-all-closed', () => {
  if (!tray && !store.get('licenseKey')) app.quit();
});

// ── IPC handlers ──────────────────────────────────────────────────────────────
ipcMain.handle('get-saved-server-url', () => PROD_SERVER);

ipcMain.handle('get-status', () => ({
  ...connectionStatus,
  serverUrl: store.get('serverUrl') || '',
  workstationName: store.get('workstationName') || '',
}));

ipcMain.handle('check-now', async () => {
  await checkConnection();
  return { ...connectionStatus, serverUrl: store.get('serverUrl') || '', workstationName: store.get('workstationName') || '' };
});

ipcMain.handle('get-system-stats', () => latestSystemStats);

ipcMain.handle('refresh-system-stats', () => collectSystemStats());

ipcMain.handle('get-process-monitor-settings', () => ({
  enabled: store.get('processMonitorEnabled') || false,
  intervalSeconds: store.get('processMonitorIntervalSeconds') || 10,
}));

ipcMain.handle('set-process-monitor-settings', (_e, { enabled, intervalSeconds }) => {
  store.set('processMonitorEnabled', !!enabled);
  if (intervalSeconds > 0) store.set('processMonitorIntervalSeconds', intervalSeconds);
  applyProcessMonitorSettings();
  return { enabled: store.get('processMonitorEnabled'), intervalSeconds: store.get('processMonitorIntervalSeconds') };
});

ipcMain.handle('get-browser-monitor-settings', () => ({
  enabled: store.get('browserMonitorEnabled') || false,
  intervalSeconds: store.get('browserMonitorIntervalSeconds') || 60,
}));

ipcMain.handle('set-browser-monitor-settings', (_e, { enabled, intervalSeconds }) => {
  store.set('browserMonitorEnabled', !!enabled);
  if (intervalSeconds > 0) store.set('browserMonitorIntervalSeconds', intervalSeconds);
  applyBrowserMonitorSettings();
  return { enabled: store.get('browserMonitorEnabled'), intervalSeconds: store.get('browserMonitorIntervalSeconds') };
});

ipcMain.handle('get-screenshot-settings', () => ({
  enabled: store.get('screenshotsEnabled') || false,
  intervalMinutes: store.get('screenshotIntervalMinutes') || 5,
}));

ipcMain.handle('set-screenshot-settings', (_e, { enabled, intervalMinutes }) => {
  store.set('screenshotsEnabled', !!enabled);
  if (intervalMinutes > 0) store.set('screenshotIntervalMinutes', intervalMinutes);
  applyScreenshotSettings();
  return { enabled: store.get('screenshotsEnabled'), intervalMinutes: store.get('screenshotIntervalMinutes') };
});

ipcMain.handle('activate-license', async (_e, licenseKey) => {
  const machineId = getMachineId();
  const url = PROD_SERVER; // always production; the server URL is not user-configurable
  try {
    const result = await httpPost(
      `${url}/api/dms/activate-license`,
      {},
      { licenseKey: licenseKey.trim(), machineId }
    );
    if (result.status === 200 && result.body.success) {
      store.set('licenseKey', licenseKey.trim());
      if (result.body.deviceToken) store.set('deviceToken', result.body.deviceToken);
      store.set('serverUrl', url);
      store.set('workstationName', result.body.workstationName);
      return { success: true, workstationName: result.body.workstationName };
    }
    return { success: false, error: result.body.message || 'Activation failed.' };
  } catch (err) {
    return { success: false, error: 'Could not reach the server. Check the URL and internet connection.' };
  }
});

ipcMain.on('go-hidden', () => goHidden());

// ── Update IPC ──────────────────────────────────────────────────────────────────
ipcMain.handle('update-get-state', () => updater.getState());
ipcMain.handle('update-check', () => updater.check());
ipcMain.handle('update-install', () => updater.update());

// ── Softphone IPC ───────────────────────────────────────────────────────────────
ipcMain.handle('softphone-login', (_e, { email, password }) => softphoneLogin(email, password));
ipcMain.handle('softphone-logout', () => { softphoneLogout(); return { success: true }; });
ipcMain.handle('softphone-get-status', () => softphoneStatus);
ipcMain.on('open-softphone', () => openSoftphoneWindow());

ipcMain.handle('softphone-dial', async (_e, number) => {
  if (!sipClient || !softphoneStatus.registered) return { success: false, error: 'Not registered' };
  const n = String(number || '').replace(/[^0-9*#+]/g, '');
  if (!n) return { success: false, error: 'Enter a number' };
  try { await sipClient.call(n); return { success: true }; }
  catch (err) { return { success: false, error: err.message }; }
});
ipcMain.handle('softphone-answer', () => { if (sipClient) sipClient.answer(); return { success: true }; });
ipcMain.handle('softphone-hangup', () => { if (sipClient) sipClient.hangup(); return { success: true }; });
// Mic PCM (Int16 8 kHz) from the renderer → active call's RTP sender.
ipcMain.on('softphone-mic', (_e, buf) => { if (sipClient) sipClient.sendAudio(Buffer.from(buf)); });
ipcMain.handle('softphone-mute', (_e, muted) => { if (sipClient) sipClient.setMuted(muted); return { muted: !!muted }; });
ipcMain.on('softphone-dtmf', (_e, digit) => { if (sipClient) sipClient.sendDtmf(digit); });
ipcMain.handle('softphone-hold', (_e, held) => { if (sipClient) { held ? sipClient.hold() : sipClient.unhold(); } return { held: !!held }; });
ipcMain.handle('softphone-transfer', (_e, target) => { if (sipClient) sipClient.transfer(target); return { success: true }; });

// ── Scanner IPC ─────────────────────────────────────────────────────────────────
ipcMain.on('open-scanner', () => openScannerWindow());
ipcMain.handle('scanner-get-user', () => store.get('dmsUser') || null);
ipcMain.handle('scanner-login', (_e, { email, password }) => scannerLogin(email, password));
ipcMain.handle('scanner-logout', () => { store.delete('dmsUser'); return { success: true }; });
ipcMain.handle('scanner-list-devices', (_e, driver) => scanner.listDevices(store, driver));
ipcMain.handle('scanner-scan', async (_e, opts) => {
  try {
    lastScan = await scanner.scan(store, opts || {});
    return { success: true, pageCount: lastScan.pageCount, size: lastScan.size };
  } catch (err) {
    return { success: false, error: err.message || 'Scan failed' };
  }
});
ipcMain.handle('scanner-send', () => sendScanToSplitter());
