// Windows document scanning for the Inventus DMS scanner module.
// Uses NAPS2.Console (bundled or installed) to drive TWAIN/WIA scanners and
// output a PDF directly. NAPS2 is the pragmatic cross-driver choice on Windows;
// this module shells out to it. If NAPS2 isn't found we surface a clear message.
//
// Scanning hardware cannot be exercised on the build machine — this needs live
// testing on a Windows box with a real scanner.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

// Resolve the NAPS2.Console executable: explicit override → bundled resource →
// common install locations → PATH.
function resolveNaps2Path(store) {
  const override = store && store.get('naps2Path');
  const candidates = [
    override,
    // Bundled via electron-builder extraResources (resources/naps2/NAPS2.Console.exe)
    process.resourcesPath && path.join(process.resourcesPath, 'naps2', 'NAPS2.Console.exe'),
    path.join(__dirname, 'vendor', 'naps2', 'NAPS2.Console.exe'),
    'C:\\Program Files\\NAPS2\\NAPS2.Console.exe',
    'C:\\Program Files (x86)\\NAPS2\\NAPS2.Console.exe',
  ].filter(Boolean);
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  return 'NAPS2.Console.exe'; // last resort: rely on PATH
}

function run(exe, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return reject(new Error('NAPS2 not found. Install NAPS2 or set its path in the scanner settings.'));
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// Best-effort device list. NAPS2 version differences make this unreliable, so a
// failure here is non-fatal — the UI falls back to "default device".
async function listDevices(store, driver = 'wia') {
  const exe = resolveNaps2Path(store);
  try {
    const { stdout } = await run(exe, ['--listdevices', '--driver', driver], 20000);
    return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// Crude page count without a PDF library: count page objects in the bytes.
function countPdfPages(buf) {
  const s = buf.toString('latin1');
  const m = s.match(/\/Type\s*\/Page[^s]/g);
  return m ? m.length : 1;
}

// Scan to a temp PDF. Returns { pdfPath, pageCount }.
async function scan(store, { driver = 'wia', device = '', source = 'glass', dpi = 200 } = {}) {
  const exe = resolveNaps2Path(store);
  const outPath = path.join(os.tmpdir(), `inv-scan-${Date.now()}.pdf`);
  const args = ['-o', outPath, '--driver', driver, '--source', source, '--dpi', String(dpi), '--force'];
  if (device) args.push('--device', device);

  const { err, stderr } = await run(exe, args);
  if (!fs.existsSync(outPath)) {
    const detail = (stderr || (err && err.message) || '').trim();
    throw new Error(detail || 'Scan produced no output. Check the scanner is on and the correct driver/source is selected.');
  }
  const buf = fs.readFileSync(outPath);
  return { pdfPath: outPath, pageCount: countPdfPages(buf), size: buf.length };
}

module.exports = { resolveNaps2Path, listDevices, scan, countPdfPages };
