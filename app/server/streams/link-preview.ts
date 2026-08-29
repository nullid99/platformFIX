// Recognizes TradingView chart-snapshot links only (https://www.tradingview.com/x/<id>/) — a
// narrow allowlist on purpose, so this never turns into an open URL-fetch proxy for arbitrary
// links pasted into chat.
const TRADINGVIEW_URL_PATTERN = /https?:\/\/(?:www\.)?tradingview\.com\/x\/[A-Za-z0-9]+\/?/;

export type LinkPreview = { title: string; imageUrl: string; siteName: string; sourceUrl: string };

const HTML_ENTITIES: Record<string, string> = { "&amp;": "&", "&quot;": "\"", "&#39;": "'", "&apos;": "'", "&lt;": "<", "&gt;": ">" };

function decodeEntities(text: string): string {
  return text.replace(/&amp;|&quot;|&#39;|&apos;|&lt;|&gt;/g, (entity) => HTML_ENTITIES[entity] ?? entity);
}

function extractMetaContent(html: string, property: string): string | null {
  const pattern = new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, "i");
  const reversed = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, "i");
  const match = pattern.exec(html) ?? reversed.exec(html);
  return match ? decodeEntities(match[1]) : null;
}

/** Fetches a TradingView chart-snapshot page and extracts its OpenGraph preview — null for any other URL, or on failure/timeout. */
export async function fetchTradingViewPreview(rawUrl: string): Promise<LinkPreview | null> {
  const match = TRADINGVIEW_URL_PATTERN.exec(rawUrl);
  if (!match) return null;
  const url = match[0];
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FIXPracticumBot/1.0; +https://tradingview.com)" },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) return null;
    const html = await response.text();
    const title = extractMetaContent(html, "og:title");
    const imageUrl = extractMetaContent(html, "og:image");
    const siteName = extractMetaContent(html, "og:site_name") ?? "TradingView";
    if (!title || !imageUrl) return null;
    return { title, imageUrl, siteName, sourceUrl: url };
  } catch {
    return null;
  }
}

/** First TradingView chart-snapshot link found anywhere in the text, if any. */
export function findTradingViewUrl(text: string): string | null {
  return TRADINGVIEW_URL_PATTERN.exec(text)?.[0] ?? null;
}
