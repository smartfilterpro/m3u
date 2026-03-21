const express = require('express');
const cors = require('cors');
const axios = require('axios');
const puppeteer = require('puppeteer-core');

// ─────────────────────────────────────────────────────────────────────────────
// Chromium path resolution
// Works on: Synology NAS (system Chromium), Railway (@sparticuz/chromium),
// or any machine with Chrome/Chromium installed locally.
// ─────────────────────────────────────────────────────────────────────────────
async function getChromiumConfig () {
// 1. Explicit env var --- set this in Docker or Railway env
if (process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROMIUM_PATH) {
return {
executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROMIUM_PATH,
args: [
'--no-sandbox', '--disable-setuid-sandbox',
'--disable-dev-shm-usage', '--disable-gpu',
'--no-first-run', '--no-zygote', '--single-process',
'--disable-extensions',
],
headless: true,
defaultViewport: { width: 1280, height: 800 },
};
}

// 2. @sparticuz/chromium (Railway / serverless)
try {
const chromium = require('@sparticuz/chromium');
return {
executablePath: await chromium.executablePath(),
args: chromium.args,
headless: chromium.headless,
defaultViewport: chromium.defaultViewport,
};
} catch {}

// 3. Common system paths (fallback for local dev)
const { execSync } = require('child_process');
const candidates = [
'/usr/bin/chromium',
'/usr/bin/chromium-browser',
'/usr/bin/google-chrome',
'/usr/bin/google-chrome-stable',
'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
'C:\Program Files\Google\Chrome\Application\chrome.exe',
];
for (const p of candidates) {
try { execSync(`test -f "${p}"`); return { executablePath: p, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], headless: true, defaultViewport: { width: 1280, height: 800 } }; } catch {}
}

throw new Error('No Chromium/Chrome found. Set PUPPETEER_EXECUTABLE_PATH env var.');
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve the web UI from /public
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────────────────────
// User agents
// ─────────────────────────────────────────────────────────────────────────────
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

// ─────────────────────────────────────────────────────────────────────────────
// Video URL regex patterns (m3u8 + mp4 + other formats)
// ─────────────────────────────────────────────────────────────────────────────
const VIDEO_EXTENSIONS = 'm3u8|mp4|mkv|webm|avi|mov|flv|wmv|m4v|ts';
const VIDEO_EXT_RE = new RegExp(`\\.(${VIDEO_EXTENSIONS})`, 'i');

