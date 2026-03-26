// ============================================================
// Sophie — Backend Server
// ============================================================
require('dotenv').config();

const express     = require('express');
const cors        = require('cors');
const Anthropic   = require('@anthropic-ai/sdk');
const FirecrawlApp = require('@mendable/firecrawl-js').default;

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// ── CLIENTS ──────────────────────────────────────────────────
const claude    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

// ── SEARCH CACHE (5 min TTL) ──────────────────────────────────
const searchCache = {};
function getCached(key) {
  const entry = searchCache[key];
  if (entry && Date.now() - entry.ts < 5 * 60 * 1000) return entry.data;
  return null;
}
function setCache(key, data) { searchCache[key] = { data, ts: Date.now() }; }

// ── SESSION STORE ─────────────────────────────────────────────
const sessions = {};
function getSession(id) {
  if (!sessions[id]) sessions[id] = { history: [], lastProducts: [], lastQuery: '' };
  return sessions[id];
}

// ── INTENT SYSTEM PROMPT ─────────────────────────────────────
const INTENT_PROMPT = `
You are Sophie, a friendly voice shopping assistant.
Extract shopping intent and decide: ask a follow-up OR search.

SLOTS to extract:
- product_hint   : what kind of product (null if unknown)
- recipient      : who it's for — self/friend/parent/child (null if unknown)
- interest       : hobbies/interests (null if unknown)
- budget         : number in USD (null if not mentioned)
- vibe           : style words — minimal/quirky/luxury/practical (null if unknown)
- ranking_priority: cheapest/best_rated/most_unique (null if unknown)
- currency      : USD/GBP/EUR/INR/AUD/CAD/AED/SGD (null if not mentioned)

RULES — follow in order:
1. budget is null → action=ask, ask for budget FIRST
2. product_hint AND interest both null → action=ask, ask what they enjoy
3. product_hint null but interest known → action=search
4. product_hint + budget known → action=search
4b. If budget given but currency unclear and amount is ambiguous → ask "What currency is that in?"
5. NEVER ask more than 1 question per turn
6. action=reset if user says "start over" or "reset"

RANKING PRIORITY:
- price/budget mentioned first → "best value for budget"
- "best"/"premium"/"top rated" → "highest rated across sources"
- "unique"/"unusual"/"cool"/"different" → "most distinctive and talked-about"
- "practical"/"durable"/"everyday" → "best reviewed for practical use"
- no signal → "most recommended overall"

SEARCH QUERY: specific, like a human — include product type, style, budget, "buy review"
Examples:
  "cheetah print brown sunglasses under $80 buy review"
  "yoga wellness gift under $50 ideas Reddit"

RESPOND WITH RAW JSON ONLY — no markdown, no explanation:
{
  "action": "ask" | "search" | "reset",
  "question": "...",
  "query": "...",
  "confirmation": "...",
  "ranking_reason": "..."
}
`;

// ── API CALL 1: Claude — parse intent ─────────────────────────
async function parseIntent(message, history) {
  const res = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    system: INTENT_PROMPT,
    messages: [...history, { role: 'user', content: message }],
  });
  const text = res.content[0].text.trim().replace(/```json\n?|```/g, '').trim();
  try { return JSON.parse(text); }
  catch { return { action: 'ask', question: "Sorry, could you say that again?" }; }
}

// ── BUDGET FILTER ─────────────────────────────────────────────
function extractBudget(query) {
  // Returns { amount, currency } or null
  const patterns = [
    { re: /under\s+\$?([\d,]+)/i, cur: 'USD' },
    { re: /below\s+\$?([\d,]+)/i, cur: 'USD' },
    { re: /less\s+than\s+\$?([\d,]+)/i, cur: 'USD' },
    { re: /\$?([\d,]+)\s+budget/i, cur: 'USD' },
    { re: /under\s+([\d,]+)\s*(?:inr|rupee|rs)/i, cur: 'INR' },
    { re: /under\s+([\d,]+)\s*(?:gbp|pound)/i, cur: 'GBP' },
    { re: /under\s+£([\d,]+)/i, cur: 'GBP' },
    { re: /under\s+([\d,]+)\s*(?:eur|euro)/i, cur: 'EUR' },
    { re: /under\s+€([\d,]+)/i, cur: 'EUR' },
    { re: /under\s+([\d,]+)\s*(?:aud|australian)/i, cur: 'AUD' },
    { re: /under\s+A\$?([\d,]+)/i, cur: 'AUD' },
    { re: /under\s+([\d,]+)\s*(?:cad|canadian)/i, cur: 'CAD' },
    { re: /under\s+C\$?([\d,]+)/i, cur: 'CAD' },
    { re: /under\s+([\d,]+)\s*(?:aed|dirham)/i, cur: 'AED' },
    { re: /under\s+([\d,]+)\s*(?:sgd|singapore)/i, cur: 'SGD' },
    { re: /under\s+S\$?([\d,]+)/i, cur: 'SGD' },
  ];
  for (const { re, cur } of patterns) {
    const m = query.match(re);
    if (m) return { amount: parseFloat(m[1].replace(/,/g, '')), currency: cur };
  }
  return null;
}

