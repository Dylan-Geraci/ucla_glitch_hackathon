// src/renderer/renderer.js
// Renderer process: UI logic, mic recording, audio playback, agent event handling

// ─── Elements ────────────────────────────────────────────────────────────────
const setupOverlay   = document.getElementById('setup-overlay');
const apiKeyInput    = document.getElementById('api-key-input');
const connectBtn     = document.getElementById('connect-btn');
const setupError     = document.getElementById('setup-error');

const backBtn        = document.getElementById('back-btn');
const fwdBtn         = document.getElementById('fwd-btn');
const reloadBtn      = document.getElementById('reload-btn');
const urlBar         = document.getElementById('url-bar');
const keyBtn         = document.getElementById('key-btn');

const statusDot      = document.getElementById('status-dot');
const agentToggle    = document.getElementById('agent-toggle');
const freqSlider     = document.getElementById('freq-slider');
const micBtn         = document.getElementById('mic-btn');
const commentary     = document.getElementById('commentary');
const screenshotFlash = document.getElementById('screenshot-flash');
const loadingDot     = document.getElementById('loading-dot');

// ─── State ───────────────────────────────────────────────────────────────────
let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];

// ─── Setup / Connect ─────────────────────────────────────────────────────────
connectBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) { setupError.textContent = 'Please enter an API key.'; return; }

  connectBtn.textContent = 'Connecting…';
  connectBtn.disabled = true;
  setupError.textContent = '';

  const result = await window.agent.initAgent({ apiKey: key });
  if (result.success) {
    setupOverlay.classList.add('hidden');
    localStorage.setItem('gemini_api_key', key);
  } else {
    setupError.textContent = result.error || 'Connection failed. Check your API key.';
    connectBtn.textContent = 'Connect Agent';
    connectBtn.disabled = false;
  }
});

// Auto-connect if key saved
window.addEventListener('DOMContentLoaded', async () => {
  const saved = localStorage.getItem('gemini_api_key');
  if (saved) {
    apiKeyInput.value = saved;
    connectBtn.click();
  }
});

// Allow pressing Enter on API key field
apiKeyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') connectBtn.click();
});

// ─── API Key Reset ────────────────────────────────────────────────────────────
keyBtn.addEventListener('click', () => {
  localStorage.removeItem('gemini_api_key');
  setupOverlay.classList.remove('hidden');
  apiKeyInput.value = '';
  connectBtn.textContent = 'Connect Agent';
  connectBtn.disabled = false;
  setupError.textContent = '';
});

// ─── Navigation ───────────────────────────────────────────────────────────────
backBtn.addEventListener('click', () => window.agent.goBack());
fwdBtn.addEventListener('click', () => window.agent.goForward());
reloadBtn.addEventListener('click', () => window.agent.reload());

urlBar.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    await window.agent.navigate(urlBar.value);
    urlBar.blur();
  }
});

window.agent.on('url-changed', ({ url } = {}) => {
  // The event data might be just the url string
  urlBar.value = typeof url === 'string' ? url : (arguments[0] || '');
});

window.agent.on('title-changed', () => {});

// Intercept the event correctly (the preload passes data directly)
window.agent.on('url-changed', (url) => {
  if (typeof url === 'string') urlBar.value = url;
});

// ─── Agent Toggle ─────────────────────────────────────────────────────────────
agentToggle.addEventListener('change', () => {
  window.agent.toggleAgent({ active: agentToggle.checked });
  setCommentary(agentToggle.checked ? 'Agent active — watching…' : 'Agent paused.', !agentToggle.checked);
});

// ─── Frequency Slider ─────────────────────────────────────────────────────────
freqSlider.addEventListener('input', () => {
  window.agent.setAgentFrequency({ value: parseFloat(freqSlider.value) });
});

// ─── Microphone / Voice Input ─────────────────────────────────────────────────
micBtn.addEventListener('mousedown', startRecording);
micBtn.addEventListener('mouseup', stopRecording);
micBtn.addEventListener('mouseleave', () => { if (isRecording) stopRecording(); });

// Touch support
micBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startRecording(); });
micBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopRecording(); });

async function startRecording() {
  if (isRecording) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      const arrayBuffer = await blob.arrayBuffer();
      // btoa in chunks to avoid call-stack overflow
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      const base64 = btoa(binary);
      setCommentary('Thinking…', false);
      window.agent.sendVoiceMessage({ audioBase64: base64, mimeType: 'audio/webm' });
    };

    mediaRecorder.start();
    isRecording = true;
    micBtn.classList.add('recording');
    statusDot.classList.add('recording');
    setCommentary('Listening…', false);
  } catch (e) {
    console.error('Mic error:', e);
    setCommentary('Microphone access denied.', true);
  }
}

function stopRecording() {
  if (!isRecording || !mediaRecorder) return;
  isRecording = false;
  mediaRecorder.stop();
  micBtn.classList.remove('recording');
  statusDot.classList.remove('recording');
}

// ─── Agent Events ─────────────────────────────────────────────────────────────
window.agent.on('agent-status', ({ connected }) => {
  if (connected) {
    statusDot.classList.add('connected');
    setCommentary('Connected. Ready.', false);
  } else {
    statusDot.classList.remove('connected');
    setCommentary('Disconnected.', true);
  }
});

window.agent.on('agent-text', ({ text }) => {
  if (!text) return;
  setCommentary(text, false);
  // Speak the response aloud using browser TTS
  window.speechSynthesis.cancel(); // stop any in-progress speech
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.05;
  utterance.onend = () => setCommentary('Agent active — watching…', false);
  window.speechSynthesis.speak(utterance);
});

window.agent.on('agent-turn-complete', () => {
  // Only reset if nothing is being spoken
  if (!window.speechSynthesis.speaking) {
    setCommentary('Agent active — watching…', false);
  }
});

window.agent.on('agent-error', ({ error }) => {
  setCommentary('Error: ' + error, true);
});

window.agent.on('screenshot-taken', () => {
  // Brief visual flash to indicate screenshot captured
  screenshotFlash.classList.remove('flash');
  void screenshotFlash.offsetWidth; // reflow to restart animation
  screenshotFlash.classList.add('flash');
  setTimeout(() => screenshotFlash.classList.remove('flash'), 500);
});

// ─── Execute Agent Commands (highlight / annotate / scroll) ───────────────────
async function executeCommands(commands) {
  for (const cmd of commands) {
    if (cmd.type === 'highlight') {
      // Try as CSS selector first, then as text scroll
      try {
        await window.agent.highlightSelector({ selector: cmd.value });
      } catch {
        await window.agent.scrollToText({ text: cmd.value });
      }
    } else if (cmd.type === 'annotate') {
      await window.agent.injectAnnotation({ text: cmd.text, x: cmd.x, y: cmd.y });
    } else if (cmd.type === 'scroll') {
      await window.agent.scrollToText({ text: cmd.value });
    }
  }
}


// ─── Helpers ──────────────────────────────────────────────────────────────────
function setCommentary(text, idle = false) {
  commentary.textContent = text;
  commentary.classList.toggle('idle', idle);
}
