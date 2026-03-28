// src/main/geminiLive.js
// Gemini Live multimodal client using @google/genai SDK

const { GoogleGenAI, Modality } = require('@google/genai');

const SYSTEM_PROMPT = `You are an intelligent, witty inner voice and browsing companion. 
You observe what the user is looking at in their browser and offer insightful, concise commentary.

Your personality:
- Curious and observant — you notice details others miss
- Helpful but not overbearing — you respect the user's focus
- Occasionally dry humor, always substantive
- You speak in short, natural sentences — never walls of text

When the user asks a question about the page:
1. Answer directly and concisely
2. If you reference something on the page, say "I'll highlight that for you" and include [HIGHLIGHT: css_selector_or_text] in your response
3. If you want to annotate something, include [ANNOTATE: x,y: your text] in your response  
4. If you want to scroll to content, include [SCROLL: text to find]

When proactively commenting (not asked):
- Keep it to 1-2 sentences max
- Only comment if something is genuinely interesting or worth noting
- Don't repeat yourself about the same page

Always be aware you're seeing a screenshot of what the user is viewing.`;

class GeminiLiveClient {
  constructor(apiKey, mainWindow) {
    this.apiKey = apiKey;
    this.mainWindow = mainWindow;
    this.ai = new GoogleGenAI({ apiKey });
    this.session = null;
    this.connected = false;
  }

  async connect() {
    try {
      // Use Gemini 2.0 Flash for Live API
      this.session = await this.ai.live.connect({
        model: 'gemini-2.0-flash-live-001',
        config: {
          responseModalities: [Modality.AUDIO, Modality.TEXT],
          systemInstruction: SYSTEM_PROMPT,
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Charon' }, // Deep, calm voice
            },
          },
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
    // Extract text
    const textParts = message.serverContent?.modelTurn?.parts?.filter(p => p.text) || [];
    const audioParts = message.serverContent?.modelTurn?.parts?.filter(p => p.inlineData) || [];

    for (const part of textParts) {
      const text = part.text;
      if (!text) continue;

      // Parse inline commands from text
      const commands = this._parseCommands(text);
      const cleanText = this._stripCommands(text);

      this.mainWindow.webContents.send('agent-text', { text: cleanText, commands });
    }

    for (const part of audioParts) {
      // Forward raw audio to renderer for playback
      this.mainWindow.webContents.send('agent-audio', {
        data: part.inlineData.data,
        mimeType: part.inlineData.mimeType,
      });
    }

    if (message.serverContent?.turnComplete) {
      this.mainWindow.webContents.send('agent-turn-complete');
    }
  }

  _parseCommands(text) {
    const commands = [];

    // [HIGHLIGHT: selector_or_text]
    const highlightMatch = text.match(/\[HIGHLIGHT:\s*(.+?)\]/g);
    if (highlightMatch) {
      highlightMatch.forEach(m => {
        const val = m.match(/\[HIGHLIGHT:\s*(.+?)\]/)[1].trim();
        commands.push({ type: 'highlight', value: val });
      });
    }

    // [ANNOTATE: x,y: text]
    const annotateMatch = text.match(/\[ANNOTATE:\s*(\d+),(\d+):\s*(.+?)\]/g);
    if (annotateMatch) {
      annotateMatch.forEach(m => {
        const parts = m.match(/\[ANNOTATE:\s*(\d+),(\d+):\s*(.+?)\]/);
        commands.push({ type: 'annotate', x: parseInt(parts[1]), y: parseInt(parts[2]), text: parts[3] });
      });
    }

    // [SCROLL: text]
    const scrollMatch = text.match(/\[SCROLL:\s*(.+?)\]/g);
    if (scrollMatch) {
      scrollMatch.forEach(m => {
        const val = m.match(/\[SCROLL:\s*(.+?)\]/)[1].trim();
        commands.push({ type: 'scroll', value: val });
      });
    }

    return commands;
  }

  _stripCommands(text) {
    return text
      .replace(/\[HIGHLIGHT:\s*.+?\]/g, '')
      .replace(/\[ANNOTATE:\s*\d+,\d+:\s*.+?\]/g, '')
      .replace(/\[SCROLL:\s*.+?\]/g, '')
      .trim();
  }

  async sendScreenshot(base64Image) {
    if (!this.session || !this.connected) return;
    try {
      await this.session.sendMessage({
        turns: [{
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType: 'image/png',
                data: base64Image.replace(/^data:image\/\w+;base64,/, ''),
              },
            },
            { text: 'Here is what I am currently viewing. Offer a brief observation if anything is interesting, otherwise stay quiet. Keep it to 1-2 sentences max.' },
          ],
        }],
      });
    } catch (e) {
      console.error('[Gemini] Screenshot send failed:', e);
    }
  }

  async sendAudio(audioBase64, mimeType = 'audio/webm') {
    if (!this.session || !this.connected) return { error: 'Not connected' };
    try {
      // First send current screenshot for context
      // Then send audio
      await this.session.sendMessage({
        turns: [{
          role: 'user',
          parts: [{
            inlineData: {
              mimeType,
              data: audioBase64,
            },
          }],
        }],
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

  async sendScreenshotWithQuestion(base64Image, question) {
    if (!this.session || !this.connected) return;
    try {
      await this.session.sendMessage({
        turns: [{
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType: 'image/png',
                data: base64Image.replace(/^data:image\/\w+;base64,/, ''),
              },
            },
            { text: question },
          ],
        }],
      });
    } catch (e) {
      console.error('[Gemini] Q+Screenshot send failed:', e);
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
