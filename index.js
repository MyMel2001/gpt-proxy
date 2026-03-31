require('dotenv').config();
const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const path = require('path');
const db = require('quick.db'); // ready for future conversation persistence

const app = express();
app.use(cors());
app.use(express.json());

let browser = null;
let lastActivity = Date.now();
const INACTIVITY_TIMEOUT = 5 * 60 * 1000; // 5 minutes

const SITE_CONFIGS = {
  chatgpt: {
    url: 'https://chatgpt.com',
    inputSelector: 'textarea#prompt-textarea',           // update if OpenAI changes UI
    sendSelector: '[data-testid="send-button"]',
  },
  gemini: {
    url: 'https://gemini.google.com/app',
    inputSelector: 'textarea',
    sendSelector: 'button[aria-label="Send message"]',
  },
  grok: {
    url: 'https://grok.com/',
    inputSelector: 'textarea',
    sendSelector: 'button[type="submit"]',
  }
};

async function getBrowser() {
  if (!browser) {
    console.log('🚀 Launching headless Chromium...');
    browser = await puppeteer.launch({
      headless: process.env.HEADLESS !== 'false',
      userDataDir: path.resolve(process.env.USER_DATA_DIR || './browser-profiles'),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    });
  }
  lastActivity = Date.now();
  return browser;
}

async function cleanupBrowser() {
  if (browser) {
    console.log('🧹 Closing browser due to inactivity');
    await browser.close();
    browser = null;
  }
}

// Inactivity monitor
setInterval(() => {
  if (browser && Date.now() - lastActivity > INACTIVITY_TIMEOUT) {
    cleanupBrowser();
  }
}, 30000);

function getSiteKey(model) {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes('gpt') || m.includes('chatgpt')) return 'chatgpt';
  if (m.includes('gemini')) return 'gemini';
  if (m.includes('grok')) return 'grok';
  return null;
}

// ====================== OPENAI COMPATIBLE ENDPOINTS ======================

app.get('/v1/models', (req, res) => {
  res.json({
    object: "list",
    data: [
      { id: "chatgpt", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "ai-proxy" },
      { id: "gemini", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "ai-proxy" },
      { id: "grok", object: "model", created: Math.floor(Date.now() / 1000), owned_by: "ai-proxy" }
    ]
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages = [], stream = false } = req.body;

    if (!model) return res.status(400).json({ error: { message: 'model is required' } });

    const siteKey = getSiteKey(model);
    if (!siteKey) {
      return res.status(400).json({ error: { message: `Unsupported model "${model}". Use any model containing "gpt", "gemini" or "grok".` } });
    }

    const config = SITE_CONFIGS[siteKey];
    const browserInstance = await getBrowser();
    const page = await browserInstance.newPage();

    // Basic stealth
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    await page.goto(config.url, { waitUntil: 'networkidle2', timeout: 60000 });

    // Build prompt from the full OpenAI-style message history (last user message is what we send)
    const lastUserMessage = messages.filter(m => m.role === 'user').pop();
    if (!lastUserMessage) {
      await page.close();
      return res.status(400).json({ error: { message: 'No user message found in the messages array' } });
    }
    const prompt = lastUserMessage.content;

    // Type into chat box
    await page.waitForSelector(config.inputSelector, { timeout: 15000 });
    await page.type(config.inputSelector, prompt, { delay: 30 });

    // Click send
    await page.waitForSelector(config.sendSelector, { timeout: 10000 });
    await page.click(config.sendSelector);

    // Wait for any response to appear
    await page.waitForSelector('div[data-message-author-role="assistant"], .message-content, .prose', { timeout: 60000 });

    // Give the model time to finish generating
    await page.waitForTimeout(120000);

    // === OLLAMA RESPONSE EXTRACTION (exactly as requested) ===
    // Grab the latest response container HTML
    const rawHTML = await page.evaluate(() => {
      // Try common containers for all three sites
      const containers = document.querySelectorAll('div[data-message-author-role="assistant"], .message-content, .prose, .markdown');
      return containers[containers.length - 1]?.outerHTML || document.body.innerHTML;
    });

    // Ask Ollama (local model from .env) to extract ONLY the clean AI response
    const ollamaRes = await fetch(`${process.env.OLLAMA_HOST}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_MODEL,
        prompt: `You are an HTML parser. From the following HTML snippet, extract ONLY the final AI assistant response text. Remove any UI elements, buttons, avatars, or previous conversation history. Return nothing but the clean response text.\n\n${rawHTML}`,
        stream: false,
        temperature: 0
      })
    });

    const ollamaData = await ollamaRes.json();
    let responseText = ollamaData.response ? ollamaData.response.trim() : 'Ollama could not extract response';

    await page.close();

    lastActivity = Date.now();

    // Official OpenAI response shape
    const openAIResponse = {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: responseText },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };

    res.json(openAIResponse);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: { message: err.message || 'Browser automation failed' } });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 OpenAI-compatible Web Proxy listening on http://localhost:${PORT}`);
  console.log('   → Model selection chooses the target website (gpt*/chatgpt* → ChatGPT, gemini* → Gemini, grok* → Grok)');
  console.log('   → Response extraction powered by Ollama model from .env');
  console.log('   → Browser auto-closes after 5 minutes of inactivity');
});
