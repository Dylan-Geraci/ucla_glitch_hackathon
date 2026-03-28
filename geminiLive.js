// src/main/geminiLive.js
// Gemini Live multimodal client using @google/genai SDK

const { GoogleGenAI, Modality } = require('@google/genai');

const SYSTEM_PROMPT = `You are an intelligent, witty browsing companion built into the user's browser.
You observe what the user is looking at via periodic screenshots and can hear them via microphone.

Your personality:
- Curious and observant — you notice details others miss
- Helpful but not overbearing — you respect the user's focus
- Occasionally dry humor, always substantive
- You speak in short, natural sentences — never walls of text

You have tools to interact with the browser:
- highlight_answer: visually highlight an element on the page and explain it
- scroll_to_text: scroll to find text on the page
- navigate_to_url: navigate to a URL
- go_back: go back in browser history
- reload_page: reload the current page
- get_page_text: read all visible text on the page

When the user asks about something on the page, use highlight_answer or scroll_to_text.
When proactively commenting (not asked), keep it to 1-2 sentences. Only comment if something is genuinely interesting.`;

const TOOL_DECLARATIONS = [
  {
    name: 'highlight_answer',
    description: 'Highlight a DOM element on the page that contains the answer to the user\'s question. Use this whenever you identify where the answer is on the page.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to highlight.' },
        explanation: { type: 'string', description: 'Brief spoken explanation to give while the element is highlighted.' },
      },
      required: ['selector', 'explanation'],
    },
  },
  {
    name: 'scroll_to_text',
    description: 'Find text on the page and scroll it into view.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text string to find and scroll to.' },
      },
      required: ['text'],
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
    name: 'get_page_text',
    description: 'Get all visible text from the current page for analysis. Use this before answering questions about page content.',
    parameters: { type: 'object', properties: {} },
  },
];

class GeminiLiveClient {
  constructor(apiKey, mainWindow, browserView) {
    this.apiKey = apiKey;
    this.mainWindow = mainWindow;
    this.browserView = browserView;
    this.ai = new GoogleGenAI({ apiKey });
    this.session = null;
    this.connected = false;
  }

  async connect() {
    try {
      this.session = await this.ai.live.connect({
        model: 'gemini-2.0-flash-live-001',
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_PROMPT,
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Charon' },
            },
          },
          tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        },
        callbacks: {
          onopen: () => {
            this.connected = true;
            console.log('[Gemini Live] Connected');
            this.mainWindow.webContents.send('agent-status', { connected: true });
          },
          onmessage: (msg) => this._handleMessage(msg),
          onerror: (e) => {
            console.error('[Gemini Live] Error:', e);
            this.mainWindow.webContents.send('agent-error', { error: e.message });
          },
          onclose: (e) => {
            this.connected = false;
            console.log('[Gemini Live] Disconnected:', e);
            this.mainWindow.webContents.send('agent-status', { connected: false });
          },
        },
      });
      return true;
    } catch (e) {
      console.error('[Gemini Live] Connection failed:', e);
      throw e;
    }
  }

  _handleMessage(message) {
    // Audio response — forward to renderer for playback
    const audioParts = message.serverContent?.modelTurn?.parts?.filter(p => p.inlineData) || [];
    for (const part of audioParts) {
      this.mainWindow.webContents.send('agent-audio', {
        data: part.inlineData.data,
        mimeType: part.inlineData.mimeType,
      });
    }

    if (message.serverContent?.turnComplete) {
      this.mainWindow.webContents.send('agent-turn-complete');
    }

    // Tool call — Gemini wants to perform a browser action
    if (message.toolCall) {
      this._handleToolCall(message.toolCall);
    }
  }

  async _handleToolCall(toolCall) {
    for (const call of toolCall.functionCalls) {
      console.log(`[Tool] ${call.name}`, call.args);
      const result = await this._executeTool(call.name, call.args || {});
      try {
        await this.session.sendToolResponse({
          functionResponses: [{
            id: call.id,
            name: call.name,
            response: { result },
          }],
        });
      } catch (e) {
        console.error('[Tool] sendToolResponse failed:', e);
      }
    }
  }

  async _executeTool(name, args) {
    const bv = this.browserView;
    if (!bv) return 'No browser view available';

    try {
      switch (name) {
        case 'highlight_answer': {
          await bv.webContents.executeJavaScript(`
            (function() {
              const el = document.querySelector(${JSON.stringify(args.selector)});
              if (!el) return false;
              const prev = el.style.cssText;
              el.style.cssText += ';outline:3px solid #00E5FF !important;box-shadow:0 0 16px rgba(0,229,255,0.5) !important;background-color:rgba(0,229,255,0.12) !important;transition:all 0.3s ease !important;';
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              setTimeout(() => { el.style.cssText = prev; }, 4000);
              return true;
            })()
          `);
          return args.explanation || 'Highlighted.';
        }

        case 'scroll_to_text': {
          const found = await bv.webContents.executeJavaScript(`
            (function() {
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              let node;
              while ((node = walker.nextNode())) {
                if (node.textContent.toLowerCase().includes(${JSON.stringify(args.text.toLowerCase())})) {
                  const el = node.parentElement;
                  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  const prev = el.style.background;
                  el.style.background = 'rgba(0,229,255,0.15)';
                  setTimeout(() => { el.style.background = prev; }, 3000);
                  return true;
                }
              }
              return false;
            })()
          `);
          return found ? `Scrolled to "${args.text}"` : `Text not found: "${args.text}"`;
        }

        case 'navigate_to_url': {
          let url = args.url;
          if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
          await bv.webContents.loadURL(url);
          return `Navigated to ${url}`;
        }

        case 'go_back':
          bv.webContents.goBack();
          return 'Went back';

        case 'reload_page':
          bv.webContents.reload();
          return 'Page reloaded';

        case 'get_page_text': {
          const text = await bv.webContents.executeJavaScript(
            `document.body.innerText.slice(0, 6000)`
          );
          return text;
        }

        default:
          return `Unknown tool: ${name}`;
      }
    } catch (e) {
      console.error(`[Tool] ${name} failed:`, e);
      return `Error: ${e.message}`;
    }
  }

  async sendScreenshot(base64Image) {
    if (!this.session || !this.connected) return;
    try {
      await this.session.sendRealtimeInput({
        video: {
          data: base64Image.replace(/^data:image\/\w+;base64,/, ''),
          mimeType: 'image/png',
        },
      });
    } catch (e) {
      console.error('[Gemini] Screenshot send failed:', e);
    }
  }

  async sendAudio(audioBase64, mimeType = 'audio/pcm;rate=16000') {
    if (!this.session || !this.connected) return { error: 'Not connected' };
    try {
      await this.session.sendRealtimeInput({
        audio: { data: audioBase64, mimeType },
      });
      return { success: true };
    } catch (e) {
      console.error('[Gemini] Audio send failed:', e);
      return { error: e.message };
    }
  }

  async sendText(text) {
    if (!this.session || !this.connected) return { error: 'Not connected' };
    try {
      await this.session.sendMessage({
        turns: [{ role: 'user', parts: [{ text }] }],
      });
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  }

  disconnect() {
    if (this.session) {
      this.session.close();
      this.session = null;
      this.connected = false;
    }
  }
}

module.exports = { GeminiLiveClient };
