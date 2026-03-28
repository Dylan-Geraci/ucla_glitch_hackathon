// musicManager.js
// Adaptive background music via Lyria API for Chrome Extension
//
// Flow:
//   1. background.js detects tab URL change → calls onCycle(url)
//   2. Mood detection maps URL to focus/chill/ambient/mute
//   3. If mood changed, generate clip via Lyria API (or use cache)
//   4. Send audio base64 to side panel for playback via onPlayAudio callback
//   5. Side panel plays it; notifies background when clip ends → loop or switch

const LYRIA_MODEL = 'lyria-3-clip-preview';
const LYRIA_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

class MusicManager {
  constructor(apiKey, onPlayAudio, onStopAudio) {
    this.apiKey = apiKey;
    this.onPlayAudio = onPlayAudio;   // callback(mood, base64, mimeType)
    this.onStopAudio = onStopAudio;   // callback()
    this.enabled = false;
    this.currentMood = null;
    this.pendingMood = null;
    this.isPlaying = false;
    this.generating = false;
    this.clipCache = new Map(); // mood -> { data: base64, mimeType: string }
  }

  // ─── Mood Detection (URL heuristics) ──────────────────────────────────────

  static detectMood(url) {
    let domain;
    try { domain = new URL(url).hostname.toLowerCase(); }
    catch { return 'chill'; }

    // Mute — sites with their own audio
    const muteDomains = [
      'youtube.com', 'netflix.com', 'spotify.com', 'twitch.tv',
      'soundcloud.com', 'music.apple.com', 'hulu.com', 'disneyplus.com',
    ];
    if (muteDomains.some(d => domain.includes(d))) return 'mute';

    // Focus — dev & productivity
    const focusDomains = [
      'github.com', 'gitlab.com', 'stackoverflow.com', 'codepen.io',
      'replit.com', 'docs.google.com', 'sheets.google.com', 'notion.so',
      'figma.com', 'linear.app', 'jira.atlassian.com',
    ];
    if (focusDomains.some(d => domain.includes(d))) return 'focus';

    // Ambient — reading & knowledge
    const ambientDomains = [
      'wikipedia.org', 'medium.com', 'arxiv.org', 'scholar.google.com',
      'bbc.com', 'nytimes.com', 'reuters.com', 'cnn.com', 'theguardian.com',
    ];
    if (ambientDomains.some(d => domain.includes(d))) return 'ambient';

    // Chill — social & shopping
    const chillDomains = [
      'reddit.com', 'twitter.com', 'x.com', 'instagram.com', 'facebook.com',
      'amazon.com', 'ebay.com', 'etsy.com',
    ];
    if (chillDomains.some(d => domain.includes(d))) return 'chill';

    return 'chill';
  }

  // Lyria prompts — instrumental only
  static moodPrompts = {
    focus:   'lo-fi instrumental hip hop beat, calm study music, soft piano and drums, no vocals, 30 seconds',
    chill:   'soft ambient electronic music, relaxing synth pads, gentle beat, no vocals, 30 seconds',
    ambient: 'peaceful ambient soundscape, slow evolving textures, gentle and warm, no vocals, 30 seconds',
  };

  // ─── Called on tab URL change ─────────────────────────────────────────────

  async onCycle(url) {
    if (!this.enabled) return;

    const newMood = MusicManager.detectMood(url);
    if (newMood === this.currentMood) return;

    console.log(`[Music] Mood change: ${this.currentMood || 'none'} -> ${newMood}`);

    if (newMood === 'mute') {
      this.pendingMood = null;
      this.currentMood = 'mute';
      this.isPlaying = false;
      this.onStopAudio();
      return;
    }

    if (!this.isPlaying && !this.generating) {
      await this._startMood(newMood);
    } else {
      // Something playing or generating — queue the new mood
      this.pendingMood = newMood;
      console.log(`[Music] Queued "${newMood}" — waiting for current clip to finish`);
    }
  }

  // ─── Generate + send clip to side panel ───────────────────────────────────

  async _startMood(mood) {
    this.currentMood = mood;

    // Check cache first
    let cached = this.clipCache.get(mood);

    if (!cached) {
      if (this.generating) {
        console.log('[Music] Already generating, skipping');
        return;
      }
      cached = await this._generateClip(mood);
      if (!cached) {
        console.error('[Music] Failed to generate clip for:', mood);
        return;
      }
      this.clipCache.set(mood, cached);

      // Check if mood changed while we were generating
      if (this.pendingMood && this.pendingMood !== mood) {
        const next = this.pendingMood;
        this.pendingMood = null;
        await this._startMood(next);
        return;
      }
    }

    this.isPlaying = true;
    this.pendingMood = null;
    this.onPlayAudio(mood, cached.data, cached.mimeType);
    console.log(`[Music] Playing: ${mood} (looping in side panel)`);
  }

  // ─── Lyria API call ───────────────────────────────────────────────────────

  async _generateClip(mood) {
    const prompt = MusicManager.moodPrompts[mood];
    if (!prompt) return null;

    this.generating = true;
    console.log(`[Music] Generating Lyria clip for: "${mood}"...`);

    try {
      const url = `${LYRIA_API_BASE}/${LYRIA_MODEL}:generateContent?key=${this.apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
          },
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Lyria API ${res.status}: ${err}`);
      }

      const data = await res.json();
      console.log('[Music] Lyria raw response:', JSON.stringify(data).slice(0, 500));
      const audioPart = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (!audioPart) {
        throw new Error('No audio data in Lyria response');
      }

      console.log(`[Music] Generated clip for "${mood}" (${audioPart.inlineData.mimeType})`);
      return {
        data: audioPart.inlineData.data,
        mimeType: audioPart.inlineData.mimeType,
      };
    } catch (e) {
      console.error('[Music] Lyria generation failed:', e);
      return null;
    } finally {
      this.generating = false;
    }
  }

  // ─── Controls ─────────────────────────────────────────────────────────────

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) {
      this.isPlaying = false;
      this.pendingMood = null;
      this.onStopAudio();
    }
  }

  stop() {
    this.enabled = false;
    this.isPlaying = false;
    this.pendingMood = null;
    this.currentMood = null;
    this.onStopAudio();
  }
}
