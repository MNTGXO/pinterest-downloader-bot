const fetch = require('node-fetch');

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;
const KLICKPIN_WORKER = 'https://resolve-cc1770c86b02.vasinvictory3.workers.dev/';
const SUPPORT_GROUP_URL = 'https://t.me/mnbots_support';
const SOURCE_CODE_URL = 'https://github.com/MNTGXO/pinterest-downloader-bot';
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
            webhookInfo: getWebhookInfoUrl(req)
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

        const mediaData = await extractMediaFromKlickPin(targetUrl);

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

function getWebhookUrl(req) {
    const origin = getRequestOrigin(req);
    return origin ? `${origin}/api/webhook` : null;
}

function getWebhookSetupUrl(req) {
    const origin = getRequestOrigin(req);
    return origin ? `${origin}/api/webhook?setWebhook=1` : null;
}

function getWebhookInfoUrl(req) {
    const origin = getRequestOrigin(req);
    return origin ? `${origin}/api/webhook?webhookInfo=1` : null;
}

async function setTelegramWebhook(req) {
    if (!TELEGRAM_API) {
        return {
            ok: false,
            error: 'BOT_TOKEN is not configured in Vercel.'
        };
    }

    const webhookUrl = getWebhookUrl(req);
    if (!webhookUrl) {
        return {
            ok: false,
            error: 'Could not determine this deployment host.'
        };
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
        nextStep: response.ok && data.ok === true
            ? 'Send /start to the bot again in Telegram.'
            : 'Check the Telegram error and verify BOT_TOKEN belongs to this bot.'
    };
}

async function getTelegramWebhookInfo() {
    if (!TELEGRAM_API) {
        return {
            ok: false,
            error: 'BOT_TOKEN is not configured in Vercel.'
        };
    }

    const response = await fetch(`${TELEGRAM_API}/getWebhookInfo`);
    const data = await response.json().catch(() => ({}));

    return {
        ok: response.ok && data.ok === true,
        telegram: data
    };
}

function parseRequestBody(body) {
    if (!body) return {};
    if (typeof body === 'string') {
        try {
            return JSON.parse(body);
        } catch (err) {
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

async function resolveShortUrl(shortUrl) {
    try {
        const response = await fetch(`${KLICKPIN_WORKER}?url=${encodeURIComponent(shortUrl)}`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            redirect: 'follow'
        });
        if (!response.ok) return null;
        const data = await response.json();
        return data.finalUrl || data.url || data.resolvedUrl || null;
    } catch (err) {
        console.error('Short URL resolution crash:', err);
        return null;
    }
}

async function extractMediaFromKlickPin(canonicalUrl) {
    try {
        const response = await fetch('https://klickpin.com/download', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Origin': 'https://klickpin.com',
                'Referer': 'https://klickpin.com/'
            },
            body: `url=${encodeURIComponent(canonicalUrl)}`
        });

        if (!response.ok) return null;
        const html = await response.text();

        const downloadUrlMatch = html.match(/data-download-url="([^"]+)"/) ||
            html.match(/href="([^"]+)"[^>]*(?:id="dlMP4"|id="dlMP3"|download)/i) ||
            html.match(/(?:https?:)?\/\/[^"'\s<>]+\.(?:mp4|jpg|jpeg|png|gif|webp)(?:\?[^"'\s<>]*)?/i);
        const titleMatch = html.match(/<p class="card-text"[^>]*>[\s\S]*?<strong>([\s\S]*?)<\/strong>/i) ||
            html.match(/<title>([\s\S]*?)<\/title>/i);

        if (!downloadUrlMatch) return null;

        const downloadUrl = normalizeUrl(downloadUrlMatch[1] || downloadUrlMatch[0]);
        const title = cleanHtml(titleMatch ? titleMatch[1].trim() : 'Pinterest Media');
        const isVideo = /\.mp4(?:\?|$)/i.test(downloadUrl) || /id="dlMP4"/i.test(html);

        return { downloadUrl, title, isVideo };
    } catch (err) {
        console.error('KlickPin parsing execution error:', err);
        return null;
    }
}

function normalizeUrl(url) {
    if (url.startsWith('//')) return `https:${url}`;
    return url.replace(/&amp;/g, '&');
}

function cleanHtml(value) {
    return value
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
        body: JSON.stringify({
            chat_id: chatId,
            text,
            disable_web_page_preview: true
        })
    });

    if (!response.ok) {
        console.error('Telegram sendMessage rejection:', await response.text());
    }
}

async function sendMediaToTelegram(chatId, { downloadUrl, title, isVideo }) {
    const endpoint = isVideo ? 'sendVideo' : 'sendPhoto';
    const payloadKey = isVideo ? 'video' : 'photo';

    const body = { chat_id: chatId, caption: `${title}\n\nSupport: ${SUPPORT_GROUP_URL}\nSource: ${SOURCE_CODE_URL}` };
    body[payloadKey] = downloadUrl;

    const response = await fetch(`${TELEGRAM_API}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const errLog = await response.text();
        console.error('Telegram media upload rejection:', errLog);
        await sendTextMessage(chatId, `🔗 Link extracted, but Telegram file upload failed. Download here directly:\n\n${downloadUrl}\n\nSupport: ${SUPPORT_GROUP_URL}\nSource: ${SOURCE_CODE_URL}`);
    }
}
