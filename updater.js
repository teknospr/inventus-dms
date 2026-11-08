// Updates from GitHub Releases (teknospr/inventus-dms) via electron-updater.
//
// The app checks on start and every 4 hours. Nothing downloads until the user
// clicks Update (Dashboard window or tray menu); then it downloads, installs and
// restarts. Linux updates only work when running the AppImage.

const { app, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

let state = {
  status: 'idle',        // idle | checking | none | available | downloading | ready | error | unsupported
  currentVersion: app.getVersion(),
  version: null,         // newest version on GitHub, when one is available
  percent: 0,
  error: null,
  checkedAt: null,
};
let listeners = [];
let notifiedVersion = null;
let installWhenReady = false;

function set(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) { try { fn(state); } catch {} }
}

function unsupportedReason() {
  if (!app.isPackaged) return 'Updates work only in the installed app.';
  if (process.platform === 'linux' && !process.env.APPIMAGE) return 'Updates work only in the AppImage version.';
  return null;
}

function init(onChange) {
  if (onChange) listeners.push(onChange);
  const reason = unsupportedReason();
  if (reason) { set({ status: 'unsupported', error: reason }); return; }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;

  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }));
  autoUpdater.on('update-not-available', () => set({ status: 'none', version: null, checkedAt: new Date().toISOString() }));
  autoUpdater.on('update-available', (info) => {
    set({ status: 'available', version: info.version, checkedAt: new Date().toISOString() });
    if (notifiedVersion !== info.version && Notification.isSupported()) {
      notifiedVersion = info.version;
      new Notification({ title: 'Inventus DMS update available', body: `Version ${info.version} is ready. Open the Dashboard and click Update.` }).show();
    }
  });
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => {
    set({ status: 'ready', version: info.version, percent: 100 });
    if (installWhenReady) install();
  });
  autoUpdater.on('error', (err) => {
    installWhenReady = false;
    set({ status: 'error', error: (err && err.message ? err.message : String(err)).split('\n')[0].slice(0, 300) });
  });

  setTimeout(check, 10000);
  setInterval(check, CHECK_EVERY_MS);
}

async function check() {
  if (unsupportedReason()) return state;
  if (state.status === 'downloading' || state.status === 'ready') return state;
  try { await autoUpdater.checkForUpdates(); } catch { /* reported through the 'error' event */ }
  return state;
}

// The Update button: download (if needed), then install and restart.
async function update() {
  if (state.status === 'ready') { install(); return state; }
  const retry = state.status === 'error' && state.version;
  if (state.status !== 'available' && !retry) return state;
  installWhenReady = true;
  set({ status: 'downloading', percent: 0, error: null });
  try { await autoUpdater.downloadUpdate(); } catch { /* reported through the 'error' event */ }
  return state;
}

function install() {
  // Windows: silent install, then relaunch. macOS and Linux relaunch after replacing the app.
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
}

module.exports = { init, check, update, getState: () => state };
