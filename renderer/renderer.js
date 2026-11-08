const urlInput = document.getElementById('serverUrl');
const keyInput = document.getElementById('licenseKey');
const btn = document.getElementById('activateBtn');
const statusEl = document.getElementById('status');

function validate() {
  btn.disabled = keyInput.value.length !== 8;
}

keyInput.addEventListener('input', () => {
  keyInput.value = keyInput.value.replace(/[^0-9]/g, '').slice(0, 8);
  validate();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !btn.disabled) btn.click();
});

function setStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + (type || '');
}

btn.addEventListener('click', async () => {
  btn.disabled = true;
  btn.textContent = 'Activating…';
  setStatus('', '');

  const result = await window.dms.activateLicense(keyInput.value);

  if (result.success) {
    setStatus('Activated for: ' + result.workstationName, 'success');
    btn.textContent = 'Activated!';
    setTimeout(() => window.dms.goHidden(), 2000);
  } else {
    setStatus(result.error || 'Activation failed.', 'error');
    btn.textContent = 'Activate';
    validate();
  }
});

window.addEventListener('DOMContentLoaded', async () => {
  const saved = await window.dms.getSavedServerUrl();
  if (saved) urlInput.value = saved;
  keyInput.focus();
  validate();
});
