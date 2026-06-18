const fetch = require('node-fetch');

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;
const SUPPORT_GROUP_URL = 'https://t.me/mnbots_support';
const SOURCE_CODE_URL = 'https://github.com/MNTGXO/pinterest-downloader-bot';
const VERCEL_PRODUCTION_URL = process.env.VERCEL_PROJECT_PRODUCTION_URL;
const PINTEREST_URL_REGEX = /https?:\/\/(?:www\.)?(?:[\w-]+\.)?(?:pinterest\.(?:com|co\.uk|de|fr|it|es|nl|se|ch|co\.in|br|au|at|cl|jp|ru|ie|ca|mx|nz|pt|ph)\/[^\s]+|pin\.it\/[A-Za-z0-9\-_/?=&%.]+)/i;

module.exports = async (req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
        const query = getRequestQuery(req);

        if (query.setWebhook === '1' || query.setWebhook === 'true') {
            const webhookResult = await setTelegramWebhook(req);
            return res.status(webhookResult.ok ? 200 : 500).json(webhookResult);
        }

        if (query.webhookInfo === '1' || query.webhookInfo === 'true') {
            const webhookInfo = await getTelegramWebhookInfo();
            return res.status(webhookInfo.ok ? 200 : 500).json(webhookInfo);
        }

        return res.status(200).json({
            ok: true,
            message: 'Pinterest Downloader Bot webhook is running. Telegram updates must be sent with POST.',
            support: SUPPORT_GROUP_URL,
            source: SOURCE_CODE_URL,
            botTokenConfigured: Boolean(BOT_TOKEN),
            webhookSetup: getWebhookSetupUrl(req),
            productionWebhookSetup: getWebhookSetupUrl(req, 'production'),
            currentDeploymentWebhookSetup: getWebhookSetupUrl(req, 'current'),
            webhookInfo: getWebhookInfoUrl(req),
            note: 'If Telegram webhookInfo shows 401 Unauthorized, your Vercel deployment is protected. Use the productionWebhookSetup URL after deploying to an unprotected Production deployment, or disable Vercel Deployment Protection.'
        });
    }

    if (req.method !== 'POST') {
        res.setHeader('Allow', 'GET, HEAD, POST');
        return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    }

    if (!TELEGRAM_API) {
        console.error('BOT_TOKEN is not configured. Set the BOT_TOKEN environment variable in Vercel.');
        return res.status(200).send('OK');
    }

    try {
        const body = parseRequestBody(req.body);
        const message = body.message || body.edited_message || body.channel_post || body.edited_channel_post;

        if (!message) {
            console.log('Received update payload without a supported message object:', JSON.stringify(body));
            return res.status(200).send('OK');
        }

        const chatId = message.chat && message.chat.id;
        const text = getMessageText(message);

        if (!chatId) {
            return res.status(200).send('OK');
        }

        if (isCommand(text, '/start') || isCommand(text, '/help')) {
            await sendTextMessage(chatId, buildHelpMessage(message.chat.type));
            return res.status(200).send('OK');
        }

        if (isCommand(text, '/support')) {
            await sendTextMessage(chatId, `Need help? Join our support group:\n${SUPPORT_GROUP_URL}`);
            return res.status(200).send('OK');
        }

        if (isCommand(text, '/source')) {
            await sendTextMessage(chatId, `Source code:\n${SOURCE_CODE_URL}`);
            return res.status(200).send('OK');
        }

        const pinterestUrl = extractPinterestUrl(text);
        if (!pinterestUrl) {
            await sendTextMessage(chatId, `❌ Please send a valid Pinterest URL.\n\nSupport: ${SUPPORT_GROUP_URL}\nSource: ${SOURCE_CODE_URL}`);
            return res.status(200).send('OK');
        }

        await sendTextMessage(chatId, '⚡ Processing your Pinterest link...');

        const targetUrl = isShortPinterestUrl(pinterestUrl)
            ? await resolveShortUrl(pinterestUrl)
            : pinterestUrl;

        if (!targetUrl) {
            await sendTextMessage(chatId, `❌ Failed to resolve the short Pinterest link. Please try copying the full desktop link.\n\nSupport: ${SUPPORT_GROUP_URL}`);
            return res.status(200).send('OK');
        }

        // Try multiple extraction strategies in order
        let mediaData = null;

        mediaData = await extractMediaFromPinterestApi(targetUrl);

        if (!mediaData || !mediaData.downloadUrl) {
            console.log('Pinterest API extraction failed, trying KlickPin...');
            mediaData = await extractMediaFromKlickPin(targetUrl);
        }

        if (!mediaData || !mediaData.downloadUrl) {
            console.log('KlickPin extraction failed, trying PinDown...');
            mediaData = await extractMediaFromPinDown(targetUrl);
        }

        if (!mediaData || !mediaData.downloadUrl) {
            await sendTextMessage(chatId, `❌ Could not extract media from this pin. It might be private, deleted, or unsupported.\n\nSupport: ${SUPPORT_GROUP_URL}`);
            return res.status(200).send('OK');
        }

        await sendMediaToTelegram(chatId, mediaData);
        return res.status(200).send('OK');
    } catch (error) {
        console.error('Fatal webhook execution crash:', error);
        return res.status(200).send('OK');
    }
};


