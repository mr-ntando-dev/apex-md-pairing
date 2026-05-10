# ⚡ APEX-MD Pairing Site

Get your `SESSION_ID` for [apex-md-bot](https://github.com/mr-ntando-dev/apex-md-bot) via QR code or pairing code.

## Deploy to Render (free)

1. Fork this repo
2. Create a **Web Service** on [Render](https://render.com), connect your fork
3. Build command: `npm install`
4. Start command: `node index.js`
5. No env vars needed — just deploy
6. Open the URL, scan QR or enter pairing code
7. Copy your `SESSION_ID` and paste it into `apex-md-bot` env vars

## Run locally

```bash
npm install
npm start
# Open http://localhost:3000
```

## How it works

- **QR Code tab** — generates a scannable QR, poll updates every 1.5s
- **Pairing Code tab** — enter your number, get an 8-digit code to type in WhatsApp
- Once paired, your `SESSION_ID` appears — copy and paste it into your bot's `SESSION_ID` env var
- The session is encoded as a base64 JSON blob — no files stored on the server after pairing
