import Parser from 'rss-parser';

export interface Article {
  sourceId: string;
  sourceName: string;
  title: string;
  link: string;        // Key for deduplication
  publishedAt: string; // ISO 8601 formatting
  summary: string;     // description / contentSnippet or empty string
}

export interface FeedSource {
  id: string;
  name: string;
  priority: number;
  url: string;
}

export const SOURCES: FeedSource[] = [
  { id: 'openai_research',    name: 'OpenAI Research',    priority: 1, url: 'https://openai.com/blog/rss.xml' },
  { id: 'openai_eng',         name: 'OpenAI Engineering', priority: 1, url: 'https://openai.com/news/engineering/rss.xml' },
  { id: 'huggingface',        name: 'Hugging Face Blog',  priority: 1, url: 'https://huggingface.co/blog/feed.xml' },
  { id: 'google_ai',          name: 'Google AI',          priority: 1, url: 'https://deepmind.google/blog/rss.xml' },
  { id: 'theverge_ai',        name: 'The Verge AI',       priority: 1, url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
  { id: 'anthropic_news',     name: 'Anthropic News',     priority: 2, url: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml' },
  { id: 'anthropic_eng',      name: 'Anthropic Engineering', priority: 2, url: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_engineering.xml' },
  { id: 'cursor',             name: 'Cursor Blog',        priority: 2, url: 'https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_cursor.xml' },
];

const parser = new Parser();

// Browser-like headers to bypass scraper blockers
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/rss+xml, application/rdf+xml, application/xml, text/xml, */*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache'
};

const TIMEOUT_MS = 10000; // 10 seconds timeout

/**
 * Helper to fetch a single URL with a specific strict timeout
 * @param url Target feed url
 * @returns Promise with decoded string payload
 */
async function fetchWithTimeout(url: string): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.warn(JSON.stringify({
      severity: 'WARNING',
      message: `Request timeout triggered for URL: "${url}" after ${TIMEOUT_MS}ms`
    }));
    controller.abort();
  }, TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: HEADERS,
      signal: controller.signal
    });

    console.log(JSON.stringify({
      severity: 'DEBUG',
      message: `HTTP Response metadata received for: "${url}"`,
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get('content-type')
    }));

    if (!response.ok) {
      let errContext = `HTTP Error Code ${response.status} (${response.statusText})`;
      if (response.status === 403) {
        errContext += " - Access Forbidden. This often indicates Scraping blocker/Cloudflare protection (Anti-bot).";
      } else if (response.status === 429) {
        errContext += " - Too Many Requests. Rate limited by target server.";
      }
      throw new Error(errContext);
    }

    const payload = await response.text();
    if (!payload || payload.trim().length === 0) {
      throw new Error("HTTP Response succeeded but decoded content payload is entirely empty (0 characters).");
    }

    return payload;
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error(`Request timed out after ${TIMEOUT_MS}ms. The server failed to respond in time.`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetches and parses a single RSS source, including 1 automatic retry on failure
 * @param source Target feed source metadata
 * @returns Promise with list of normalized Articles
 */
export async function fetchSingleSource(source: FeedSource): Promise<Article[]> {
  let attempt = 1;
  const maxAttempts = 2;

  while (attempt <= maxAttempts) {
    try {
      console.log(JSON.stringify({
        severity: 'INFO',
        message: `Attempting fetch sequence for source "${source.name}" (Attempt ${attempt}/${maxAttempts})`,
        sourceId: source.id,
        url: source.url
      }));

      const xmlData = await fetchWithTimeout(source.url);
      
      // XML data format pre-flight diagnostic validation
      const isXml = xmlData.trim().startsWith('<');
      if (!isXml) {
        console.warn(JSON.stringify({
          severity: 'WARNING',
          message: `Fetched payload doesn't seem to be matching structured XML/RSS encoding syntax headers.`,
          sourceId: source.id,
          payloadPreview: xmlData.substring(0, 150)
        }));
      }

      console.log(JSON.stringify({
        severity: 'DEBUG',
        message: `Parsing raw feed content for source "${source.name}" using rss-parser...`,
        payloadLength: xmlData.length,
        sourceId: source.id
      }));

      let feed;
      try {
        feed = await parser.parseString(xmlData);
      } catch (parseErr: any) {
        let diagnosticMsg = `Format Parsing Failure: The data received cannot be parsed by standard feed library.`;
        if (xmlData.toLowerCase().includes('<!doctype html>')) {
          diagnosticMsg += " Detected raw HTML document content structure rather than standard XML/RSS. This usually means the server rendered a Single Page Application (SPA), a login gateway, or a blocked-page error screen instead of the actual feed.";
        }
        throw new Error(`${diagnosticMsg} Original parse error: ${parseErr.message || parseErr}`);
      }

      const parsedArticles: Article[] = (feed.items || []).map((item) => {
        // Construct canonical ISO timestamp. Fallback to current time if missing or invalid.
        let pubDateStr = item.isoDate || item.pubDate;
        let publishedAt = new Date().toISOString();
        if (pubDateStr) {
          const parsedDate = new Date(pubDateStr);
          if (!isNaN(parsedDate.getTime())) {
            publishedAt = parsedDate.toISOString();
          }
        }

        // Retrieve summary from description or content snippet safely
        const summary = (item.contentSnippet || item.summary || item.description || '')
          .replace(/<[^>]*>/g, '') // strip HTML tags
          .trim();

        return {
          sourceId: source.id,
          sourceName: source.name,
          title: item.title || 'Untitled Article',
          link: item.link || '',
          publishedAt,
          summary: summary.length > 300 ? summary.substring(0, 300) + '...' : summary
        };
      }).filter((art) => art.link !== '');

      console.log(JSON.stringify({
        severity: 'INFO',
        message: `Successfully fetched and parsed feed source: "${source.name}"`,
        sourceId: source.id,
        articlesCount: parsedArticles.length,
        attempt
      }));

      return parsedArticles;
    } catch (err: any) {
      const isRetryable = attempt < maxAttempts;
      console.warn(JSON.stringify({
        severity: 'WARNING',
        message: `Sweep failed for feed source "${source.name}" on attempt ${attempt}`,
        sourceId: source.id,
        error: err.message || String(err),
        willRetry: isRetryable
      }));

      if (!isRetryable) {
        throw err;
      }
      attempt++;
    }
  }

  return [];
}

/**
 * Fetches all curated blog sources in parallel, ensuring failures on single feeds do not block overall sweep.
 * @returns Promise resolving to flattened list of successfully crawled articles
 */
export async function fetchAllSources(): Promise<Article[]> {
  console.log(JSON.stringify({
    severity: 'INFO',
    message: 'Initiating parallel RSS/Atom crawling sweep across all configured developer journals...'
  }));

  const results = await Promise.allSettled(
    SOURCES.map((source) => fetchSingleSource(source))
  );

  const allArticles: Article[] = [];

  results.forEach((res, index) => {
    const source = SOURCES[index];
    if (res.status === 'fulfilled') {
      allArticles.push(...res.value);
    } else {
      console.error(JSON.stringify({
        severity: 'ERROR',
        message: `Critical Failure: Feed source "${source.name}" failed to fetch entirely after retries.`,
        sourceId: source.id,
        reason: res.reason?.message || String(res.reason)
      }));
    }
  });

  console.log(JSON.stringify({
    severity: 'INFO',
    message: `Parallel crawling sweep finished. Successfully harvested ${allArticles.length} articles in total.`
  }));

  return allArticles;
}
