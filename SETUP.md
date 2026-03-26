# Sophie — Setup Guide

## Files in this project

```
voicecart/
  server.js          ← Node.js backend (all API calls)
  package.json       ← dependencies
  .env.example       ← copy to .env and fill in your keys
  .gitignore         ← keeps .env off GitHub
  public/
    index.html       ← complete frontend
```

---

## Step 1 — Install Node.js

1. Go to **nodejs.org** → click **LTS** → install
2. Verify: open Terminal and type `node --version` → should show v18 or higher

---

## Step 2 — Get your API keys (5 total)

### Firecrawl (web search)
1. Go to **firecrawl.dev** → Sign Up → Dashboard → API Keys → Create key
2. Claim 10,000 free credits: `hacks.elevenlabs.io/hackathons/0` → Attendee Offers → Firecrawl

### Anthropic (Claude — the brain)
1. Go to **console.anthropic.com** → Sign Up → API Keys → Create Key
2. $5 free credit on signup

### ElevenLabs (voice)
1. Go to **elevenlabs.io** → Sign Up
2. Claim free Creator month: `hacks.elevenlabs.io/hackathons/0` → Attendee Offers
3. Get API key: Profile → API Keys
4. Create agent: **elevenlabs.io/agents** → Create Agent → name it Sophie

   **Agent System Prompt:**
   ```
   You are Sophie, a friendly voice shopping assistant.
   Help users find products through natural conversation.
   Ask for budget first if not mentioned.
   Once you know what they want AND their budget, call the search_products tool.
   Keep responses short and natural.
   After showing results, stay listening for follow-ups.
   If user says "tell me more about X", call the tell_me_more tool with product_index.
   If user says "buy it" or "yes" after a product is discussed, call open_product_url.
   If user says "start over", reset the conversation.
   ```

   **Agent Tools — add these 3 client tools:**

   Tool 1: `search_products`
   - Description: Search for products matching the user's request
   - Parameter: `query` (string) — the search query
   - Wait for response: ON

   Tool 2: `open_product_url`
   - Description: Open a product page in the browser
   - Parameter: `url` (string) — the product URL
   - Parameter: `brand` (string) — the brand name
   - Wait for response: ON

   Tool 3: `tell_me_more`
   - Description: Show detailed review for a specific product
   - Parameter: `product_index` (string) — "1", "2", or "3"
   - Wait for response: ON

   5. Copy the **Agent ID** from the bottom of Settings

### Clerk (auth — optional but recommended)
1. Go to **clerk.com** → Sign Up → Create application → name it Sophie
2. Go to API Keys → copy **Publishable key** (starts with `pk_test_`)
3. If you skip Clerk, the app still works in guest mode

---

## Step 3 — Configure your keys

In Terminal, navigate to your voicecart folder:
```bash
cd ~/Desktop/voicecart
cp .env.example .env
open -e .env
```

Fill in all your keys:
```
FIRECRAWL_API_KEY=fc-...
ANTHROPIC_API_KEY=sk-ant-...
ELEVENLABS_AGENT_ID=...
ELEVENLABS_API_KEY=sk_...
CLERK_PUBLISHABLE_KEY=pk_test_...   ← optional, leave blank for guest mode
PORT=3000
```

Save and close.

---

## Step 4 — Install and run

```bash
npm install
npm start
```

Open Chrome → `http://localhost:3000`

Health check: `http://localhost:3000/api/health` — all keys should show `true`

---

## Step 5 — Deploy to Railway

1. Push to GitHub (GitHub Desktop → Commit → Push)
2. Go to **railway.app** → New Project → Deploy from GitHub repo
3. Select your repo → Deploy Now
4. Add your 5 env vars in the Variables tab
5. Settings → Domains → Generate Domain → your live URL

---

## How to update after deployment

1. Edit the file on your laptop
2. GitHub Desktop → Commit → Push
3. Railway auto-redeploys in ~30 seconds
4. Refresh your live URL

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Mic doesn't work | Use Chrome. Click Allow on the mic popup |
| `/api/health` shows `false` | Check .env — that key is wrong or missing |
| ElevenLabs not speaking | Check Agent ID is correct in .env |
| Search returns no results | Check Firecrawl credits at firecrawl.dev/dashboard |
| Clerk not working | Make sure CLERK_PUBLISHABLE_KEY is set correctly |
