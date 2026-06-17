const fetch = require('node-fetch');

// Environment variables configuration
const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Extracted worker URL from your provided KlickPin frontend script
const KLICKPIN_WORKER = 'https://resolve-cc1770c86b02.vasinvictory3.workers.dev/';

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    try {
        const { message } = req.body;
        if (!message || !message.text) {
            return res.status(200).send('OK');
        }

        const chatId = message.chat.id;
        const text = message.text.trim();

        // 1. Validate incoming Pinterest URL formats
        const isLongPin = /^https?:\/\/(?:[\w-]+\.)?pinterest\.(com|co\.uk|de|fr|it|es|nl|se|ch|co\.in|br|au|at|cl|jp|ru|ie|ca|mx|nz|pt|ph)\/.+/i.test(text);
        const isShortPin = /^https?:\/\/(?:www\.)?pin\.it\/[A-Za-z0-9\-_]+/i.test(text);

        if (!isLongPin && !isShortPin) {
            if (text === '/start') {
                await sendTextMessage(chatId, "👋 Send me any Pinterest link (pin.it or pinterest.com), and I'll extract the direct media file for you.");
            } else {
                await sendTextMessage(chatId, "❌ Please send a valid Pinterest URL.");
            }
            return res.status(200).send('OK');
        }

        await sendTextMessage(chatId, "⚡ Processing your link via KlickPin Engine...");

        // 2. Resolve Canonical URL if it's a short pin (pin.it)
        let targetUrl = text;
        if (isShortPin) {
            targetUrl = await resolveShortUrl(text);
            if (!targetUrl) {
                await sendTextMessage(chatId, "❌ Failed to resolve short pin link. Please try the full desktop link.");
                return res.status(200).send('OK');
            }
        }

        // 3. Request the media from KlickPin download processing route
        const mediaData = await extractMediaFromKlickPin(targetUrl);
        
        if (!mediaData || !mediaData.downloadUrl) {
            await sendTextMessage(chatId, "❌ KlickPin could not extract media from this pin. It might be private or unsupported.");
            return res.status(200).send('OK');
        }

        // 4. Dispatch the media back to Telegram using the appropriate structural type
        await sendMediaToTelegram(chatId, mediaData);

        return res.status(200).send('OK');
    } catch (error) {
        console.error('Webhook Error:', error);
        return res.status(200).send('OK'); // Always reply 200 to Telegram so it doesn't retry infinitely
    }
};

/**
 * Leverages KlickPin's dedicated CF Worker routing infrastructure to unwrap short links
 */
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

/**
 * Submits the canonical URL to KlickPin's main engine and parses out download URLs
 */
async function extractMediaFromKlickPin(canonicalUrl) {
    try {
        // Step A: Request initial download page context mimicking original web client variables
        const response = await fetch('https://klickpin.com/download', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            body: `url=${encodeURIComponent(canonicalUrl)}`
        });

        if (!response.ok) return null;
        const html = await response.text();

        // Step B: Regex targeting structural components down in the tables you supplied
        // Looks for raw data-download-url elements or typical target media elements
        const downloadUrlMatch = html.match(/data-download-url="([^"]+)"/) || html.match(/href="([^"]+)"[^>]*id="dlMP3"/);
        const titleMatch = html.match(/<p class="card-text"[^>]*>[\s\S]*?<strong>([\s\S]*?)<\/strong>/);

        if (!downloadUrlMatch) return null;

        const downloadUrl = downloadUrlMatch[1];
        const title = titleMatch ? titleMatch[1].trim() : "Pinterest Media";

        // Determine if it's a video based on extension types inside the link elements
        const isVideo = downloadUrl.includes('.mp4') || html.includes('id="dlMP4"') && !downloadUrl.match(/\.(jpg|jpeg|png|gif)/i);

        return {
            downloadUrl,
            title,
            isVideo
        };
    } catch (err) {
        console.error('KlickPin parsing execution error:', err);
        return null;
    }
}

/**
 * Basic text message dispatching helper
 */
async function sendTextMessage(chatId, text) {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text })
    });
}

/**
 * Ships media straight to the user via URL injection routing
 */
async function sendMediaToTelegram(chatId, { downloadUrl, title, isVideo }) {
    const endpoint = isVideo ? 'sendVideo' : 'sendPhoto';
    const payloadKey = isVideo ? 'video' : 'photo';

    const body = {
        chat_id: chatId,
        caption: title
    };
    body[payloadKey] = downloadUrl;

    const res = await fetch(`${TELEGRAM_API}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    // Fallback error messaging if structural constraints fail (e.g. file payload limits)
    if (!res.ok) {
        const errLog = await res.text();
        console.error('Telegram Media Upload Rejection:', errLog);
        await sendTextMessage(chatId, `🔗 I found your media, but Telegram couldn't stream it directly. You can download it directly here:\n\n${downloadUrl}`);
    }
}
  
