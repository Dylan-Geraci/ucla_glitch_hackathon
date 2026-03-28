// content.js — Injected into every page for DOM operations

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'highlight_answer') {
    const result = highlightAnswer(msg.text);
    sendResponse({ found: result });
  } else if (msg.type === 'scroll_to_text') {
    const result = scrollToText(msg.text);
    sendResponse({ found: result });
  } else if (msg.type === 'get_page_text') {
    sendResponse({ text: document.body.innerText.slice(0, 8000) });
  } else if (msg.type === 'inject_annotation') {
    injectAnnotation(msg.text, msg.x, msg.y, msg.duration);
    sendResponse({ ok: true });
  }
  return false; // synchronous response
});

function highlightAnswer(searchText) {
  function normalize(s) {
    return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  }
  const normalized = normalize(searchText);
  const keywords = normalized.split(' ').filter(w => w.length >= 3).slice(0, 5);
  if (keywords.length === 0) return false;

  const candidates = document.querySelectorAll(
    'p, h1, h2, h3, h4, h5, h6, li, td, th, dd, blockquote, figcaption'
  );
  let best = null;
  let bestScore = 0;

  for (const el of candidates) {
    const norm = normalize(el.innerText);
    const score = keywords.filter(w => norm.includes(w)).length;
    if (score > bestScore && score >= Math.min(3, keywords.length)) {
      best = el;
      bestScore = score;
    }
  }
  if (!best) return false;

  const prev = best.style.cssText;
  best.style.cssText += ';outline:3px solid #00E5FF !important;box-shadow:0 0 20px rgba(0,229,255,0.5) !important;background-color:rgba(0,229,255,0.15) !important;transition:all 0.3s ease !important;border-radius:4px !important;';
  best.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => { best.style.cssText = prev; }, 5000);
  return true;
}

function scrollToText(text) {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.textContent.toLowerCase().includes(text.toLowerCase())) {
      const el = node.parentElement;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const prev = el.style.background;
      el.style.background = 'rgba(0,229,255,0.15)';
      setTimeout(() => { el.style.background = prev; }, 3000);
      return true;
    }
  }
  return false;
}

function injectAnnotation(text, x, y, duration = 4000) {
  const div = document.createElement('div');
  div.style.cssText = `
    position: fixed;
    left: ${x}px; top: ${y}px;
    background: rgba(10,10,20,0.92);
    color: #c8f7e8;
    font-family: 'Courier New', monospace;
    font-size: 13px;
    padding: 8px 14px;
    border-radius: 8px;
    border: 1px solid #3dffa0;
    box-shadow: 0 0 20px #3dffa040;
    z-index: 2147483647;
    max-width: 320px;
    pointer-events: none;
    animation: agentFadeIn 0.3s ease;
  `;
  div.textContent = text;

  const style = document.createElement('style');
  style.textContent = '@keyframes agentFadeIn { from { opacity:0; transform:translateY(-8px); } to { opacity:1; transform:translateY(0); } }';
  document.head.appendChild(style);
  document.body.appendChild(div);
  setTimeout(() => div.remove(), duration);
}