function getRequestQuery(req) {
    if (req.query && typeof req.query === 'object') return req.query;

    const host = req.headers && req.headers.host ? req.headers.host : 'localhost';
    const url = new URL(req.url || '/', `https://${host}`);
    return Object.fromEntries(url.searchParams.entries());
}

function getRequestOrigin(req) {
    const headers = req.headers || {};
    const protocol = headers['x-forwarded-proto'] || 'https';
    const host = headers['x-forwarded-host'] || headers.host;

    if (!host) return null;
    return `${protocol}://${host}`;
}

function normalizeOrigin(origin) {
    if (!origin) return null;
    return origin.startsWith('http://') || origin.startsWith('https://')
        ? origin.replace(/\/$/, '')
        : `https://${origin.replace(/\/$/, '')}`;
}

function getPreferredWebhookOrigin(req, target = 'production') {
    if (target === 'current') return getRequestOrigin(req);
    return normalizeOrigin(VERCEL_PRODUCTION_URL) || getRequestOrigin(req);
}

function getWebhookUrl(req, target = 'production') {
    const origin = getPreferredWebhookOrigin(req, target);
    return origin ? `${origin}/api/webhook` : null;
}

function getWebhookSetupUrl(req, target = 'production') {
    const origin = getPreferredWebhookOrigin(req, target);
    if (!origin) return null;
    const targetQuery = target === 'current' ? '&target=current' : '';
    return `${origin}/api/webhook?setWebhook=1${targetQuery}`;
}

function getWebhookInfoUrl(req) {
    const origin = getRequestOrigin(req);
    return origin ? `${origin}/api/webhook?webhookInfo=1` : null;
}

