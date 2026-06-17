const fetch = require('node-fetch');

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const KLICKPIN_WORKER = 'https://resolve-cc1770c86b02.vasinvictory3.workers.dev/';

module.exports = async (req, res) => {
    // 1. Block invalid request types
    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    try {
        // Safe check for body structure
        const body = req.body || {};
        const message = body.message;
        
        if (!message) {
            console.log('Received update payload without a standard message object:', JSON.stringify(body));
            return res.status(200).send('OK');
        }

        const chatId = message.chat ? message.chat.id : null;
        const text = message.text ? message.text.trim() : '';

        if (!chatId) {
            return res.status(200).send('OK');
        }

        // 2. Handle System Commands
        if (text.startsWith('/start')) {
            await sendTextMessage(chatId, "👋 Send me any Pinterest link (pin.it or pinterest.com), and I'll extract the direct media file for you.");
            return res.status(200).send('OK');
        }

        // 3. Match and validate target Pinterest links
        const isLongPin = /^https?:\/\/(?:[\w-]+\.)?pinterest\.(com|co\.uk|de|fr|it|es|nl|se|ch|co\.in|br|au|at|cl|jp|ru|ie|ca|mx|nz|pt|ph)\/.+/i.test(text);
        const isShortPin = /^https?:\/\/(?:www\.)?pin\.it\/[A-Za-z0-9\-_]+/i.test(text);

        if (!isLongPin && !isShortPin) {
            await sendTextMessage(chatId, "❌ Please send a valid Pinterest URL.");
            return res.status(200).send('OK');
        }

        await sendTextMessage(chatId, "⚡ Processing your link via KlickPin Engine...");

        let targetUrl = text;
        if (isShortPin) {
            targetUrl = await resolveShortUrl(text);
            if (!targetUrl) {
                await sendTextMessage(chatId, "❌ Failed to resolve short pin link. Please try copying the full desktop link.");
                return res.status(200).send('OK');
            }
        }

        const mediaData = await extractMediaFromKlickPin(targetUrl);
        
        if (!mediaData || !mediaData.downloadUrl) {
            await sendTextMessage(chatId, "❌ KlickPin could not extract media from this pin. It might be private or unsupported.");
            return res.status(200).send('OK');
        }

        await sendMediaToTelegram(chatId, mediaData);
        return res.status(200).send('OK');

    } catch (error) {
        // Critical block: Catches typos or runtime errors and prints them clearly to your Vercel log console
        console.error('Fatal Webhook execution crash:', error);
        return res.status(200).send('OK'); 
    }
};

async function resolveShortUrl(shortUrl) {
    try {
        const response = await fetch(`${KLICKPIN_WORKER}?url=${encodeURIComponent(shortUrl)}`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
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
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            body: `url=${encodeURIComponent(canonicalUrl)}`
        });

        if (!response.ok) return null;
        const html = await response.text();

        const downloadUrlMatch = html.match(/data-download-url="([^"]+)"/) || html.match(/href="([^"]+)"[^>]*id="dlMP3"/);
        const titleMatch = html.match(/<p class="card-text"[^>]*>[\s\S]*?<strong>([\s\S]*?)<\/strong>/);

        if (!downloadUrlMatch) return null;

        const downloadUrl = downloadUrlMatch[1];
        const title = titleMatch ? titleMatch[1].trim() : "Pinterest Media";
        const isVideo = downloadUrl.includes('.mp4') || html.includes('id="dlMP4"') && !downloadUrl.match(/\.(jpg|jpeg|png|gif)/i);

        return { downloadUrl, title, isVideo };
    } catch (err) {
        console.error('KlickPin parsing execution error:', err);
        return null;
    }
}

async function sendTextMessage(chatId, text) {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text })
    });
}

async function sendMediaToTelegram(chatId, { downloadUrl, title, isVideo }) {
    const endpoint = isVideo ? 'sendVideo' : 'sendPhoto';
    const payloadKey = isVideo ? 'video' : 'photo';

    const body = { chat_id: chatId, caption: title };
    body[payloadKey] = downloadUrl;

    const res = await fetch(`${TELEGRAM_API}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const errLog = await res.text();
        console.error('Telegram Media Upload Rejection:', errLog);
        await sendTextMessage(chatId, `🔗 Link extracted, but Telegram file upload failed. Download here directly:\n\n${downloadUrl}`);
    }
}
