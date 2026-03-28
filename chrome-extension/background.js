// background.js — Service worker: Gemini API client + screenshot manager

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

CRITICAL RULES — follow these exactly:
1. DEFAULT BEHAVIOR: Respond with plain text. Most of the time you should just TALK — give a spoken answer without using any tools.
2. When the user asks a QUESTION ("what is", "what's the difference", "explain", "tell me", "why", "how", "compare"), respond ONLY with text. Do NOT call any tool. You already have the page text in the message, so just read it and answer.
3. ONLY use the highlight_answer tool when the user explicitly says "highlight" or "show me where".
4. ONLY use navigate_to_url when the user explicitly asks to go to a website.
5. When proactively commenting (not asked), keep it to 1-2 sentences.

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
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'get_page_text' });
        if (res?.text) {
          pageText = res.text;
          parts.push({ text: `${buildMemoryContext()}[FULL PAGE TEXT START]\n${res.text}\n[FULL PAGE TEXT END]\n\nThe user said:` });
        }
      }
    } catch (e) { /* ignore if content script not ready */ }

    parts.push({ inlineData: { mimeType, data: audioBase64 } });

    // No tools — just answer directly
    const response = await generateContent(
      [{ role: 'user', parts }],
      { tools: false }
    );

    const answer = response.candidates?.[0]?.content?.parts?.find(p => p.text)?.text?.trim();

    if (answer) {
      addToMemory('user', '[voice message]');
      addToMemory('model', answer);
      sendToSidePanel({ type: 'agent-text', text: answer });
      lastSpokeTime = Date.now();

      // If the user said "highlight" or "show me", also try to highlight
      // We do this as a separate step after answering
      if (pageText) {
        try {
          const highlightCheck = await generateContent([{
            role: 'user',
            parts: [{ text: `The user asked something and you answered: "${answer}"\n\nShould something be highlighted on the page? If so, respond with ONLY a short text snippet (5-15 words) from the page to highlight. If not, respond with exactly: NO` }],
          }], { tools: false });
          const snippet = highlightCheck.candidates?.[0]?.content?.parts?.find(p => p.text)?.text?.trim();
          if (snippet && snippet !== 'NO' && snippet.length < 100) {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab) {
              chrome.tabs.sendMessage(tab.id, { type: 'highlight_answer', text: snippet });
            }
          }
        } catch (e) { /* highlight is optional, don't fail */ }
      }
    }

    sendToSidePanel({ type: 'agent-turn-complete' });

    await handleResponse(response);
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

    // Include full page text
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'get_page_text' });
        if (res?.text) {
          parts.push({ text: `${buildMemoryContext()}[FULL PAGE TEXT START]\n${res.text}\n[FULL PAGE TEXT END]\n\nThe user says: ${text}` });
        } else {
          parts.push({ text: `${buildMemoryContext()}The user says: ${text}` });
        }
      } else {
        parts.push({ text: `${buildMemoryContext()}The user says: ${text}` });
      }
    } catch (e) {
      parts.push({ text: `${buildMemoryContext()}The user says: ${text}` });
    }

    // No tools — just answer the question directly
    const response = await generateContent(
      [{ role: 'user', parts }],
      { tools: false }
    );

    const answer = response.candidates?.[0]?.content?.parts?.find(p => p.text)?.text?.trim();
    if (answer) {
      addToMemory('user', text);
      addToMemory('model', answer);
      sendToSidePanel({ type: 'agent-text', text: answer });
      lastSpokeTime = Date.now();
    }
    sendToSidePanel({ type: 'agent-turn-complete' });
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
      chrome.storage.local.remove('apiKey');
      sendResponse({ ok: true });
      break;
    }
  }
});

// ─── Open side panel on extension icon click ────────────────────────────────

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// ─── Tab navigation listener (trigger screenshot on nav) ────────────────────

let navDebounceTimer = null;
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' && agentActive) {
    clearTimeout(navDebounceTimer);
    navDebounceTimer = setTimeout(() => captureScreenshot(), 2000);
  }
});

// ─── Restore API key on startup ─────────────────────────────────────────────

chrome.storage.local.get('apiKey', (data) => {
  if (data.apiKey) {
    apiKey = data.apiKey;
    // Don't auto-connect — let the side panel trigger it
  }
});
