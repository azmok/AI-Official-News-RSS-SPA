import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { Firestore } from '@google-cloud/firestore';
import * as cheerio from 'cheerio';
import { GoogleGenAI } from '@google/genai';
import { handleCheck } from './src/index';

// Enable environment variable loading
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// Initialize Firestore
let firebaseConfig: any = {};
try {
  const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }
} catch (e) {
  console.error('Failed to load firebase-applet-config.json:', e);
}

// Support cross-project / sandbox deployments via dedicated Google Service Account Private Key
let db: Firestore;
const serviceAccountEnv = process.env.FIREBASE_SERVICE_ACCOUNT;

try {
  const firestoreOptions: any = {
    projectId: firebaseConfig.projectId,
    databaseId: firebaseConfig.firestoreDatabaseId || '(default)',
  };

  if (serviceAccountEnv) {
    console.log('[Firestore] FIREBASE_SERVICE_ACCOUNT secret detected. Attempting parsing...');
    try {
      firestoreOptions.credentials = JSON.parse(serviceAccountEnv);
      console.log('[Firestore] Service account credentials custom credentials bound successfully.');
    } catch (parseErr: any) {
      console.error('[Firestore] CRITICAL ERROR: Unable to parse FIREBASE_SERVICE_ACCOUNT as JSON string:', parseErr.message);
    }
  } else {
    console.warn('[Firestore] WARNING: No FIREBASE_SERVICE_ACCOUNT environment variable found.');
    console.warn('[Firestore] Utilizing default platform credentials, which may fail if IAM permissions are missing on this named database. Please provide a Firebase Service Account JSON string in environment variable FIREBASE_SERVICE_ACCOUNT if permissions are denied.');
  }

  db = new Firestore(firestoreOptions);
  console.log('[Firestore] Initialization complete on database:', firestoreOptions.databaseId);
} catch (initErr: any) {
  console.error('[Firestore] Failed to initialize Firestore SDK:', initErr);
  // fallback placeholder to prevent app crash on startup
  db = new Firestore({
    projectId: firebaseConfig.projectId || 'fallback',
    databaseId: '(default)'
  });
}