// Detect search/category page URLs — not direct product pages
function isSearchPageUrl(url) {
  if (!url) return true;
  const bad = ['/search', '?q=', '?query=', '?keyword', '/category', '/browse', '/c/', '/s?', '/s/', 'search?', '/collections/', '/shop?', '/store?', '/listing'];
  return bad.some(p => url.toLowerCase().includes(p));
}

function priceWithinBudget(priceStr, budget) {
  if (!budget || !priceStr) return true;
  const m = priceStr.replace(/,/g, '').match(/([\d.]+)/);
  if (!m) return true;
  return parseFloat(m[1]) <= budget.amount * 1.25; // 25% tolerance — Firecrawl returns review pages with mixed prices
}

// ── API CALL 2: Firecrawl — search ────────────────────────────
async function searchProducts(query) {
  const search = firecrawl.search(query, {
    limit: 3,
    scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
  });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Firecrawl timeout')), 12000));
  const res = await Promise.race([search, timeout]);
  return res?.data || [];
}

// ── API CALL 3: Claude — rank results (with Firecrawl fallback) ──
async function rankResults(rawResults, query, rankingReason) {
  try {
    const res = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: `You are a product ranking assistant.
Given web search results, pick the 3 best matching products.
Return ONLY a raw JSON array — no markdown, no fences, no explanation.

Each item MUST have exactly these fields:
{
  "brand": "brand name",
  "name": "specific product name/model",
  "price": "price string e.g. '$75'",
  "reason": "one specific sentence explaining why this matches",
  "rating": "rating string e.g. '4.8'",
  "rating_note": "e.g. 'avg across 3 review sites'",
  "buy_url": "direct URL to a SPECIFIC product page — NOT a search results page, category page, or URL containing /search, ?q=, /category, /browse, /collections. Must link to one specific product.",
  "source_name": "website name e.g. 'Wirecutter'",
  "image_url": "first image URL found, or null"
}

Ranking priority for #1: ${rankingReason || 'most recommended overall'}.
CRITICAL: If the query contains a budget (e.g. "under $50", "below 5000 rupees"), ONLY include products within that budget. Exclude any product priced above the stated budget. If no within-budget products are found, return [].
Only return real products found in the results. Return [] if none found.`,
      messages: [{
        role: 'user',
        content: `Query: "${query}"\n\nResults:\n${JSON.stringify(rawResults.slice(0, 5), null, 2)}`,
      }],
    });
    const text = res.content[0].text.trim().replace(/```json\n?|```/g, '').trim();
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed.slice(0, 3) : fallbackRank(rawResults, query);
    } catch { return fallbackRank(rawResults, query); }
  } catch (err) {
    console.warn('[rankResults] Claude unavailable, using fallback:', err.message?.slice(0,80));
    return fallbackRank(rawResults, query);
  }
}

// Fallback: extract products directly from Firecrawl results without Claude
function fallbackRank(rawResults, query) {
  return rawResults.slice(0, 3).map(r => {
    const domain = (() => { try { return new URL(r.url).hostname.replace('www.',''); } catch { return r.url; } })();
    // extract first price-looking string from markdown
    const priceMatch = (r.markdown||r.description||'').match(/\$[\d,]+(?:\.\d{2})?|\£[\d,]+|\€[\d,]+|[\d,]+\s*(?:USD|GBP|EUR|INR|AUD)/i);
    // extract first image URL from markdown
    const imgMatch = (r.markdown||'').match(/!\[.*?\]\((https?:\/\/[^)]+\.(?:jpg|jpeg|png|webp)(?:\?[^)]*)?)\)/i);
    return {
      brand: domain,
      name: (r.title || query).slice(0, 80),
      price: priceMatch ? priceMatch[0] : 'See site',
      reason: (r.description || r.title || 'Matches your search').slice(0, 120),
      rating: '4.5',
      rating_note: 'from review site',
      buy_url: r.url,
      source_name: domain,
      image_url: imgMatch ? imgMatch[1] : null,
    };
  });
}

