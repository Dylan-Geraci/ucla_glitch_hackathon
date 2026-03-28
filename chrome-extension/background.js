// background.js — Service worker: Gemini Live API (WebSocket) + screenshot manager

importScripts('musicManager.js');

// ─── Config ──────────────────────────────────────────────────────────────────
const LIVE_MODEL = 'gemini-3.1-flash-live-preview';
const WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
// Keep REST API for screenshots only (text-only observations, no audio)
const REST_MODEL = 'gemini-3.1-flash-lite-preview';
const REST_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const SYSTEM_PROMPT = `You are an intelligent, witty browsing companion built into the user's browser.
You observe what the user is looking at via periodic screenshots and can hear them via microphone.

Your personality:
- Curious and observant — you notice details others miss
- Helpful but not overbearing — you respect the user's focus
- Occasionally dry humor, always substantive
- You speak in short, natural sentences — never walls of text

CRITICAL RULES — follow these in priority order:
1. TAB MANAGEMENT:
   - "close tab" → use close_tab.
   - "switch tab" → use switch_tab.
   - "open X in new tab" → use open_new_tab.
2. PAGE INTERACTION:
   - You receive structured page context. Links are [L1: Text], [L2: Text], etc. Buttons are [B1: Text].
   - To open a link, use click_element with the label (e.g., "L1") or the text.
   - If asked for the "first link", use "L1".
3. VERBAL CONFIRMATION:
   - Always give a short verbal confirmation after using a tool (e.g., "Opening that UCLA link for you" or "Searching for monkeys").
4. KEY CONTEXT:
   - When the user asks a question about the page, use the provided text context.
   - If page text says "No page text available", do NOT make up content.

Your response will be spoken aloud — keep it concise (1-3 sentences). Do NOT read out URLs.`;

const TOOL_DECLARATIONS = [
  {
    name: 'highlight_answer',
    description: 'Find and highlight text on the page that contains the answer.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'A short unique snippet of visible text to highlight (5-15 words).' },
        explanation: { type: 'string', description: 'Spoken explanation while highlighted.' },
      },
      required: ['text', 'explanation'],
    },
  },
  {
    name: 'navigate_to_url',
    description: 'Navigate the browser to a URL.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Full URL (include https://).' } },
      required: ['url'],
    },
  },
  { name: 'go_back', description: 'Navigate back.', parameters: { type: 'object', properties: {} } },
  { name: 'reload_page', description: 'Reload the current page.', parameters: { type: 'object', properties: {} } },
  {
    name: 'click_element',
    description: 'Click a button, link, radio, checkbox, or interactive element by its visible text label.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Visible text label of the element to click.' } },
      required: ['text'],
    },
  },
  {
    name: 'open_new_tab',
    description: 'Open a URL in a new tab.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Full URL (include https://).' } },
      required: ['url'],
    },
  },
  { name: 'close_tab', description: 'Close the current tab.', parameters: { type: 'object', properties: {} } },
  {
    name: 'switch_tab',
    description: 'Switch to another open tab by matching title or URL keyword.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Keyword to match tab title/URL.' } },
      required: ['query'],
    },
  },
];

// ─── State ───────────────────────────────────────────────────────────────────
let apiKey = null;
let connected = false;
let agentActive = false;
let screenshotTimer = null;
let intervalMs = 60000;
let lastScreenshotHash = null;
let lastSpokeTime = 0;
let lastScreenshotData = null;
let musicManager = null;

// ─── WebSocket State ────────────────────────────────────────────────────────
let ws = null;
let wsReady = false;
let wsConnectResolve = null;
let wsConnectReject = null;
let reconnectAttempts = 0;
let keepAliveInterval = null;
let turnInProgress = false;
let isStreaming = false; // true while mic is actively streaming audio

// ─── WebSocket Connection ───────────────────────────────────────────────────

