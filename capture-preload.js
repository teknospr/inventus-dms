const { contextBridge, ipcRenderer, desktopCapturer } = require('electron');

contextBridge.exposeInMainWorld('capture', {
  captureScreen: async (width, height) => {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: width || 1920, height: height || 1080 },
    });
    if (!sources.length) throw new Error('No screens found');
    return Array.from(sources[0].thumbnail.toPNG());
  },
  onCaptureNow: (cb) => ipcRenderer.on('capture-now', (_e, opts) => cb(opts)),
  sendResult: (pngArray) => ipcRenderer.send('capture-result', { pngArray }),
  sendError: (msg) => ipcRenderer.send('capture-result', { error: msg }),
});
