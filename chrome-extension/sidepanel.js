// sidepanel.js — Side panel UI: mic, Gemini Live audio playback, agent events

// ─── Elements ────────────────────────────────────────────────────────────────
const setupOverlay   = document.getElementById('setup-overlay');
const apiKeyInput    = document.getElementById('api-key-input');
const connectBtn     = document.getElementById('connect-btn');
const setupError     = document.getElementById('setup-error');
const mainPanel      = document.getElementById('main-panel');

const statusDot      = document.getElementById('status-dot');
const agentToggle    = document.getElementById('agent-toggle');
const freqSlider     = document.getElementById('freq-slider');
const micBtn         = document.getElementById('mic-btn');
const commentary     = document.getElementById('commentary');
const screenshotFlash = document.getElementById('screenshot-flash');
const keyBtn         = document.getElementById('key-btn');
const textInput      = document.getElementById('text-input');
const sendBtn        = document.getElementById('send-btn');
const musicToggle    = document.getElementById('music-toggle');
const musicStatus    = document.getElementById('music-status');

// ─── State ───────────────────────────────────────────────────────────────────
let isRecording = false;
let musicAudio = null;
let currentMusicDataUrl = null;
let turnTimeout = null;

function startTurnTimeout(ms = 15000) {
  clearTurnTimeout();
  turnTimeout = setTimeout(() => {
    if (!isRecording) {
      setCommentary('Agent active — watching...', false);
    }
  }, ms);
}

function clearTurnTimeout() {
  if (turnTimeout) { clearTimeout(turnTimeout); turnTimeout = null; }
}

// ─── Gemini Voice Playback (PCM via AudioContext) ────────────────────────────
let playbackCtx = null;
let nextPlayTime = 0;

function initPlayback() {
  if (!playbackCtx || playbackCtx.state === 'closed') {
    playbackCtx = new AudioContext({ sampleRate: 24000 });
  }
}

function queuePCMAudio(base64Data) {
  initPlayback();
  if (playbackCtx.state === 'suspended') playbackCtx.resume();

  // Decode base64 → Int16 → Float32
  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

  const buffer = playbackCtx.createBuffer(1, float32.length, 24000);
  buffer.getChannelData(0).set(float32);

  const source = playbackCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(playbackCtx.destination);

  const now = playbackCtx.currentTime;
  const startAt = Math.max(now + 0.01, nextPlayTime);
  source.start(startAt);
  nextPlayTime = startAt + buffer.duration;
}

function stopVoicePlayback() {
  nextPlayTime = 0;
  if (playbackCtx) {
    playbackCtx.close().catch(() => {});
    playbackCtx = null;
  }
}

// ─── Persistent port to background ──────────────────────────────────────────
const port = chrome.runtime.connect({ name: 'sidepanel' });
port.onMessage.addListener(handleBackgroundMessage);

// ─── Setup / Connect ─────────────────────────────────────────────────────────
connectBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) { setupError.textContent = 'Please enter an API key.'; return; }

  connectBtn.textContent = 'Connecting...';
  connectBtn.disabled = true;
  setupError.textContent = '';

  chrome.runtime.sendMessage({ action: 'init-agent', apiKey: key }, (result) => {
    if (result?.success) {
      setupOverlay.classList.add('hidden');
      mainPanel.classList.add('active');
    } else {
      setupError.textContent = result?.error || 'Connection failed. Check your API key.';
      connectBtn.textContent = 'Connect Agent';
      connectBtn.disabled = false;
    }
  });
});

// Auto-connect if key saved
chrome.runtime.sendMessage({ action: 'get-api-key' }, (result) => {
  if (result?.apiKey) {
    apiKeyInput.value = result.apiKey;
    connectBtn.click();
  }
});

apiKeyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') connectBtn.click();
});

// ─── API Key Reset ───────────────────────────────────────────────────────────
keyBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'clear-api-key' });
  mainPanel.classList.remove('active');
  setupOverlay.classList.remove('hidden');
  apiKeyInput.value = '';
  connectBtn.textContent = 'Connect Agent';
  connectBtn.disabled = false;
  setupError.textContent = '';
  stopVoicePlayback();
});

// ─── Agent Toggle ────────────────────────────────────────────────────────────
agentToggle.addEventListener('change', () => {
  chrome.runtime.sendMessage({ action: 'toggle-agent', active: agentToggle.checked });
  setCommentary(agentToggle.checked ? 'Agent active — watching...' : 'Agent paused.', !agentToggle.checked);
});

// ─── Frequency Slider ────────────────────────────────────────────────────────
freqSlider.addEventListener('input', () => {
  chrome.runtime.sendMessage({ action: 'set-frequency', value: parseFloat(freqSlider.value) });
});

// ─── Music Toggle ────────────────────────────────────────────────────────────
musicToggle.addEventListener('change', () => {
  const enabled = musicToggle.checked;
  chrome.runtime.sendMessage({ action: 'toggle-music', enabled });
  if (!enabled) {
    stopMusicAudio();
    musicStatus.textContent = 'Off';
  } else {
    musicStatus.textContent = 'Loading...';
  }
});

// ─── Microphone / Voice Input ───────────────────────────────────────────────
micBtn.addEventListener('click', toggleRecording);

function toggleRecording() {
  if (isRecording) stopRecording();
  else startRecording();
}