function connectWebSocket() {
  return new Promise((resolve, reject) => {
    wsConnectResolve = resolve;
    wsConnectReject = reject;

    const url = `${WS_BASE}?key=${apiKey}`;
    console.log('[WS] Connecting...');
    ws = new WebSocket(url);

    ws.onopen = () => {
      console.log('[WS] Connected, sending setup...');
      ws.send(JSON.stringify({
        setup: {
          model: `models/${LIVE_MODEL}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: 'Puck' }
              }
            }
          },
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        }
      }));
    };

    ws.onmessage = async (event) => {
      try {
        let text;
        if (event.data instanceof Blob) {
          text = await event.data.text();
        } else {
          text = event.data;
        }
        const msg = JSON.parse(text);
        onWsMessage(msg);
      } catch (e) {
        console.error('[WS] Parse error:', e);
      }
    };

    ws.onclose = (event) => {
      console.log('[WS] Closed:', event.code, event.reason);
      wsReady = false;
      stopKeepAlive();

      if (wsConnectReject) {
        wsConnectReject(new Error('WebSocket closed: ' + event.code));
        wsConnectResolve = null;
        wsConnectReject = null;
      }

      // Auto-reconnect
      if (connected && apiKey) {
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        reconnectAttempts++;
        console.log(`[WS] Reconnecting in ${delay}ms...`);
        setTimeout(() => {
          if (connected && apiKey) {
            connectWebSocket().catch(e => console.error('[WS] Reconnect failed:', e));
          }
        }, delay);
      }
    };

    ws.onerror = (e) => {
      console.error('[WS] Error:', e);
    };
  });
}

function onWsMessage(msg) {
  if (msg.setupComplete) {
    console.log('[WS] Setup complete — session ready');
    wsReady = true;
    reconnectAttempts = 0;
    startKeepAlive();
    if (wsConnectResolve) {
      wsConnectResolve();
      wsConnectResolve = null;
      wsConnectReject = null;
    }
    return;
  }

  if (msg.serverContent) {
    const sc = msg.serverContent;
    if (sc.modelTurn && sc.modelTurn.parts) {
      if (!turnInProgress) {
        turnInProgress = true;
        sendToSidePanel({ type: 'agent-turn-start' });
      }
      for (const part of sc.modelTurn.parts) {
        if (part.text) {
          console.log('[WS] Text:', part.text.slice(0, 100));
          sendToSidePanel({ type: 'agent-text', text: part.text });
          lastSpokeTime = Date.now();
        }
        if (part.inlineData) {
          console.log('[WS] Audio chunk received, mime:', part.inlineData.mimeType, 'len:', part.inlineData.data?.length?.toString().slice(0, 6));
          sendToSidePanel({
            type: 'agent-audio',
            data: part.inlineData.data,
            mimeType: part.inlineData.mimeType,
          });
          lastSpokeTime = Date.now();
        }
      }
    }
    if (sc.turnComplete) {
      console.log('[WS] Turn complete');
      turnInProgress = false;
      sendToSidePanel({ type: 'agent-turn-complete' });
    }
    return;
  }

  if (msg.toolCall) {
    console.log('[WS] Tool call received');
    handleToolCall(msg.toolCall);
    return;
  }

  // Log anything unexpected
  console.log('[WS] Unhandled message:', JSON.stringify(msg).slice(0, 200));
}

// ─── Tool Call Handling ─────────────────────────────────────────────────────

async function handleToolCall(toolCall) {
  const responses = [];
  for (const fc of toolCall.functionCalls) {
    console.log(`[Tool] ${fc.name}`, fc.args);
    
    // Provide feedback to UI
    let statusMsg = `Working: ${fc.name.replace(/_/g, ' ')}...`;
    if (fc.name === 'navigate_to_url' && fc.args?.url) statusMsg = `Navigating to ${fc.args.url}...`;
    if (fc.name === 'click_element' && fc.args?.text) statusMsg = `Clicking "${fc.args.text}"...`;
    
    sendToSidePanel({ type: 'agent-status-text', text: statusMsg });

    const result = await executeTool(fc.name, fc.args || {});

    responses.push({
      id: fc.id,
      response: { result: String(result) },
    });
  }

  if (ws && wsReady) {
    console.log('[WS] Sending toolResponse');
    ws.send(JSON.stringify({
      toolResponse: { functionResponses: responses }
    }));
  }
}

// ─── Tool Execution ─────────────────────────────────────────────────────────

async function executeTool(name, args) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return 'No active tab';

  try {
    switch (name) {
      case 'highlight_answer': {
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'highlight_answer', text: args.text });
        return res?.found ? (args.explanation || 'Highlighted.') : 'Could not find that text.';
      }
      case 'navigate_to_url': {
        let url = args.url;
        if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
        await chrome.tabs.update(tab.id, { url });
        return `Navigated to ${url}`;
      }
      case 'go_back':
        await chrome.tabs.goBack(tab.id);
        return 'Went back';
      case 'reload_page':
        await chrome.tabs.reload(tab.id);
        return 'Page reloaded';
      case 'click_element': {
        let res;
        try {
          res = await chrome.tabs.sendMessage(tab.id, { type: 'click_element', text: args.text });
        } catch (e) {
          await new Promise(r => setTimeout(r, 2000));
          try {
            const [freshTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            res = await chrome.tabs.sendMessage(freshTab.id, { type: 'click_element', text: args.text });
          } catch (e2) {
            return 'Could not click — page may still be loading';
          }
        }
        return res?.found ? `Clicked "${args.text}"` : `Could not find "${args.text}"`;
      }
      case 'open_new_tab': {
        let url = args.url;
        if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('about:') && !url.startsWith('chrome://')) url = 'https://' + url;
        await chrome.tabs.create({ url });
        return `Opened ${url} in a new tab`;
      }
      case 'close_tab':
        await chrome.tabs.remove(tab.id);
        return 'Closed the current tab';
      case 'switch_tab': {
        const allTabs = await chrome.tabs.query({ currentWindow: true });
        const q = args.query.toLowerCase();
        const match = allTabs.find(t =>
          (t.title && t.title.toLowerCase().includes(q)) ||
          (t.url && t.url.toLowerCase().includes(q))
        );
        if (!match) return `No open tab matching "${args.query}"`;
        await chrome.tabs.update(match.id, { active: true });
        return `Switched to tab: ${match.title}`;
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    console.error(`[Tool] ${name} failed:`, e);
    return `Error: ${e.message}`;
  }
}

// ─── Send Text to Live Session ──────────────────────────────────────────────

async function sendTextToLive(text) {
  if (!ws || !wsReady) return { error: 'Not connected' };

  const parts = [];

  let pageText = '';
  let currentUrl = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      currentUrl = tab.url || '';
      try {
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'get_page_text' });
        if (res?.text) pageText = res.text.slice(0, 5000);
      } catch (e) {}
    }
  } catch (e) {}

  if (pageText) {
    parts.push({ text: `[URL: ${currentUrl}]\n[PAGE TEXT]\n${pageText}\n[END]\n\nUser says: ${text}` });
  } else {
    parts.push({ text: `[URL: ${currentUrl}]\n[No page text]\n\nUser says: ${text}` });
  }

  console.log('[WS] Sending text to Live session');
  ws.send(JSON.stringify({
    clientContent: {
      turns: [{ role: 'user', parts }],
      turnComplete: true,
    }
  }));

  return { success: true };
}

// ─── Stream mic audio to Live session ────────────────────────────────────────

function sendAudioChunkToLive(pcmBase64) {
  if (!ws || !wsReady) return;
  ws.send(JSON.stringify({
    realtimeInput: {
      audio: {
        data: pcmBase64,
        mimeType: 'audio/pcm;rate=16000',
      }
    }
  }));
}

// Send a short silence chunk so server VAD detects end-of-speech
function sendSilencePadding() {
  if (!ws || !wsReady) return;
  // 0.5s of silence at 16kHz mono Int16 = 8000 samples = 16000 bytes
  const silence = new Int16Array(8000);
  const bytes = new Uint8Array(silence.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  const base64 = btoa(binary);
  ws.send(JSON.stringify({
    realtimeInput: {
      audio: { data: base64, mimeType: 'audio/pcm;rate=16000' }
    }
  }));
  console.log('[Mic] Sent 0.5s silence for VAD');
}

// ─── Send page context before voice input ────────────────────────────────────

async function sendPageContextToLive() {
  if (!ws || !wsReady) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    const currentUrl = tab.url || '';
    let pageText = '';
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'get_page_text' });
      if (res?.text) pageText = res.text.slice(0, 5000);
    } catch (e) {}

    const contextMsg = pageText
      ? `[Current page context for voice interaction]\n[URL: ${currentUrl}]\n[PAGE TEXT]\n${pageText}\n[END]`
      : `[Current page context for voice interaction]\n[URL: ${currentUrl}]\n[No page text available]`;

    ws.send(JSON.stringify({
      clientContent: {
        turns: [{ role: 'user', parts: [{ text: contextMsg }] }],
        turnComplete: false,
      }
    }));
    console.log('[WS] Sent page context for voice interaction');
  } catch (e) {
    console.error('[WS] Failed to send page context:', e);
  }
}

// ─── Screenshot Capture (uses REST API for text-only, no audio) ─────────────

async function captureScreenshot() {
  if (!connected || !agentActive) return;

  if (Date.now() - lastSpokeTime < 15000) {
    console.log('[Screenshot] Skipped — spoke recently');
    return;
  }

  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 40 });
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');

    const hash = base64.length;
    if (hash === lastScreenshotHash) {
      console.log('[Screenshot] Unchanged, skipping');
      return;
    }
    lastScreenshotHash = hash;
    lastScreenshotData = base64;

    sendToSidePanel({ type: 'screenshot-taken' });

    // Use REST API for silent text-only observation (not Live, to avoid unwanted audio)
    const url = `${REST_BASE}/${REST_MODEL}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [
          { inlineData: { mimeType: 'image/jpeg', data: base64 } },
          { text: 'Briefly observe this page. Only comment if something is genuinely interesting — 1 sentence max. If nothing notable, respond with exactly: "."' },
        ] }],
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
      }),
    });

    if (res.ok) {
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.find(p => p.text)?.text?.trim();
      if (text && text !== '.') {
        sendToSidePanel({ type: 'agent-text', text });
        sendToSidePanel({ type: 'agent-turn-complete' });
        lastSpokeTime = Date.now();
      }
    }
  } catch (e) {
    console.error('[Screenshot] Error:', e);
  }
}

