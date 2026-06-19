'use strict';

/**
 * api/webhook.js  –  Vercel serverless entry-point
 *
 * GET  /api/webhook?setWebhook=1          → register webhook with Telegram
 * GET  /api/webhook?webhookInfo=1         → inspect current webhook status
 * GET  /api/webhook                       → health-check JSON
 * POST /api/webhook                       → receive Telegram updates
 */

const { extractPinterestUrl } = require('../lib/utils');
const { getMedia }             = require('../lib/pinterest');
const {
    sendMessage,
    sendMedia,
    setWebhook,
    getWebhookInfo,
} = require('../lib/telegram');

const SUPPORT_GROUP  = 'https://t.me/mnbots_support';
const SOURCE_CODE    = 'https://github.com/MNTGXO/pinterest-downloader-bot';
const PRODUCTION_URL = process.env.VERCEL_PROJECT_PRODUCTION_URL;   // auto-set by Vercel

// ─── Tiny helpers ──────────────────────────────────────────────────────────────

function getQuery(req) {
    if (req.query && typeof req.query === 'object') return req.query;
    const host = req.headers?.host || 'localhost';
    const u    = new URL(req.url || '/', `https://${host}`);
    return Object.fromEntries(u.searchParams);
}

function getOrigin(req, preferProduction = true) {
    if (preferProduction && PRODUCTION_URL) {
        const u = PRODUCTION_URL.startsWith('http')
            ? PRODUCTION_URL
            : `https://${PRODUCTION_URL}`;
        return u.replace(/\/$/, '');
    }
    const h = req.headers || {};
    const proto = h['x-forwarded-proto'] || 'https';
    const host  = h['x-forwarded-host']  || h.host;
    return host ? `${proto}://${host}` : null;
}

function isCommand(text, cmd) {
    return text === cmd
        || text.startsWith(`${cmd} `)
        || text.startsWith(`${cmd}@`);
}

function helpMessage(chatType = 'private') {
    const hint = chatType === 'private'
        ? '⚙️ Ensure BOT_TOKEN is set in Vercel → Settings → Env Vars, then re-run setWebhook.'
        : '⚙️ Add me to the group and grant permission to read messages.';

    return [
        '📌 *Pinterest Downloader Bot*',
        '',
        'Send me any Pinterest link and I will download the image or video for you.',
        'Works with `pinterest.com` and `pin.it` short links.',
        '',
        '📋 *Commands*',
        '/start – Show this message',
        '/help  – Show this message',
        '/support – Support group link',
        '/source  – Source code',
        '',
        `💬 Support: ${SUPPORT_GROUP}`,
        `💻 Source:  ${SOURCE_CODE}`,
        '',
    ].join('\n');
}

// ─── GET handler (health + webhook setup) ─────────────────────────────────────

async function handleGet(req, res) {
    const q = getQuery(req);

    if (q.setWebhook === '1' || q.setWebhook === 'true') {
        const useCurrent = q.target === 'current';
        const origin     = getOrigin(req, !useCurrent);
        if (!origin) return res.status(400).json({ ok: false, error: 'Cannot determine host' });
        const result = await setWebhook(`${origin}/api/webhook`);
        return res.status(result.ok ? 200 : 500).json(result);
    }

    if (q.webhookInfo === '1' || q.webhookInfo === 'true') {
        const result = await getWebhookInfo();
        return res.status(result.ok ? 200 : 500).json(result);
    }

    const origin        = getOrigin(req);
    const originCurrent = getOrigin(req, false);
    return res.status(200).json({
        ok: true,
        message: 'Pinterest Downloader Bot is running.',
        botConfigured: Boolean(process.env.BOT_TOKEN),
        quickSetup: {
            description: 'Open this URL to register the webhook with Telegram',
            productionWebhook:   origin        ? `${origin}/api/webhook?setWebhook=1`               : null,
            currentDeployment:   originCurrent ? `${originCurrent}/api/webhook?setWebhook=1&target=current` : null,
        },
        webhookInfo: origin ? `${origin}/api/webhook?webhookInfo=1` : null,
        support: SUPPORT_GROUP,
        source:  SOURCE_CODE,
    });
}

// ─── POST handler (Telegram updates) ──────────────────────────────────────────

async function handlePost(req, res) {
    if (!process.env.BOT_TOKEN) {
        console.error('[webhook] BOT_TOKEN is not set – ignoring update');
        return res.status(200).send('OK');
    }

    // Parse body (Vercel may deliver it pre-parsed or as a string)
    let body = req.body;
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    const message = body.message
                 || body.edited_message
                 || body.channel_post
                 || body.edited_channel_post;

    if (!message) return res.status(200).send('OK');

    const chatId = message.chat?.id;
    const text   = (message.text || message.caption || '').trim();
    if (!chatId) return res.status(200).send('OK');

    // ── Commands ───────────────────────────────────────────────────────────────
    if (isCommand(text, '/start') || isCommand(text, '/help')) {
        await sendMessage(chatId, helpMessage(message.chat.type));
        return res.status(200).send('OK');
    }
    if (isCommand(text, '/support')) {
        await sendMessage(chatId, `💬 Support group:\n${SUPPORT_GROUP}`);
        return res.status(200).send('OK');
    }
    if (isCommand(text, '/source')) {
        await sendMessage(chatId, `💻 Source code:\n${SOURCE_CODE}`);
        return res.status(200).send('OK');
    }

    // ── Pinterest URL ──────────────────────────────────────────────────────────
    const pinterestUrl = extractPinterestUrl(text);
    if (!pinterestUrl) {
        await sendMessage(
            chatId,
            `❌ Please send a valid Pinterest URL (pinterest.com or pin.it).\n\nSupport: ${SUPPORT_GROUP}`
        );
        return res.status(200).send('OK');
    }

    await sendMessage(chatId, '⚡ Processing your Pinterest link…');

    try {
        const media = await getMedia(pinterestUrl);

        if (!media?.downloadUrl) {
            await sendMessage(
                chatId,
                `❌ Could not extract media from this pin.\nIt may be private, deleted, or unsupported.\n\nSupport: ${SUPPORT_GROUP}`
            );
            return res.status(200).send('OK');
        }

        await sendMedia(chatId, media);
    } catch (err) {
        console.error('[webhook] Unhandled error:', err);
        await sendMessage(
            chatId,
            `❌ Unexpected error. Please try again later.\n\nSupport: ${SUPPORT_GROUP}`
        );
    }

    return res.status(200).send('OK');
}

// ─── Vercel handler export ────────────────────────────────────────────────────

module.exports = async (req, res) => {
    try {
        if (req.method === 'GET' || req.method === 'HEAD') return handleGet(req, res);
        if (req.method === 'POST') return handlePost(req, res);
        res.setHeader('Allow', 'GET, HEAD, POST');
        return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    } catch (err) {
        console.error('[webhook] Fatal crash:', err);
        return res.status(200).send('OK');   // always 200 so Telegram doesn't retry
    }
};
