// src/main/main.js
const { app, BrowserWindow, BrowserView, ipcMain, desktopCapturer, session } = require('electron');
const path = require('path');
const { GeminiLiveClient } = require('./geminiLive');
const { ScreenshotManager } = require('./screenshotManager');

let mainWindow = null;
let browserView = null;
let geminiClient = null;
let screenshotManager = null;

// ─── Constants ───────────────────────────────────────────────────────────────
const UI_HEIGHT = 120; // height of the control bar at the bottom

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0f',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // BrowserView is created lazily in init-agent so the setup overlay is visible on launch

  mainWindow.on('resize', () => repositionBrowserView());
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (geminiClient) geminiClient.disconnect();
  });
}

function createBrowserView() {
  browserView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Allow the browserview to load any page
      webSecurity: true,
    },
  });

  mainWindow.addBrowserView(browserView);
  repositionBrowserView();

  // Load a start page
  browserView.webContents.loadURL('https://www.google.com');

  // Keep renderer updated with current URL
  browserView.webContents.on('did-navigate', (_, url) => {
    mainWindow.webContents.send('url-changed', url);
    // Trigger a proactive screenshot on navigation if agent is active
    if (screenshotManager) screenshotManager.onNavigation();
  });

  browserView.webContents.on('page-title-updated', (_, title) => {
    mainWindow.webContents.send('title-changed', title);
  });
}

function repositionBrowserView() {
  if (!browserView || !mainWindow) return;
  const [w, h] = mainWindow.getContentSize();
  browserView.setBounds({ x: 0, y: 0, width: w, height: h - UI_HEIGHT });
}

// ─── IPC: Navigation ─────────────────────────────────────────────────────────
ipcMain.handle('navigate', async (_, url) => {
  if (!browserView) return;
  let finalUrl = url.trim();
  if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
    // Treat as a search query if no protocol
    if (finalUrl.includes('.') && !finalUrl.includes(' ')) {
      finalUrl = 'https://' + finalUrl;
    } else {
      finalUrl = `https://www.google.com/search?q=${encodeURIComponent(finalUrl)}`;
    }
  }
  browserView.webContents.loadURL(finalUrl);
});

ipcMain.handle('go-back', () => browserView?.webContents.goBack());
ipcMain.handle('go-forward', () => browserView?.webContents.goForward());
ipcMain.handle('reload', () => browserView?.webContents.reload());
ipcMain.handle('get-url', () => browserView?.webContents.getURL());

// ─── IPC: Screenshot ─────────────────────────────────────────────────────────
ipcMain.handle('capture-screenshot', async () => {
  if (!browserView) return null;
  try {
    const image = await browserView.webContents.capturePage();
    return image.toDataURL();
  } catch (e) {
    console.error('Screenshot failed:', e);
    return null;
  }
});

// ─── IPC: Page Manipulation (highlight / scroll / annotate) ──────────────────
ipcMain.handle('highlight-selector', async (_, { selector, color = '#FFD700', duration = 3000 }) => {
  if (!browserView) return;
  await browserView.webContents.executeJavaScript(`
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const prev = el.style.cssText;
      el.style.outline = '3px solid ${color}';
      el.style.boxShadow = '0 0 12px ${color}88';
      el.style.transition = 'all 0.3s ease';
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => { el.style.cssText = prev; }, ${duration});
      return true;
    })();
  `);
});

ipcMain.handle('inject-annotation', async (_, { text, x, y, duration = 4000 }) => {
  if (!browserView) return;
  await browserView.webContents.executeJavaScript(`
    (function() {
      const div = document.createElement('div');
      div.id = '__agent_annotation__';
      div.style.cssText = \`
        position: fixed;
        left: ${x}px;
        top: ${y}px;
        background: rgba(10,10,20,0.92);
        color: #c8f7e8;
        font-family: 'Courier New', monospace;
        font-size: 13px;
        padding: 8px 14px;
        border-radius: 8px;
        border: 1px solid #3dffa0;
        box-shadow: 0 0 20px #3dffa040;
        z-index: 2147483647;
        max-width: 320px;
        pointer-events: none;
        animation: agentFadeIn 0.3s ease;
      \`;
      div.textContent = ${JSON.stringify(text)};
      const style = document.createElement('style');
      style.textContent = '@keyframes agentFadeIn { from { opacity:0; transform:translateY(-8px); } to { opacity:1; transform:translateY(0); } }';
      document.head.appendChild(style);
      document.body.appendChild(div);
      setTimeout(() => div.remove(), ${duration});
    })();
  `);
});

ipcMain.handle('scroll-to-text', async (_, { text }) => {
  if (!browserView) return false;
  return await browserView.webContents.executeJavaScript(`
    (function() {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) {
        if (node.textContent.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})) {
          node.parentElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
          node.parentElement.style.background = 'rgba(61,255,160,0.18)';
          setTimeout(() => node.parentElement.style.background = '', 3000);
          return true;
        }
      }
      return false;
    })();
  `);
});

ipcMain.handle('get-page-text', async () => {
  if (!browserView) return '';
  return await browserView.webContents.executeJavaScript(`document.body.innerText.slice(0, 8000)`);
});

// ─── IPC: Agent Control ───────────────────────────────────────────────────────
ipcMain.handle('init-agent', async (_, { apiKey }) => {
  try {
    // Create the browser view now that setup is complete
    if (!browserView) createBrowserView();
    geminiClient = new GeminiLiveClient(apiKey, mainWindow, browserView);
    screenshotManager = new ScreenshotManager(mainWindow, browserView, geminiClient);
    geminiClient.screenshotManager = screenshotManager;
    await geminiClient.connect();
    return { success: true };
  } catch (e) {
    console.error('Agent init failed:', e);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('set-agent-frequency', (_, { value }) => {
  if (screenshotManager) screenshotManager.setFrequency(value);
});

ipcMain.handle('toggle-agent', (_, { active }) => {
  if (screenshotManager) {
    if (active) screenshotManager.start();
    else screenshotManager.stop();
  }
});

ipcMain.handle('send-voice-message', async (_, { audioBase64, mimeType }) => {
  if (!geminiClient) return { error: 'Agent not initialized' };
  const result = await geminiClient.sendAudio(audioBase64, mimeType);
  if (screenshotManager) screenshotManager.markSpoke();
  return result;
});

ipcMain.handle('send-text-message', async (_, { text }) => {
  if (!geminiClient) return { error: 'Agent not initialized' };
  return await geminiClient.sendText(text);
});

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(createMainWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWindow) createMainWindow(); });
