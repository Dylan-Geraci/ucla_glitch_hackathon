// offscreen.js — Captures mic audio as PCM 16kHz mono, streams chunks to background
// Uses ScriptProcessorNode (deprecated but works, no CSP issues unlike AudioWorklet)

let audioContext = null;
let mediaStream = null;
let sourceNode = null;
let scriptNode = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  if (msg.action === 'start-recording') {
    startStreaming()
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ error: e.name + ': ' + (e.message || 'Permission denied') }));
    return true;
  }

  if (msg.action === 'stop-recording') {
    stopStreaming();
    sendResponse({ ok: true });
  }
});

async function ensureMicAccess() {
  if (mediaStream && mediaStream.getTracks().every(t => t.readyState === 'live')) return;
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true }
  });
}

async function ensureAudioContext() {
  if (audioContext && audioContext.state !== 'closed') {
    if (audioContext.state === 'suspended') await audioContext.resume();
    return;
  }
  audioContext = new AudioContext({ sampleRate: 16000 });
}

async function startStreaming() {
  if (scriptNode) return;

  await ensureMicAccess();
  await ensureAudioContext();

  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  // 4096 samples at 16kHz = ~256ms per chunk
  scriptNode = audioContext.createScriptProcessor(4096, 1, 1);

  scriptNode.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    const int16 = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      int16[i] = Math.max(-32768, Math.min(32767, Math.round(input[i] * 32767)));
    }
    const bytes = new Uint8Array(int16.buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    chrome.runtime.sendMessage({
      target: 'background',
      action: 'audio-chunk',
      data: btoa(binary),
    });
  };

  sourceNode.connect(scriptNode);
  scriptNode.connect(audioContext.destination);
  console.log('[Offscreen] PCM streaming started (16kHz mono)');
}

function stopStreaming() {
  if (scriptNode) {
    scriptNode.onaudioprocess = null;
    scriptNode.disconnect();
    scriptNode = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  // Keep audioContext + mediaStream alive to avoid re-prompting permission
  console.log('[Offscreen] PCM streaming paused');
}
