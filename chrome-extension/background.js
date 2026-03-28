// background.js — Service worker: Gemini API client + screenshot manager

importScripts('musicManager.js');

// ─── Config ──────────────────────────────────────────────────────────────────
const MODEL = 'gemini-3.1-flash-lite-preview';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const SYSTEM_PROMPT = `You are an intelligent, witty browsing companion built into the user's browser.
You observe what the user is looking at via periodic screenshots and can hear them via microphone.
You already have the page text included in every message — you do NOT need to fetch it.

Your personality:
- Curious and observant — you notice details others miss
- Helpful but not overbearing — you respect the user's focus
- Occasionally dry humor, always substantive
- You speak in short, natural sentences — never walls of text

CRITICAL RULES — follow these in priority order (check higher rules first):
1. TAB MANAGEMENT (check these BEFORE navigation):
   - "close tab" / "close this tab" → use the close_tab tool. Do NOT use click_element — close_tab is a browser action, not a page button.
   - "switch tab" / "switch to the X tab" / "go to my X tab" → use the switch_tab tool to switch to an already-open tab. Do NOT use navigate_to_url.
   - "open X in a new tab" / "new tab" → use the open_new_tab tool. Do NOT use navigate_to_url.
2. When the user asks a QUESTION about the page ("what is", "what's the difference", "explain", "tell me", "why", "how", "compare"), respond with text. You already have the page text, so read it and answer directly.
3. When the user says "highlight" or "show me where", use the highlight_answer tool.
4. When the user says "search for", "look up", "go to", "open", or "navigate to" (and they are NOT referring to an already-open tab), use the navigate_to_url tool. Use https://www.google.com/search?q=QUERY for searches. Do NOT tell the user to search themselves — YOU do it.
5. When the user asks you to click, press, select, enable, disable, toggle, or interact with a button/link/checkbox/radio on the page, use the click_element tool with the visible text label of the element.
6. When proactively commenting (not asked), keep it to 1-2 sentences.
7. If page text says "No page text available", do NOT make up what's on the page. Just say you can't see the page content.

Your response will be spoken aloud — keep it concise (2-4 sentences for answers).`;

const TOOL_DECLARATIONS = [
  {
    name: 'highlight_answer',
    description: 'Find and highlight text on the page that contains the answer, and explain it verbally. Use a short unique snippet of the visible text you want to highlight.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'A short, unique snippet of visible text on the page to find and highlight (5-15 words).' },
        explanation: { type: 'string', description: 'Spoken explanation to give while the element is highlighted.' },
      },
      required: ['text', 'explanation'],
    },
  },
  {
    name: 'navigate_to_url',
    description: 'Navigate the browser to a URL.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to navigate to (include https://).' },
      },
      required: ['url'],
    },
  },
  {
    name: 'go_back',
    description: 'Navigate back in the browser history.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'reload_page',
    description: 'Reload the current page.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'click_element',
    description: 'Click a button, link, radio button, checkbox, or other interactive element on the page. Describe the element by its visible text label or nearby text.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The visible text label of the element to click (e.g. "Disabled", "Submit", "Hide").' },
      },
      required: ['text'],
    },
  },
  {
    name: 'open_new_tab',
    description: 'Open a URL in a new browser tab.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to open in a new tab (include https://).' },
      },
      required: ['url'],
    },
  },
  {
    name: 'close_tab',
    description: 'Close the current browser tab.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'switch_tab',
    description: 'Switch to another open tab by matching its title or URL. Use a keyword from the tab title or domain.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A keyword to match against tab titles or URLs (e.g. "YouTube", "google", "reddit").' },
      },
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
let lastScreenshotData = null; // raw base64 (no prefix)
let musicManager = null;

// ─── Conversation Memory ────────────────────────────────────────────────────
// Stores recent conversation turns so the model has context
const MAX_MEMORY_TURNS = 20;
let conversationMemory = []; // [{role: 'user', text: '...'}, {role: 'model', text: '...'}]

function addToMemory(role, text) {
  if (!text) return;
  // Keep text short in memory to avoid blowing up token count
  const trimmed = text.slice(0, 500);
  conversationMemory.push({ role, text: trimmed });
  if (conversationMemory.length > MAX_MEMORY_TURNS) {
    conversationMemory = conversationMemory.slice(-MAX_MEMORY_TURNS);
  }
}