function startScreenshots() {
  if (screenshotTimer) return;
  agentActive = true;
  scheduleScreenshot();
}

function stopScreenshots() {
  agentActive = false;
  if (screenshotTimer) { clearTimeout(screenshotTimer); screenshotTimer = null; }
}

function scheduleScreenshot() {
  if (!agentActive) return;
  screenshotTimer = setTimeout(async () => {
    await captureScreenshot();
    screenshotTimer = null;
    scheduleScreenshot();
  }, intervalMs);
}

function setFrequency(value) {
  const min = 30000;
  const max = 120000;
  intervalMs = max - value * (max - min);
  if (agentActive) { stopScreenshots(); startScreenshots(); }
}

// ─── Keepalive ──────────────────────────────────────────────────────────────

function startKeepAlive() {
  stopKeepAlive();
  keepAliveInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send('{}');
    }
  }, 25000);
}

function stopKeepAlive() {
  if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
}

// ─── Offscreen Document ─────────────────────────────────────────────────────

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Recording microphone audio for voice input',
  });
}

// ─── Side Panel Communication ───────────────────────────────────────────────

let sidePanelPort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidepanel') {
    sidePanelPort = port;
    port.onDisconnect.addListener(() => { sidePanelPort = null; });
  }
});

function sendToSidePanel(msg) {
  if (sidePanelPort) {
    try { sidePanelPort.postMessage(msg); } catch (e) {}
  }
}