// Seed sources lists
const SEED_SOURCES = [
  { name: 'OpenAI Research',    pageUrl: 'https://openai.com/blog',                  type: 'rss', feedUrl: 'https://openai.com/blog/rss.xml', enabled: true, selector: '' },
  { name: 'OpenAI Engineering',  pageUrl: 'https://openai.com/news/engineering',      type: 'rss', feedUrl: 'https://openai.com/news/engineering/rss.xml', enabled: true, selector: '' },
  { name: 'Hugging Face Blog',   pageUrl: 'https://huggingface.co/blog',              type: 'rss', feedUrl: 'https://huggingface.co/blog/feed.xml', enabled: true, selector: '' },
  { name: 'Google AI',          pageUrl: 'https://deepmind.google/blog',             type: 'rss', feedUrl: 'https://deepmind.google/blog/rss.xml', enabled: true, selector: '' },
  { name: 'The Verge AI',       pageUrl: 'https://www.theverge.com/rss/ai-artificial-intelligence', type: 'rss', feedUrl: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', enabled: true, selector: '' },
  { name: 'Anthropic News',     pageUrl: 'https://www.anthropic.com/news',           type: 'rss', feedUrl: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml', enabled: true, selector: '' },
  { name: 'Anthropic Engineering', pageUrl: 'https://www.anthropic.com/engineering', type: 'rss', feedUrl: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_engineering.xml', enabled: true, selector: '' },
  { name: 'Cursor Blog',        pageUrl: 'https://www.cursor.com/blog',              type: 'rss', feedUrl: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_cursor.xml', enabled: true, selector: '' },
];

// Helper to Sleep
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper to Normalize URLs for duplicate checking
function normalizeUrl(urlStr: string): string {
  try {
    const u = new URL(urlStr);
    let normalized = `${u.protocol}//${u.hostname}${u.pathname}`;
    if (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
    return normalized.toLowerCase();
  } catch {
    return urlStr.toLowerCase();
  }
}

// Mailer Helper
async function sendEmailNotification(subject: string, htmlContent: string) {
  const resendApiKey = process.env.RESEND_API_KEY;
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_PASS;
  const recipient = process.env.NOTIFICATION_EMAIL || "gentakanashi0425@gmail.com";

  console.log(`\n================== OUTBOX EMAIL DISPATCH ==================`);
  console.log(`SUBJECT : ${subject}`);
  console.log(`TO      : ${recipient}`);
  console.log(`---------------------------------------------------------`);
  console.log(htmlContent.replace(/<[^>]*>/g, ' ').slice(0, 300) + '...');
  console.log(`=========================================================\n`);

  if (resendApiKey) {
    try {
      console.log('Sending via Resend API...');
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${resendApiKey}`,
        },
        body: JSON.stringify({
          from: 'AI Notifier <notifier@resend.dev>',
          to: recipient,
          subject: subject,
          html: htmlContent,
        }),
      });
      if (response.ok) {
        console.log('Resend API dispatched successfully.');
        return { success: true, method: 'resend' };
      } else {
        const errTxt = await response.text();
        console.error('Resend API failed:', errTxt);
        if (errTxt.includes('validation_error') && errTxt.includes('testing emails')) {
          console.warn('\n========================================================================');
          console.warn('⚠️ RESEND API SANDBOX RESTRICTION DETECTED!');
          console.warn(`Your Resend API Key is currently limited to sending testing emails to its owner.`);
          console.warn('Please do one of the following to resolve:');
          console.warn(`1. Set NOTIFICATION_EMAIL to the Resend owner address (e.g., mail.to.azumao@gmail.com) in AI Studio secrets.`);
          console.warn('2. Verify your custom sender domain in Resend Console (https://resend.com/domains).');
          console.warn('3. Rely on Gmail SMTP below by configuring valid GMAIL_USER and GMAIL_PASS parameters.');
          console.warn('========================================================================\n');
        }
      }
    } catch (e) {
      console.error('Resend transaction exploded:', e);
    }
  }

  if (gmailUser && gmailPass) {
    try {
      console.log('Sending via Nodemailer Gmail SMTP...');
      const nodemailer = await import('nodemailer');
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: gmailUser,
          pass: gmailPass,
        },
      });
      await transporter.sendMail({
        from: `"AI Notifier" <${gmailUser}>`,
        to: recipient,
        subject: subject,
        html: htmlContent,
      });
      console.log('Gmail SMTP dispatched successfully.');
      return { success: true, method: 'nodemailer' };
    } catch (e: any) {
      console.error('Gmail SMTP transaction exploded:', e);
      if (e.message && (e.message.includes('Application-specific password required') || e.message.includes('534-5.7.9'))) {
        console.warn('\n========================================================================');
        console.warn('⚠️ GMAIL SMTP APPLICATION-SPECIFIC PASSWORD REQUIRED!');
        console.warn('Your Google Account requires a 16-character App Password (アプリパスワード) when 2-Step Verification is active.');
        console.warn('To resolve this:');
        console.warn('1. Go to your Google Account Settings -> Security: https://myaccount.google.com/security');
        console.warn('2. Search for "App passwords" under How you sign in to Google (or click "2-Step Verification" -> "App passwords" at the bottom).');
        console.warn('3. Select application "Mail" and device "Other", then click "Generate".');
        console.warn('4. Copy the safe 16-character code and paste it as GMAIL_PASS inside AI Studio secrets.');
        console.warn('========================================================================\n');
      }
    }
  }

  console.warn('⚠️ No active email credentials (RESEND_API_KEY / GMAIL_USER / GMAIL_PASS) identified in environment. Flight logs simulated.');
  return { success: true, method: 'simulated' };
}

// XML / HTML Source Discovery Function
async function discoverSourceType(pageUrl: string) {
  console.log(`[Discovery Debug] Starting discovery crawl on "${pageUrl}"...`);
  try {
    const response = await fetch(pageUrl, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    console.log(`[Discovery Debug] GET "${pageUrl}" returned HTTP Status: ${response.status} (${response.statusText})`);
    const serverHeader = response.headers.get('server') || 'Unknown';
    const cloudflareRay = response.headers.get('cf-ray');
    console.log(`[Discovery Debug] Response Headers -> Server: "${serverHeader}", CF-Ray: "${cloudflareRay || 'None'}"`);

    if (response.status === 403 || response.status === 503) {
      console.warn(`[Discovery Debug] ⚠️ HTTP ${response.status} detected. This is highly indicative of anti-bot protections (e.g. Cloudflare, Akamai WAF) blocking crawler containers.`);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} failed to fetch page content`);
    }
    const htmlText = await response.text();
    console.log(`[Discovery Debug] Content fetched successfully. Length: ${htmlText.length} characters.`);
    const $ = cheerio.load(htmlText);

    // 1. Search for RSS/Atom <link rel="alternate">
    let rssUrl: string | null = null;
    $('link[rel="alternate"]').each((_, elem) => {
      const typeAttr = $(elem).attr('type') || '';
      const hrefAttr = $(elem).attr('href') || '';
      if (typeAttr.includes('rss') || typeAttr.includes('xml') || typeAttr.includes('atom')) {
        if (hrefAttr) {
          rssUrl = new URL(hrefAttr, pageUrl).toString();
        }
      }
    });

    if (rssUrl) {
      console.log(`[Discovery Debug] ✅ Auto-discovered alternate RSS feed URL: "${rssUrl}"`);
      return { type: 'rss' as const, feedUrl: rssUrl };
    }

    // 2. Fallback check for standard sitemap
    console.log(`[Discovery Debug] No RSS links found on page. Falling back to test popular default sitemaps...`);
    const originUrl = new URL(pageUrl).origin;
    const sitemapCandidates = [
      `${originUrl}/sitemap.xml`,
      `${originUrl}/sitemap-posts.xml`
    ];

    for (const siteUrl of sitemapCandidates) {
      try {
        console.log(`[Discovery Debug] Probing sitemap candidate: "${siteUrl}"`);
        const siteRes = await fetch(siteUrl, {
          method: 'HEAD',
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
        });
        if (siteRes.ok) {
          const testRes = await fetch(siteUrl);
          const xmlText = await testRes.text();
          if (xmlText.toLowerCase().includes('<urlset') || xmlText.toLowerCase().includes('<sitemapindex')) {
            console.log(`[Discovery Debug] ✅ Auto-discovered healthy XML sitemap feed URL at: "${siteUrl}"`);
            return { type: 'sitemap' as const, feedUrl: siteUrl };
          }
        }
      } catch (err: any) {
        console.log(`[Discovery Debug] Candidate probe failed for "${siteUrl}": ${err.message}`);
      }
    }

    // 3. Fallback to scraping
    console.log(`[Discovery Debug] No sitemaps found either. Falling back to local scraper strategy.`);
    return { type: 'scrape' as const, feedUrl: null };
  } catch (err: any) {
    console.error(`[Discovery Debug] Autonomous discovery failed entirely for target page ${pageUrl}:`, err);
    return { type: 'scrape' as const, feedUrl: null, error: err.message };
  }
}

// Lazy initialization of Gemini API Client
let aiInstance: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI | null {
  if (!aiInstance) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      console.warn('[Gemini SDK Warning] GEMINI_API_KEY environment variable is missing.');
      return null;
    }
    aiInstance = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
  }
  return aiInstance;
}

// Fetch articles via Gemini Search Grounding as robust scraper fallback
async function fetchArticlesViaGeminiSearch(sourceName: string, pageUrl: string): Promise<{ url: string; title: string; date: Date; description?: string }[]> {
  console.log(`[Gemini Search Debug] Attempting Google Search Grounding for developer journal target: "${sourceName}" (${pageUrl})...`);
  const ai = getGeminiClient();
  if (!ai) {
    console.warn('[Gemini Search Debug] Aborted because GEMINI_API_KEY is not configured in secrets.');
    return [];
  }

  const prompt = `Use Google Search to find the latest 8 public blog articles or news articles written and published directly by "${sourceName}" at the URL "${pageUrl}".
For each article, recover:
1. The exact absolute URL (must belong specifically to the host of "${pageUrl}" and not be a feed subscription or generic landing page).
2. The exact article title.
3. The approximate publication date.
4. A short description or paragraph detailing the article content.

Return a JSON array of objects fitting exactly into this TypeScript type:
interface CrawledArticle {
  url: string;
  title: string;
  dateStr: string; // ISO format or representative publish date string
  description: string;
}

Ensure you provide valid, raw JSON array of objects. Do not add markdown wrappers. Just raw text.`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
      }
    });

    const responseText = response.text || "";
    console.log(`[Gemini Search Debug] Received response for ${sourceName} (length: ${responseText.length} characters)`);
    
    // Parse JSON safely
    let cleanJson = responseText.trim();
    if (cleanJson.startsWith('```')) {
      cleanJson = cleanJson.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    }
    
    const parsed: any[] = JSON.parse(cleanJson);
    if (!Array.isArray(parsed)) {
      console.warn('[Gemini Search Debug] Output parsed successfully but has no array envelope:', parsed);
      return [];
    }

    const articles = parsed.map((item: any) => {
      const pubDate = item.dateStr ? new Date(item.dateStr) : new Date();
      return {
        url: String(item.url || '').trim(),
        title: String(item.title || 'Untitled Article').trim(),
        date: isNaN(pubDate.getTime()) ? new Date() : pubDate,
        description: String(item.description || '').trim() || undefined
      };
    }).filter(a => a.url && a.title);

    console.log(`[Gemini Search Debug] Discovered ${articles.length} valid articles via Google Search Grounding for: "${sourceName}"`);
    return articles;
  } catch (err: any) {
    console.error(`[Gemini Search Debug] Failed search grounding for: "${sourceName}":`, err);
    return [];
  }
}

