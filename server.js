const express = require(‘express’);
const cors = require(‘cors’);
const axios = require(‘axios’);
const puppeteer = require(‘puppeteer-core’);

// ─────────────────────────────────────────────────────────────────────────────
// Chromium path resolution
// Works on: Synology NAS (system Chromium), Railway (@sparticuz/chromium),
// or any machine with Chrome/Chromium installed locally.
// ─────────────────────────────────────────────────────────────────────────────
async function getChromiumConfig () {
// 1. Explicit env var — set this in Docker or Railway env
if (process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROMIUM_PATH) {
return {
executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROMIUM_PATH,
args: [
‘–no-sandbox’, ‘–disable-setuid-sandbox’,
‘–disable-dev-shm-usage’, ‘–disable-gpu’,
‘–no-first-run’, ‘–no-zygote’, ‘–single-process’,
‘–disable-extensions’,
],
headless: true,
defaultViewport: { width: 1280, height: 800 },
};
}

// 2. @sparticuz/chromium (Railway / serverless)
try {
const chromium = require(’@sparticuz/chromium’);
return {
executablePath: await chromium.executablePath(),
args: chromium.args,
headless: chromium.headless,
defaultViewport: chromium.defaultViewport,
};
} catch {}

// 3. Common system paths (fallback for local dev)
const { execSync } = require(‘child_process’);
const candidates = [
‘/usr/bin/chromium’,
‘/usr/bin/chromium-browser’,
‘/usr/bin/google-chrome’,
‘/usr/bin/google-chrome-stable’,
‘/Applications/Google Chrome.app/Contents/MacOS/Google Chrome’,
‘C:\Program Files\Google\Chrome\Application\chrome.exe’,
];
for (const p of candidates) {
try { execSync(`test -f "${p}"`); return { executablePath: p, args: [’–no-sandbox’, ‘–disable-setuid-sandbox’, ‘–disable-dev-shm-usage’, ‘–disable-gpu’], headless: true, defaultViewport: { width: 1280, height: 800 } }; } catch {}
}

throw new Error(‘No Chromium/Chrome found. Set PUPPETEER_EXECUTABLE_PATH env var.’);
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// User agents
// ─────────────────────────────────────────────────────────────────────────────
const UA_IPHONE = ‘Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1’;

// ─────────────────────────────────────────────────────────────────────────────
// m3u8 regex patterns
// ─────────────────────────────────────────────────────────────────────────────
const M3U8_PATTERNS = [
/https?://[^\s”’`<>]+\.m3u8[^\s"'`<>]*/gi,
/[”’`](https?:\/\/[^"'`]+.m3u8[^”’`]*)/gi, /(?:source|file|src|hls|stream|url|path|manifest)\s*[=:]\s*["'`]?(https?://[^”’`\s,)]+\.m3u8[^"'`\s,)]*)/gi,
/[”’`](https?:\/\/[^"'`]+/[A-Za-z0-9+/=~_-]{20,}/[A-Za-z0-9+/=]{10,}.m3u8[^”’`]*)/gi, /https?:\/\/[^\s"'`<>]+cGxheWxpc3[^\s”’`<>]*/gi,
];

function extractM3U8s(text, pageUrl) {
const found = new Set();
let base = ‘’;
try { base = new URL(pageUrl).origin; } catch {}

for (const pattern of M3U8_PATTERNS) {
pattern.lastIndex = 0;
let m;
while ((m = pattern.exec(text)) !== null) {
let u = (m[1] || m[0]).trim().replace(/[”’`;,)>\s]+$/, ‘’);
if (!u.startsWith(‘http’) && base) {
u = base + (u.startsWith(’/’) ? ‘’ : ‘/’) + u;
}
if (u.includes(’.m3u8’)) found.add(u);
}
}

