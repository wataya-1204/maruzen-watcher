import * as cheerio from 'cheerio';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import puppeteer from 'puppeteer';

const NEW_URL = 'https://maruzen-toy.com/photo/NEW/';
const X_URL = 'https://maruzen-toy.com/photo/X';
const STATE_PATH = 'state.json';
const MAX_KNOWN = 1000;
const MAX_SHOWN_PER_SECTION = 10;
const MAX_DISCORD_LEN = 2000;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchWithPuppeteer(url) {
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    const html = await page.content();
    await browser.close();
    return html;
  } catch (err) {
    console.warn(`[warn] ${url} -> ${err.message}`);
    if (browser) await browser.close();
    return null;
  }
}

function extractProducts(html) {
  const $ = cheerio.load(html);
  $('script, style').remove();
  $('br').each((_, el) => {
    $(el).replaceWith('\n');
  });
  $('div, p, tr, li, td, h1, h2, h3, h4, h5, section, article').each((_, el) => {
    $(el).after('\n');
  });

  const lines = $('body')
    .text()
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const codeRe = /商品コード[:：]\s*([A-Za-z0-9\-]+)/;
  const priceRe = /[¥￥]\s?[\d,]+|[\d,]+\s?円/;

  const products = [];
  for (let i = 0; i < lines.length; i++) {
    const codeMatch = lines[i].match(codeRe);
    if (!codeMatch) continue;
    const code = codeMatch[1];

    let price = null;
    for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 3); j++) {
      const priceMatch = lines[j].match(priceRe);
      if (priceMatch) {
        price = priceMatch[0];
        break;
      }
    }

    let name = null;
    for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
      const candidate = lines[j];
      if (!candidate || codeRe.test(candidate) || priceRe.test(candidate)) continue;
      if (candidate.length < 2) continue;
      name = candidate;
      break;
    }

    products.push({ code, name: name ?? '(商品名不明)', price: price ?? '(価格不明)' });
  }

  const seen = new Set();
  return products.filter((p) => {
    if (seen.has(p.code)) return false;
    seen.add(p.code);
    return true;
  });
}

function normalizePrice(raw) {
  const m = String(raw).match(/[\d,]+/);
  return m ? m[0] : String(raw);
}

function loadState() {
  if (!existsSync(STATE_PATH)) {
    return { initialized: false, knownCodes: [], xKnownCodes: [] };
  }
  const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  return {
    initialized: parsed.initialized === true,
    knownCodes: Array.isArray(parsed.knownCodes) ? parsed.knownCodes : [],
    xKnownCodes: Array.isArray(parsed.xKnownCodes) ? parsed.xKnownCodes : [],
  };
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

function capOldest(codes) {
  return codes.length > MAX_KNOWN ? codes.slice(codes.length - MAX_KNOWN) : codes;
}

function formatSection(title, items) {
  const shown = items.slice(0, MAX_SHOWN_PER_SECTION);
  const body = shown.map((p) => `・${p.name} (￥${normalizePrice(p.price)})`).join('\n');
  const more = items.length > MAX_SHOWN_PER_SECTION ? `\n他${items.length - MAX_SHOWN_PER_SECTION}件` : '';
  return `【${title}】${items.length}件\n${body}${more}`;
}

function buildMessage(freshNew, freshX) {
  const sections = [];
  if (freshNew.length > 0) sections.push(formatSection('新製品コーナー', freshNew));
  if (freshX.length > 0) sections.push(formatSection('超特価コーナー', freshX));

  let content = `🧸 丸善商店で新着があります\n\n${sections.join(
    '\n\n'
  )}\n\nhttps://maruzen-toy.com/photo/NEW/\nhttps://maruzen-toy.com/photo/X`;

  if (content.length > MAX_DISCORD_LEN) {
    content = content.slice(0, MAX_DISCORD_LEN - 10) + '\n…(省略)';
  }
  return content;
}

async function postToDiscord(webhookUrl, content) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    throw new Error(`Discord webhook failed: HTTP ${res.status} ${await res.text()}`);
  }
}

async function main() {
  const state = loadState();
  const isFirstRun = !state.initialized;
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

  const [newHtml, xHtml] = await Promise.all([fetchWithPuppeteer(NEW_URL), fetchWithPuppeteer(X_URL)]);

  if (!newHtml && !xHtml) {
    console.log('両ページとも取得に失敗しました。今回は状態を更新せず終了します。');
    return;
  }

  const newProducts = newHtml ? extractProducts(newHtml) : null;
  const xProducts = xHtml ? extractProducts(xHtml) : null;

  if (newProducts) console.log(`[新製品コーナー] ${newProducts.length}件抽出`);
  else console.log('[新製品コーナー] 取得失敗のためスキップ');
  if (xProducts) console.log(`[超特価コーナー] ${xProducts.length}件抽出`);
  else console.log('[超特価コーナー] 取得失敗のためスキップ');

  if (isFirstRun) {
    const newState = {
      initialized: true,
      knownCodes: newProducts ? capOldest(newProducts.map((p) => p.code)) : [],
      xKnownCodes: xProducts ? capOldest(xProducts.map((p) => p.code)) : [],
    };
    saveState(newState);
    console.log('初回実行: 基準値を作成しました(通知なし)。');
    return;
  }

  const knownSet = new Set(state.knownCodes);
  const xKnownSet = new Set(state.xKnownCodes);
  const freshNew = newProducts ? newProducts.filter((p) => !knownSet.has(p.code)) : [];
  const freshX = xProducts ? xProducts.filter((p) => !xKnownSet.has(p.code)) : [];

  if (freshNew.length === 0 && freshX.length === 0) {
    console.log('新着なし。');
  } else {
    console.log(`新着検出: 新製品${freshNew.length}件 / 超特価${freshX.length}件`);
    const message = buildMessage(freshNew, freshX);
    if (webhookUrl) {
      await postToDiscord(webhookUrl, message);
      console.log('Discordに通知しました。');
    } else {
      console.warn('DISCORD_WEBHOOK_URL が未設定のため通知をスキップしました。');
    }
  }

  const updatedState = {
    initialized: true,
    knownCodes: newProducts ? capOldest(newProducts.map((p) => p.code)) : state.knownCodes,
    xKnownCodes: xProducts ? capOldest(xProducts.map((p) => p.code)) : state.xKnownCodes,
  };
  saveState(updatedState);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