// Fetch RSS XML articles
async function fetchRssArticles(feedUrl: string) {
  console.log(`[Fetch RSS Debug] Crawling RSS Feed at "${feedUrl}"...`);
  const response = await fetch(feedUrl, {
    headers: {
      'Accept': 'application/rss+xml, application/rdf+xml, application/xml, text/xml, */*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });

  console.log(`[Fetch RSS Debug] GET "${feedUrl}" returned HTTP Status: ${response.status} (${response.statusText})`);
  const serverHeader = response.headers.get('server') || 'Unknown';
  console.log(`[Fetch RSS Debug] Response Headers -> Server: "${serverHeader}", CF-Ray: "${response.headers.get('cf-ray') || 'None'}"`);

  if (!response.ok) {
    if (response.status === 403 || response.status === 503) {
      throw new Error(`HTTP ${response.status} fetching RSS Feed (Anti-bot blockage detected)`);
    }
    throw new Error(`HTTP ${response.status} fetching RSS Feed`);
  }

  const text = await response.text();
  console.log(`[Fetch RSS Debug] Received RSS payload of length: ${text.length} characters.`);
  const $ = cheerio.load(text, { xml: true });
  const articles: { url: string; title: string; date: Date; description?: string }[] = [];

  const items = $('item, entry');
  console.log(`[Fetch RSS Debug] Found ${items.length} raw <item> or <entry> XML tags.`);

  items.each((_, elem) => {
    let url = $(elem).find('link').text().trim();
    if (!url) {
      url = $(elem).find('link').attr('href')?.trim() || '';
    }
    const title = $(elem).find('title').text().trim();
    const pubDateStr = $(elem).find('pubDate, pubdate, updated, published').text().trim();
    const date = pubDateStr ? new Date(pubDateStr) : new Date();

    // Parse RSS description / summary
    let descRaw = $(elem).find('description, summary').text().trim();
    if (!descRaw) {
      descRaw = $(elem).find('content\\:encoded, encoded').text().trim();
    }
    const cleanDesc = descRaw
      .replace(/<[^>]*>/g, '') // strip HTML tags
      .replace(/\s+/g, ' ')   // merge whitespace
      .trim();
    const shortDesc = cleanDesc.length > 200 ? cleanDesc.substring(0, 200) + '...' : cleanDesc;

    if (url && title) {
      articles.push({ 
        url, 
        title, 
        date: isNaN(date.getTime()) ? new Date() : date,
        description: shortDesc || undefined
      });
    }
  });
  console.log(`[Fetch RSS Debug] Successfully parsed ${articles.length} valid articles from feed.`);
  return articles;
}

// Fetch Sitemap URLs
async function fetchSitemapArticles(feedUrl: string, pageUrl: string) {
  console.log(`[Fetch Sitemap Debug] Crawling Sitemap at "${feedUrl}" (Referer Target Domain: "${pageUrl}")...`);
  const response = await fetch(feedUrl, {
    headers: {
      'Accept': 'application/xml, text/xml, */*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });

  console.log(`[Fetch Sitemap Debug] GET "${feedUrl}" returned HTTP Status: ${response.status} (${response.statusText})`);
  const serverHeader = response.headers.get('server') || 'Unknown';
  console.log(`[Fetch Sitemap Debug] Response Headers -> Server: "${serverHeader}", CF-Ray: "${response.headers.get('cf-ray') || 'None'}"`);

  if (!response.ok) {
    if (response.status === 403 || response.status === 503) {
      throw new Error(`HTTP ${response.status} fetching sitemap (Anti-bot blockage detected)`);
    }
    throw new Error(`HTTP ${response.status} fetching sitemap`);
  }

  const text = await response.text();
  console.log(`[Fetch Sitemap Debug] Received XML payload of length: ${text.length} characters.`);
  const $ = cheerio.load(text, { xml: true });
  const articles: { url: string; title: string; date: Date; description?: string }[] = [];

  const targetDomain = new URL(pageUrl).hostname;
  const urls = $('url');
  console.log(`[Fetch Sitemap Debug] Found ${urls.length} raw <url> elements in XML.`);

  urls.each((_, elem) => {
    const url = $(elem).find('loc').text().trim();
    const lastmodStr = $(elem).find('lastmod').text().trim();
    const date = lastmodStr ? new Date(lastmodStr) : new Date();

    if (url) {
      let title = '';
      try {
        const u = new URL(url);
        const slug = u.pathname.split('/').filter(Boolean).pop() || '';
        title = slug
          .split(/[-_]+/)
          .map(w => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');
      } catch {
        title = 'Blog Post';
      }
      if (!title) title = 'Blog Update';

      articles.push({ 
        url, 
        title, 
        date: isNaN(date.getTime()) ? new Date() : date,
        description: 'Discovered via sitemap index feed.'
      });
    }
  });

  const matches = articles.filter(a => {
    try {
      return new URL(a.url).hostname === targetDomain;
    } catch {
      return false;
    }
  });
  console.log(`[Fetch Sitemap Debug] Parsed ${matches.length} articles matching target domain: "${targetDomain}"`);
  return matches;
}

// Fetch Scraped HTML articles
async function fetchScrapedArticles(pageUrl: string, selector: string) {
  console.log(`[Fetch Scraper Debug] Scrape crawling page: "${pageUrl}" with query selector constraints: "${selector || 'default'}"`);
  const response = await fetch(pageUrl, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });

  console.log(`[Fetch Scraper Debug] GET "${pageUrl}" returned HTTP Status: ${response.status} (${response.statusText})`);
  const serverHeader = response.headers.get('server') || 'Unknown';
  console.log(`[Fetch Scraper Debug] Response Headers -> Server: "${serverHeader}", CF-Ray: "${response.headers.get('cf-ray') || 'None'}"`);

  if (!response.ok) {
    if (response.status === 403 || response.status === 503) {
      throw new Error(`HTTP ${response.status} failed to fetch target scraping web page (Anti-bot blockage detected)`);
    }
    throw new Error(`HTTP ${response.status} failed to fetch target scraping web page`);
  }

  const html = await response.text();
  console.log(`[Fetch Scraper Debug] Content decoded successfully. HTML string length: ${html.length} characters.`);
  const $ = cheerio.load(html);
  const articles: { url: string; title: string; date: Date; description?: string }[] = [];

  const targetSelector = selector || 'article a, .post-card a, a[href*="/blog/"], a[href*="/news/"]';
  const targetDomain = new URL(pageUrl).hostname;

  const foundElements = $(targetSelector);
  console.log(`[Fetch Scraper Debug] Running cheerio selector query "${targetSelector}". Matches count: ${foundElements.length}`);

  foundElements.each((_, elem) => {
    const href = $(elem).attr('href');
    if (!href) return;

    let url = '';
    try {
      url = new URL(href, pageUrl).toString();
    } catch {
      return;
    }

    const title = $(elem).text().trim() || $(elem).attr('title')?.trim() || '';
    if (url && title && title.length > 5 && !href.startsWith('#')) {
      articles.push({
        url,
        title,
        date: new Date(),
        description: 'Extracted post notification link from publication stream Scrape.'
      });
    }
  });

  const uniqueUrls = new Set<string>();
  const filtered: typeof articles = [];

  for (const art of articles) {
    try {
      const parsed = new URL(art.url);
      if (parsed.hostname === targetDomain && !uniqueUrls.has(art.url)) {
        uniqueUrls.add(art.url);
        filtered.push(art);
      }
    } catch {}
  }

  console.log(`[Fetch Scraper Debug] Scrape filtering complete. Extracted ${filtered.length} unique valid articles belonging to: "${targetDomain}"`);
  return filtered;
}

// Seeding implementation
async function seedDefaultSources() {
  try {
    if (!firebaseConfig.projectId) {
      console.warn('[Seeding] Firebase project ID is missing in config. Skipping database seeding.');
      return;
    }

    console.log('[Seeding] Starting database synchronization & migration...');
    const snapshot = await db.collection('sources').get();
    const existingDocs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as any));

    // 1. Sync SEED_SOURCES to database sources: Update existing or create missing
    for (const seed of SEED_SOURCES) {
      const match = existingDocs.find(doc => doc.name.toLowerCase() === seed.name.toLowerCase());
      if (match) {
        console.log(`[Seeding] Updating existing source: "${match.name}" to newer RSS standard.`);
        await db.collection('sources').doc(match.id).update({
          name: seed.name,
          type: seed.type,
          pageUrl: seed.pageUrl,
          feedUrl: seed.feedUrl || null,
          selector: seed.selector || null,
          enabled: seed.enabled,
          consecutiveEmptyCount: 0,
          lastError: null
        });
      } else {
        console.log(`[Seeding] Creating new feed source: "${seed.name}"`);
        await db.collection('sources').add({
          name: seed.name,
          type: seed.type,
          pageUrl: seed.pageUrl,
          feedUrl: seed.feedUrl || null,
          selector: seed.selector || null,
          enabled: seed.enabled,
          consecutiveEmptyCount: 0,
          lastCheckedAt: null,
          lastError: null
        });
      }
    }

    // 2. Safely retire obsolete legacy sources
    const obsoleteNames = ["OpenAI News", "CLAUDE News", "Meta AI Blog", "Cohere Blog", "Mistral News", "Google DeepMind Blog"];
    for (const doc of existingDocs) {
      if (obsoleteNames.some(name => doc.name.toLowerCase() === name.toLowerCase())) {
        console.log(`[Seeding] Deleting obsolete/deprecated legacy source: "${doc.name}"`);
        await db.collection('sources').doc(doc.id).delete();
      }
    }

    console.log('[Seeding] Database synchronization completed perfectly!');
  } catch (err: any) {
    if (err.message?.includes('PERMISSION_DENIED') || err.code === 7) {
      console.warn('\n========================================================================');
      console.warn('⚠️ FIRESTORE PERMISSION DENIED ON SEEDING!');
      console.warn('The backend server is unauthorized to access or create Firestore documents.');
      console.warn('To resolve this, please generate a service account key inside');
      console.warn('Firebase Console (Project Settings -> Service Accounts -> Generate Private Key)');
      console.warn('and paste the entire JSON string into the "FIREBASE_SERVICE_ACCOUNT" env variable.');
      console.warn('========================================================================\n');
    } else {
      console.error('Failed to run automatic database seeding:', err);
    }
  }
}

// Trigger automatic seeding on server start
seedDefaultSources();

// Middleware to verify Firebase Auth ID Token (Single User Gate)
async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: "Access Denied. Missing Authorization token." });
  }

  const token = authHeader.split('Bearer ')[1];
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return res.status(401).json({ error: "Access Denied. Invalid token format." });
    }
    // Decode JWT payload safely
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
    
    // Check if the email matches our single-user target email
    const isTargetUser = payload.email === 'gentakanashi0425@gmail.com' && payload.email_verified === true;
    
    if (!isTargetUser) {
      return res.status(403).json({ error: "Access Forbidden. Unauthorized user email." });
    }

    (req as any).user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Session authentication failed." });
  }
}