const rel = /[”’`](\/[^"'`\s]+.m3u8[^”’`]*)/gi;
let m;
while ((m = rel.exec(text)) !== null) {
if (base) found.add(base + m[1]);
}

return […found];
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard script — injected into every page before any site JS runs.
// Blocks: popups, pop-unders, new-tab tricks, cross-origin redirects,
// overlay ads, sticky ad elements.
// ─────────────────────────────────────────────────────────────────────────────
const PAGE_GUARD_SCRIPT = `
(function () {
‘use strict’;
const _origin = location.origin;

// ── Block window.open (popups / pop-unders) ───────────────────────────────
window.open = function () { return null; };

// ── Block cross-origin location redirects ─────────────────────────────────
try {
const desc = Object.getOwnPropertyDescriptor(window, ‘location’);
Object.defineProperty(window, ‘location’, {
get() { return desc ? desc.get.call(window) : location; },
set(v) {
try {
if (new URL(String(v), _origin).origin !== _origin) {
console.warn(’[guard] Blocked redirect:’, v); return;
}
} catch {}
if (desc && desc.set) desc.set.call(window, v);
},
configurable: true,
});
} catch (e) {}

// ── Block history-based cross-origin redirects ────────────────────────────
const _push = history.pushState.bind(history);
const _replace = history.replaceState.bind(history);
history.pushState = function (s, t, url) {
try { if (new URL(String(url), _origin).origin !== _origin) return; } catch {}
return _push(s, t, url);
};
history.replaceState = function (s, t, url) {
try { if (new URL(String(url), _origin).origin !== _origin) return; } catch {}
return _replace(s, t, url);
};

// ── Neutralise common redirect tricks ────────────────────────────────────
window.addEventListener(‘beforeunload’, e => e.stopImmediatePropagation(), true);

// ── Remove ad/overlay DOM elements ───────────────────────────────────────
const AD_SELECTORS = [
‘[id*=“pop” i]’, ‘[class*=“pop” i]’,
‘[id*=“overlay” i]’, ‘[class*=“overlay” i]’,
‘[id*=“interstitial” i]’, ‘[class*=“interstitial” i]’,
‘[id*=“advert” i]’, ‘[class*=“advert” i]’,
‘iframe[src*=“doubleclick”]’, ‘iframe[src*=“googlesyndication”]’,
‘iframe[src*=“popads”]’, ‘iframe[src*=“popcash”]’,
‘iframe[src*=“exoclick”]’, ‘iframe[src*=“trafficjunky”]’,
‘[style*=“z-index: 9999”]’, ‘[style*=“z-index:9999”]’,
‘[style*=“z-index: 2147483647”]’,
];

function removeAds () {
AD_SELECTORS.forEach(sel => {
try {
document.querySelectorAll(sel).forEach(el => {
if (!el.querySelector(‘video’) && !el.closest(’[id*=“player” i]’)) {
el.remove();
}
});
} catch {}
});
// Kill fixed/absolute overlays that cover the whole viewport
document.querySelectorAll(’*’).forEach(el => {
try {
const s = getComputedStyle(el);
if ((s.position === ‘fixed’ || s.position === ‘absolute’) &&
parseInt(s.zIndex) > 1000 &&
!el.querySelector(‘video’) && !el.closest(’[id*=“player” i]’)) {
el.remove();
}
} catch {}
});
}

if (document.readyState === ‘loading’) {
document.addEventListener(‘DOMContentLoaded’, removeAds);
} else {
removeAds();
}
setTimeout(removeAds, 1500);
setTimeout(removeAds, 4000);

console.log(’[guard] Protection active on’, _origin);
})();
`;

// ─────────────────────────────────────────────────────────────────────────────
// Network-level block list (ad networks, trackers, pop-under scripts)
// ─────────────────────────────────────────────────────────────────────────────
const BLOCKED_DOMAINS = [
/doubleclick.net/, /googlesyndication.com/, /googletagmanager.com/,
/adnxs.com/, /outbrain.com/, /taboola.com/,
/popads.net/, /popcash.net/, /propellerads.com/,
/trafficjunky.net/, /juicyads.com/, /exoclick.com/,
/trafficstars.net/, /hilltopads.net/, /clickadu.com/,
/adsterra.com/, /adspyglass.com/, /adskeeper.co/,
/mgid.com/, /revcontent.com/, /media.net/,
/ero-advertising.com/, /plugrush.com/, /zeroredirect/,
/pop.ac//, /fullpagebot.com/, /go.affec.tv/,
/serv.adtelligent.com/, /ovideoadserver.com/,
/cdn.adnium.com/, /adsafeprotected.com/,
];

// ─────────────────────────────────────────────────────────────────────────────
// Puppeteer browser singleton
// ─────────────────────────────────────────────────────────────────────────────
let _browser = null;

async function getBrowser () {
if (_browser && _browser.isConnected()) return _browser;
const config = await getChromiumConfig();
_browser = await puppeteer.launch({
executablePath: config.executablePath,
args: config.args,
headless: config.headless,
defaultViewport: config.defaultViewport,
ignoreHTTPSErrors: true,
});
_browser.on(‘disconnected’, () => { _browser = null; });
return _browser;
}

// ─────────────────────────────────────────────────────────────────────────────
// Puppeteer extraction
// ─────────────────────────────────────────────────────────────────────────────
async function extractWithPuppeteer (targetUrl, waitMs = 8000) {
const browser = await getBrowser();
const page = await browser.newPage();
const streams = new Set();
const log = [];

try {
await page.setUserAgent(UA_IPHONE);
await page.setExtraHTTPHeaders({ ‘Accept-Language’: ‘en-US,en;q=0.9’, ‘DNT’: ‘1’ });

```
// ── Request interception: block ads, capture m3u8 ────────────────────────
await page.setRequestInterception(true);

page.on('request', req => {
const url = req.url();
const type = req.resourceType();

// Block ad/tracker domains
if (BLOCKED_DOMAINS.some(p => p.test(url))) {
log.push({ action: 'blocked', url: url.slice(0, 100) });
return req.abort();
}

// Block popup/new-tab navigations from sub-frames
if (type === 'document' && req.isNavigationRequest() && req.frame() !== page.mainFrame()) {
log.push({ action: 'popup-blocked', url: url.slice(0, 100) });
return req.abort();
}

// Block cross-origin top-level navigations (redirects away)
if (type === 'document' && req.isNavigationRequest() && req.frame() === page.mainFrame()) {
try {
const dest = new URL(url);
const orig = new URL(targetUrl);
if (dest.origin !== orig.origin && url !== targetUrl) {
log.push({ action: 'redirect-blocked', url: url.slice(0, 100) });
return req.abort();
}
} catch {}
}

// Sniff m3u8 in request URL
if (url.includes('.m3u8')) {
streams.add(url);
log.push({ action: 'stream-captured', url });
}

req.continue();
});

// ── Sniff m3u8 in response content-type ──────────────────────────────────
page.on('response', response => {
const url = response.url();
const ct = response.headers()['content-type'] || '';
if (ct.includes('mpegurl') || ct.includes('x-mpegurl') || url.includes('.m3u8')) {
streams.add(url);
}
});

// ── Inject protection before any page JS runs ─────────────────────────────
await page.evaluateOnNewDocument(PAGE_GUARD_SCRIPT);

// ── Navigate ──────────────────────────────────────────────────────────────
await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });

