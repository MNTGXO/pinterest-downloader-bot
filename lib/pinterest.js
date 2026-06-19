'use strict';

/**
 * lib/pinterest.js
 *
 * Extracts the direct media URL from any Pinterest pin.
 * Three methods are tried in order:
 *
 *   1. Pinterest Resource API  – internal JSON API, most reliable
 *   2. HTML scraper            – parses pinimg.com URLs out of the page HTML
 *   3. btch-downloader         – npm package as final fallback
 *
 * Public export:
 *   getMedia(url) → Promise<{ downloadUrl, title, isVideo } | null>
 */

const fetch = require('node-fetch');
const { cleanText } = require('./utils');

const BASE_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
};

// ─── URL helpers ───────────────────────────────────────────────────────────────

/** Follow pin.it redirects so we always have a full pinterest.com URL. */
async function resolvePinUrl(url) {
    if (!url.includes('pin.it')) return url;
    try {
        const res = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: BASE_HEADERS });
        return res.url || url;
    } catch {
        return url;
    }
}

/** Extract the numeric pin ID from a pinterest.com/pin/ID/ URL. */
function extractPinId(url) {
    const m = (url || '').match(/\/pin\/(\d+)/);
    return m ? m[1] : null;
}

// ─── Method 1 : Pinterest Resource API ────────────────────────────────────────

/**
 * Calls Pinterest's internal PinResource API.
 * Returns video at the highest available quality, otherwise the original image.
 */
async function fetchViaApi(pinId) {
    try {
        const data = JSON.stringify({
            options: { id: pinId, field_set_key: 'detailed' },
            context: {},
        });
        const qs = new URLSearchParams({
            source_url: `/pin/${pinId}/`,
            data,
            _: Date.now().toString(),
        });

        const res = await fetch(
            `https://www.pinterest.com/resource/PinResource/get/?${qs}`,
            {
                headers: {
                    ...BASE_HEADERS,
                    'X-Requested-With': 'XMLHttpRequest',
                    Accept: 'application/json, text/javascript, */*; q=0.01',
                    Referer: `https://www.pinterest.com/pin/${pinId}/`,
                },
            }
        );
        if (!res.ok) return null;

        const json = await res.json().catch(() => null);
        const pin = json?.resource_response?.data;
        if (!pin) return null;

        const title = cleanText(pin.title || pin.description || 'Pinterest Media');

        // ── Video ──────────────────────────────────────────────────────────────
        const videoList = pin?.videos?.video_list;
        if (videoList && typeof videoList === 'object') {
            for (const q of ['V_1080P', 'V_720P', 'V_480P', 'V_240P']) {
                if (videoList[q]?.url) {
                    return { downloadUrl: videoList[q].url, title, isVideo: true };
                }
            }
            // Any quality available
            const first = Object.values(videoList).find(v => v?.url);
            if (first) return { downloadUrl: first.url, title, isVideo: true };
        }

        // ── Image ──────────────────────────────────────────────────────────────
        const imgUrl = pin?.images?.orig?.url || pin?.images?.['736x']?.url;
        if (imgUrl) return { downloadUrl: imgUrl, title, isVideo: false };

        return null;
    } catch (err) {
        console.error('[pinterest:api]', err.message);
        return null;
    }
}

// ─── Method 2 : HTML scraper ───────────────────────────────────────────────────

/**
 * Fetches the pin page HTML and extracts the first matching media URL.
 * Priority: video → orig image → any-size image → og:image meta tag.
 */
async function fetchViaScraper(url) {
    try {
        const res = await fetch(url, {
            headers: {
                ...BASE_HEADERS,
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            redirect: 'follow',
        });
        if (!res.ok) return null;
        const html = await res.text();

        // Decode any JSON unicode escapes in URLs
        const decode = s => s.replace(/\\u002F/g, '/').replace(/\\\//g, '/');

        // 1. Video (v.pinimg.com)
        let m = html.match(/"url"\s*:\s*"(https:\/\/v\.pinimg\.com\/[^"]+\.mp4[^"]*)"/);
        if (m) return { downloadUrl: decode(m[1]), isVideo: true, title: _scrapedTitle(html) };

        // 2. Image – originals (highest quality)
        m = html.match(/"url"\s*:\s*"(https:\/\/i\.pinimg\.com\/originals\/[^"]+)"/);
        if (m) return { downloadUrl: decode(m[1]), isVideo: false, title: _scrapedTitle(html) };

        // 3. Image – any resolution; upgrade path to /originals/
        m = html.match(/"url"\s*:\s*"(https:\/\/i\.pinimg\.com\/\d+x[^"]+)"/);
        if (m) {
            const upgraded = decode(m[1]).replace(
                /i\.pinimg\.com\/\d+x(?:\/\d+x)?\//, 'i.pinimg.com/originals/'
            );
            return { downloadUrl: upgraded, isVideo: false, title: _scrapedTitle(html) };
        }

        // 4. og:image meta tag (lowest priority)
        m = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
        if (m) return { downloadUrl: m[1], isVideo: false, title: _scrapedTitle(html) };

        return null;
    } catch (err) {
        console.error('[pinterest:scraper]', err.message);
        return null;
    }
}

/** Pull the page title or og:title from raw HTML. */
function _scrapedTitle(html) {
    const m = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i)
           || html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return cleanText(m ? m[1] : 'Pinterest Media');
}

// ─── Method 3 : btch-downloader ───────────────────────────────────────────────

async function fetchViaBtch(url) {
    try {
        const { pinterest } = require('btch-downloader'); // eslint-disable-line
        const result = await pinterest(url);
        if (!result) return null;

        const items = Array.isArray(result)        ? result
                    : Array.isArray(result.data)   ? result.data
                    : result.url                   ? [result]
                    : [];
        if (!items.length) return null;

        const item = items[0];
        const downloadUrl = item.url || item.download_url || null;
        if (!downloadUrl) return null;

        const isVideo =
            /\.(mp4|mov|m4v|webm)(?:\?|$)/i.test(downloadUrl) || item.type === 'video';

        return {
            downloadUrl,
            title: cleanText(item.title || result.title || 'Pinterest Media'),
            isVideo,
        };
    } catch (err) {
        console.error('[pinterest:btch]', err.message);
        return null;
    }
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract direct media from a Pinterest URL.
 *
 * @param   {string} url  – pinterest.com or pin.it URL
 * @returns {Promise<{ downloadUrl: string, title: string, isVideo: boolean } | null>}
 */
async function getMedia(url) {
    const resolved = await resolvePinUrl(url);
    const pinId    = extractPinId(resolved);

    if (pinId) {
        const api = await fetchViaApi(pinId);
        if (api) return api;
    }

    const scraped = await fetchViaScraper(resolved);
    if (scraped) return scraped;

    return fetchViaBtch(url);
}

module.exports = { getMedia };
