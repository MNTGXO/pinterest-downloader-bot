'use strict';

/**
 * lib/telegram.js
 *
 * Thin wrappers around the Telegram Bot API.
 * Reads BOT_TOKEN from process.env at call-time (safe for Vercel preview vs prod).
 *
 * Exports:
 *   sendMessage(chatId, text)
 *   sendMedia(chatId, { downloadUrl, title, isVideo })
 *   setWebhook(webhookUrl)
 *   getWebhookInfo()
 */

const fetch = require('node-fetch');
const {
    getExtFromUrl,
    getContentType,
    getSafeFilename,
    buildMultipartBody,
} = require('./utils');

const MAX_BYTES = 45 * 1024 * 1024; // Telegram bot upload limit: 50 MB; leave 5 MB headroom

// ─── Helpers ───────────────────────────────────────────────────────────────────

function apiUrl(method) {
    const token = process.env.BOT_TOKEN;
    if (!token) throw new Error('BOT_TOKEN env var is not set');
    return `https://api.telegram.org/bot${token}/${method}`;
}

async function _post(method, body) {
    return fetch(apiUrl(method), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

// ─── sendMessage ───────────────────────────────────────────────────────────────

async function sendMessage(chatId, text) {
    const res = await _post('sendMessage', {
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
    });
    if (!res.ok) {
        console.error('[telegram:sendMessage]', await res.text());
    }
}

// ─── sendMedia ────────────────────────────────────────────────────────────────

/**
 * Try to download the file and upload it to Telegram.
 * Returns the parsed JSON response or null on any failure.
 */
async function _uploadFile(chatId, endpoint, payloadKey, caption, mediaUrl, title) {
    let buffer, contentType;

    try {
        const res = await fetch(mediaUrl, {
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                Referer: 'https://www.pinterest.com/',
                Accept: 'image/*,video/*,*/*;q=0.8',
            },
        });
        if (!res.ok) return null;

        // Bail early if content-length exceeds limit
        const declared = Number(res.headers.get('content-length') || 0);
        if (declared > MAX_BYTES) return null;

        const raw = Buffer.from(await res.arrayBuffer());
        if (!raw.length || raw.length > MAX_BYTES) return null;

        buffer      = raw;
        contentType = res.headers.get('content-type') || getContentType(getExtFromUrl(mediaUrl));
    } catch (err) {
        console.error('[telegram:download]', err.message);
        return null;
    }

    try {
        const ext      = getExtFromUrl(mediaUrl);
        const filename = getSafeFilename(title, ext);
        const boundary = `PinBot${Date.now().toString(16)}`;

        const body = buildMultipartBody(
            boundary,
            { chat_id: String(chatId), caption },
            { fieldName: payloadKey, filename, contentType, buffer }
        );

        const res = await fetch(apiUrl(endpoint), {
            method: 'POST',
            headers: {
                'Content-Type':   `multipart/form-data; boundary=${boundary}`,
                'Content-Length': String(body.length),
            },
            body,
        });

        return res.json().catch(() => null);
    } catch (err) {
        console.error('[telegram:upload]', err.message);
        return null;
    }
}

/** Pass the URL directly to Telegram (Telegram fetches it on their side). */
async function _sendByUrl(chatId, endpoint, payloadKey, caption, mediaUrl) {
    try {
        const body = { chat_id: chatId, caption };
        body[payloadKey] = mediaUrl;
        const res  = await _post(endpoint, body);
        return res.json().catch(() => null);
    } catch (err) {
        console.error('[telegram:sendByUrl]', err.message);
        return null;
    }
}

/**
 * Send a Pinterest media item.
 * Strategy:
 *   1. Download the file and upload it (most reliable)
 *   2. Send the CDN URL directly to Telegram
 *   3. Send a plain text fallback with the download link
 */
async function sendMedia(chatId, { downloadUrl, title, isVideo }) {
    const endpoint   = isVideo ? 'sendVideo' : 'sendPhoto';
    const payloadKey = isVideo ? 'video'     : 'photo';
    const caption    = `📌 ${title}\n\n🤖 @MNTGX-`;

    // 1. Upload
    const uploaded = await _uploadFile(chatId, endpoint, payloadKey, caption, downloadUrl, title);
    if (uploaded?.ok) return;
    if (uploaded) console.warn('[telegram:upload] rejected:', JSON.stringify(uploaded));

    // 2. URL pass-through
    const urlSent = await _sendByUrl(chatId, endpoint, payloadKey, caption, downloadUrl);
    if (urlSent?.ok) return;
    if (urlSent) console.warn('[telegram:sendByUrl] rejected:', JSON.stringify(urlSent));

    // 3. Fallback plain link
    await sendMessage(
        chatId,
        `⚠️ Could not upload media directly.\n\n🔗 Download link:\n${downloadUrl}`
    );
}

// ─── Webhook management ────────────────────────────────────────────────────────

async function setWebhook(webhookUrl) {
    if (!process.env.BOT_TOKEN) return { ok: false, error: 'BOT_TOKEN not configured' };
    try {
        const res = await _post('setWebhook', {
            url: webhookUrl,
            allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post'],
            drop_pending_updates: false,
        });
        const data = await res.json().catch(() => ({}));
        return { ok: res.ok && data.ok === true, webhookUrl, telegram: data };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

async function getWebhookInfo() {
    if (!process.env.BOT_TOKEN) return { ok: false, error: 'BOT_TOKEN not configured' };
    try {
        const res  = await fetch(apiUrl('getWebhookInfo'));
        const data = await res.json().catch(() => ({}));
        return { ok: res.ok && data.ok === true, telegram: data };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

module.exports = { sendMessage, sendMedia, setWebhook, getWebhookInfo };
