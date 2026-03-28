document.getElementById('allow-btn').addEventListener('click', async () => {
  const status = document.getElementById('status');
  status.textContent = 'Requesting...';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    status.textContent = 'Microphone granted! You can close this tab.';
    status.style.color = '#3dffa0';
    // Notify background that permission was granted
    chrome.runtime.sendMessage({ action: 'mic-permission-granted' });
    setTimeout(() => window.close(), 1500);
  } catch (e) {
    status.textContent = 'Denied: ' + e.name + ' — ' + e.message;
    status.style.color = '#ff4d6a';
  }
});
