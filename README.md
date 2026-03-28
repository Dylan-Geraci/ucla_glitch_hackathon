# 🧠 Browsing Agent

An AI inner voice that lives in your browser. It watches what you read, speaks observations, answers your questions, highlights content on screen, and reacts to your browsing in real time — powered by **Gemini Live**.

---

## Architecture

```
Electron Main Process
├── main.js              — Window/BrowserView management, IPC router
├── geminiLive.js        — Gemini Live WebSocket client (voice + vision)
└── screenshotManager.js — Periodic screenshot capture + proactive commentary

Electron Renderer Process
├── index.html           — UI shell (nav bar + agent control bar)
└── renderer.js          — Mic recording, audio playback, agent event handling

Preload
└── preload.js           — Secure contextBridge (main ↔ renderer)
```

```
User speaks (hold mic button)
        ↓
  MediaRecorder (WebM/Opus)
        ↓
  IPC → main → GeminiLiveClient.sendAudio()
        ↓
  Gemini Live API (vision + audio → text + audio response)
        ↓
  agent-text event → parse commands (HIGHLIGHT / ANNOTATE / SCROLL)
  agent-audio event → enqueue → Web Audio playback
        ↓
  BrowserView DOM manipulation (highlight, annotate, scroll)
```

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Get a Gemini API key

Go to [Google AI Studio](https://aistudio.google.com/app/apikey) and create an API key with access to **Gemini 2.0 Flash Live**.

### 3. Run the app

```bash
npm start
```

Enter your API key in the setup screen. It's stored locally in localStorage.

---

## Usage

| Control | Action |
|---|---|
| **Agent toggle** | Turn the AI inner voice on/off |
| **Frequency slider** | How often the agent proactively comments (Quiet ↔ Chatty) |
| **Hold mic button** | Ask a question — release to send |
| **URL bar** | Navigate normally, or type a search query |

### What the agent can do

- **Proactive commentary** — notices interesting content on the page and comments
- **Answer questions** — hold mic, ask anything about what you're viewing
- **Highlight** — says "I'll highlight that" and outlines the relevant element in gold
- **Annotate** — injects floating text bubbles on the page pointing to content
- **Scroll** — finds and scrolls to text you ask about
- **Verbal browsing** — ask it to find content on the page and it navigates there

---

## Google Models Used

| Model | Purpose |
|---|---|
| **Gemini 2.0 Flash Live** | Real-time multimodal: understands screenshots + voice, responds with voice |
| **Lyria** *(next phase)* | Ambient background music matching page tone |

---

## Roadmap

- [x] BrowserView embedded browser
- [x] Gemini Live voice I/O
- [x] Periodic screenshot → proactive commentary
- [x] Mic hold-to-talk
- [x] DOM highlight / annotate / scroll
- [x] Frequency slider
- [ ] Lyria ambient music integration
- [ ] Music mood mapping from page content
- [ ] User music preference controls
- [ ] Session memory / context window management
- [ ] Multiple voice options

---

## Notes

- Screenshots are captured from the BrowserView and sent **directly to Google's API** — no backend server
- Audio is recorded in the renderer and sent via IPC to the main process, then to Gemini
- The BrowserView DOM manipulation uses `executeJavaScript` and is always reverted after a timeout
- The agent uses Gemini's built-in audio output (PCM/WAV) for the spoken response
