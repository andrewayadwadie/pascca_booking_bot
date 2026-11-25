# Pascca Heliopolis website

One Cloudflare Worker that serves the website and sends table bookings to the restaurant's Telegram.

- `public/` – the website (menu book, ordering for the table, table booking). `index.html` is built from the design files, so edit those, not this file by hand.
- `src/worker.js` – receives bookings on `POST /api/booking` and sends them to Telegram through @pasccabot.
- `wrangler.jsonc` – Cloudflare settings. Every push to `main` deploys automatically (Workers Builds).

## Settings in Cloudflare

Workers & Pages → pascca-booking-bot → Settings → Variables and Secrets:

| Name | Type | What |
|---|---|---|
| `BOT_TOKEN` | Secret | token from @BotFather |
| `CHAT_ID` | Text | who gets the bookings (find it at `/api/setup` while CHAT_ID is empty) |
| `ALLOWED_ORIGINS` | Text, optional | other sites allowed to send bookings |

## Checking it

- `https://<site>/api/check` – settings present, bot and chat found.
- Bookings appear in Telegram as "New table booking #REF" with the guest's name and phone.