function buildMemoryContext() {
  if (conversationMemory.length === 0) return '';
  const lines = conversationMemory.map(m =>
    m.role === 'user' ? `User: ${m.text}` : `You: ${m.text}`
  );
  return `[CONVERSATION HISTORY]\n${lines.join('\n')}\n[END CONVERSATION HISTORY]\n\n`;
}

// ─── Offscreen Document (for mic recording) ─────────────────────────────────

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Recording microphone audio for voice input',
  });
}

// ─── Gemini API (raw fetch) ─────────────────────────────────────────────────

async function generateContent(contents, { tools = false, systemInstruction = true } = {}) {
  const url = `${API_BASE}/${MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents,
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
  };
  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: SYSTEM_PROMPT }] };
  }
  if (tools) {
    body.tools = [{ functionDeclarations: TOOL_DECLARATIONS }];
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API ${res.status}: ${err}`);
  }
  return await res.json();
}

// ─── Handle Gemini Response (tool calls + text) ─────────────────────────────

async function handleResponse(response) {
  const candidate = response.candidates?.[0];
  if (!candidate) return;

  const parts = candidate.content?.parts || [];
  let spokenText = null;
  let toolExplanation = null;

  for (const part of parts) {
    if (part.functionCall) {
      const { name, args } = part.functionCall;
      console.log(`[Tool] ${name}`, args);
      const result = await executeTool(name, args || {});

      if (name === 'highlight_answer') {
        // Always speak the explanation, even if highlight didn't find the element
        toolExplanation = args.explanation || `I highlighted "${args.text}" on the page.`;
        // Don't set spokenText here — let model's text part take priority if present
        continue;
      } else if (name === 'get_page_text') {
        // Fresh call with page text baked in (avoids multi-turn issues)
        try {
          const followUp = await generateContent([{
            role: 'user',
            parts: [{ text: `Here is the visible text from the page the user is viewing:\n\n${result}\n\nBased on the above, answer the user's question concisely.` }],
          }]);
          const followText = followUp.candidates?.[0]?.content?.parts?.find(p => p.text)?.text;
          if (followText) spokenText = followText;
        } catch (e) {
          console.error('[Tool] Follow-up failed:', e);
          spokenText = 'I read the page but had trouble summarizing it.';
        }
      } else {
        spokenText = `Done — ${result}`;
      }
    }

    if (part.text) {
      spokenText = part.text;
    }
  }

  // Prefer model's text response; fall back to tool explanation
  const finalText = spokenText || toolExplanation;
  if (finalText) {
    sendToSidePanel({ type: 'agent-text', text: finalText });
    lastSpokeTime = Date.now();
  }
  sendToSidePanel({ type: 'agent-turn-complete' });
}

// ─── Tool Execution ─────────────────────────────────────────────────────────

async function executeTool(name, args) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return 'No active tab';

  try {
    switch (name) {
      case 'highlight_answer': {
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'highlight_answer', text: args.text });
        console.log('[Highlight]', res?.found ? 'Applied on page' : 'Text not found');
        return res?.found ? (args.explanation || 'Highlighted.') : 'Could not find that text on the page.';
      }
      case 'scroll_to_text': {
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'scroll_to_text', text: args.text });
        return res?.found ? `Scrolled to "${args.text}"` : `Text not found: "${args.text}"`;
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
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'click_element', text: args.text });
        return res?.found ? `Clicked "${args.text}"` : `Could not find element with text "${args.text}"`;
      }
      case 'open_new_tab': {
        let url = args.url;
        if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
        await chrome.tabs.create({ url });
        return `Opened ${url} in a new tab`;
      }
      case 'close_tab': {
        await chrome.tabs.remove(tab.id);
        return 'Closed the current tab';
      }
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
      case 'get_page_text': {
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'get_page_text' });
        return res?.text || '';
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    console.error(`[Tool] ${name} failed:`, e);
    return `Error: ${e.message}`;
  }
}

// ─── Screenshot Capture ─────────────────────────────────────────────────────

async function captureScreenshot() {
  if (!connected || !agentActive) return;

  // Skip if agent spoke within last 15 seconds
  if (Date.now() - lastSpokeTime < 15000) {
    console.log('[Screenshot] Skipped — agent spoke recently');
    return;
  }

  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 60 });
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');

    // Simple duplicate detection via string length
    const hash = base64.length;
    if (hash === lastScreenshotHash) {
      console.log('[Screenshot] Page unchanged, skipping');
      return;
    }
    lastScreenshotHash = hash;
    lastScreenshotData = base64;

    sendToSidePanel({ type: 'screenshot-taken' });

    // Send to Gemini for observation
    const response = await generateContent([{
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'image/jpeg', data: base64 } },
        { text: 'Briefly observe this page. Only comment if something is genuinely interesting — 1 sentence max. If nothing notable, respond with exactly: "."' },
      ],
    }]);

    const text = response.candidates?.[0]?.content?.parts?.find(p => p.text)?.text?.trim();
    if (text && text !== '.') {
      sendToSidePanel({ type: 'agent-text', text });
      sendToSidePanel({ type: 'agent-turn-complete' });
      lastSpokeTime = Date.now();
    }
  } catch (e) {
    console.error('[Screenshot] Capture error:', e);
  }
}

