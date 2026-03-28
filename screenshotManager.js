// src/main/screenshotManager.js
// Manages periodic screenshot capture and proactive agent commentary

class ScreenshotManager {
  constructor(mainWindow, browserView, geminiClient) {
    this.mainWindow = mainWindow;
    this.browserView = browserView;
    this.geminiClient = geminiClient;

    this.active = false;
    this.intervalMs = 15000;   // default: screenshot every 15s
    this.timer = null;
    this.lastUrl = '';
    this.lastScreenshotTime = 0;
    this.navigationCooldown = 2000; // wait 2s after nav before capturing
  }

  // frequency: 0.0 (never) → 1.0 (very often)
  setFrequency(value) {
    // Map 0→1 to 60s→5s interval
    const min = 5000;
    const max = 60000;
    this.intervalMs = max - value * (max - min);
    if (this.active) {
      this.stop();
      this.start();
    }
  }

  start() {
    if (this.active) return;
    this.active = true;
    this._schedule();
    console.log(`[ScreenshotManager] Started, interval: ${this.intervalMs}ms`);
  }

  stop() {
    this.active = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    console.log('[ScreenshotManager] Stopped');
  }

  onNavigation() {
    if (!this.active) return;
    // Debounce: capture shortly after navigation settles
    clearTimeout(this._navTimer);
    this._navTimer = setTimeout(() => this._capture(), this.navigationCooldown);
  }

  _schedule() {
    if (!this.active) return;
    this.timer = setTimeout(async () => {
      await this._capture();
      this._schedule();
    }, this.intervalMs);
  }

  async _capture() {
    if (!this.browserView || !this.geminiClient?.connected) return;
    try {
      const image = await this.browserView.webContents.capturePage();
      const base64 = image.toDataURL(); // data:image/png;base64,...
      this.lastScreenshotTime = Date.now();
      this.mainWindow.webContents.send('screenshot-taken', { timestamp: this.lastScreenshotTime });
      await this.geminiClient.sendScreenshot(base64);
    } catch (e) {
      console.error('[ScreenshotManager] Capture error:', e);
    }
  }
}

module.exports = { ScreenshotManager };