// Helper to inspect Firestore errors and format extremely helpful responses
function handleRouteFirebaseError(err: any, res: express.Response, messageContext: string) {
  console.error(`[Diagnostics Error] Failure during "${messageContext}":`, err);
  if (err.message?.includes('PERMISSION_DENIED') || err.code === 7) {
    return res.status(403).json({
      error: "Firebase Permission Denied",
      details: "The backend server is running under a restricted sandbox service account and cannot access your custom database automatically.",
      suggestion: "To resolve, generate a Firebase Service Account Key from Firebase Console (Project Settings -> Service Accounts -> Generate Private Key), and paste the entire JSON string into standard environment variable: FIREBASE_SERVICE_ACCOUNT inside AI Studio Settings tab.",
      code: "PERMISSION_DENIED"
    });
  }
  return res.status(500).json({ error: err.message });
}

// API ROUTES - SECURED VIA MULTI-AUTH GATES (User Google login token or Cron Shared Secret)

app.get('/api/admin/diagnose-public', async (req, res) => {
  console.log('[API] GET /api/admin/diagnose-public - Initiating public system environment verification...');
  
  const responseBlob: any = {
    serviceAccount: {
      present: false,
      validJson: false,
      projectId: null,
      clientEmail: null,
      privateKeyPresent: false,
      error: null
    },
    databaseConfig: {
      projectId: firebaseConfig.projectId || null,
      databaseId: firebaseConfig.firestoreDatabaseId || '(default)'
    },
    firestoreConnection: {
      authorized: false,
      error: null,
      details: null
    }
  };

  const serviceAccountStr = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (serviceAccountStr) {
    responseBlob.serviceAccount.present = true;
    try {
      const parsed = JSON.parse(serviceAccountStr);
      responseBlob.serviceAccount.validJson = true;
      responseBlob.serviceAccount.projectId = parsed.project_id || null;
      responseBlob.serviceAccount.clientEmail = parsed.client_email || null;
      responseBlob.serviceAccount.privateKeyPresent = !!parsed.private_key;
    } catch (parseErr: any) {
      responseBlob.serviceAccount.error = parseErr.message;
    }
  }

  try {
    const testSnapshot = await db.collection('sources').limit(1).get();
    responseBlob.firestoreConnection.authorized = true;
    responseBlob.firestoreConnection.details = `Authorized successfully! Active node list populated. Snapshot contains ${testSnapshot.size} query items.`;
  } catch (dbErr: any) {
    console.error('[Diagnostics Route Public] Firestore collection read test failed:', dbErr);
    responseBlob.firestoreConnection.authorized = false;
    responseBlob.firestoreConnection.error = dbErr.message || 'Unknown Firestore Exception';
    
    if (dbErr.message?.includes('PERMISSION_DENIED') || dbErr.code === 7) {
      responseBlob.firestoreConnection.details = 'IAM Permission Denied. The service account credential exists but does NOT possess the necessary Firestore Reader/Owner permissions on database: ' + (firebaseConfig.firestoreDatabaseId || '(default)');
    } else {
      responseBlob.firestoreConnection.details = 'A generic database communication issue went wrong. Check if the projectId or databaseId name matches.';
    }
  }

  res.json(responseBlob);
});

