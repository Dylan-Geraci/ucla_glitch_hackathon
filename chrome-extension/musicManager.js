// musicManager.js
// Adaptive background music via Lyria API — SCAFFOLDING ONLY, not yet integrated
//
// How it works:
//   1. On each screenshot cycle, detectMood() maps the current URL to a mood
//   2. If mood changed AND the screenshot was different, queue a mood switch
//   3. Current Lyria clip plays to completion (no abrupt cut)
//   4. On clip end: if a new mood is pending, generate + play that mood's clip
//      Otherwise, loop the current mood
//
// Integration points (in screenshotManager.js _capture):
//   const screenshotChanged = (hash !== this.lastScreenshotHash);
//   await musicManager.onCycle(currentUrl, pageTitle, screenshotChanged);

class MusicManager {
  constructor(mainWindow, ai) {
    this.mainWindow = mainWindow;
    this.ai = ai;            // GoogleGenAI instance — for Lyria calls
    this.currentMood = null;  // 'focus' | 'chill' | 'ambient' | 'mute' | null
    this.currentAudio = null; // Audio element playing the current clip
    this.isPlaying = false;
    this.pendingMood = null;  // mood to switch to after current clip finishes
    this.clipCache = new Map(); // mood -> { url: objectURL, buffer: ArrayBuffer }
    this.volume = 0.25;       // background level (0-1)
  }

  // ─── Mood Detection (URL heuristics) ──────────────────────────────────────

  static detectMood(url, pageTitle = '') {
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

    // Default
    return 'chill';
  }

  // Lyria prompt for each mood — instrumental only, 30s clips
  static moodPrompts = {
    focus:   'lo-fi instrumental hip hop beat, calm study music, soft piano and drums, no vocals, 30 seconds',
    chill:   'soft ambient electronic music, relaxing synth pads, gentle beat, no vocals, 30 seconds',
    ambient: 'peaceful ambient soundscape, slow evolving textures, gentle and warm, no vocals, 30 seconds',
  };

  // ─── Cycle Hook (called from screenshotManager._capture) ─────────────────

  async onCycle(url, pageTitle, screenshotChanged) {
    if (!screenshotChanged) return; // page looks the same, keep current music

    const newMood = MusicManager.detectMood(url, pageTitle);
    if (newMood === this.currentMood) return; // same mood, no action

    console.log(`[Music] Mood change detected: ${this.currentMood || 'none'} -> ${newMood}`);

    if (newMood === 'mute') {
      this.pendingMood = null;
      this._fadeOutAndStop();
      this.currentMood = 'mute';
      return;
    }

    if (!this.isPlaying || !this.currentAudio) {
      // Nothing playing — start immediately
      await this._playMood(newMood);
    } else {
      // Something playing — queue the new mood, current clip plays to the end
      this.pendingMood = newMood;
      console.log(`[Music] Queued "${newMood}" — waiting for current clip to finish`);
    }
  }

  // ─── Playback ─────────────────────────────────────────────────────────────

  async _playMood(mood) {
    this.currentMood = mood;

    // Check cache first
    let clipUrl = this.clipCache.get(mood);

    if (!clipUrl) {
      // TODO: Generate clip via Lyria API
      // clipUrl = await this._generateClip(mood);
      // this.clipCache.set(mood, clipUrl);
      console.log(`[Music] Would generate Lyria clip for mood: "${mood}"`);
      console.log(`[Music] Prompt: "${MusicManager.moodPrompts[mood]}"`);
      return; // Can't play yet — no Lyria integration
    }

    this.currentAudio = new Audio(clipUrl);
    this.currentAudio.volume = this.volume;
    this.currentAudio.onended = () => this._onClipEnded();
    this.currentAudio.onerror = (e) => {
      console.error('[Music] Playback error:', e);
      this.isPlaying = false;
    };

    try {
      await this.currentAudio.play();
      this.isPlaying = true;
      console.log(`[Music] Playing: ${mood}`);
    } catch (e) {
      console.error('[Music] Play failed:', e);
    }
  }

  _onClipEnded() {
    this.isPlaying = false;

    if (this.pendingMood && this.pendingMood !== this.currentMood) {
      // Mood changed while clip was playing — switch now
      const next = this.pendingMood;
      this.pendingMood = null;
      this._playMood(next);
    } else {
      // Same mood — loop
      this.pendingMood = null;
      this._playMood(this.currentMood);
    }
  }

  _fadeOutAndStop() {
    if (!this.currentAudio) {
      this.isPlaying = false;
      return;
    }

    // Gradual fade over 2 seconds
    const audio = this.currentAudio;
    const steps = 20;
    const stepTime = 2000 / steps;
    const volumeStep = audio.volume / steps;
    let step = 0;

    const fadeInterval = setInterval(() => {
      step++;
      audio.volume = Math.max(0, audio.volume - volumeStep);
      if (step >= steps) {
        clearInterval(fadeInterval);
        audio.pause();
        audio.currentTime = 0;
        this.isPlaying = false;
        this.currentAudio = null;
      }
    }, stepTime);
  }

  // ─── Lyria Generation (TODO) ──────────────────────────────────────────────

  async _generateClip(mood) {
    const prompt = MusicManager.moodPrompts[mood];
    if (!prompt) return null;

    // TODO: Uncomment when ready to integrate Lyria
    //
    // try {
    //   const result = await this.ai.models.generateContent({
    //     model: 'lyria-3-clip-preview',   // $0.04 per 30s clip
    //     contents: [{ role: 'user', parts: [{ text: prompt }] }],
    //   });
    //
    //   // Extract audio data from response
    //   const audioPart = result.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    //   if (!audioPart) return null;
    //
    //   // Convert to object URL for playback
    //   const binary = atob(audioPart.inlineData.data);
    //   const bytes = new Uint8Array(binary.length);
    //   for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    //   const blob = new Blob([bytes], { type: audioPart.inlineData.mimeType });
    //   const url = URL.createObjectURL(blob);
    //
    //   this.clipCache.set(mood, url);
    //   console.log(`[Music] Generated and cached clip for: ${mood}`);
    //   return url;
    // } catch (e) {
    //   console.error('[Music] Lyria generation failed:', e);
    //   return null;
    // }
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  stop() {
    this.pendingMood = null;
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
    this.isPlaying = false;
    this.currentMood = null;
  }

  setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, vol));
    if (this.currentAudio) this.currentAudio.volume = this.volume;
  }
}

module.exports = { MusicManager };
