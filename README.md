# Pinterest Downloader Bot

A Telegram bot that downloads Pinterest **images and videos**.  
Deployed as a zero-config serverless function on **Vercel**.

---

## Features

- Downloads both images and videos
- Supports `pinterest.com` and `pin.it` short links
- Three fallback download methods for maximum reliability
- No database, no cron, no external servers

---

## Download Methods (tried in order)

| # | Method | How it works |
|---|--------|-------------|
| 1 | **Pinterest Resource API** | Calls Pinterest's internal `/resource/PinResource/get/` endpoint — returns video at the highest quality available and original-resolution images |
| 2 | **HTML Scraper** | Fetches the pin page and extracts `v.pinimg.com` (video) or `i.pinimg.com/originals/` (image) URLs |
| 3 | **btch-downloader** | npm package as a final safety net |

---

## Project Structure

```
/
├── api/
│   ├── webhook.js   # Vercel serverless handler (all logic lives here)
│   └── index.js     # Re-exports webhook.js for the root route
├── lib/
│   ├── pinterest.js # Pinterest extraction (3 methods)
│   ├── telegram.js  # Telegram API wrappers
│   └── utils.js     # URL regex, text helpers, multipart builder
├── .github/
│   └── workflows/ci.yml
├── .gitignore
├── package.json
├── vercel.json
└── README.md
```

---

## Setup

### 1 — Create a Telegram Bot

1. Message [@BotFather](https://t.me/BotFather)
2. `/newbot` → follow prompts → copy the **token**

### 2 — Deploy to Vercel

**One-click:**

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/MNTGXO/pinterest-downloader-bot)

**Or manually via CLI:**

```bash
npm i -g vercel
vercel login
vercel          # deploy; follow the prompts
```

### 3 — Set the Environment Variable

In Vercel dashboard → **Project → Settings → Environment Variables**, add:

| Name | Value |
|------|-------|
| `BOT_TOKEN` | `123456:ABC-your-token` |

Or via CLI:

```bash
vercel env add BOT_TOKEN production
```

### 4 — Register the Webhook

Open this URL in your browser (replace with your domain):

```
https://your-app.vercel.app/api/webhook?setWebhook=1
```

You should see `{"ok":true,...}` — your bot is live. Send it a Pinterest link to test.

---

## Local Development

```bash
npm install
vercel dev           # starts a local server on http://localhost:3000
```

Use [ngrok](https://ngrok.com/) or Vercel's built-in tunnel to expose the local server, then run:

```
http://localhost:3000/api/webhook?setWebhook=1&target=current
```

---

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` or `/help` | Show help message |
| `/support` | Support group link |
| `/source`  | Source code link |

Send any Pinterest URL (no command needed) — the bot downloads and replies with the media.

---

## Troubleshooting

**Bot doesn't respond**  
→ Check `BOT_TOKEN` is set. Visit `/api/webhook?webhookInfo=1` to inspect the registered webhook.

**Vercel returns 401 Unauthorized to Telegram**  
→ Go to Vercel project → Settings → **Deployment Protection** → disable it for Production, then re-run `setWebhook`.

**Media download fails**  
→ The pin is likely private, deleted, or a Story. Try a different pin.

---

## Environment Variables

| Variable | Set by | Description |
|----------|--------|-------------|
| `BOT_TOKEN` | You | Telegram bot token |
| `VERCEL_PROJECT_PRODUCTION_URL` | Vercel (auto) | Used to build the webhook URL |
