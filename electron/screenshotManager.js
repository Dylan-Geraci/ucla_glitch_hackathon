// src/main/screenshotManager.js
// Manages periodic screenshot capture and proactive agent commentary

class ScreenshotManager {
  constructor(mainWindow, browserView, geminiClient) {
    this.mainWindow = mainWindow;
    this.browserView = browserView;
    this.geminiClient = geminiClient;

    this.active = false;
    this.intervalMs = 60000;   // default: screenshot every 60s
    this.timer = null;
    this.lastUrl = '';
    this.lastScreenshotTime = 0;
    this.navigationCooldown = 2000; // wait 2s after nav before capturing
    this.lastScreenshotHash = null;
    this.lastSpokeTime = 0; // timestamp of last agent speech
  }

  // Call this after the agent speaks so the timer knows to skip
  markSpoke() {
    this.lastSpokeTime = Date.now();
  }

  // frequency: 0.0 (never) → 1.0 (very often)
  setFrequency(value) {
    // Testing range: 120s → 30s  (was 60s → 5s — too expensive)
    const min = 30000;
    const max = 120000;
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
    // Skip if agent spoke within the last 15 seconds
    if (Date.now() - this.lastSpokeTime < 15000) {
      console.log('[ScreenshotManager] Skipped — agent spoke recently');
      return;
    }
    try {
      const image = await this.browserView.webContents.capturePage();

      // Resize to 800px wide + JPEG at 60% quality — reduces token cost ~8x vs full PNG
      const resized = image.resize({ width: 800, quality: 'good' });
      const jpegBuffer = resized.toJPEG(60);
      const base64 = 'data:image/jpeg;base64,' + jpegBuffer.toString('base64');

      // Skip if page looks identical to last capture (saves calls on static pages)
      const hash = jpegBuffer.length;
      if (hash === this.lastScreenshotHash) {
        console.log('[ScreenshotManager] Page unchanged, skipping API call');
        return;
      }
      this.lastScreenshotHash = hash;

      this.lastScreenshotTime = Date.now();
      this.mainWindow.webContents.send('screenshot-taken', { timestamp: this.lastScreenshotTime });
      await this.geminiClient.sendScreenshot(base64);
    } catch (e) {
      console.error('[ScreenshotManager] Capture error:', e);
    }
  }
}

module.exports = { ScreenshotManager };