// Give JS players time to initialise
await new Promise(r => setTimeout(r, waitMs));

// ── Scrape full rendered HTML + inline scripts ────────────────────────────
const fullText = await page.evaluate(() => {
const scripts = [...document.querySelectorAll('script')]
.map(s => s.textContent || '').join('\n');
return document.documentElement.outerHTML + '\n' + scripts;
});
extractM3U8s(fullText, targetUrl).forEach(u => streams.add(u));

// ── Scan window-level globals for stream URLs ─────────────────────────────
const globals = await page.evaluate(() => {
const found = [];
for (const k of Object.keys(window)) {
try {
const v = JSON.stringify(window[k]);
if (v && v.includes('.m3u8')) {
const hits = v.match(/https?:\/\/[^"'`\s]+\.m3u8[^"'`\s]*/g);
if (hits) found.push(...hits);
}
} catch {}
}
return found;
});
globals.forEach(u => streams.add(u));

return { success: true, streams: [...streams], count: streams.size, log };
```

} finally {
await page.close();
}
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

/**

- GET /extract
- ?url= Page URL to scan
- ?js=true Use Puppeteer (JS-rendered) mode — catches dynamically loaded streams
- ?wait= ms to wait after page load (default 8000, max 30000)
*/
app.get(’/extract’, async (req, res) => {
const { url, js, wait } = req.query;
if (!url) return res.status(400).json({ error: ‘Missing ?url= parameter’ });

let targetUrl;
try { targetUrl = new URL(url).toString(); }
catch { return res.status(400).json({ error: ‘Invalid URL’ }); }

const useJs = js === ‘true’ || js === ‘1’;
const waitMs = Math.min(parseInt(wait) || 8000, 30000);

if (useJs) {
try {
const result = await extractWithPuppeteer(targetUrl, waitMs);
return res.json({ …result, mode: ‘puppeteer’, pageUrl: targetUrl });
} catch (err) {
return res.status(502).json({ error: ’Puppeteer error: ’ + err.message, mode: ‘puppeteer’ });
}
}

// Static axios mode
try {
const response = await axios.get(targetUrl, {
timeout: 15000,
maxRedirects: 5,
headers: {
‘User-Agent’: UA_IPHONE,
‘Accept’: ‘text/html,application/xhtml+xml,*/*;q=0.8’,
‘Accept-Language’: ‘en-US,en;q=0.5’,
‘Referer’: new URL(targetUrl).origin,
‘DNT’: ‘1’,
},
responseType: ‘text’,
});

```
const streams = extractM3U8s(response.data, targetUrl);
return res.json({
success: true, mode: 'static', pageUrl: targetUrl,
finalUrl: response.request?.res?.responseUrl || targetUrl,
streams, count: streams.length,
});
```

} catch (err) {
const status = err.response?.status;
return res.status(502).json({
error: `Failed to fetch page: ${status ? 'HTTP ' + status : err.message}`,
code: status || null, mode: ‘static’,
});
}
});

/**

- GET /proxy
- ?url= URL to proxy (m3u8, ts segment, any stream asset)
- ?referer= Referer to send with the request
*/
app.get(’/proxy’, async (req, res) => {
const { url, referer } = req.query;
if (!url) return res.status(400).send(‘Missing ?url=’);

try {
const response = await axios.get(url, {
timeout: 20000,
responseType: ‘arraybuffer’,
headers: {
‘User-Agent’: UA_IPHONE,
‘Referer’: referer || new URL(url).origin,
‘Origin’: referer ? new URL(referer).origin : new URL(url).origin,
},
});

```
const ct = response.headers['content-type'] || 'application/octet-stream';
res.set('Content-Type', ct);
res.set('Access-Control-Allow-Origin', '*');
res.set('Cache-Control', 'no-store');
res.send(response.data);
```

} catch (err) {
res.status(502).send(’Proxy error: ’ + err.message);
}
});

// Health
app.get(’/’, (req, res) => res.json({
status: ‘ok’, service: ‘m3u8-extractor’,
modes: [‘static (axios)’, ‘js (puppeteer)’],
}));

app.listen(PORT, () => console.log(`m3u8 extractor :${PORT}`));
