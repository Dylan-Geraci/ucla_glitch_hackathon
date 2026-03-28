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
let recordingStream = null;
let recordingCtx = null;
let recordingProcessor = null;
let pcmChunks = [];
let audioQueue = [];
let isPlayingAudio = false;

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
    recordingStream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true },
    });
    pcmChunks = [];

    // ScriptProcessor captures raw PCM at 16kHz — Gemini Live requires this format
    recordingCtx = new AudioContext({ sampleRate: 16000 });
    const source = recordingCtx.createMediaStreamSource(recordingStream);
    recordingProcessor = recordingCtx.createScriptProcessor(4096, 1, 1);

    recordingProcessor.onaudioprocess = (e) => {
      const float32 = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768));
      }
      pcmChunks.push(int16);
    };

    // Silent gain node: ScriptProcessor must connect to destination to fire, but we don't want feedback
    const silence = recordingCtx.createGain();
    silence.gain.value = 0;
    source.connect(recordingProcessor);
    recordingProcessor.connect(silence);
    silence.connect(recordingCtx.destination);

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
  if (!isRecording || !recordingProcessor) return;
  isRecording = false;
  micBtn.classList.remove('recording');
  statusDot.classList.remove('recording');

  recordingProcessor.disconnect();
  recordingStream.getTracks().forEach(t => t.stop());
  recordingCtx.close();

  // Combine all PCM chunks and base64-encode
  const totalLen = pcmChunks.reduce((sum, c) => sum + c.length, 0);
  const combined = new Int16Array(totalLen);
  let offset = 0;
  for (const chunk of pcmChunks) { combined.set(chunk, offset); offset += chunk.length; }

  // btoa in chunks to avoid call-stack overflow on large buffers
  const bytes = new Uint8Array(combined.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  const base64 = btoa(binary);

  setCommentary('Thinking…', false);
  window.agent.sendVoiceMessage({ audioBase64: base64, mimeType: 'audio/pcm;rate=16000' });

  recordingStream = null;
  recordingCtx = null;
  recordingProcessor = null;
  pcmChunks = [];
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

window.agent.on('agent-text', ({ text, commands }) => {
  if (text) setCommentary(text, false);
  if (commands && commands.length > 0) executeCommands(commands);
});

window.agent.on('agent-audio', ({ data, mimeType }) => {
  setCommentary('Speaking…', false);
  enqueueAudio(data, mimeType);
});

window.agent.on('agent-turn-complete', () => {
  // If no audio queued, turn is text-only or empty — reset commentary
  if (audioQueue.length === 0 && !isPlayingAudio) {
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

// ─── Audio Playback Queue ─────────────────────────────────────────────────────
function enqueueAudio(base64Data, mimeType) {
  audioQueue.push({ base64Data, mimeType });
  if (!isPlayingAudio) playNextAudio();
}

async function playNextAudio() {
  if (audioQueue.length === 0) { isPlayingAudio = false; return; }
  isPlayingAudio = true;

  const { base64Data } = audioQueue.shift();
  try {
    // Gemini returns raw PCM Int16 LE at 24kHz — browsers can't play this with new Audio()
    // Decode manually: base64 → Int16 → Float32 → AudioContext buffer
    const binary = atob(base64Data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0;

    const audioCtx = new AudioContext({ sampleRate: 24000 });
    const buffer = audioCtx.createBuffer(1, float32.length, 24000);
    buffer.getChannelData(0).set(float32);

    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);
    source.onended = () => {
      audioCtx.close();
      if (audioQueue.length === 0) {
        isPlayingAudio = false;
        setCommentary('Agent active — watching…', false);
      } else {
        playNextAudio();
      }
    };
    source.start();
  } catch (e) {
    console.error('Audio playback error:', e);
    playNextAudio();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function setCommentary(text, idle = false) {
  commentary.textContent = text;
  commentary.classList.toggle('idle', idle);
}
