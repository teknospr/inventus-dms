const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dms', {
  getSavedServerUrl:      ()         => ipcRenderer.invoke('get-saved-server-url'),
  activateLicense:        (key, url) => ipcRenderer.invoke('activate-license', key, url),
  goHidden:               ()         => ipcRenderer.send('go-hidden'),

  getUpdateState:         ()         => ipcRenderer.invoke('update-get-state'),
  checkForUpdates:        ()         => ipcRenderer.invoke('update-check'),
  installUpdate:          ()         => ipcRenderer.invoke('update-install'),
  onUpdateState:          (cb)       => ipcRenderer.on('update-state', (_e, d) => cb(d)),

  getStatus:              ()         => ipcRenderer.invoke('get-status'),
  checkNow:               ()         => ipcRenderer.invoke('check-now'),
  onStatusUpdate:         (cb)       => ipcRenderer.on('status-update', (_e, d) => cb(d)),

  getSystemStats:         ()         => ipcRenderer.invoke('get-system-stats'),
  refreshSystemStats:     ()         => ipcRenderer.invoke('refresh-system-stats'),
  onSystemStats:          (cb)       => ipcRenderer.on('system-stats', (_e, d) => cb(d)),

  getScreenshotSettings:      ()  => ipcRenderer.invoke('get-screenshot-settings'),
  setScreenshotSettings:      (s) => ipcRenderer.invoke('set-screenshot-settings', s),
  getBrowserMonitorSettings:   ()  => ipcRenderer.invoke('get-browser-monitor-settings'),
  setBrowserMonitorSettings:   (s) => ipcRenderer.invoke('set-browser-monitor-settings', s),
  getProcessMonitorSettings:   ()  => ipcRenderer.invoke('get-process-monitor-settings'),
  setProcessMonitorSettings:   (s) => ipcRenderer.invoke('set-process-monitor-settings', s),

  softphoneLogin:        (email, password) => ipcRenderer.invoke('softphone-login', { email, password }),
  softphoneLogout:       ()                => ipcRenderer.invoke('softphone-logout'),
  softphoneGetStatus:    ()                => ipcRenderer.invoke('softphone-get-status'),
  openSoftphone:         ()                => ipcRenderer.send('open-softphone'),
  onSoftphoneStatus:     (cb)              => ipcRenderer.on('softphone-status', (_e, d) => cb(d)),

  softphoneDial:         (number)          => ipcRenderer.invoke('softphone-dial', number),
  softphoneAnswer:       ()                => ipcRenderer.invoke('softphone-answer'),
  softphoneHangup:       ()                => ipcRenderer.invoke('softphone-hangup'),
  softphoneSendMic:      (buf)             => ipcRenderer.send('softphone-mic', buf),
  softphoneMute:         (muted)           => ipcRenderer.invoke('softphone-mute', muted),
  softphoneDtmf:         (digit)           => ipcRenderer.send('softphone-dtmf', digit),
  softphoneHold:         (held)            => ipcRenderer.invoke('softphone-hold', held),
  softphoneTransfer:     (target)          => ipcRenderer.invoke('softphone-transfer', target),
  onSoftphoneCall:       (cb)              => ipcRenderer.on('softphone-call', (_e, d) => cb(d)),
  onSoftphoneAudio:      (cb)              => ipcRenderer.on('softphone-audio', (_e, buf) => cb(buf)),

  openScanner:           ()                => ipcRenderer.send('open-scanner'),
  scannerGetUser:        ()                => ipcRenderer.invoke('scanner-get-user'),
  scannerLogin:          (email, password) => ipcRenderer.invoke('scanner-login', { email, password }),
  scannerLogout:         ()                => ipcRenderer.invoke('scanner-logout'),
  scannerListDevices:    (driver)          => ipcRenderer.invoke('scanner-list-devices', driver),
  scannerScan:           (opts)            => ipcRenderer.invoke('scanner-scan', opts),
  scannerSend:           ()                => ipcRenderer.invoke('scanner-send'),
});
