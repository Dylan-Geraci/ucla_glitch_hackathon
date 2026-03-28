// musicManager.js
// Adaptive background music via Lyria API for Chrome Extension
//
// Flow:
//   1. background.js detects tab URL change → calls onCycle(url)
//   2. Mood detection maps URL to focus/chill/ambient/mute
//   3. Generate clip via Lyria API, send base64 to side panel for playback
//   4. Every 30s, generate a fresh clip and crossfade (handled by side panel)

const LYRIA_MODEL = 'lyria-3-clip-preview';
const LYRIA_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

class MusicManager {
  constructor(apiKey, onPlayAudio, onStopAudio) {
    this.apiKey = apiKey;
    this.onPlayAudio = onPlayAudio;   // callback(mood, base64, mimeType)
    this.onStopAudio = onStopAudio;   // callback()
    this.enabled = false;
    this.currentMood = null;
    this.regenTimer = null;
    this.sessionId = 0; // Incremented on each fresh start to cancel stale async work
  }

  // ─── Mood Detection (URL heuristics) ──────────────────────────────────────

  static detectMood(url) {
    let domain;
    try { domain = new URL(url).hostname.toLowerCase(); }
    catch { return 'chill'; }

    const muteDomains = [
      'youtube.com', 'netflix.com', 'spotify.com', 'twitch.tv',
      'soundcloud.com', 'music.apple.com', 'hulu.com', 'disneyplus.com',
    ];
    if (muteDomains.some(d => domain.includes(d))) return 'mute';

    const focusDomains = [
      'github.com', 'gitlab.com', 'stackoverflow.com', 'codepen.io',
      'replit.com', 'docs.google.com', 'sheets.google.com', 'notion.so',
      'figma.com', 'linear.app', 'jira.atlassian.com',
    ];
    if (focusDomains.some(d => domain.includes(d))) return 'focus';

    const ambientDomains = [
      'wikipedia.org', 'medium.com', 'arxiv.org', 'scholar.google.com',
      'bbc.com', 'nytimes.com', 'reuters.com', 'cnn.com', 'theguardian.com',
    ];
    if (ambientDomains.some(d => domain.includes(d))) return 'ambient';

    const chillDomains = [
      'reddit.com', 'twitter.com', 'x.com', 'instagram.com', 'facebook.com',
      'amazon.com', 'ebay.com', 'etsy.com',
    ];
    if (chillDomains.some(d => domain.includes(d))) return 'chill';

    return 'chill';
  }

  // Lyria prompt variations for variety
  static moodPromptBases = {
    focus: [
      'lo-fi instrumental hip hop beat, calm study music, soft piano and drums',
      'lo-fi jazz hop instrumental, mellow keys and vinyl crackle, steady boom bap drums',
      'chill instrumental beat, acoustic guitar loops and soft snare, warm lo-fi feel',
      'mellow instrumental hip hop, Rhodes piano chords and tape hiss, relaxed groove',
      'downtempo lo-fi beat, gentle flute melody over soft drums, cozy study vibe',
    ],
    chill: [
      'soft ambient electronic music, relaxing synth pads, gentle beat',
      'dreamy chillwave instrumental, lush reverb synths, slow tempo groove',
      'smooth downtempo electronica, warm bass and airy pads, easy listening',
      'chillhop instrumental, mellow vibes with soft percussion and floating melodies',
      'laid-back electronic instrumental, gentle arpeggios and deep sub bass, calm mood',
    ],
    ambient: [
      'peaceful ambient soundscape, slow evolving textures, gentle and warm',
      'serene ambient music, soft drones and distant chimes, meditative feel',
      'calm ambient instrumental, ocean-like pads and subtle harmonics, tranquil',
      'ethereal ambient soundscape, shimmering tones and deep reverb, weightless',
      'minimalist ambient music, sparse piano notes over warm pad layers, contemplative',
    ],
  };

  static getPrompt(mood) {
    const bases = MusicManager.moodPromptBases[mood];
    if (!bases) return null;
    const base = bases[Math.floor(Math.random() * bases.length)];
    return `${base}, no vocals, 30 seconds`;
  }

  // ─── Called on tab URL change ─────────────────────────────────────────────

  async onCycle(url) {
    if (!this.enabled) return;
    const newMood = MusicManager.detectMood(url);
    if (newMood === this.currentMood) return;

    console.log(`[Music] Mood change: ${this.currentMood || 'none'} -> ${newMood}`);

    if (newMood === 'mute') {
      this._stopSession();
      this.currentMood = 'mute';
      return;
    }

    // Start a brand new session for the new mood
    this._startSession(newMood);
  }

  // ─── Called when toggling on — always starts fresh ────────────────────────

  async startForUrl(url) {
    if (!this.enabled) return;
    const mood = MusicManager.detectMood(url);
    if (mood === 'mute') return;
    this._startSession(mood);
  }

  // ─── Session management ───────────────────────────────────────────────────

  _startSession(mood) {
    // Increment session ID — any in-flight work from old sessions will bail out
    this.sessionId++;
    const sid = this.sessionId;
    this._clearRegenTimer();
    this.currentMood = mood;

    console.log(`[Music] Starting session ${sid} for mood: ${mood}`);

    // Fire and forget — the session ID guards all continuations
    this._generateAndPlay(mood, sid);
  }

  _stopSession() {
    this.sessionId++; // Invalidate any in-flight work
    this._clearRegenTimer();
    this.currentMood = null;
    this.onStopAudio();
  }

  async _generateAndPlay(mood, sid) {
    const clip = await this._generateClip(mood);

    // Bail if session changed while we were generating
    if (this.sessionId !== sid) {
      console.log(`[Music] Session ${sid} expired, discarding clip`);
      return;
    }

    if (!clip) {
      console.error(`[Music] Session ${sid}: generation failed for "${mood}"`);
      return;
    }

    this.onPlayAudio(mood, clip.data, clip.mimeType);
    console.log(`[Music] Session ${sid}: playing "${mood}"`);

    // Schedule next fresh clip in 30s
    this._clearRegenTimer();
    this.regenTimer = setTimeout(() => {
      if (this.sessionId !== sid || !this.enabled) return;
      console.log(`[Music] Session ${sid}: regenerating fresh clip`);
      this._generateAndPlay(mood, sid);
    }, 30000);
  }

  // ─── Lyria API call ───────────────────────────────────────────────────────

  async _generateClip(mood) {
    const prompt = MusicManager.getPrompt(mood);
    if (!prompt) return null;

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
    }
  }

  _clearRegenTimer() {
    if (this.regenTimer) {
      clearTimeout(this.regenTimer);
      this.regenTimer = null;
    }
  }

  // ─── Controls ─────────────────────────────────────────────────────────────

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) {
      this._stopSession();
    }
  }

  stop() {
    this.enabled = false;
    this._stopSession();
  }
}