async function setTelegramWebhook(req) {
    const query = getRequestQuery(req);
    const target = query.target === 'current' ? 'current' : 'production';
    if (!TELEGRAM_API) {
        return { ok: false, error: 'BOT_TOKEN is not configured in Vercel.' };
    }

    const webhookUrl = getWebhookUrl(req, target);
    if (!webhookUrl) {
        return { ok: false, error: 'Could not determine this deployment host.' };
    }

    const response = await fetch(`${TELEGRAM_API}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            url: webhookUrl,
            allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post'],
            drop_pending_updates: false
        })
    });
    const data = await response.json().catch(() => ({}));

    return {
        ok: response.ok && data.ok === true,
        webhookUrl,
        telegram: data,
        target,
        nextStep: response.ok && data.ok === true
            ? 'Send /start to the bot again in Telegram. If webhookInfo later shows 401 Unauthorized, deploy to an unprotected Production deployment or disable Vercel Deployment Protection.'
            : 'Check the Telegram error and verify BOT_TOKEN belongs to this bot.'
    };
}

async function getTelegramWebhookInfo() {
    if (!TELEGRAM_API) {
        return { ok: false, error: 'BOT_TOKEN is not configured in Vercel.' };
    }

    const response = await fetch(`${TELEGRAM_API}/getWebhookInfo`);
    const data = await response.json().catch(() => ({}));

    const lastError = data.result && data.result.last_error_message;
    const deploymentProtectionHint = lastError && lastError.includes('401 Unauthorized')
        ? 'Telegram is reaching Vercel but Vercel is rejecting it with 401. This is usually Vercel Deployment Protection on a Preview deployment. Deploy Production with protection disabled, then open /api/webhook?setWebhook=1 again.'
        : null;

    return { ok: response.ok && data.ok === true, telegram: data, deploymentProtectionHint };
}

function parseRequestBody(body) {
    if (!body) return {};
    if (typeof body === 'string') {
        try { return JSON.parse(body); } catch (err) {
            console.error('Failed to parse webhook body as JSON:', err);
            return {};
        }
    }
    return body;
}

function getMessageText(message) {
    return (message.text || message.caption || '').trim();
}

function isCommand(text, command) {
    return text === command || text.startsWith(`${command}@`) || text.startsWith(`${command} `);
}

function buildHelpMessage(chatType = 'private') {
    const setupHint = chatType === 'private'
        ? 'If I do not respond in Telegram, make sure your Vercel BOT_TOKEN env var is set and your Telegram webhook URL points to this deployment.'
        : 'If I do not respond in this chat, make sure I am added to the group and can read messages.';

    return [
        '👋 Send me any Pinterest link (pin.it or pinterest.com), and I will extract the direct media file for you.',
        '',
        `Support group: ${SUPPORT_GROUP_URL}`,
        `Source code: ${SOURCE_CODE_URL}`,
        '',
        'Commands:',
        '/help - Show this message',
        '/support - Get the support group link',
        '/source - Get the source code link',
        '',
        setupHint
    ].join('\n');
}

function extractPinterestUrl(text) {
    const match = text.match(PINTEREST_URL_REGEX);
    return match ? match[0].replace(/[),.]+$/, '') : null;
}

function isShortPinterestUrl(url) {
    return /^https?:\/\/(?:www\.)?pin\.it\//i.test(url);
}

// ─── Strategy 1: Pinterest oEmbed / internal API ─────────────────────────────

async function extractMediaFromPinterestApi(canonicalUrl) {
    try {
        // Extract pin ID from URL
        const pinIdMatch = canonicalUrl.match(/\/pin\/(\d+)/i);
        if (!pinIdMatch) return null;
        const pinId = pinIdMatch[1];

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.pinterest.com/',
            'X-Requested-With': 'XMLHttpRequest'
        };

        // Try Pinterest's resource API
        const apiUrl = `https://www.pinterest.com/resource/PinResource/get/?source_url=/pin/${pinId}/&data={"options":{"id":"${pinId}","field_set_key":"detailed"},"context":{}}`;
        const response = await fetch(apiUrl, { headers, redirect: 'follow' });

        if (!response.ok) return null;
        const data = await response.json().catch(() => null);
        if (!data) return null;

        const pin = data.resource_response && data.resource_response.data;
        if (!pin) return null;

        // Try video first
        if (pin.videos && pin.videos.video_list) {
            const videoList = pin.videos.video_list;
            // Pick highest quality
            const qualities = ['V_720P', 'V_480P', 'V_360P', 'V_HLS'];
            for (const q of qualities) {
                if (videoList[q] && videoList[q].url) {
                    return {
                        downloadUrl: videoList[q].url,
                        title: cleanHtml(pin.title || pin.description || 'Pinterest Video'),
                        isVideo: true
                    };
                }
            }
        }

        // Try image
        const imgUrl = (pin.images && (
            (pin.images.orig && pin.images.orig.url) ||
            (pin.images['736x'] && pin.images['736x'].url) ||
            (pin.images['474x'] && pin.images['474x'].url)
        )) || null;

        if (imgUrl) {
            return {
                downloadUrl: imgUrl,
                title: cleanHtml(pin.title || pin.description || 'Pinterest Image'),
                isVideo: false
            };
        }

        return null;
    } catch (err) {
        console.error('Pinterest API extraction error:', err);
        return null;
    }
}

// ─── Strategy 2: KlickPin scraper (fixed) ────────────────────────────────────

