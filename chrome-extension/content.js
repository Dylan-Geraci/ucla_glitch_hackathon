// content.js — Injected into every page for DOM operations

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[Content] Received:', msg.type, msg);
  if (msg.type === 'highlight_answer') {
    const result = highlightAnswer(msg.text);
    sendResponse({ found: result });
  } else if (msg.type === 'scroll_to_text') {
    const result = scrollToText(msg.text);
    sendResponse({ found: result });
  } else if (msg.type === 'get_page_text') {
    sendResponse({ text: getStructuredPageText() });
  } else if (msg.type === 'click_element') {
    const result = clickElement(msg.text);
    sendResponse({ found: result });
  } else if (msg.type === 'inject_annotation') {
    injectAnnotation(msg.text, msg.x, msg.y, msg.duration);
    sendResponse({ ok: true });
  } else if (msg.type === 'annotate_element') {
    const res = annotateElement(msg.target, msg.text);
    sendResponse({ found: res });
  }
  return false;
});

function findElement(searchText) {
  const normalize = s => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const target = normalize(searchText);
  console.log('[Content] normalize search:', target);

  // Helper to search deep (including Shadow DOM)
  function findDeep(root, targetLabel, targetText) {
    const labeled = root.querySelector(`[data-agent-label="${targetLabel}"]`);
    if (labeled) return labeled;

    const selectors = 'button, a, input, label, [role="button"], [role="tab"], [onclick], h1, h2, h3, h4, p, span, div';
    const elements = root.querySelectorAll(selectors);
    let best = null;
    let bestScore = 0;

    for (const el of elements) {
      if (el.shadowRoot) {
        const found = findDeep(el.shadowRoot, targetLabel, targetText);
        if (found) return found;
      }
      
      const texts = [
        el.innerText, el.value, el.getAttribute('aria-label'), el.title, el.getAttribute('alt')
      ].filter(Boolean).map(normalize);

      for (const t of texts) {
        if (t === targetText) return el;
        if (t.includes(targetText) || targetText.includes(t)) {
          const score = targetText.length / Math.max(t.length, 1);
          if (score > bestScore) { best = el; bestScore = score; }
        }
      }
    }
    return best;
  }

  const found = findDeep(document, searchText.toUpperCase(), target);
  console.log('[Content] findElement found:', found);
  return found;
}

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

function clickElement(searchText) {
  const best = findElement(searchText);

  if (!best) return false;

  // Flash the element briefly to show what was clicked
  const prev = best.style.cssText;
  best.style.cssText += ';outline:3px solid #00E5FF !important;box-shadow:0 0 20px rgba(0,229,255,0.5) !important;transition:all 0.3s ease !important;';
  best.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // For labels with a "for" attribute, click the associated input
  if (best.tagName === 'LABEL' && best.htmlFor) {
    const input = document.getElementById(best.htmlFor);
    if (input) input.click();
  }

  best.click();
  setTimeout(() => { best.style.cssText = prev; }, 2000);
  return true;
}

function getStructuredPageText() {
  const prioritySelectors = ['main', '#main', '#search', '#content', '#rso', '.main-content', 'article'];
  const interactiveSelectors = 'a, button, input[type="button"], input[type="submit"], [role="button"]';
  
  let linkIdx = 1;
  let btnIdx = 1;
  let lines = [`TITLE: ${document.title}`];
  let seen = new Set();

  function processElement(el) {
    if (seen.has(el)) return;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.top <= window.innerHeight) {
      const text = (el.innerText || el.value || el.ariaLabel || el.title || "").trim().replace(/\s+/g, ' ');
      if (!text || text.length < 2) return;

      // Filter out meta-information
      const lower = text.toLowerCase();
      const excluded = ['about this result', 'feedback', 'privacy', 'terms', 'learn more', 'about the source', 'ai overview'];
      if (excluded.some(phrase => lower.includes(phrase))) return;

      const tag = (el.tagName === 'A') ? 'L' : 'B';
      const idx = (tag === 'L') ? linkIdx++ : btnIdx++;
      const label = `${tag}${idx}`;
      el.setAttribute('data-agent-label', label);
      lines.push(`[${label}: ${text.slice(0, 60)}]`);
      seen.add(el);
    }
  }

  // 1. Process Priority Elements First (Main Content / Search Results)
  prioritySelectors.forEach(selector => {
    const container = document.querySelector(selector);
    if (container) {
      container.querySelectorAll(interactiveSelectors).forEach(processElement);
    }
  });

  // 2. Process All Other Visible Elements
  document.querySelectorAll(interactiveSelectors).forEach(processElement);

  const bodyText = document.body.innerText.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 20)
    .slice(0, 15)
    .join('\n');

  return lines.join('\n') + '\n\n--- TEXT SLICE ---\n' + bodyText;
}

function annotateElement(searchText, annotationText) {
  const el = findElement(searchText);
  if (!el) return false;

  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const prev = el.style.cssText;
  el.style.cssText += ';outline:3px solid #3dffa0 !important;box-shadow:0 0 15px #3dffa080 !important;transition:all 0.3s ease !important;';
  
  injectAnnotation(annotationText, x + 20, y - 40);
  
  setTimeout(() => { el.style.cssText = prev; }, 4000);
  return true;
}

function injectAnnotation(text, x, y, duration = 4000) {
  const div = document.createElement('div');
  div.style.cssText = `
    position: fixed;
    left: ${x}px; top: ${y}px;
    background: rgba(10,10,20,0.95);
    color: #c8f7e8;
    font-family: 'Outfit', sans-serif;
    font-size: 14px;
    padding: 12px 18px;
    border-radius: 12px;
    border: 1px solid #3dffa0;
    box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 0 15px #3dffa040;
    z-index: 2147483647;
    max-width: 280px;
    pointer-events: none;
    backdrop-filter: blur(8px);
    transition: all 0.3s ease;
    animation: agentPopIn 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
  `;
  div.textContent = text;

  // Add a small pointer triangle
  const arrow = document.createElement('div');
  arrow.style.cssText = `
    position: absolute;
    bottom: -8px; left: 20px;
    width: 0; height: 0;
    border-left: 8px solid transparent;
    border-right: 8px solid transparent;
    border-top: 8px solid #3dffa0;
  `;
  div.appendChild(arrow);

  const styleId = 'agent-annotation-styles';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      @keyframes agentPopIn { 
        0% { opacity:0; transform: scale(0.8) translateY(10px); } 
        100% { opacity:1; transform: scale(1) translateY(0); } 
      }
    `;
    document.head.appendChild(style);
  }
  
  document.body.appendChild(div);
  setTimeout(() => {
    div.style.opacity = '0';
    div.style.transform = 'scale(0.8) translateY(10px)';
    setTimeout(() => div.remove(), 400);
  }, duration);
}