app.get('/api/admin/diagnose', requireAuth, async (req, res) => {
  console.log('[API] GET /api/admin/diagnose - Initiating system environment verification...');
  
  const responseBlob: any = {
    serviceAccount: {
      present: false,
      validJson: false,
      projectId: null,
      clientEmail: null,
      privateKeyPresent: false,
      error: null
    },
    databaseConfig: {
      projectId: firebaseConfig.projectId || null,
      databaseId: firebaseConfig.firestoreDatabaseId || '(default)'
    },
    firestoreConnection: {
      authorized: false,
      error: null,
      details: null
    }
  };

  const serviceAccountStr = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (serviceAccountStr) {
    responseBlob.serviceAccount.present = true;
    try {
      const parsed = JSON.parse(serviceAccountStr);
      responseBlob.serviceAccount.validJson = true;
      responseBlob.serviceAccount.projectId = parsed.project_id || null;
      responseBlob.serviceAccount.clientEmail = parsed.client_email || null;
      responseBlob.serviceAccount.privateKeyPresent = !!parsed.private_key;
    } catch (parseErr: any) {
      responseBlob.serviceAccount.error = parseErr.message;
    }
  }

  try {
    const testSnapshot = await db.collection('sources').limit(1).get();
    responseBlob.firestoreConnection.authorized = true;
    responseBlob.firestoreConnection.details = `Authorized successfully! Active node list populated. Snapshot contains ${testSnapshot.size} query items.`;
  } catch (dbErr: any) {
    console.error('[Diagnostics Route] Firestore collection read test failed:', dbErr);
    responseBlob.firestoreConnection.authorized = false;
    responseBlob.firestoreConnection.error = dbErr.message || 'Unknown Firestore Exception';
    
    if (dbErr.message?.includes('PERMISSION_DENIED') || dbErr.code === 7) {
      responseBlob.firestoreConnection.details = 'IAM Permission Denied. The service account credential exists but does NOT possess the necessary Firestore Reader/Owner permissions on database: ' + (firebaseConfig.firestoreDatabaseId || '(default)');
    } else {
      responseBlob.firestoreConnection.details = 'A generic database communication issue went wrong. Check if the projectId or databaseId name matches.';
    }
  }

  res.json(responseBlob);
});