async function extractMediaFromKlickPin(canonicalUrl) {
    try {
        const pageResponse = await fetch('https://klickpin.com/', {
            method: 'GET',
            headers: getScraperHeaders(),
            redirect: 'follow'
        });

        const pageHtml = pageResponse.ok ? await pageResponse.text() : '';
        const csrfToken = extractCsrfToken(pageHtml);

        // FIX: safe cookie extraction that works in all node-fetch v2 environments
        const cookie = safeGetCookies(pageResponse);

        const form = new URLSearchParams({ url: canonicalUrl });
        if (csrfToken) form.set('csrf_token', csrfToken);

        const requestHeaders = {
            ...getScraperHeaders(),
            'Content-Type': 'application/x-www-form-urlencoded',
            'Origin': 'https://klickpin.com',
            'Referer': 'https://klickpin.com/'
        };
        if (cookie) requestHeaders['Cookie'] = cookie;

        const response = await fetch('https://klickpin.com/download', {
            method: 'POST',
            headers: requestHeaders,
            body: form.toString(),
            redirect: 'follow'
        });

        if (!response.ok) {
            console.error('KlickPin /download responded with status:', response.status);
            return null;
        }

        const html = await response.text();
        const media = parseKlickPinDownload(html);

        if (!media.downloadUrl) {
            console.error('KlickPin returned no downloadable URL. CSRF present:', Boolean(csrfToken));
        }

        return media.downloadUrl ? media : null;
    } catch (err) {
        console.error('KlickPin extraction error:', err);
        return null;
    }
}

// ─── Strategy 3: PinDown (alternative service) ───────────────────────────────

async function extractMediaFromPinDown(canonicalUrl) {
    try {
        const pageResponse = await fetch('https://pindown.net/', {
            method: 'GET',
            headers: getScraperHeaders(),
            redirect: 'follow'
        });

        const pageHtml = pageResponse.ok ? await pageResponse.text() : '';
        const csrfToken = extractAnyCsrfToken(pageHtml);
        const cookie = safeGetCookies(pageResponse);

        const form = new URLSearchParams({ url: canonicalUrl });
        if (csrfToken) form.set('_token', csrfToken);

        const requestHeaders = {
            ...getScraperHeaders(),
            'Content-Type': 'application/x-www-form-urlencoded',
            'Origin': 'https://pindown.net',
            'Referer': 'https://pindown.net/',
            'X-Requested-With': 'XMLHttpRequest'
        };
        if (cookie) requestHeaders['Cookie'] = cookie;

        const response = await fetch('https://pindown.net/download', {
            method: 'POST',
            headers: requestHeaders,
            body: form.toString(),
            redirect: 'follow'
        });

        if (!response.ok) return null;

        const data = await response.json().catch(() => null);
        if (!data) return null;

        // Handle JSON response from PinDown
        const url = data.url || data.download_url || data.media_url || null;
        if (!url) return null;

        const isVideo = /\.(mp4|mov|m4v|webm)(?:\?|$)/i.test(url);
        return {
            downloadUrl: normalizeUrl(url),
            title: cleanHtml(data.title || 'Pinterest Media'),
            isVideo
        };
    } catch (err) {
        console.error('PinDown extraction error:', err);
        return null;
    }
}

// ─── Short URL resolution ─────────────────────────────────────────────────────

async function resolveShortUrl(shortUrl) {
    const directUrl = await resolveShortUrlWithRedirect(shortUrl);
    if (directUrl) return directUrl;

    try {
        const response = await fetch(`https://resolve-cc1770c86b02.vasinvictory3.workers.dev/?url=${encodeURIComponent(shortUrl)}`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            redirect: 'follow'
        });
        if (!response.ok) return null;
        const data = await response.json();
        const resolvedUrl = data.finalUrl || data.url || data.resolvedUrl || null;
        return resolvedUrl && !isShortPinterestUrl(resolvedUrl) ? resolvedUrl : null;
    } catch (err) {
        console.error('Short URL resolution crash:', err);
        return null;
    }
}