function startScreenshots() {
  if (screenshotTimer) return;
  agentActive = true;
  scheduleScreenshot();
  console.log(`[Screenshot] Started, interval: ${intervalMs}ms`);
}

function stopScreenshots() {
  agentActive = false;
  if (screenshotTimer) {
    clearTimeout(screenshotTimer);
    screenshotTimer = null;
  }
  console.log('[Screenshot] Stopped');
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
  if (agentActive) {
    stopScreenshots();
    startScreenshots();
  }
}

// ─── Send Audio to Gemini ───────────────────────────────────────────────────

async function sendAudio(audioBase64, mimeType) {
  if (!connected) return { error: 'Not connected' };

  try {
    const parts = [];

    // Attach last screenshot as visual context
    if (lastScreenshotData) {
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: lastScreenshotData } });
    }

    // Include full page text so model can answer questions directly
    let pageText = '';
    let currentUrl = '';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        currentUrl = tab.url || '';
        try {
          const res = await chrome.tabs.sendMessage(tab.id, { type: 'get_page_text' });
          if (res?.text) pageText = res.text;
        } catch (e) { /* content script not available on this page */ }
      }
    } catch (e) { /* no tab */ }

    // Build context — tell model what page we're on even if we can't read text
    let context = buildMemoryContext();
    if (pageText) {
      context += `[Current URL: ${currentUrl}]\n[FULL PAGE TEXT START]\n${pageText}\n[FULL PAGE TEXT END]\n\nThe user said:`;
    } else {
      context += `[Current URL: ${currentUrl}]\n[No page text available — content script cannot run on this page. Do NOT guess or hallucinate page content.]\n\nThe user said:`;
    }
    parts.push({ text: context });

    parts.push({ inlineData: { mimeType, data: audioBase64 } });

    // Use tools so navigation works
    const response = await generateContent(
      [{ role: 'user', parts }],
      { tools: true }
    );

    await handleResponse(response);
    addToMemory('user', '[voice message]');
    const answer = response.candidates?.[0]?.content?.parts?.find(p => p.text)?.text?.trim();
    if (answer) addToMemory('model', answer);
    lastSpokeTime = Date.now();
    return { success: true };
  } catch (e) {
    console.error('[Gemini] sendAudio failed:', e);
    sendToSidePanel({ type: 'agent-error', error: e.message });
    return { error: e.message };
  }
}

// ─── Send Text to Gemini ────────────────────────────────────────────────────

async function sendText(text) {
  if (!connected) return { error: 'Not connected' };

  try {
    const parts = [];

    // Attach last screenshot as visual context
    if (lastScreenshotData) {
      parts.push({ inlineData: { mimeType: 'image/jpeg', data: lastScreenshotData } });
    }

    // Include full page text + URL
    let pageText = '';
    let currentUrl = '';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        currentUrl = tab.url || '';
        try {
          const res = await chrome.tabs.sendMessage(tab.id, { type: 'get_page_text' });
          if (res?.text) pageText = res.text;
        } catch (e) { /* content script not available */ }
      }
    } catch (e) { /* no tab */ }

    let context = buildMemoryContext();
    if (pageText) {
      context += `[Current URL: ${currentUrl}]\n[FULL PAGE TEXT START]\n${pageText}\n[FULL PAGE TEXT END]\n\nThe user says: ${text}`;
    } else {
      context += `[Current URL: ${currentUrl}]\n[No page text available — do NOT guess page content.]\n\nThe user says: ${text}`;
    }
    parts.push({ text: context });

    // Tools enabled for navigation
    const response = await generateContent(
      [{ role: 'user', parts }],
      { tools: true }
    );

    await handleResponse(response);
    addToMemory('user', text);
    const answer = response.candidates?.[0]?.content?.parts?.find(p => p.text)?.text?.trim();
    if (answer) addToMemory('model', answer);
    lastSpokeTime = Date.now();
    return { success: true };
  } catch (e) {
    console.error('[Gemini] sendText failed:', e);
    sendToSidePanel({ type: 'agent-error', error: e.message });
    return { error: e.message };
  }
}