// ─── Message Handler ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.tab) return;

  switch (msg.action) {
    case 'init-agent': {
      apiKey = msg.apiKey;
      connectWebSocket().then(() => {
        connected = true;
        chrome.storage.local.set({ apiKey });
        musicManager = new MusicManager(
          apiKey,
          (mood, audioData, mimeType) => sendToSidePanel({ type: 'music-play', mood, audioData, mimeType }),
          () => sendToSidePanel({ type: 'music-stop' }),
        );
        sendToSidePanel({ type: 'agent-status', connected: true });
        sendResponse({ success: true });
      }).catch((e) => {
        console.error('[WS] Connection failed:', e);
        sendResponse({ success: false, error: e.message });
      });
      return true;
    }

    case 'toggle-agent': {
      if (msg.active) startScreenshots();
      else stopScreenshots();
      sendResponse({ ok: true });
      break;
    }

    case 'set-frequency': {
      setFrequency(msg.value);
      sendResponse({ ok: true });
      break;
    }

    case 'start-recording': {
      isStreaming = true;
      // Send page context so model knows what's on screen during voice interaction
      sendPageContextToLive();
      ensureOffscreen().then(() => {
        chrome.runtime.sendMessage({ target: 'offscreen', action: 'start-recording' }, (res) => {
          sendResponse(res);
        });
      }).catch(e => sendResponse({ error: e.message }));
      return true;
    }

    case 'stop-recording': {
      isStreaming = false;
      chrome.runtime.sendMessage({ target: 'offscreen', action: 'stop-recording' });
      // Send silence padding so server VAD detects end-of-speech
      sendSilencePadding();
      sendResponse({ ok: true });
      break;
    }

    case 'audio-chunk': {
      if (msg.target === 'background' && isStreaming) {
        sendAudioChunkToLive(msg.data);
      }
      break;
    }

    case 'send-text': {
      sendToSidePanel({ type: 'agent-text', text: 'Thinking...' });
      sendTextToLive(msg.text).then(sendResponse);
      return true;
    }

    case 'get-api-key': {
      chrome.storage.local.get('apiKey', (data) => sendResponse({ apiKey: data.apiKey || null }));
      return true;
    }

    case 'clear-api-key': {
      apiKey = null;
      connected = false;
      wsReady = false;
      if (ws) { ws.close(); ws = null; }
      stopScreenshots();
      stopKeepAlive();
      if (musicManager) musicManager.stop();
      chrome.storage.local.remove('apiKey');
      sendResponse({ ok: true });
      break;
    }

    case 'toggle-music': {
      if (musicManager) {
        musicManager.setEnabled(msg.enabled);
        if (msg.enabled) {
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.url) musicManager.startForUrl(tabs[0].url);
          });
        }
      }
      sendResponse({ ok: true });
      break;
    }
  }
});

// ─── Extension icon → open side panel ───────────────────────────────────────

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// ─── Tab navigation listener ────────────────────────────────────────────────

let navDebounceTimer = null;
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    if (agentActive) {
      clearTimeout(navDebounceTimer);
      navDebounceTimer = setTimeout(() => captureScreenshot(), 2000);
    }
    if (musicManager && musicManager.enabled && tab.url) {
      musicManager.onCycle(tab.url);
    }
  }
});

// ─── Restore API key on startup ─────────────────────────────────────────────

chrome.storage.local.get('apiKey', (data) => {
  if (data.apiKey) apiKey = data.apiKey;
});