// ── API CALL 4+5: Firecrawl scrape + Claude summarise ─────────
async function getMoreDetail(brand, name, url) {
  let content = '';
  try {
    const scrape = firecrawl.scrapeUrl(url, { formats: ['markdown'] });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('scrape timeout')), 10000));
    const scraped = await Promise.race([scrape, timeout]);
    content = scraped?.markdown?.slice(0, 4000) || '';
  } catch { content = `Product: ${brand} ${name}`; }

  try {
    const res = await claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 250,
      system: `Summarise product pages into concise buying advice.
Write 2-3 sentences in a warm, conversational tone — like telling a friend.
Focus on: sizing/fit, common complaints, standout praise, durability.
No bullet points. Plain text only.`,
      messages: [{ role: 'user', content: `Product: ${brand} ${name}\n\nPage:\n${content}` }],
    });
    return res.content[0].text.trim();
  } catch {
    // Fallback: extract first meaningful sentences from scraped content
    const sentences = content.replace(/#+\s*/g,'').replace(/\n+/g,' ').match(/[A-Z][^.!?]{20,}[.!?]/g) || [];
    return sentences.slice(0,3).join(' ') || `${brand} ${name} — check the product page for full details.`;
  }
}

// ── API CALL 6: ElevenLabs signed URL ─────────────────────────
async function getSignedUrl() {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${process.env.ELEVENLABS_AGENT_ID}`,
    { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }
  );
  if (!res.ok) throw new Error(`ElevenLabs: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.signed_url;
}

// ── ROUTES ────────────────────────────────────────────────────

