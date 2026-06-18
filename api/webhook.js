const fetch = require('node-fetch');
const { pinterest } = require('btch-downloader');

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
            note: 'If Telegram webhookInfo shows 401 Unauthorized, your Vercel deployment is protected. Disable Vercel Deployment Protection for Production, then open the productionWebhookSetup URL.'
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
            console.log('Received update without a supported message:', JSON.stringify(body));
            return res.status(200).send('OK');
        }

        const chatId = message.chat && message.chat.id;
        const text = getMessageText(message);

        if (!chatId) return res.status(200).send('OK');

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
            await sendTextMessage(chatId, `❌ Please send a valid Pinterest URL.\n\nSupport: ${SUPPORT_GROUP_URL}`);
            return res.status(200).send('OK');
        }

        await sendTextMessage(chatId, '⚡ Processing your Pinterest link...');

        const mediaData = await extractMedia(pinterestUrl);

        if (!mediaData || !mediaData.downloadUrl) {
            await sendTextMessage(chatId, `❌ Could not extract media from this pin. It might be private, deleted, or unsupported.\n\nSupport: ${SUPPORT_GROUP_URL}`);
            return res.status(200).send('OK');
        }

        await sendMediaToTelegram(chatId, mediaData);
        return res.status(200).send('OK');
    } catch (error) {
        console.error('Fatal webhook crash:', error);
        return res.status(200).send('OK');
    }
};

// ─── Media extraction via btch-downloader ────────────────────────────────────

async function extractMedia(url) {
    try {
        const result = await pinterest(url);
        // btch-downloader returns { status, data: [ { url, type } ] } or similar
        if (!result) return null;

        // Handle array of media items — pick the first valid one
        const items = Array.isArray(result) ? result
            : Array.isArray(result.data) ? result.data
            : result.url ? [result]
            : null;

        if (!items || items.length === 0) return null;

        const item = items[0];
        const downloadUrl = item.url || item.download_url || item.media_url || null;
        if (!downloadUrl) return null;

        const isVideo = /\.(mp4|mov|m4v|webm)(?:\?|$)/i.test(downloadUrl)
            || item.type === 'video';

        const title = cleanText(item.title || result.title || 'Pinterest Media');

        return { downloadUrl, title, isVideo };
    } catch (err) {
        console.error('btch-downloader pinterest() error:', err);
        return null;
    }
}

// ─── Telegram helpers ─────────────────────────────────────────────────────────

async function sendMediaToTelegram(chatId, { downloadUrl, title, isVideo }) {
    const endpoint = isVideo ? 'sendVideo' : 'sendPhoto';
    const payloadKey = isVideo ? 'video' : 'photo';
    const caption = `${title}\n\nSupport: ${SUPPORT_GROUP_URL}\nSource: ${SOURCE_CODE_URL}`;

    const mediaFile = await downloadMediaFile(downloadUrl);
    const response = mediaFile
        ? await sendDownloadedMedia(chatId, endpoint, payloadKey, caption, mediaFile, title)
        : await sendMediaByUrl(chatId, endpoint, payloadKey, caption, downloadUrl);

    if (!response.ok) {
        const errText = await response.text();
        console.error('Telegram media upload rejection:', errText);
        await sendTextMessage(chatId,
            `🔗 Media extracted but Telegram upload failed. Download directly:\n\n${downloadUrl}\n\nSupport: ${SUPPORT_GROUP_URL}`
        );
    }
}

async function downloadMediaFile(downloadUrl) {
    try {
        const response = await fetch(downloadUrl, {
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8',
                'Referer': 'https://www.pinterest.com/'
            }
        });

        if (!response.ok) return null;

        const contentLength = Number(response.headers.get('content-length') || 0);
        if (contentLength > 45 * 1024 * 1024) return null;

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        if (!buffer.length || buffer.length > 45 * 1024 * 1024) return null;

        return {
            buffer,
            contentType: response.headers.get('content-type') || getContentTypeFromUrl(downloadUrl)
        };
    } catch (err) {
        console.error('Media download error:', err);
        return null;
    }
}

