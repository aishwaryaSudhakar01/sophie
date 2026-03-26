# Sophie — Shop by Voice

> Why type when you can just... talk?

Sophie is a voice-first shopping agent with a personality. Tell her what you're looking for, your budget, and currency — she asks the right questions, searches the web in real time, and reads your top picks back like a best friend who happens to know everything about everything.

Built for [ElevenHacks Season 1](https://hacks.elevenlabs.io) using ElevenLabs + Firecrawl.

---

## How it works

1. **Tap the mic** — Sophie immediately asks your name
2. **Have a conversation** — she collects what you need, your budget, and currency
3. **She searches** — Firecrawl scours the web, Claude ranks the top 3
4. **Results read aloud** — Sophie reads your picks back and stays listening
5. **Buy by voice** — say "buy it" and the product page opens instantly

No typing. No scrolling. Just ask.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Voice | ElevenLabs Conversational AI — VAD, interruptions, client tools |
| Search | Firecrawl Search API |
| AI Brain | Claude Sonnet 4.6 — intent parsing + result ranking |
| Backend | Node.js + Express |
| Hosting | Railway |

---

## Setup

### 1. Clone the repo
```bash
git clone https://github.com/aishwaryaSudhakar01/sophie.git
cd sophie
```

### 2. Install dependencies
```bash
npm install
```

### 3. Add your API keys
```bash
cp .env.example .env
```
Fill in `.env`:
```
FIRECRAWL_API_KEY=fc-...
ANTHROPIC_API_KEY=sk-ant-...
ELEVENLABS_AGENT_ID=...
ELEVENLABS_API_KEY=sk_...
PORT=3000
```

### 4. Run locally
```bash
npm start
```
Open `http://localhost:3000` in Chrome.

---

## ElevenLabs Agent Setup

1. Go to [elevenlabs.io/agents](https://elevenlabs.io/agents) → Create Agent
2. Set voice to **Lauren**, LLM to **Claude Sonnet 4.6**
3. Set First message to: `Hey! What's your name?`
4. Add 3 client tools: `search_products`, `open_product_url`, `tell_me_more`
5. See `CLAUDE.md` for full agent prompt and tool configuration

---

## Built by

Aishwarya Sudhakar & M S Mihir — [ElevenHacks Season 1](https://hacks.elevenlabs.io)
