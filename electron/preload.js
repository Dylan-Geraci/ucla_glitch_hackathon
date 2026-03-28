// src/preload/preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  // ── Navigation ──────────────────────────────────────────────────────────────
  navigate: (url) => ipcRenderer.invoke('navigate', url),
  goBack: () => ipcRenderer.invoke('go-back'),
  goForward: () => ipcRenderer.invoke('go-forward'),
  reload: () => ipcRenderer.invoke('reload'),
  getUrl: () => ipcRenderer.invoke('get-url'),

  // ── Screenshot / Page Info ──────────────────────────────────────────────────
  captureScreenshot: () => ipcRenderer.invoke('capture-screenshot'),
  getPageText: () => ipcRenderer.invoke('get-page-text'),

  // ── Page Manipulation ───────────────────────────────────────────────────────
  highlightSelector: (opts) => ipcRenderer.invoke('highlight-selector', opts),
  injectAnnotation: (opts) => ipcRenderer.invoke('inject-annotation', opts),
  scrollToText: (opts) => ipcRenderer.invoke('scroll-to-text', opts),

  // ── Agent Control ───────────────────────────────────────────────────────────
  initAgent: (opts) => ipcRenderer.invoke('init-agent', opts),
  toggleAgent: (opts) => ipcRenderer.invoke('toggle-agent', opts),
  setAgentFrequency: (opts) => ipcRenderer.invoke('set-agent-frequency', opts),
  sendVoiceMessage: (opts) => ipcRenderer.invoke('send-voice-message', opts),
  sendTextMessage: (opts) => ipcRenderer.invoke('send-text-message', opts),

  // ── Events (main → renderer) ────────────────────────────────────────────────
  on: (channel, callback) => {
    const allowed = [
      'url-changed', 'title-changed',
      'agent-status', 'agent-error', 'agent-text', 'agent-audio',
      'agent-turn-complete', 'screenshot-taken',
    ];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_, data) => callback(data));
    }
  },
  off: (channel, callback) => ipcRenderer.removeListener(channel, callback),
});