// ─── Side Panel Communication (persistent port) ────────────────────────────

let sidePanelPort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidepanel') {
    sidePanelPort = port;
    console.log('[Background] Side panel connected');
    port.onDisconnect.addListener(() => {
      sidePanelPort = null;
      console.log('[Background] Side panel disconnected');
    });
  }
});

function sendToSidePanel(msg) {
  if (sidePanelPort) {
    try { sidePanelPort.postMessage(msg); } catch (e) { /* port closed */ }
  }
}

// ─── Message Handler (from sidepanel.js) ────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Ignore messages from content scripts
  if (sender.tab) return;

  switch (msg.action) {
    case 'init-agent': {
      apiKey = msg.apiKey;
      // Verify the key with a cheap ping
      generateContent(
        [{ role: 'user', parts: [{ text: 'hi' }] }],
        { tools: false, systemInstruction: false }
      ).then(() => {
        connected = true;
        chrome.storage.local.set({ apiKey });
        // Initialize music manager with callbacks to side panel
        musicManager = new MusicManager(
          apiKey,
          (mood, audioData, mimeType) => {
            sendToSidePanel({ type: 'music-play', mood, audioData, mimeType });
          },
          () => {
            sendToSidePanel({ type: 'music-stop' });
          }
        );
        sendToSidePanel({ type: 'agent-status', connected: true });
        sendResponse({ success: true });
      }).catch((e) => {
        console.error('[Gemini] Connection failed:', e);
        sendResponse({ success: false, error: e.message });
      });
      return true; // async response
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
      ensureOffscreen().then(() => {
        chrome.runtime.sendMessage({ target: 'offscreen', action: 'start-recording' }, (res) => {
          sendResponse(res);
        });
      }).catch(e => sendResponse({ error: e.message }));
      return true; // async
    }

    case 'stop-recording': {
      chrome.runtime.sendMessage({ target: 'offscreen', action: 'stop-recording' });
      sendResponse({ ok: true });
      break;
    }

    case 'audio-recorded': {
      // Comes from offscreen.js after recording stops
      if (msg.target === 'background') {
        console.log('[Background] Got recorded audio, sending to Gemini...');
        sendAudio(msg.audioBase64, msg.mimeType).then((result) => {
          console.log('[Background] Gemini audio result:', result);
        }).catch((e) => {
          console.error('[Background] sendAudio failed:', e);
          sendToSidePanel({ type: 'agent-error', error: e.message });
        });
      }
      break;
    }

    case 'send-audio': {
      sendAudio(msg.audioBase64, msg.mimeType).then(sendResponse);
      return true; // async
    }

    case 'send-text': {
      sendText(msg.text).then(sendResponse);
      return true; // async
    }

    case 'get-api-key': {
      chrome.storage.local.get('apiKey', (data) => {
        sendResponse({ apiKey: data.apiKey || null });
      });
      return true; // async
    }

    case 'clear-api-key': {
      apiKey = null;
      connected = false;
      stopScreenshots();
      if (musicManager) musicManager.stop();
      chrome.storage.local.remove('apiKey');
      sendResponse({ ok: true });
      break;
    }

    case 'toggle-music': {
      if (musicManager) {
        musicManager.setEnabled(msg.enabled);
        if (msg.enabled) {
          // Start fresh — bypass onCycle guards
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]?.url) musicManager.startForUrl(tabs[0].url);
          });
        }
      }
      sendResponse({ ok: true });
      break;
    }

    case 'music-ended':
      // No longer needed — regen is timer-based
      break;
  }
});

// ─── Open side panel on extension icon click ────────────────────────────────

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// ─── Tab navigation listener (trigger screenshot on nav) ────────────────────

let navDebounceTimer = null;
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    if (agentActive) {
      clearTimeout(navDebounceTimer);
      navDebounceTimer = setTimeout(() => captureScreenshot(), 2000);
    }
    // Trigger music mood check on navigation
    if (musicManager && musicManager.enabled && tab.url) {
      musicManager.onCycle(tab.url);
    }
  }
});

// ─── Restore API key on startup ─────────────────────────────────────────────

chrome.storage.local.get('apiKey', (data) => {
  if (data.apiKey) {
    apiKey = data.apiKey;
    // Don't auto-connect — let the side panel trigger it
  }
});
