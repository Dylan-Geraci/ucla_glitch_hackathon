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
    this.regenTimer = null; // 30s regeneration timer
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

  // Lyria prompt templates — instrumental only, with variations for variety
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
      this._clearRegenTimer();
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
    this._clearRegenTimer();

    if (this.generating) {
      console.log('[Music] Already generating, skipping');
      return;
    }

    const clip = await this._generateClip(mood);
    if (!clip) {
      console.error('[Music] Failed to generate clip for:', mood);
      return;
    }

    // Check if mood changed while we were generating
    if (this.pendingMood && this.pendingMood !== mood) {
      const next = this.pendingMood;
      this.pendingMood = null;
      await this._startMood(next);
      return;
    }

    this.isPlaying = true;
    this.pendingMood = null;
    this.onPlayAudio(mood, clip.data, clip.mimeType);
    console.log(`[Music] Playing: ${mood}`);

    // Schedule next clip generation in 30s (crossfades in side panel)
    this._scheduleRegen();
  }

  _scheduleRegen() {
    this._clearRegenTimer();
    this.regenTimer = setTimeout(() => this._regenClip(), 30000);
  }

  _clearRegenTimer() {
    if (this.regenTimer) {
      clearTimeout(this.regenTimer);
      this.regenTimer = null;
    }
  }

  async _regenClip() {
    if (!this.enabled || !this.isPlaying || !this.currentMood || this.currentMood === 'mute') return;

    // If mood changed while waiting, switch to the new mood
    if (this.pendingMood) {
      const next = this.pendingMood;
      this.pendingMood = null;
      await this._startMood(next);
      return;
    }

    const mood = this.currentMood;
    console.log(`[Music] Regenerating fresh clip for: "${mood}"`);

    const clip = await this._generateClip(mood);
    if (!clip) {
      console.error('[Music] Regen failed, scheduling retry');
      this._scheduleRegen();
      return;
    }

    // Check if still the same mood after generation
    if (this.currentMood !== mood || !this.enabled) return;

    this.onPlayAudio(mood, clip.data, clip.mimeType);
    console.log(`[Music] Fresh clip playing: ${mood}`);
    this._scheduleRegen();
  }

  // ─── Lyria API call ───────────────────────────────────────────────────────

  async _generateClip(mood) {
    const prompt = MusicManager.getPrompt(mood);
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
      this._clearRegenTimer();
      this.isPlaying = false;
      this.generating = false; // Reset so re-enable isn't blocked by stale flag
      this.pendingMood = null;
      this.currentMood = null;
      this.onStopAudio();
    }
  }

  // Called when re-enabling — bypasses onCycle's guards and starts fresh
  async startForUrl(url) {
    if (!this.enabled) return;
    const mood = MusicManager.detectMood(url);
    if (mood === 'mute') return;
    // Force reset state so nothing blocks us
    this.isPlaying = false;
    this.generating = false;
    this.pendingMood = null;
    this.currentMood = null;
    await this._startMood(mood);
  }

  stop() {
    this._clearRegenTimer();
    this.enabled = false;
    this.isPlaying = false;
    this.generating = false;
    this.pendingMood = null;
    this.currentMood = null;
    this.onStopAudio();
  }
}