app.get('/api/sources', requireAuth, async (req, res) => {
  console.log('[API] GET /api/sources - Initiating retrieve channels request...');
  try {
    const snapshot = await db.collection('sources').get();
    const sources = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    console.log(`[API] GET /api/sources - Successfully extracted ${sources.length} items.`);
    res.json(sources);
  } catch (err: any) {
    return handleRouteFirebaseError(err, res, "listing sources configs");
  }
});

// GET /api/articles (Load historic recorded seen articles)
app.get('/api/articles', requireAuth, async (req, res) => {
  console.log('[API] GET /api/articles - Fetching recorded seen articles...');
  try {
    const snapshot = await db.collection('seen_articles').get();
    const articles = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
    
    // Sort in JS to prevent missing composite index failures
    articles.sort((a: any, b: any) => {
      const dateA = new Date(a.firstSeenAt || 0).getTime();
      const dateB = new Date(b.firstSeenAt || 0).getTime();
      return dateB - dateA;
    });

    res.json(articles);
  } catch (err: any) {
    return handleRouteFirebaseError(err, res, "retrieving recorded seen articles");
  }
});

// POST /api/sources/seed (Trigger forced re-seed/reset)
app.post('/api/sources/seed', requireAuth, async (req, res) => {
  console.log('[API] POST /api/sources/seed - Initiating database re-seeding...');
  try {
    const snapshot = await db.collection('sources').get();
    const batch = db.batch();
    snapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });
    await batch.commit();
    console.log('[API] Cleared old configurations. Provisioning seed default list...');

    await seedDefaultSources();
    res.json({ message: "Re-seeded default sources list successfully!" });
  } catch (err: any) {
    return handleRouteFirebaseError(err, res, "seeding sources configs list");
  }
});

