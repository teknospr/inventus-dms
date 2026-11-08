const path = require('path');
const fs = require('fs');
const os = require('os');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

// ── Platform browser paths ────────────────────────────────────────────────────
function getBrowserPaths() {
  if (IS_WIN) {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const appData      = process.env.APPDATA      || path.join(os.homedir(), 'AppData', 'Roaming');
    return {
      chromium: [
        { name: 'Chrome',  path: path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Default', 'History') },
        { name: 'Edge',    path: path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Default', 'History') },
        { name: 'Brave',   path: path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default', 'History') },
        { name: 'Opera',   path: path.join(appData, 'Opera Software', 'Opera Stable', 'History') },
        { name: 'Vivaldi', path: path.join(localAppData, 'Vivaldi', 'User Data', 'Default', 'History') },
      ],
      firefoxProfilesDir: path.join(appData, 'Mozilla', 'Firefox', 'Profiles'),
    };
  }
  if (IS_MAC) {
    const sup = path.join(os.homedir(), 'Library', 'Application Support');
    return {
      chromium: [
        { name: 'Chrome',  path: path.join(sup, 'Google', 'Chrome', 'Default', 'History') },
        { name: 'Edge',    path: path.join(sup, 'Microsoft Edge', 'Default', 'History') },
        { name: 'Brave',   path: path.join(sup, 'BraveSoftware', 'Brave-Browser', 'Default', 'History') },
        { name: 'Opera',   path: path.join(sup, 'com.operasoftware.Opera', 'History') },
        { name: 'Vivaldi', path: path.join(sup, 'Vivaldi', 'Default', 'History') },
      ],
      firefoxProfilesDir: path.join(os.homedir(), 'Library', 'Application Support', 'Firefox', 'Profiles'),
    };
  }
  // Linux fallback
  const cfgDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return {
    chromium: [
      { name: 'Chrome',  path: path.join(cfgDir, 'google-chrome', 'Default', 'History') },
      { name: 'Chromium',path: path.join(cfgDir, 'chromium', 'Default', 'History') },
      { name: 'Brave',   path: path.join(cfgDir, 'BraveSoftware', 'Brave-Browser', 'Default', 'History') },
      { name: 'Vivaldi', path: path.join(cfgDir, 'vivaldi', 'Default', 'History') },
    ],
    firefoxProfilesDir: path.join(os.homedir(), '.mozilla', 'firefox'),
  };
}

// Chrome stores time as microseconds since 1601-01-01
function chromeTimeToIso(t) {
  return new Date((Number(t) - 11644473600000000) / 1000).toISOString();
}

// Firefox stores time as microseconds since Unix epoch
function foxTimeToIso(t) {
  return new Date(Number(t) / 1000).toISOString();
}

function chromeDefault24h() {
  return BigInt(Date.now()) * 1000n + 11644473600000000n - 86400000000n;
}

function foxDefault24h() {
  return BigInt(Date.now()) * 1000n - 86400000000n;
}

function getFirefoxProfilePaths(profilesDir) {
  if (!fs.existsSync(profilesDir)) return [];
  try {
    return fs.readdirSync(profilesDir)
      .filter(d => d.includes('.default'))
      .map(d => path.join(profilesDir, d, 'places.sqlite'))
      .filter(p => fs.existsSync(p));
  } catch { return []; }
}

function copyDb(src, dest) {
  fs.copyFileSync(src, dest);
  for (const ext of ['-wal', '-shm']) {
    const extra = src + ext;
    if (fs.existsSync(extra)) { try { fs.copyFileSync(extra, dest + ext); } catch {} }
  }
}

class BrowserMonitor {
  constructor(store) {
    this.store = store;
    this.SQL = null;
  }

  async _initSQL() {
    if (this.SQL) return;
    const initSqlJs = require('sql.js');
    const wasmPath = path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
    const wasmBinary = fs.readFileSync(wasmPath);
    this.SQL = await initSqlJs({ wasmBinary });
  }

  _openDb(filePath) {
    const buf = fs.readFileSync(filePath);
    return new this.SQL.Database(buf);
  }

  async collectAll() {
    await this._initSQL();
    const entries = [];
    const { chromium, firefoxProfilesDir } = getBrowserPaths();

    // Chromium browsers
    for (const browser of chromium) {
      if (!fs.existsSync(browser.path)) continue;
      const storeKey = `browserLastSeen_${browser.name}`;
      const lastSeen = BigInt(this.store.get(storeKey) || String(chromeDefault24h()));
      const tmpPath = path.join(os.tmpdir(), `inv-ch-${browser.name}.db`);

      try {
        copyDb(browser.path, tmpPath);
        const db = this._openDb(tmpPath);
        const rows = db.exec(
          `SELECT url, title, last_visit_time FROM urls WHERE last_visit_time > ${lastSeen} ORDER BY last_visit_time ASC LIMIT 500`
        );
        db.close();

        if (rows.length && rows[0].values.length) {
          let maxTime = lastSeen;
          for (const [url, title, t] of rows[0].values) {
            entries.push({ browser: browser.name, url, title: title || '', visitedAt: chromeTimeToIso(t) });
            const bigT = BigInt(t);
            if (bigT > maxTime) maxTime = bigT;
          }
          this.store.set(storeKey, String(maxTime));
        }
      } catch {
        // Browser file locked or unavailable — skip silently
      } finally {
        for (const f of [tmpPath, tmpPath + '-wal', tmpPath + '-shm']) {
          try { fs.unlinkSync(f); } catch {}
        }
      }
    }

    // Firefox
    for (const foxPath of getFirefoxProfilePaths(firefoxProfilesDir)) {
      const storeKey = 'browserLastSeen_Firefox';
      const lastSeen = BigInt(this.store.get(storeKey) || String(foxDefault24h()));
      const tmpPath = path.join(os.tmpdir(), 'inv-fox.db');

      try {
        copyDb(foxPath, tmpPath);
        const db = this._openDb(tmpPath);
        const rows = db.exec(
          `SELECT p.url, p.title, h.visit_date FROM moz_historyvisits h JOIN moz_places p ON h.place_id = p.id WHERE h.visit_date > ${lastSeen} ORDER BY h.visit_date ASC LIMIT 500`
        );
        db.close();

        if (rows.length && rows[0].values.length) {
          let maxTime = lastSeen;
          for (const [url, title, t] of rows[0].values) {
            entries.push({ browser: 'Firefox', url, title: title || '', visitedAt: foxTimeToIso(t) });
            const bigT = BigInt(t);
            if (bigT > maxTime) maxTime = bigT;
          }
          this.store.set(storeKey, String(maxTime));
        }
      } catch {
        // skip
      } finally {
        for (const f of [tmpPath, tmpPath + '-wal', tmpPath + '-shm']) {
          try { fs.unlinkSync(f); } catch {}
        }
      }

      break; // only read first Firefox profile
    }

    return entries;
  }
}

module.exports = { BrowserMonitor };