async function sendDownloadedMedia(chatId, endpoint, payloadKey, caption, mediaFile, title) {
    const boundary = `----PinterestBot${Date.now().toString(16)}`;
    const filename = getSafeFilename(title, mediaFile.contentType);
    const body = buildMultipartBody(boundary,
        { chat_id: String(chatId), caption },
        { fieldName: payloadKey, filename, contentType: mediaFile.contentType, buffer: mediaFile.buffer }
    );

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

async function sendTextMessage(chatId, text) {
    const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
    });
    if (!response.ok) console.error('Telegram sendMessage rejection:', await response.text());
}

// ─── Webhook setup helpers ────────────────────────────────────────────────────

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
    if (!TELEGRAM_API) return { ok: false, error: 'BOT_TOKEN is not configured in Vercel.' };

    const webhookUrl = getWebhookUrl(req, target);
    if (!webhookUrl) return { ok: false, error: 'Could not determine deployment host.' };

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
            ? 'Webhook set! Send /start to your bot in Telegram.'
            : 'Check the Telegram error and verify your BOT_TOKEN.'
    };
}

async function getTelegramWebhookInfo() {
    if (!TELEGRAM_API) return { ok: false, error: 'BOT_TOKEN is not configured in Vercel.' };
    const response = await fetch(`${TELEGRAM_API}/getWebhookInfo`);
    const data = await response.json().catch(() => ({}));
    const lastError = data.result && data.result.last_error_message;
    const hint = lastError && lastError.includes('401 Unauthorized')
        ? 'Vercel Deployment Protection is blocking Telegram. Disable it for Production, then re-run setWebhook.'
        : null;
    return { ok: response.ok && data.ok === true, telegram: data, deploymentProtectionHint: hint };
}

// ─── Misc helpers ─────────────────────────────────────────────────────────────

function parseRequestBody(body) {
    if (!body) return {};
    if (typeof body === 'string') {
        try { return JSON.parse(body); } catch { return {}; }
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
    const hint = chatType === 'private'
        ? 'If I do not respond, make sure your Vercel BOT_TOKEN env var is set and the webhook URL points to this deployment.'
        : 'If I do not respond in this chat, make sure I am added to the group and can read messages.';
    return [
        '👋 Send me any Pinterest link (pin.it or pinterest.com), and I will extract the media for you.',
        '',
        `Support group: ${SUPPORT_GROUP_URL}`,
        `Source code: ${SOURCE_CODE_URL}`,
        '',
        'Commands:',
        '/help - Show this message',
        '/support - Get the support group link',
        '/source - Get the source code link',
        '',
        hint
    ].join('\n');
}

function extractPinterestUrl(text) {
    const match = text.match(PINTEREST_URL_REGEX);
    return match ? match[0].replace(/[),.]+$/, '') : null;
}

function cleanText(value) {
    return (value || '')
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'")
        .replace(/\s+/g, ' ').trim().slice(0, 900) || 'Pinterest Media';
}

function getContentTypeFromUrl(url) {
    if (/\.png(?:\?|$)/i.test(url)) return 'image/png';
    if (/\.gif(?:\?|$)/i.test(url)) return 'image/gif';
    if (/\.webp(?:\?|$)/i.test(url)) return 'image/webp';
    if (/\.avif(?:\?|$)/i.test(url)) return 'image/avif';
    if (/\.(?:mp4|mov|m4v|webm)(?:\?|$)/i.test(url)) return 'video/mp4';
    return 'image/jpeg';
}

function getSafeFilename(title, contentType) {
    const extMap = {
        'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
        'image/webp': 'webp', 'image/avif': 'avif', 'video/mp4': 'mp4'
    };
    const ext = extMap[contentType] || 'jpg';
    const base = cleanText(title)
        .replace(/[^a-z0-9-_]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80)
        || 'pinterest_media';
    return `${base}.${ext}`;
}

function buildMultipartBody(boundary, fields, file) {
    const chunks = [];
    for (const [name, value] of Object.entries(fields)) {
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename.replace(/["\\r\\n]/g, '_')}"\r\nContent-Type: ${file.contentType}\r\n\r\n`));
    chunks.push(file.buffer);
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    return Buffer.concat(chunks);
}