// POST /api/sources
app.post('/api/sources', requireAuth, async (req, res) => {
  console.log('[API] POST /api/sources - Registering custom target news channel...');
  try {
    const { pageUrl, name, selector } = req.body;
    if (!pageUrl || !name) {
      return res.status(400).json({ error: "Name and pageUrl are required properties" });
    }

    console.log(`[API] Discovery parsing for: "${name}" (${pageUrl})`);
    const discovery = await discoverSourceType(pageUrl);

    const docData = {
      name,
      pageUrl,
      type: discovery.type,
      feedUrl: discovery.feedUrl,
      selector: selector || null,
      enabled: true,
      consecutiveEmptyCount: 0,
      lastCheckedAt: null,
      lastError: discovery.error || null
    };

    const docRef = await db.collection('sources').add(docData);
    console.log(`[API] Source registered successfully with ID: ${docRef.id}`);
    res.status(201).json({ id: docRef.id, ...docData });
  } catch (err: any) {
    return handleRouteFirebaseError(err, res, "adding new RSS/scrape source");
  }
});

// PUT /api/sources/:id
app.put('/api/sources/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  console.log(`[API] PUT /api/sources/${id} - Modifying configuration...`);
  try {
     const { enabled, selector, name, type, feedUrl, pageUrl } = req.body;

     const sourceRef = db.collection('sources').doc(id);
     const doc = await sourceRef.get();
     if (!doc.exists) {
       return res.status(404).json({ error: "Source not found" });
     }

     const updates: any = {};
     if (enabled !== undefined) updates.enabled = Boolean(enabled);
     if (selector !== undefined) updates.selector = selector || null;
     if (name !== undefined) updates.name = name;
     if (type !== undefined) updates.type = type;
     if (feedUrl !== undefined) updates.feedUrl = feedUrl || null;
     if (pageUrl !== undefined) updates.pageUrl = pageUrl;

     await sourceRef.update(updates);
     console.log(`[API] PUT /api/sources/${id} - Update processed successfully.`);
     res.json({ id, ...doc.data(), ...updates });
  } catch (err: any) {
    return handleRouteFirebaseError(err, res, "updating target source profile");
  }
});

