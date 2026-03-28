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
const volumeSlider   = document.getElementById('volume-slider');
const micBtn         = document.getElementById('mic-btn');
const historyContainer = document.getElementById('history-container');
const screenshotFlash = document.getElementById('screenshot-flash');
const keyBtn         = document.getElementById('key-btn');
const textInput      = document.getElementById('text-input');
const sendBtn        = document.getElementById('send-btn');
const musicToggle    = document.getElementById('music-toggle');
const musicStatus    = document.getElementById('music-status');
const agentThinking  = document.getElementById('agent-thinking');

// ─── State ───────────────────────────────────────────────────────────────────
let isRecording = false;
let musicAudio = null;
let musicVol = 0.25;
let currentMusicDataUrl = null;
let turnTimeout = null;
let chatHistory = []; // { role: 'user'|'agent'|'status', text: string }

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
  if (playbackCtx.state === 'suspended') {
    playbackCtx.resume().catch(e => console.warn('Audio resume failed:', e));
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
      initPlayback(); // Prime audio on successful connection
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
  loadHistory();
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
  const active = agentToggle.checked;
  if (active) initPlayback(); // Prime audio on toggle
  chrome.storage.local.set({ agentActive: active });
  chrome.runtime.sendMessage({ action: 'toggle-agent', active });
  if (active) addMessage('status', 'Agent active — watching...');
  else addMessage('status', 'Agent paused.');
});

// ─── Frequency Slider ────────────────────────────────────────────────────────
freqSlider.addEventListener('input', () => {
  const value = parseFloat(freqSlider.value);
  chrome.storage.local.set({ agentFreq: value });
  chrome.runtime.sendMessage({ action: 'set-frequency', value });
});

// Load settings
chrome.storage.local.get(['agentActive', 'agentFreq', 'musicVol'], (data) => {
  if (data.agentActive !== undefined) {
    agentToggle.checked = data.agentActive;
    chrome.runtime.sendMessage({ action: 'toggle-agent', active: data.agentActive });
  }
  if (data.agentFreq !== undefined) {
    freqSlider.value = data.agentFreq;
    chrome.runtime.sendMessage({ action: 'set-frequency', value: data.agentFreq });
  }
  if (data.musicVol !== undefined) {
    musicVol = data.musicVol;
    volumeSlider.value = musicVol;
  }
});

// ─── Volume Slider ──────────────────────────────────────────────────────────
volumeSlider.addEventListener('input', () => {
  musicVol = parseFloat(volumeSlider.value);
  chrome.storage.local.set({ musicVol });
  if (musicAudio) {
    musicAudio.volume = musicVol;
  }
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
  initPlayback(); // Prime audio on text send
  textInput.value = '';
  addMessage('user', text);
  if (agentThinking) agentThinking.classList.remove('hidden');
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
      if (agentThinking) agentThinking.classList.remove('hidden');
      stopVoicePlayback();
      break;

    case 'agent-text':
      if (!msg.text || msg.text === 'Thinking...') break;
      addMessage('agent', msg.text);
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
      if (agentThinking) agentThinking.classList.add('hidden');
      clearTurnTimeout();
      setTimeout(() => {
        if (!isRecording) {
          setCommentary('GEORGE_LIVE: WATCHING', false);
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
        musicStatus.textContent = `BPM: ${msg.mood.toUpperCase()}`;
        fadeAudio(newAudio, 0, musicVol, 5000);
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
      musicStatus.textContent = musicToggle.checked ? 'BPM: PAUSED' : 'BPM: OFF';
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
      fadeAudio(clone, 0, musicVol, 3000);
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

// ─── History Management ─────────────────────────────────────────────────────

function addMessage(role, text) {
  if (!text) return;
  
  // Status messages are temporary and shouldn't bloat history if possible,
  if (role !== 'status') {
    chatHistory.push({ role, text });
    if (chatHistory.length > 50) chatHistory.shift();
    saveHistory();
  } else {
    // If it's a status message, we might want to show it in the thinking/status area
    if (agentThinking) {
      agentThinking.textContent = text.toUpperCase();
      agentThinking.classList.remove('hidden');
    }
    return; // Don't render status in chat history for this design
  }

  renderMessage(role, text);
}

function renderMessage(role, text) {
  const div = document.createElement('div');
  div.className = `message ${role}-msg`;
  div.textContent = text;
  
  // Remove any existing status or thinking messages
  if (role === 'status') {
    const existing = historyContainer.querySelectorAll('.status-msg');
    existing.forEach(el => el.remove());
  }

  historyContainer.appendChild(div);
  historyContainer.scrollTop = historyContainer.scrollHeight;
}

function saveHistory() {
  chrome.storage.local.set({ chatHistory });
}

function loadHistory() {
  chrome.storage.local.get('chatHistory', (data) => {
    if (data.chatHistory) {
      chatHistory = data.chatHistory;
      historyContainer.innerHTML = '';
      chatHistory.forEach(m => renderMessage(m.role, m.text));
    }
  });
}

function clearHistory() {
  chatHistory = [];
  chrome.storage.local.remove('chatHistory');
  historyContainer.innerHTML = '<div class="welcome-msg">History cleared. Agent standing by...</div>';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function setCommentary(text, idle = false) {
  // Backwards compatibility or direct status updates
  if (idle && !text.includes('Listening')) {
    // Just a status update
    addMessage('status', text);
  } else {
    // If it's a specific instruction, treat as agent message
    addMessage('status', text);
  }
}