async function startRecording() {
  if (isRecording) return;
  stopVoicePlayback(); // Stop any playing agent audio

  // Init playback context (needs user gesture)
  initPlayback();
  if (playbackCtx.state === 'suspended') playbackCtx.resume();

  chrome.runtime.sendMessage({ action: 'start-recording' }, (res) => {
    if (res?.error) {
      console.error('Mic error:', res.error);
      setCommentary('Opening mic permission page...', false);
      chrome.tabs.create({ url: chrome.runtime.getURL('mic-permission.html') });
      return;
    }
    isRecording = true;
    micBtn.classList.add('recording');
    statusDot.classList.add('recording');
    setCommentary('Listening... (click mic to stop)', false);
  });
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  chrome.runtime.sendMessage({ action: 'stop-recording' });
  micBtn.classList.remove('recording');
  statusDot.classList.remove('recording');
  setCommentary('Processing...', false);
  startTurnTimeout(); // Reset if no response in 15s
}

// ─── Text Input ──────────────────────────────────────────────────────────────
sendBtn.addEventListener('click', sendTextMessage);
textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendTextMessage();
});

function sendTextMessage() {
  const text = textInput.value.trim();
  if (!text) return;
  textInput.value = '';
  setCommentary('Thinking...', false);
  startTurnTimeout(); // Reset if no response in 15s
  chrome.runtime.sendMessage({ action: 'send-text', text });
}

// ─── Messages from Background (via port) ─────────────────────────────────────
function handleBackgroundMessage(msg) {
  switch (msg.type) {
    case 'agent-status':
      if (msg.connected) {
        statusDot.classList.add('connected');
        setCommentary('Connected. Ready.', false);
      } else {
        statusDot.classList.remove('connected');
        setCommentary('Disconnected.', true);
      }
      break;

    case 'agent-turn-start':
      // New response — clear any old queued audio
      stopVoicePlayback();
      break;

    case 'agent-text':
      if (!msg.text) break;
      setCommentary(msg.text, false);
      break;

    case 'agent-audio':
      if (msg.data) {
        queuePCMAudio(msg.data);
      }
      break;

    case 'agent-status-text':
      setCommentary(msg.text, false);
      break;

    case 'agent-turn-complete':
      clearTurnTimeout();
      setTimeout(() => {
        if (!isRecording) {
          setCommentary('Agent active — watching...', false);
        }
      }, 1500);
      break;

    case 'agent-error':
      setCommentary('Error: ' + msg.error, true);
      break;

    case 'screenshot-taken':
      screenshotFlash.classList.remove('flash');
      void screenshotFlash.offsetWidth;
      screenshotFlash.classList.add('flash');
      setTimeout(() => screenshotFlash.classList.remove('flash'), 500);
      break;

    case 'music-play': {
      const dataUrl = `data:${msg.mimeType};base64,${msg.audioData}`;
      if (musicAudio) {
        const old = musicAudio;
        fadeAudio(old, old.volume, 0, 5000, () => { old.pause(); });
        musicAudio = null;
      }
      const newAudio = createMusicAudio(dataUrl);
      newAudio.play().then(() => {
        musicStatus.textContent = msg.mood;
        fadeAudio(newAudio, 0, 0.25, 5000);
      }).catch(e => {
        console.error('[Music] Play failed:', e);
        musicStatus.textContent = 'Error';
      });
      musicAudio = newAudio;
      currentMusicDataUrl = dataUrl;
      break;
    }

    case 'music-stop':
      stopMusicAudio();
      musicStatus.textContent = musicToggle.checked ? 'Paused' : 'Off';
      break;
  }
}

// ─── Music Helpers ──────────────────────────────────────────────────────────

function createMusicAudio(dataUrl) {
  const audio = new Audio(dataUrl);
  audio.volume = 0;
  audio.loop = false;

  audio.onerror = (e) => {
    console.error('[Music] Playback error:', e);
    musicStatus.textContent = 'Error';
  };

  let looping = false;
  audio.addEventListener('timeupdate', () => {
    if (looping) return;
    if (!audio.duration || audio.duration - audio.currentTime > 3) return;
    if (musicAudio !== audio) return;
    looping = true;

    const clone = createMusicAudio(dataUrl);
    clone.play().then(() => {
      fadeAudio(clone, 0, 0.25, 3000);
      fadeAudio(audio, audio.volume, 0, 3000, () => { audio.pause(); });
    }).catch(() => {});
    musicAudio = clone;
    currentMusicDataUrl = dataUrl;
  });

  return audio;
}

function fadeAudio(audio, from, to, duration, onDone) {
  const steps = 50;
  const stepTime = duration / steps;
  const stepDelta = (to - from) / steps;
  let step = 0;
  audio.volume = Math.max(0, Math.min(1, from));
  const interval = setInterval(() => {
    step++;
    audio.volume = Math.max(0, Math.min(1, from + stepDelta * step));
    if (step >= steps) {
      clearInterval(interval);
      audio.volume = Math.max(0, Math.min(1, to));
      if (onDone) onDone();
    }
  }, stepTime);
}

function stopMusicAudio() {
  if (musicAudio) { musicAudio.pause(); musicAudio = null; }
  currentMusicDataUrl = null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function setCommentary(text, idle = false) {
  commentary.textContent = text;
  commentary.classList.toggle('idle', idle);
}