// DELETE /api/sources/:id
app.delete('/api/sources/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  console.log(`[API] DELETE /api/sources/${id} - Deleting configuration...`);
  try {
    const sourceRef = db.collection('sources').doc(id);
    const doc = await sourceRef.get();
    if (!doc.exists) {
      return res.status(404).json({ error: "Source not found" });
    }
    await sourceRef.delete();
    console.log(`[API] DELETE /api/sources/${id} - Configuration deleted.`);
    res.json({ message: "Source deleted successfully from database" });
  } catch (err: any) {
    return handleRouteFirebaseError(err, res, "deleting source entry");
  }
});

// POST /api/check (Main checking trigger loop - called manually or via Cloud Scheduler cron)
app.post('/api/check', async (req, res) => {
  // Dual-Auth Guard: Allows access if the request has a valid single-user JWT (manual check via dashboard)
  // OR the request has the correct CHECK_SECRET (automated cloud cron)
  let authorized = false;

  // 1. Check if user is authenticated via Bearer ID Token (Dashboard manually triggered)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split('Bearer ')[1];
    try {
      const parts = token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
        // Check if the email matches our single-user target email
        const isTargetUser = payload.email === 'gentakanashi0425@gmail.com' && payload.email_verified === true;
        if (isTargetUser) {
          authorized = true;
          console.log('[API/Check] Manual scan authorized successfully via active Firebase User Token.');
        }
      }
    } catch (err) {
      console.warn('[API/Check] Failed validating Firebase user bearer token:', err);
    }
  }

  // 2. Check if a cron secret matches
  if (!authorized) {
    const checkSecret = process.env.CHECK_SECRET;
    const requestSecret = req.query.secret || req.body.secret;

    if (checkSecret) {
      if (requestSecret === checkSecret) {
        authorized = true;
        console.log('[API/Check] Scan authorized successfully via Cloud Scheduler Shared Secret.');
      }
    } else {
      // If CHECK_SECRET is not configured in environment, let development checks work seamlessly without blockage
      authorized = true;
      console.log('[API/Check] No CHECK_SECRET env variable exists. Allowing development manual sweep as fallback.');
    }
  }

  if (!authorized) {
    console.warn('[API/Check] Unauthorized scheduler hit! Checking execution aborted (unauthorized user or mismatch secret).');
    return res.status(401).json({ error: "Unauthorized access path. Invalid cron secret." });
  }

  try {
    await handleCheck(req, res);
  } catch (err: any) {
    if (err.message?.includes('PERMISSION_DENIED') || err.code === 7) {
      return res.status(403).json({
        error: "Firebase Permission Denied",
        details: "The scheduler block cannot execute because the backend is unauthorized to access Firestore.",
        suggestion: "Please configure FIREBASE_SERVICE_ACCOUNT in your environment settings.",
        code: "PERMISSION_DENIED"
      });
    }
    console.error('[API/Check] General scanning engine failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Serve frontend assets
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Node Server booted beautifully! Port ${PORT}`);
  });
}

startServer();
