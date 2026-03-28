// geminiLive.js
// Gemini client using standard generateContent API (no Live/WebSocket)
// Audio in via inlineData, audio out via browser speechSynthesis

const { GoogleGenAI } = require('@google/genai');

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
When proactively commenting (not asked), keep it to 1-2 sentences. Only comment if something is genuinely interesting.
Always respond concisely — your response will be spoken aloud.`;

const TOOL_DECLARATIONS = [
  {
    name: 'highlight_answer',
    description: 'Highlight a DOM element on the page that contains the answer. Use this whenever you identify where the answer is.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to highlight.' },
        explanation: { type: 'string', description: 'Spoken explanation to give while the element is highlighted.' },
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
    description: 'Get all visible text from the current page. Use this before answering questions about page content.',
    parameters: { type: 'object', properties: {} },
  },
];

class GeminiLiveClient {
  constructor(apiKey, mainWindow, browserView) {
    this.apiKey = apiKey;
    this.mainWindow = mainWindow;
    this.browserView = browserView;
    this.ai = new GoogleGenAI({ apiKey });
    this.model = 'gemini-3.1-flash-lite-preview';
    this.connected = false;
    this.lastScreenshotData = null; // raw base64, no data URL prefix
    // Disable thinking to avoid thought_signature issues in multi-turn tool calls
    this.thinkingConfig = { thinkingBudget: 0 };
  }

  async connect() {
    try {
      // Verify the key works with a cheap ping
      await this.ai.models.generateContent({
        model: this.model,
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      });
      this.connected = true;
      this.mainWindow.webContents.send('agent-status', { connected: true });
      return true;
    } catch (e) {
      console.error('[Gemini] Connection failed:', e);
      throw e;
    }
  }

  async sendAudio(audioBase64, mimeType = 'audio/webm') {
    if (!this.connected) return { error: 'Not connected' };
    try {
      const parts = [];

      // Attach last screenshot as visual context if available
      if (this.lastScreenshotData) {
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: this.lastScreenshotData } });
        parts.push({ text: 'Above is the current page screenshot for context.' });
      }

      parts.push({ inlineData: { mimeType, data: audioBase64 } });

      const response = await this.ai.models.generateContent({
        model: this.model,
        contents: [{ role: 'user', parts }],
        config: {
          systemInstruction: SYSTEM_PROMPT,
          tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
          thinkingConfig: this.thinkingConfig,
        },
      });

      await this._handleResponse(response, [{ role: 'user', parts }]);
      return { success: true };
    } catch (e) {
      console.error('[Gemini] sendAudio failed:', e);
      this.mainWindow.webContents.send('agent-error', { error: e.message });
      return { error: e.message };
    }
  }

  async _handleResponse(response, originalContents) {
    const candidate = response.candidates?.[0];
    if (!candidate) return;

    const parts = candidate.content?.parts || [];
    let spokenText = null;

    for (const part of parts) {
      if (part.functionCall) {
        const { name, args } = part.functionCall;
        console.log(`[Tool] ${name}`, args);
        const result = await this._executeTool(name, args || {});

        // If highlight_answer, its explanation IS the spoken response
        if (name === 'highlight_answer' && args.explanation) {
          spokenText = args.explanation;
        } else if (name === 'get_page_text') {
          // Make a fresh call with the page text baked in — avoids thought_signature replay issue
          try {
            const followUp = await this.ai.models.generateContent({
              model: this.model,
              contents: [{
                role: 'user',
                parts: [
                  { text: `Here is the visible text from the page the user is viewing:\n\n${result}\n\nBased on the above, answer the user's question concisely.` },
                ],
              }],
              config: { systemInstruction: SYSTEM_PROMPT, thinkingConfig: this.thinkingConfig },
            });
            const followText = followUp.candidates?.[0]?.content?.parts?.find(p => p.text)?.text;
            if (followText) spokenText = followText;
          } catch (e) {
            console.error('[Tool] Follow-up failed:', e);
            spokenText = 'I read the page but had trouble summarizing it.';
          }
        } else {
          // For other tools (scroll, navigate, etc.) just confirm
          spokenText = `Done — ${result}`;
        }
      }

      if (part.text) {
        spokenText = part.text;
      }
    }

    if (spokenText) {
      this.mainWindow.webContents.send('agent-text', { text: spokenText });
    }
    this.mainWindow.webContents.send('agent-turn-complete');
  }

  async sendScreenshot(base64Image) {
    // Store for use as context on next audio query
    this.lastScreenshotData = base64Image.replace(/^data:image\/\w+;base64,/, '');

    if (!this.connected) return;
    try {
      const response = await this.ai.models.generateContent({
        model: this.model,
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: this.lastScreenshotData } },
            { text: 'Briefly observe this page. Only comment if something is genuinely interesting — 1 sentence max. If nothing notable, respond with exactly: "."' },
          ],
        }],
        config: { systemInstruction: SYSTEM_PROMPT, thinkingConfig: this.thinkingConfig },
      });

      const text = response.candidates?.[0]?.content?.parts?.find(p => p.text)?.text?.trim();
      if (text && text !== '.') {
        this.mainWindow.webContents.send('agent-text', { text });
        this.mainWindow.webContents.send('agent-turn-complete');
      }
    } catch (e) {
      console.error('[Gemini] Screenshot analysis failed:', e);
    }
  }

  async sendText(text) {
    if (!this.connected) return { error: 'Not connected' };
    try {
      const response = await this.ai.models.generateContent({
        model: this.model,
        contents: [{ role: 'user', parts: [{ text }] }],
        config: {
          systemInstruction: SYSTEM_PROMPT,
          tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
          thinkingConfig: this.thinkingConfig,
        },
      });
      await this._handleResponse(response, [{ role: 'user', parts: [{ text }] }]);
      return { success: true };
    } catch (e) {
      return { error: e.message };
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

  disconnect() {
    this.connected = false;
    this.mainWindow.webContents.send('agent-status', { connected: false });
  }
}

module.exports = { GeminiLiveClient };