// POST /api/chat — main conversation + search
app.post('/api/chat', async (req, res) => {
  const { session_id = 'default', message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const session = getSession(session_id);

  // Handle reset before calling LLM
  if (/start.?over|reset|restart/i.test(message)) {
    sessions[session_id] = { history: [], lastProducts: [], lastQuery: '' };
    return res.json({ action: 'reset', response_text: "Starting fresh! What are you looking for?", products: null });
  }

  try {
    const intent = await parseIntent(message, session.history);
    session.history.push({ role: 'user', content: message });

    if (intent.action === 'reset') {
      sessions[session_id] = { history: [], lastProducts: [], lastQuery: '' };
      return res.json({ action: 'reset', response_text: "Starting fresh! What are you looking for?", products: null });
    }

    if (intent.action === 'ask') {
      session.history.push({ role: 'assistant', content: intent.question });
      return res.json({ action: 'ask', response_text: intent.question, products: null });
    }

    if (intent.action === 'search') {
      // Append currency/region context to query if provided
      const currency = req.body.currency || 'USD';
      const regionMap = {USD:'USA',GBP:'UK site:*.co.uk OR site:*.com',EUR:'Europe',INR:'India site:*.in OR site:flipkart.com',AUD:'Australia site:*.com.au',CAD:'Canada',AED:'UAE',SGD:'Singapore'};
      const regionHint = currency !== 'USD' ? ' ' + (regionMap[currency]||'') : '';
      if(regionHint && intent.query) intent.query = intent.query + regionHint;
      const confirmation = intent.confirmation || `Searching for ${intent.query}…`;
      session.history.push({ role: 'assistant', content: confirmation });
      session.lastQuery = intent.query;

      let rawResults = [];
      try { rawResults = await searchProducts(intent.query); }
      catch { return res.json({ action: 'error', response_text: "I had trouble searching. Please try again.", products: null }); }

      if (!rawResults.length) return res.json({ action: 'no_results', response_text: "I couldn't find matches. Could you give more detail?", products: null });

      const products = await rankResults(rawResults, intent.query, intent.ranking_reason);
      session.lastProducts = products;

      if (!products.length) return res.json({ action: 'no_results', response_text: "Found pages but couldn't extract clear products. Try a more specific query.", products: null });

      const voiceText =
        `${confirmation} Here are your top three picks. ` +
        `First: ${products[0].brand} ${products[0].name} at ${products[0].price}. ${products[0].reason}. ` +
        (products[1] ? `Second: ${products[1].brand} ${products[1].name} at ${products[1].price}. ` : '') +
        (products[2] ? `Third: ${products[2].brand} ${products[2].name} at ${products[2].price}. ` : '') +
        `Say "tell me more" about any of them, or "start over" for a new search.`;

      return res.json({
        action: 'results',
        response_text: voiceText,
        confirmation,
        ranking_reason: intent.ranking_reason || 'most recommended overall',
        products,
        sources_count: rawResults.length,
        query: intent.query,
      });
    }

    return res.json({ action: 'ask', response_text: "Could you rephrase that?", products: null });

  } catch (err) {
    console.error('/api/chat error:', err);
    return res.status(500).json({ action: 'error', response_text: "Something went wrong. Please try again.", products: null });
  }
});

// POST /api/search — direct search, bypasses intent parsing
// Called when ElevenLabs client tool already extracted the query
app.post('/api/search', async (req, res) => {
  const { query, currency = 'USD' } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  // Append currency region hint so Firecrawl returns region-relevant results
  const regionMap = { USD:'', GBP:'UK', EUR:'Europe', INR:'India', AUD:'Australia', CAD:'Canada', AED:'UAE', SGD:'Singapore' };
  const regionHint = regionMap[currency] || '';
  const augmentedQuery = regionHint ? `${query} ${regionHint}` : query;

  console.log(`[/api/search] query="${augmentedQuery}" currency=${currency}`);

  // Cache hit — instant return for repeat queries
  const cacheKey = augmentedQuery.toLowerCase().trim();
  const cached = getCached(cacheKey);
  if (cached) { console.log('[/api/search] cache hit'); return res.json(cached); }

  try {
    let rawResults = [];
    try { rawResults = await searchProducts(augmentedQuery); }
    catch { return res.json({ action: 'error', response_text: 'Search failed.', products: null }); }

    if (!rawResults.length) return res.json({ action: 'no_results', response_text: 'No results found.', products: null });

    let products = await rankResults(rawResults, augmentedQuery, 'most recommended overall');
    // Filter out search/category page URLs — these are useless as product links
    const cleanProducts = products.filter(p => !isSearchPageUrl(p.buy_url));
    // Only use filtered list if it has results — otherwise keep originals rather than returning nothing
    if (cleanProducts.length > 0) {
      products = cleanProducts;
    }
    // Code-level budget filter (LLM doesn't reliably enforce this)
    const budget = extractBudget(augmentedQuery);
    if (budget) {
      const withinBudget = products.filter(p => priceWithinBudget(p.price, budget));
      // If filter wipes everything, use original list but flag over-budget items rather than returning nothing
      if (withinBudget.length === 0 && products.length > 0) {
        products.forEach(p => { p.reason = `(May exceed budget) ${p.reason}`; });
      } else {
        products = withinBudget;
        // Flag items that are slightly over the exact budget (within tolerance)
        products.forEach(p => {
          const m = (p.price||'').replace(/,/g,'').match(/([\d.]+)/);
          if (m && parseFloat(m[1]) > budget.amount) p.reason = `(Slightly over budget) ${p.reason}`;
        });
      }
    }
    if (!products.length) return res.json({ action: 'no_results', response_text: 'Could not find products within your budget. Try a higher budget or different item.', products: null });

    const result = {
      action: 'results',
      products,
      query: augmentedQuery,
      sources_count: rawResults.length,
      ranking_reason: 'most recommended overall',
      response_text: `Here are your top 3 picks for ${augmentedQuery}.`,
    };
    setCache(cacheKey, result);
    return res.json(result);
  } catch (err) {
    console.error('[/api/search] error:', err);
    return res.status(500).json({ action: 'error', response_text: 'Something went wrong.', products: null });
  }
});

// POST /api/more — tell me more detail
app.post('/api/more', async (req, res) => {
  const { product_brand, product_name, source_url } = req.body;
  if (!product_brand || !product_name) return res.status(400).json({ error: 'product_brand and product_name required' });
  try {
    const detail = await getMoreDetail(product_brand, product_name, source_url);
    return res.json({ detail });
  } catch (err) {
    return res.status(500).json({ detail: "Couldn't load more detail right now." });
  }
});

// POST /api/similar — show similar products
app.post('/api/similar', async (req, res) => {
  const { product_brand, product_name, original_query } = req.body;
  if (!product_brand || !product_name) return res.status(400).json({ error: 'product_brand and product_name required' });

  const query = `${product_brand} ${product_name} alternatives similar ${original_query || ''} buy review`.trim();
  try {
    const raw = await searchProducts(query);
    if (!raw.length) return res.json({ products: [], query });
    const products = await rankResults(raw, query, 'most similar style and price point');
    const filtered = products.filter(p => {
      const bm = (p.brand || '').toLowerCase() === product_brand.toLowerCase();
      const nm = (p.name || '').toLowerCase().includes(product_name.toLowerCase().split(' ')[0]);
      return !(bm && nm);
    });
    return res.json({ products: filtered.slice(0, 3), query });
  } catch (err) {
    return res.status(500).json({ products: [], error: err.message });
  }
});

// GET /api/elevenlabs-signed-url
app.get('/api/elevenlabs-signed-url', async (req, res) => {
  try {
    const signed_url = await getSignedUrl();
    return res.json({ signed_url });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: {
      firecrawl:  !!process.env.FIRECRAWL_API_KEY,
      anthropic:  !!process.env.ANTHROPIC_API_KEY,
      elevenlabs: !!process.env.ELEVENLABS_API_KEY,
      agent_id:   !!process.env.ELEVENLABS_AGENT_ID,

    },
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ Sophie → http://localhost:${PORT}`);
  console.log(`   Health    → http://localhost:${PORT}/api/health\n`);
});
