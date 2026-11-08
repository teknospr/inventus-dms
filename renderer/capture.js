window.capture.onCaptureNow(async (opts) => {
  try {
    const pngArray = await window.capture.captureScreen(
      opts && opts.width,
      opts && opts.height
    );
    window.capture.sendResult(pngArray);
  } catch (e) {
    window.capture.sendError(e.message || 'Capture failed');
  }
});