async function resolveShortUrlWithRedirect(shortUrl) {
    try {
        const response = await fetch(shortUrl, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            redirect: 'follow'
        });

        if (response.url && !isShortPinterestUrl(response.url)) return response.url;

        const html = response.ok ? await response.text() : '';
        const canonicalMatch = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) ||
            html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i);
        const canonicalUrl = canonicalMatch ? canonicalMatch[1] : null;

        return canonicalUrl && !isShortPinterestUrl(canonicalUrl) ? canonicalUrl : null;
    } catch (err) {
        console.error('Direct short URL resolution failed:', err);
        return null;
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getScraperHeaders() {
    return {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
    };
}

// FIX: Safe cookie extraction — does not rely on response.headers.raw()
function safeGetCookies(response) {
    try {
        // node-fetch v2 exposes getAll() on its Headers implementation
        if (response.headers && typeof response.headers.getAll === 'function') {
            const cookies = response.headers.getAll('set-cookie');
            if (cookies && cookies.length > 0) {
                return cookies.map(c => c.split(';')[0]).join('; ');
            }
        }
        // Fallback: try raw() if available
        if (response.headers && typeof response.headers.raw === 'function') {
            const raw = response.headers.raw();
            const cookies = raw['set-cookie'];
            if (cookies && cookies.length > 0) {
                return cookies.map(c => c.split(';')[0]).join('; ');
            }
        }
        return null;
    } catch (err) {
        console.error('Cookie extraction failed:', err);
        return null;
    }
}

function extractCsrfToken(html) {
    const match =
        html.match(/<input[^>]+name=["']csrf_token["'][^>]+value=["']([^"']+)["']/i) ||
        html.match(/<input[^>]+value=["']([^"']+)["'][^>]+name=["']csrf_token["']/i) ||
        html.match(/csrf[_-]token["']?\s*[=:]\s*["']([^"']+)["']/i);
    return match ? match[1] : null;
}

function extractAnyCsrfToken(html) {
    // Covers _token, csrf_token, csrfToken, etc.
    const match =
        html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i) ||
        html.match(/<input[^>]+name=["']_token["'][^>]+value=["']([^"']+)["']/i) ||
        html.match(/<input[^>]+value=["']([^"']+)["'][^>]+name=["']_token["']/i) ||
        extractCsrfToken(html);
    return match ? (typeof match === 'string' ? match : match[1]) : null;
}

function parseKlickPinDownload(html) {
    const primaryAnchorMatch = html.match(/<a\b(?=[^>]*data-download-primary=["']1["'])[^>]*>[\s\S]*?<\/a>/i);
    const imageAnchorMatch = html.match(/<td[^>]+class=["'][^"']*no-mobile[^"']*["'][^>]*>[\s\S]*?<a\b[^>]*>[\s\S]*?Download The Image[\s\S]*?<\/a>[\s\S]*?<\/td>/i);
    const preferredHtml = primaryAnchorMatch ? primaryAnchorMatch[0] : (imageAnchorMatch ? imageAnchorMatch[0] : html);

    const downloadUrlMatch =
        preferredHtml.match(/data-download-url=["']([^"']+)["']/i) ||
        // Also try href with direct media links as fallback
        html.match(/href=["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|gif|webp|mp4|mov|m4v|webm)[^"']*)["']/i) ||
        html.match(/data-download-url=["']([^"']+)["']/i);

    const titleMatch =
        preferredHtml.match(/data-download-filename=["']([^"']+)["']/i) ||
        preferredHtml.match(/title=["']([^"']+)["']/i) ||
        html.match(/<p class=["']card-text["'][^>]*>[\s\S]*?<strong>([\s\S]*?)<\/strong>/i) ||
        html.match(/<title>([\s\S]*?)<\/title>/i);

    const downloadUrl = downloadUrlMatch ? normalizeUrl(downloadUrlMatch[1] || downloadUrlMatch[0]) : null;
    const title = cleanHtml(titleMatch ? titleMatch[1].trim() : 'Pinterest Media');
    // FIX: added avif to video check (it's not video, but avoids mis-classifying)
    const isVideo = Boolean(downloadUrl && /\.(?:mp4|mov|m4v|webm)(?:\?|$)/i.test(downloadUrl));

    return { downloadUrl, title, isVideo };
}

function normalizeUrl(url) {
    if (!url) return url;
    if (url.startsWith('//')) return `https:${url}`;
    return url
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'");
}

function cleanHtml(value) {
    return (value || '')
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 900) || 'Pinterest Media';
}

async function sendTextMessage(chatId, text) {
    const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
    });
    if (!response.ok) {
        console.error('Telegram sendMessage rejection:', await response.text());
    }
}

async function sendMediaToTelegram(chatId, { downloadUrl, title, isVideo }) {
    const endpoint = isVideo ? 'sendVideo' : 'sendPhoto';
    const payloadKey = isVideo ? 'video' : 'photo';
    const caption = `${title}\n\nSupport: ${SUPPORT_GROUP_URL}\nSource: ${SOURCE_CODE_URL}`;

    const mediaFile = await downloadMediaFile(downloadUrl, title);
    const response = mediaFile
        ? await sendDownloadedMedia(chatId, endpoint, payloadKey, caption, mediaFile)
        : await sendMediaByUrl(chatId, endpoint, payloadKey, caption, downloadUrl);

    if (!response.ok) {
        const errLog = await response.text();
        console.error('Telegram media upload rejection:', errLog);
        await sendTextMessage(chatId, `🔗 Link extracted, but Telegram file upload failed. Download here directly:\n\n${downloadUrl}\n\nSupport: ${SUPPORT_GROUP_URL}\nSource: ${SOURCE_CODE_URL}`);
    }
}

async function downloadMediaFile(downloadUrl, title) {
    try {
        const response = await fetch(downloadUrl, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,video/*,*/*;q=0.8',
                'Referer': 'https://www.pinterest.com/'
            }
        });

        if (!response.ok) return null;

        const contentLength = Number(response.headers.get('content-length') || 0);
        if (contentLength > 45 * 1024 * 1024) return null;

        // FIX: response.buffer() is unreliable in some node-fetch v2 builds on Vercel.
        // Use arrayBuffer() which is part of the Fetch spec and always available.
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        if (!buffer.length || buffer.length > 45 * 1024 * 1024) return null;

        return {
            buffer,
            filename: getSafeFilename(title, downloadUrl),
            contentType: response.headers.get('content-type') || getContentTypeFromUrl(downloadUrl)
        };
    } catch (err) {
        console.error('Failed to download extracted media URL:', err);
        return null;
    }
}

async function sendDownloadedMedia(chatId, endpoint, payloadKey, caption, mediaFile) {
    const boundary = `----PinterestBot${Date.now().toString(16)}`;
    const body = buildMultipartBody(boundary, {
        chat_id: String(chatId),
        caption
    }, {
        fieldName: payloadKey,
        filename: mediaFile.filename,
        contentType: mediaFile.contentType,
        buffer: mediaFile.buffer
    });

    return fetch(`${TELEGRAM_API}/${endpoint}`, {
        method: 'POST',
        headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': String(body.length)
        },
        body
    });
}

async function sendMediaByUrl(chatId, endpoint, payloadKey, caption, downloadUrl) {
    const body = { chat_id: chatId, caption };
    body[payloadKey] = downloadUrl;
    return fetch(`${TELEGRAM_API}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
}

function buildMultipartBody(boundary, fields, file) {
    const chunks = [];
    for (const [name, value] of Object.entries(fields)) {
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${escapeMultipartValue(file.filename)}"\r\nContent-Type: ${file.contentType}\r\n\r\n`));
    chunks.push(file.buffer);
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    return Buffer.concat(chunks);
}

function escapeMultipartValue(value) {
    return String(value).replace(/["\\r\\n]/g, '_');
}

function getSafeFilename(title, downloadUrl) {
    const extensionMatch = downloadUrl.match(/\.(jpg|jpeg|png|gif|webp|mp4|mov|m4v|webm)(?:\?|$)/i);
    const extension = extensionMatch ? extensionMatch[1].toLowerCase() : 'jpg';
    const baseName = cleanHtml(title)
        .replace(/\.[a-z0-9]{2,5}$/i, '')
        .replace(/[^a-z0-9-_]+/gi, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || 'pinterest_media';
    return `${baseName}.${extension}`;
}

function getContentTypeFromUrl(downloadUrl) {
    if (/\.png(?:\?|$)/i.test(downloadUrl)) return 'image/png';
    if (/\.gif(?:\?|$)/i.test(downloadUrl)) return 'image/gif';
    if (/\.webp(?:\?|$)/i.test(downloadUrl)) return 'image/webp';
    if (/\.avif(?:\?|$)/i.test(downloadUrl)) return 'image/avif';
    if (/\.(?:mp4|mov|m4v|webm)(?:\?|$)/i.test(downloadUrl)) return 'video/mp4';
    return 'image/jpeg';
}