const M3U8_PATTERNS = [
/https?:\/\/[^\s"'`<>]+\.m3u8[^\s"'`<>]*/gi,
/["'`](https?:\/\/[^"'`]+\.m3u8[^"'`]*)/gi,
/(?:source|file|src|hls|stream|url|path|manifest)\s*[=:]\s*["'`]?(https?:\/\/[^"'`\s,)]+\.m3u8[^"'`\s,)]*)/gi,
/["'`](https?:\/\/[^"'`]+\/[A-Za-z0-9+\/=~_-]{20,}\/[A-Za-z0-9+\/=]{10,}\.m3u8[^"'`]*)/gi,
/https?:\/\/[^\s"'`<>]+cGxheWxpc3[^\s"'`<>]*/gi,
];

// Patterns for direct video file URLs (mp4, etc.)
const VIDEO_URL_PATTERNS = [
/https?:\/\/[^\s"'`<>]+\.(?:mp4|mkv|webm|mov|m4v)[^\s"'`<>]*/gi,
/["'`](https?:\/\/[^"'`]+\.(?:mp4|mkv|webm|mov|m4v)[^"'`]*)/gi,
/(?:source|file|src|video|stream|url|path)\s*[=:]\s*["'`]?(https?:\/\/[^"'`\s,)]+\.(?:mp4|mkv|webm|mov|m4v)[^"'`\s,)]*)/gi,
];

function extractM3U8s(text, pageUrl) {
const found = new Set();
let base = '';
try { base = new URL(pageUrl).origin; } catch {}

for (const pattern of M3U8_PATTERNS) {
pattern.lastIndex = 0;
let m;
while ((m = pattern.exec(text)) !== null) {
let u = (m[1] || m[0]).trim().replace(/["'`;,)>\s]+$/, '');
if (!u.startsWith('http') && base) {
u = base + (u.startsWith('/') ? '' : '/') + u;
}
if (u.includes('.m3u8')) found.add(u);
}
}

const rel = /["'`](\/[^"'`\s]+.m3u8[^"'`]*)/gi;
let m;
while ((m = rel.exec(text)) !== null) {
if (base) found.add(base + m[1]);
}

return [...found];
}

function extractVideoURLs(text, pageUrl) {
const found = new Set();
let base = '';
try { base = new URL(pageUrl).origin; } catch {}

for (const pattern of VIDEO_URL_PATTERNS) {
pattern.lastIndex = 0;
let m;
while ((m = pattern.exec(text)) !== null) {
let u = (m[1] || m[0]).trim().replace(/["'`;,)>\s]+$/, '');
if (!u.startsWith('http') && base) {
u = base + (u.startsWith('/') ? '' : '/') + u;
}
// Filter out tiny assets, thumbnails, ads
if (/thumb|poster|preview|pixel|track|beacon|\.gif|\.jpg|\.png|\.svg/i.test(u)) continue;
found.add(u);
}
}

// Relative paths
const relVid = /["'`](\/[^"'`\s]+\.(?:mp4|mkv|webm|mov|m4v)[^"'`]*)/gi;
let m2;
while ((m2 = relVid.exec(text)) !== null) {
if (base) found.add(base + m2[1]);
}

return [...found];
}

// ─────────────────────────────────────────────────────────────────────────────
// Guard script --- injected into every page before any site JS runs.
// Blocks: popups, pop-unders, new-tab tricks, cross-origin redirects,
// overlay ads, sticky ad elements.
// ─────────────────────────────────────────────────────────────────────────────
const PAGE_GUARD_SCRIPT = `
(function () {
'use strict';
const _origin = location.origin;

// ── Block window.open (popups / pop-unders) ───────────────────────────────
window.open = function () { return null; };

// ── Block cross-origin location redirects ─────────────────────────────────
try {
const desc = Object.getOwnPropertyDescriptor(window, 'location');
Object.defineProperty(window, 'location', {
get() { return desc ? desc.get.call(window) : location; },
set(v) {
try {
if (new URL(String(v), _origin).origin !== _origin) {
console.warn('[guard] Blocked redirect:', v); return;
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
window.addEventListener('beforeunload', e => e.stopImmediatePropagation(), true);

// ── Remove ad/overlay DOM elements ───────────────────────────────────────
const AD_SELECTORS = [
'[id*="pop" i]', '[class*="pop" i]',
'[id*="overlay" i]', '[class*="overlay" i]',
'[id*="interstitial" i]', '[class*="interstitial" i]',
'[id*="advert" i]', '[class*="advert" i]',
'iframe[src*="doubleclick"]', 'iframe[src*="googlesyndication"]',
'iframe[src*="popads"]', 'iframe[src*="popcash"]',
'iframe[src*="exoclick"]', 'iframe[src*="trafficjunky"]',
'[style*="z-index: 9999"]', '[style*="z-index:9999"]',
'[style*="z-index: 2147483647"]',
];

function removeAds () {
AD_SELECTORS.forEach(sel => {
try {
document.querySelectorAll(sel).forEach(el => {
if (!el.querySelector('video') && !el.closest('[id*="player" i]')) {
el.remove();
}
});
} catch {}
});
// Kill fixed/absolute overlays that cover the whole viewport
document.querySelectorAll('*').forEach(el => {
try {
const s = getComputedStyle(el);
if ((s.position === 'fixed' || s.position === 'absolute') &&
parseInt(s.zIndex) > 1000 &&
!el.querySelector('video') && !el.closest('[id*="player" i]')) {
el.remove();
}
} catch {}
});
}

if (document.readyState === 'loading') {
document.addEventListener('DOMContentLoaded', removeAds);
} else {
removeAds();
}
setTimeout(removeAds, 1500);
setTimeout(removeAds, 4000);

console.log('[guard] Protection active on', _origin);
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
/pop\.ac/, /fullpagebot.com/, /go.affec.tv/,
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
_browser.on('disconnected', () => {
    console.warn('[browser] Chromium disconnected — will relaunch on next request');
    _browser = null;
  });
return _browser;
}

// ─────────────────────────────────────────────────────────────────────────────
// Puppeteer extraction
// ─────────────────────────────────────────────────────────────────────────────
// ── Server / source selection buttons (click BEFORE play) ──────────────────
const SERVER_SELECTORS = [
  '[class*="server" i]', '[id*="server" i]',
  '[class*="source" i]', '[id*="source" i]',
  '[data-id]',                                // common data-attribute pattern
  '.nav-link[data-toggle]',                   // bootstrap tab servers
  '[class*="server-item" i]', '[class*="server-btn" i]',
  '[class*="streaming-server" i]',
  '[class*="episode-server" i]',
  '[class*="link-item" i]',
  '[class*="server_item" i]',
  'a[data-embed]', 'a[data-video]',           // embed link triggers
  '[class*="watch-link" i]', '[class*="watch_link" i]',
  'li[data-status]',                          // fmovies / watchseries style
];

const PLAY_SELECTORS = [
  '[class*="play" i]', '[id*="play" i]',
  '[aria-label*="play" i]', '[title*="play" i]',
  '[class*="btn-play" i]', '[class*="play-btn" i]',
  '[class*="vjs-big-play" i]',           // video.js
  '[class*="jw-icon-display" i]',         // JW Player
  '[class*="plyr__control--overlaid" i]', // Plyr
  'button[data-plyr="play"]',
  '.ytp-large-play-button',               // YouTube-style
  '[class*="icon-play" i]',
  'video',
  '.video-player [role="button"]',
  '[class*="player"] button',
  '[class*="playButton" i]',
  '[data-testid*="play" i]',
  'svg[class*="play" i]',
];

function clickPlayButtons(doc) {
  const clicked = new Set();
  for (const sel of (typeof PLAY_SELECTORS !== 'undefined' ? PLAY_SELECTORS : arguments[1])) {
    try {
      doc.querySelectorAll(sel).forEach(el => {
        if (clicked.has(el)) return;
        const rect = el.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) return;
        el.click();
        clicked.add(el);
      });
    } catch {}
  }
  return clicked.size;
}

async function extractWithPuppeteer (targetUrl, waitMs = 12000) {
const browser = await getBrowser();
const page = await browser.newPage();
const streams = new Set();
const videoUrls = new Set();   // direct video URLs (mp4, etc.)
const log = [];

try {
await page.setUserAgent(UA_IPHONE);
await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9', 'DNT': '1' });

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
// Allow iframe navigations to same-ish domains (video embeds)
try {
  const dest = new URL(url);
  const orig = new URL(targetUrl);
  // Allow if it looks like a video embed (common patterns)
  const embedPatterns = ['embed', 'player', 'video', 'iframe', 'stream',
    'watch', 'play', 'hls', 'cloud', 'cdn', 'load', 'ajax', 'source',
    'rabbitstream', 'megacloud', 'vidcloud', 'filemoon', 'streamtape',
    'doodstream', 'mixdrop', 'upstream', 'voe.sx', 'vidoza'];
  if (dest.hostname !== orig.hostname &&
      !embedPatterns.some(p => url.toLowerCase().includes(p))) {
    log.push({ action: 'popup-blocked', url: url.slice(0, 100) });
    return req.abort();
  }
} catch {}
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

// Sniff direct video URLs in requests
if (VIDEO_EXT_RE.test(url) && !url.includes('.m3u8') && !/thumb|poster|preview|pixel|\.gif|\.jpg|\.png|\.svg/i.test(url)) {
  // Only capture video file requests from media/xhr/fetch (skip page resources)
  if (type === 'media' || type === 'xhr' || type === 'fetch' || type === 'other') {
    videoUrls.add(url);
    log.push({ action: 'video-url-captured', url });
  }
}

// Sniff common stream patterns in XHR/fetch URLs
if (type === 'xhr' || type === 'fetch') {
  if (url.includes('m3u8') || url.includes('playlist') || url.includes('manifest')) {
    const m3u8Matches = url.match(/https?:\/\/[^\s"'`<>]+\.m3u8[^\s"'`<>]*/g);
    if (m3u8Matches) m3u8Matches.forEach(u => streams.add(u));
  }
  // Also check for video file URLs in API responses
  if (url.includes('source') || url.includes('video') || url.includes('stream') ||
      url.includes('getSources') || url.includes('getLink') || url.includes('ajax')) {
    log.push({ action: 'api-request-detected', url: url.slice(0, 150) });
  }
}

req.continue();
});

// ── Sniff video URLs in ALL responses (URL + content-type + body) ─────────
page.on('response', async response => {
const url = response.url();
const ct = response.headers()['content-type'] || '';

if (ct.includes('mpegurl') || ct.includes('x-mpegurl') || url.includes('.m3u8')) {
  streams.add(url);
  log.push({ action: 'stream-response', url });
}

// Capture direct video content-type responses
if (ct.includes('video/') && !url.includes('.ts')) {
  videoUrls.add(url);
  log.push({ action: 'video-response', url });
}

// Check response body for m3u8 AND video URL references in JSON/JS responses
if (ct.includes('json') || ct.includes('javascript') || ct.includes('text/plain')) {
  try {
    const body = await response.text();
    if (body.includes('.m3u8')) {
      extractM3U8s(body, targetUrl).forEach(u => streams.add(u));
    }
    // Also look for direct video file URLs in API responses
    if (body.includes('.mp4') || body.includes('.mkv') || body.includes('.webm') || body.includes('.mov')) {
      extractVideoURLs(body, targetUrl).forEach(u => videoUrls.add(u));
    }
  } catch {} // response may already be consumed
}
});

// ── Inject protection before any page JS runs ─────────────────────────────
await page.evaluateOnNewDocument(PAGE_GUARD_SCRIPT);

// ── Navigate ──────────────────────────────────────────────────────────────
await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });

// ── Click server/source selection buttons first ───────────────────────────
const serverSelectors = SERVER_SELECTORS;
await page.evaluate((selectors) => {
  for (const sel of selectors) {
    try {
      const els = document.querySelectorAll(sel);
      // Click the first visible server button (usually the active/default one)
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.width >= 10 && rect.height >= 10) {
          el.click();
          break; // click just the first visible one
        }
      }
    } catch {}
  }
}, serverSelectors);
log.push({ action: 'server-buttons-clicked' });
// Give time for embed iframe to load after server selection
await new Promise(r => setTimeout(r, 2000));

// ── Click play buttons (round 1) ──────────────────────────────────────────
const playSelectors = PLAY_SELECTORS;
await page.evaluate((selectors) => {
const clicked = new Set();
for (const sel of selectors) {
  try {
    document.querySelectorAll(sel).forEach(el => {
      if (clicked.has(el)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return;
      el.click();
      clicked.add(el);
    });
  } catch {}
}
}, playSelectors);
log.push({ action: 'play-buttons-clicked-round1' });

// ── Click play buttons in ALL frames (iframes) ───────────────────────────
async function clickInFrames() {
  const frames = page.frames();
  for (const frame of frames) {
    if (frame === page.mainFrame()) continue;
    try {
      // Also extract m3u8 + video URLs from frame HTML
      const frameHtml = await frame.evaluate(() => document.documentElement.outerHTML);
      extractM3U8s(frameHtml, targetUrl).forEach(u => streams.add(u));
      extractVideoURLs(frameHtml, targetUrl).forEach(u => videoUrls.add(u));

      await frame.evaluate((selectors) => {
        for (const sel of selectors) {
          try {
            document.querySelectorAll(sel).forEach(el => {
              const rect = el.getBoundingClientRect();
              if (rect.width >= 10 && rect.height >= 10) el.click();
            });
          } catch {}
        }
      }, playSelectors);
    } catch {} // cross-origin frames will throw — that's expected
  }
}
await clickInFrames();

// ── Wait for streams with network activity monitoring ─────────────────────
let lastNetworkActivity = Date.now();
const networkListener = () => { lastNetworkActivity = Date.now(); };
page.on('request', networkListener);

for (let elapsed = 0; elapsed < waitMs; elapsed += 1000) {
  await new Promise(r => setTimeout(r, 1000));
  if (streams.size > 0 || videoUrls.size > 0) {
    // Found streams — wait 2 more seconds for additional variants
    await new Promise(r => setTimeout(r, 2000));
    log.push({ action: 'stream-found', elapsed: elapsed + 1000 });
    break;
  }
  // If network went idle for 3s and we've waited at least 5s, stop early
  if (elapsed >= 5000 && Date.now() - lastNetworkActivity > 3000) {
    log.push({ action: 'network-idle-exit', elapsed });
    break;
  }
}

// ── Click play buttons again (round 2) — catches lazy-loaded players ──────
if (streams.size === 0 && videoUrls.size === 0) {
  await page.evaluate((selectors) => {
    for (const sel of selectors) {
      try {
        document.querySelectorAll(sel).forEach(el => {
          const rect = el.getBoundingClientRect();
          if (rect.width >= 10 && rect.height >= 10) el.click();
        });
      } catch {}
    }
  }, playSelectors);
  await clickInFrames();
  log.push({ action: 'play-buttons-clicked-round2' });
  // Wait another 5s after second click round
  for (let elapsed = 0; elapsed < 5000; elapsed += 1000) {
    await new Promise(r => setTimeout(r, 1000));
    if (streams.size > 0 || videoUrls.size > 0) break;
  }
}

// ── Scrape full rendered HTML + inline scripts from ALL frames ────────────
const fullText = await page.evaluate(() => {
const scripts = [...document.querySelectorAll('script')]
.map(s => s.textContent || '').join('\n');
return document.documentElement.outerHTML + '\n' + scripts;
});
extractM3U8s(fullText, targetUrl).forEach(u => streams.add(u));
extractVideoURLs(fullText, targetUrl).forEach(u => videoUrls.add(u));

// Scan all iframes too
const frames = page.frames();
for (const frame of frames) {
  if (frame === page.mainFrame()) continue;
  try {
    const frameText = await frame.evaluate(() => {
      const scripts = [...document.querySelectorAll('script')]
        .map(s => s.textContent || '').join('\n');
      return document.documentElement.outerHTML + '\n' + scripts;
    });
    extractM3U8s(frameText, targetUrl).forEach(u => streams.add(u));
    extractVideoURLs(frameText, targetUrl).forEach(u => videoUrls.add(u));
  } catch {}
}

// ── Extract video element sources from all frames ──────────────────────────
const extractVideoSources = async (frame) => {
  try {
    const sources = await frame.evaluate(() => {
      const urls = [];
      // Check all <video> elements
      document.querySelectorAll('video').forEach(v => {
        if (v.src && v.src.startsWith('http')) urls.push(v.src);
        if (v.currentSrc && v.currentSrc.startsWith('http')) urls.push(v.currentSrc);
        // Check <source> children
        v.querySelectorAll('source').forEach(s => {
          if (s.src && s.src.startsWith('http')) urls.push(s.src);
        });
      });
      // Check standalone <source> elements
      document.querySelectorAll('source[src]').forEach(s => {
        if (s.src && s.src.startsWith('http')) urls.push(s.src);
      });
      // Check <iframe> src attributes for embed URLs
      document.querySelectorAll('iframe[src]').forEach(f => {
        if (f.src && f.src.startsWith('http')) urls.push('iframe:' + f.src);
      });
      return urls;
    });
    for (const u of sources) {
      if (u.startsWith('iframe:')) {
        const iframeUrl = u.slice(7);
        log.push({ action: 'iframe-src-found', url: iframeUrl.slice(0, 150) });
        // Don't add iframe URLs to streams, but log them for debugging
      } else if (u.includes('.m3u8')) {
        streams.add(u);
      } else if (VIDEO_EXT_RE.test(u)) {
        videoUrls.add(u);
      }
    }
  } catch {}
};

await extractVideoSources(page.mainFrame());
for (const frame of page.frames()) {
  if (frame !== page.mainFrame()) await extractVideoSources(frame);
}

// ── Scan window-level globals for stream URLs (all frames) ────────────────
const scanGlobals = async (frame) => {
  try {
    const found = await frame.evaluate(() => {
      const found = [];
      const videoExts = /\.(m3u8|mp4|mkv|webm|mov|m4v)/;
      for (const k of Object.keys(window)) {
        try {
          const v = JSON.stringify(window[k]);
          if (v && (v.includes('.m3u8') || v.includes('.mp4') || v.includes('.mkv') || v.includes('.webm'))) {
            const hits = v.match(/https?:\/\/[^"'\x60\s]+\.(?:m3u8|mp4|mkv|webm|mov|m4v)[^"'\x60\s]*/g);
            if (hits) found.push(...hits);
          }
        } catch {}
      }
      return found;
    });
    found.forEach(u => {
      if (u.includes('.m3u8')) streams.add(u);
      else videoUrls.add(u);
    });
  } catch {}
};

await scanGlobals(page.mainFrame());
for (const frame of frames) {
  if (frame !== page.mainFrame()) await scanGlobals(frame);
}

const allVideoUrls = [...videoUrls].filter(u => !/thumb|poster|preview|pixel|beacon|\.gif|\.jpg|\.png|\.svg/i.test(u));
return { success: true, streams: [...streams], videoUrls: allVideoUrls, count: streams.size + allVideoUrls.length, log };

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
- ?js=true Use Puppeteer (JS-rendered) mode --- catches dynamically loaded streams
- ?wait= ms to wait after page load (default 8000, max 30000)
*/
app.get('/extract', async (req, res) => {
const { url, js, wait } = req.query;
if (!url) return res.status(400).json({ error: 'Missing ?url= parameter' });

let targetUrl;
try { targetUrl = new URL(url).toString(); }
catch { return res.status(400).json({ error: 'Invalid URL' }); }

const useJs = js === 'true' || js === '1';
const waitMs = Math.min(parseInt(wait) || 8000, 30000);

if (useJs) {
try {
const result = await extractWithPuppeteer(targetUrl, waitMs);
return res.json({ ...result, mode: 'puppeteer', pageUrl: targetUrl });
} catch (err) {
return res.status(502).json({ error: 'Puppeteer error: ' + err.message, mode: 'puppeteer' });
}
}

// Static axios mode
try {
const response = await axios.get(targetUrl, {
timeout: 15000,
maxRedirects: 5,
headers: {
'User-Agent': UA_IPHONE,
'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
'Accept-Language': 'en-US,en;q=0.5',
'Referer': new URL(targetUrl).origin,
'DNT': '1',
},
responseType: 'text',
});

const streams = extractM3U8s(response.data, targetUrl);
const videoUrlsStatic = extractVideoURLs(response.data, targetUrl);
return res.json({
success: true, mode: 'static', pageUrl: targetUrl,
finalUrl: response.request?.res?.responseUrl || targetUrl,
streams, videoUrls: videoUrlsStatic, count: streams.length + videoUrlsStatic.length,
});

} catch (err) {
const status = err.response?.status;
return res.status(502).json({
error: `Failed to fetch page: ${status ? 'HTTP ' + status : err.message}`,
code: status || null, mode: 'static',
});
}
});

/**

- GET /proxy
- ?url= URL to proxy (m3u8, ts segment, any stream asset)
- ?referer= Referer to send with the request
*/
app.get('/proxy', async (req, res) => {
const { url, referer } = req.query;
if (!url) return res.status(400).send('Missing ?url=');

try {
const response = await axios.get(url, {
timeout: 20000,
responseType: 'arraybuffer',
headers: {
'User-Agent': UA_IPHONE,
'Referer': referer || new URL(url).origin,
'Origin': referer ? new URL(referer).origin : new URL(url).origin,
},
});

const ct = response.headers['content-type'] || 'application/octet-stream';
res.set('Content-Type', ct);
res.set('Access-Control-Allow-Origin', '*');
res.set('Cache-Control', 'no-store');
res.send(response.data);

} catch (err) {
res.status(502).send('Proxy error: ' + err.message);
}
});

/**
 * GET /download
 * ?url=    m3u8 URL to download
 * ?referer= Referer to send with requests
 * ?name=   Optional filename (without extension)
 *
 * Downloads the HLS stream via ffmpeg and streams back an MP4 file.
 */
const { spawn } = require('child_process');
const activeDownloads = new Map();

app.get('/download', (req, res) => {
  const { url, referer, name } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing ?url= parameter' });

  const filename = (name || 'stream_' + Date.now()) + '.mp4';
  const ref = referer || (() => { try { return new URL(url).origin; } catch { return ''; } })();

  // Build ffmpeg command
  const args = [
    '-y',
    '-headers', `Referer: ${ref}\r\nUser-Agent: ${UA_IPHONE}\r\nOrigin: ${ref}\r\n`,
    '-i', url,
    '-c', 'copy',         // no re-encoding — fast
    '-bsf:a', 'aac_adtstoasc',  // fix AAC streams for MP4 container
    '-movflags', 'frag_keyframe+empty_moov+faststart',  // streamable MP4
    '-f', 'mp4',
    'pipe:1',             // output to stdout
  ];

  const downloadId = Date.now().toString(36);

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Download-Id', downloadId);

  const ffmpeg = spawn('ffmpeg', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  activeDownloads.set(downloadId, { ffmpeg, startedAt: Date.now() });

  ffmpeg.stdout.pipe(res);

  let stderrLog = '';
  ffmpeg.stderr.on('data', chunk => {
    stderrLog += chunk.toString();
  });

  ffmpeg.on('error', err => {
    console.error('[download] ffmpeg spawn error:', err.message);
    activeDownloads.delete(downloadId);
    if (!res.headersSent) {
      res.status(500).json({ error: 'ffmpeg not available: ' + err.message });
    }
  });

  ffmpeg.on('close', code => {
    activeDownloads.delete(downloadId);
    if (code !== 0 && !res.headersSent) {
      console.error('[download] ffmpeg exited with code', code, stderrLog.slice(-500));
      res.status(500).json({ error: 'Download failed' });
    }
  });

  req.on('close', () => {
    // Client disconnected — kill ffmpeg
    if (ffmpeg.exitCode === null) {
      ffmpeg.kill('SIGTERM');
      activeDownloads.delete(downloadId);
    }
  });
});

/**
 * GET /download/status
 * Returns count of active downloads
 */
app.get('/download/status', (req, res) => {
  res.json({ active: activeDownloads.size });
});

// Health check (only reached if public/index.html doesn't exist)
app.get('/', (req, res) => res.json({
status: 'ok', service: 'm3u8-extractor',
modes: ['static (axios)', 'js (puppeteer)'],
}));

// API health at /api/health (always available)
app.get('/api/health', (req, res) => res.json({
status: 'ok', service: 'm3u8-extractor',
modes: ['static (axios)', 'js (puppeteer)'],
}));

const server = app.listen(PORT, () => console.log(`m3u8 extractor :${PORT}`));

// ─────────────────────────────────────────────────────────────────────────────
// Keep-alive & error handling — prevent silent exit on NAS / Docker
// ─────────────────────────────────────────────────────────────────────────────

// Catch unhandled promise rejections (e.g. Puppeteer crashes) so the process
// doesn't exit with code 0 or 1 silently.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[fatal] Uncaught exception:', err);
});

// Graceful shutdown on SIGTERM (Docker stop) and SIGINT (Ctrl-C)
function shutdown(signal) {
  console.log(`[shutdown] Received ${signal}, closing server...`);
  server.close(() => {
    console.log('[shutdown] HTTP server closed.');
    if (_browser) {
      _browser.close().catch(() => {}).finally(() => process.exit(0));
    } else {
      process.exit(0);
    }
  });
  // Force exit after 10s if graceful shutdown stalls
  setTimeout(() => { console.error('[shutdown] Forced exit'); process.exit(1); }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
