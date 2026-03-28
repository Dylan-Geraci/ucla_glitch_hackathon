// offscreen.js — Runs in an offscreen document for mic recording
// This has full DOM access and can use getUserMedia reliably

let mediaRecorder = null;
let audioChunks = [];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  if (msg.action === 'start-recording') {
    startRecording().then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ error: e.name + ': ' + (e.message || 'Permission denied') }));
    return true; // async
  }

  if (msg.action === 'stop-recording') {
    stopRecording();
    sendResponse({ ok: true });
  }
});

async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  audioChunks = [];

  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus' : 'audio/webm';
  mediaRecorder = new MediaRecorder(stream, { mimeType });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    const blob = new Blob(audioChunks, { type: 'audio/webm' });
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    const base64 = btoa(binary);

    // Send recorded audio to background for Gemini processing
    chrome.runtime.sendMessage({
      target: 'background',
      action: 'audio-recorded',
      audioBase64: base64,
      mimeType: 'audio/webm',
    });
  };

  mediaRecorder.start();
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
}
