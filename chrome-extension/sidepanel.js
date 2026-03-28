// sidepanel.js — Side panel UI: mic recording, TTS, agent events

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
let musicAudio = null; // Audio element for background music

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

// Enter to connect
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
    // Stop audio immediately in the side panel (don't wait for round-trip)
    stopMusicAudio();
    musicStatus.textContent = 'Off';
  } else {
    musicStatus.textContent = 'Loading...';
  }
});

// ─── Microphone / Voice Input (toggle mode) ─────────────────────────────────
// Click once to start, click again to stop
micBtn.addEventListener('click', toggleRecording);

function toggleRecording() {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}

async function startRecording() {
  if (isRecording) return;
  // Immediately stop any agent speech so it doesn't talk over the user
  window.speechSynthesis.cancel();

  // Recording happens in the offscreen document via background
  chrome.runtime.sendMessage({ action: 'start-recording' }, (res) => {
    if (res?.error) {
      console.error('Mic error:', res.error);
      // Permission not granted yet — open the permission tab
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
  setCommentary('Thinking...', false);
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

    case 'agent-text':
      if (!msg.text) break;
      setCommentary(msg.text, false);
      // Speak the response aloud using browser TTS
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(msg.text);
      utterance.rate = 1.0;
      const voices = window.speechSynthesis.getVoices();
      const preferred = voices.find(v => v.name.includes('Samantha') || v.name.includes('Daniel'))
        || voices.find(v => v.lang.startsWith('en') && v.localService)
        || voices[0];
      if (preferred) utterance.voice = preferred;
      utterance.onend = () => setCommentary('Agent active — watching...', false);
      window.speechSynthesis.speak(utterance);
      break;

    case 'agent-turn-complete':
      if (!window.speechSynthesis.speaking) {
        setCommentary('Agent active — watching...', false);
      }
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
      // Crossfade: fade out old clip over 5s while fading in new clip
      const dataUrl = `data:${msg.mimeType};base64,${msg.audioData}`;
      const newAudio = new Audio(dataUrl);
      newAudio.volume = 0;
      newAudio.loop = true;
      newAudio.onerror = (e) => {
        console.error('[Music] Playback error:', e);
        musicStatus.textContent = 'Error';
      };

      // Fade out old audio over 5 seconds
      if (musicAudio) {
        fadeAudio(musicAudio, musicAudio.volume, 0, 5000, () => {
          musicAudio.pause();
        });
      }

      // Start new audio and fade in over 5 seconds
      newAudio.play().then(() => {
        musicStatus.textContent = msg.mood;
        fadeAudio(newAudio, 0, 0.25, 5000);
      }).catch(e => {
        console.error('[Music] Play failed:', e);
        musicStatus.textContent = 'Error';
      });

      musicAudio = newAudio;
      break;
    }

    case 'music-stop':
      stopMusicAudio();
      musicStatus.textContent = musicToggle.checked ? 'Paused' : 'Off';
      break;
  }
}

// ─── Music Helpers ──────────────────────────────────────────────────────────
function fadeAudio(audio, from, to, duration, onDone) {
  const steps = 50;
  const stepTime = duration / steps;
  const stepDelta = (to - from) / steps;
  let step = 0;
  audio.volume = from;
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
  if (musicAudio) {
    musicAudio.pause();
    musicAudio = null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function setCommentary(text, idle = false) {
  commentary.textContent = text;
  commentary.classList.toggle('idle', idle);
}
