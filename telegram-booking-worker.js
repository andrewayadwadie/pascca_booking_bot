/**
 * Pascca table booking -> restaurant Telegram (Cloudflare Worker)
 *
 * The website POSTs each booking here as JSON. This worker checks it and sends it
 * to the restaurant's Telegram through a Telegram bot. The guest never sees it,
 * and the bot token stays here, never in the website.
 *
 * ---------------------------------------------------------------------------
 * Setup (about 10 minutes, all in the browser and Telegram)
 *
 * 1. Telegram: open @BotFather -> /newbot -> name: Pascca Bookings
 *    -> username: something ending in "bot" (e.g. pascca_heliopolis_bot). Copy the token.
 * 2. On the Telegram account that should receive bookings (+20 128 124 8732):
 *    open the new bot and press Start. (A bot can only message people who did this.)
 *    Want several staff to see bookings? Make a group, add the bot, send any message there.
 * 3. dash.cloudflare.com -> Workers & Pages -> Create -> Worker -> name: pascca-booking -> Deploy
 *    -> Edit code -> replace everything with this file -> Deploy.
 * 4. Worker -> Settings -> Variables and Secrets -> Add:
 *      BOT_TOKEN  (type Secret)  = the token from BotFather
 *    Deploy, then open  https://pascca-booking.<your-subdomain>.workers.dev/setup
 *    It lists the chats that pressed Start, with their chat id.
 * 5. Add a second variable:
 *      CHAT_ID    (type Text)    = that chat id (a group's id starts with -)
 *    Deploy, then open  /test  -> a test booking should arrive in Telegram.
 * 6. Send the worker address to be put in the website (BOOKING_URL).
 *
 * Optional:
 *      ALLOWED_ORIGINS = https://pasccarestaurant.com,https://www.pasccarestaurant.com
 *        (once the site is live on its domain; empty = accept bookings from any page)
 *    A Cloudflare rate-limiting rule on this worker (e.g. 5 requests / minute / IP).
 *
 * Checking it:  /check  (settings and bot OK?)   /test  (sends a sample booking)
 * ---------------------------------------------------------------------------
 */

const MAX = { name: 60, phone: 20, note: 200 };

export default {
  async fetch(req, env) {
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const origin = req.headers.get('Origin') || '';
    const okOrigin = !allowed.length || allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed.length ? (okOrigin ? origin : allowed[0]) : '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const reply = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const path = new URL(req.url).pathname.replace(/\/+$/, '');
    if (req.method === 'GET') {
      if (path.endsWith('/setup')) return pretty(await setup(env));
      if (path.endsWith('/check')) return pretty(await diagnose(env, allowed));
      if (path.endsWith('/test')) {
        const r = await send(env, format({
          ref: 'TEST1', replaces: '', name: 'Test Guest', phone: '01000000000', guests: 2,
          dayLabel: 'Friday 27 November', service: 'Dinner', time: '20:30', vegan: false,
          note: 'This is a test from /test',
        }));
        return pretty({ ...r, hint: hint(r) }, r.ok ? 200 : 502);
      }
      return pretty({ ok: true, service: 'Pascca booking', try: ['/check', '/setup', '/test'] });
    }
    if (req.method !== 'POST') return reply({ ok: false, error: 'method' }, 405);
    if (!okOrigin) {
      console.log('blocked origin', JSON.stringify(origin), 'allowed', allowed.join(' '));
      return reply({ ok: false, error: 'origin', origin }, 403);
    }

    let b;
    try {
      b = await req.json();
    } catch {
      return reply({ ok: false, error: 'json' }, 400);
    }

    // honeypot: real guests never fill this hidden field
    if (b && b.website) return reply({ ok: true, ref: String(b.ref || '') });

    const v = check(b || {});
    if (v.error) return reply({ ok: false, error: v.error }, 422);

    const r = await send(env, format(v));
    if (!r.ok) {
      console.log('telegram error', JSON.stringify(r));
      return reply({ ok: false, error: 'send', telegram: r.description }, 502);
    }
    console.log('booking sent', v.ref);
    return reply({ ok: true, ref: v.ref });
  },
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function format(v) {
  const lines = [
    `<b>New table booking #${esc(v.ref)}</b>`,
    v.replaces ? `<i>Replaces booking #${esc(v.replaces)}</i>` : '',
    '',
    `Name: <b>${esc(v.name)}</b>`,
    `Phone: ${esc(v.phone)}`,
    `Guests: ${v.guests}`,
    `Day: ${esc(v.dayLabel)}`,
    `Time: ${esc(v.service)}, ${esc(v.time)}`,
    `Vegan menu: ${v.vegan ? 'Yes' : 'No'}`,
    v.note ? `Note: ${esc(v.note)}` : '',
  ];
  return lines.filter((l, i) => l !== '' || i === 2).join('\n');
}

async function tg(env, method, body) {
  if (!env.BOT_TOKEN) return { ok: false, description: 'BOT_TOKEN is missing' };
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return res.json().catch(() => ({ ok: false, error_code: res.status, description: 'bad answer from Telegram' }));
}

async function send(env, text) {
  if (!env.CHAT_ID) return { ok: false, description: 'CHAT_ID is missing' };
  const j = await tg(env, 'sendMessage', {
    chat_id: env.CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
  return j.ok ? { ok: true, messageId: j.result && j.result.message_id } : { ok: false, code: j.error_code, description: j.description };
}

// What usually went wrong, in plain words
function hint(r) {
  if (r.ok) return 'Sent. Check the Telegram chat.';
  const d = String(r.description || '');
  if (/BOT_TOKEN is missing/.test(d)) return 'Add BOT_TOKEN in Settings > Variables and Secrets, then Deploy.';
  if (/CHAT_ID is missing/.test(d)) return 'Open /setup to find the chat id, then add it as CHAT_ID.';
  if (r.code === 401 || /Unauthorized/i.test(d)) return 'BOT_TOKEN is wrong. Copy it again from @BotFather.';
  if (/chat not found/i.test(d)) return 'CHAT_ID is wrong, or that account never pressed Start in the bot.';
  if (r.code === 403 || /blocked|kicked/i.test(d)) return 'The bot was blocked or removed from that chat. Press Start again, or add it back to the group.';
  if (/upgraded to a supergroup/i.test(d)) return 'The group changed its id. Open /setup again and update CHAT_ID.';
  return 'Telegram said: ' + d;
}

// Lists the chats that talked to the bot, so you can copy the right CHAT_ID
async function setup(env) {
  if (env.CHAT_ID) return { ok: true, note: 'CHAT_ID is already set, so this page is off. Open /test to send a sample booking.' };
  const me = await tg(env, 'getMe');
  if (!me.ok) return { ok: false, problem: me.description, hint: hint({ ok: false, code: me.error_code, description: me.description }) };
  const up = await tg(env, 'getUpdates', { limit: 100 });
  const chats = {};
  for (const u of (up.result || [])) {
    const m = u.message || u.edited_message || u.channel_post || u.my_chat_member;
    const c = m && m.chat;
    if (c) chats[c.id] = { CHAT_ID: String(c.id), name: c.title || [c.first_name, c.last_name].filter(Boolean).join(' '), username: c.username ? '@' + c.username : '', type: c.type };
  }
  const list = Object.values(chats);
  return {
    ok: list.length > 0,
    bot: '@' + me.result.username,
    chats: list,
    next: list.length
      ? 'Copy the CHAT_ID of the restaurant chat into Settings > Variables (type Text), Deploy, then open /test.'
      : `Nobody has written to @${me.result.username} yet. From the restaurant's Telegram, open it, press Start, then reload this page.`,
  };
}

async function diagnose(env, allowed) {
  const out = {
    BOT_TOKEN: env.BOT_TOKEN ? 'set' : 'MISSING',
    CHAT_ID: env.CHAT_ID || 'MISSING (open /setup)',
    ALLOWED_ORIGINS: allowed.length ? allowed : 'any page (fine for testing)',
  };
  if (env.BOT_TOKEN) {
    const me = await tg(env, 'getMe');
    out.bot = me.ok ? '@' + me.result.username : { problem: me.description, hint: hint({ ok: false, code: me.error_code, description: me.description }) };
    if (me.ok && env.CHAT_ID) {
      const c = await tg(env, 'getChat', { chat_id: env.CHAT_ID });
      out.chat = c.ok ? (c.result.title || [c.result.first_name, c.result.last_name].filter(Boolean).join(' ')) : { problem: c.description, hint: hint({ ok: false, code: c.error_code, description: c.description }) };
    }
  }
  out.ok = typeof out.bot === 'string' && typeof out.chat === 'string';
  return out;
}

function pretty(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

function check(b) {
  const str = (x, n) => (typeof x === 'string' ? x.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n) : '');
  const ref = str(b.ref, 8).toUpperCase();
  const replaces = str(b.replaces, 8).toUpperCase();
  const name = str(b.name, MAX.name);
  const phone = str(b.phone, MAX.phone);
  const note = str(b.note, MAX.note);
  const guests = Number(b.guests);
  const service = b.service === 'Lunch' ? 'Lunch' : b.service === 'Dinner' ? 'Dinner' : '';
  const time = str(b.time, 5);
  const date = str(b.date, 10);

  if (!/^[A-Z0-9]{4,8}$/.test(ref)) return { error: 'ref' };
  if (replaces && !/^[A-Z0-9]{4,8}$/.test(replaces)) return { error: 'replaces' };
  if (!name) return { error: 'name' };
  if (phone.replace(/\D/g, '').length < 8) return { error: 'phone' };
  if (!Number.isInteger(guests) || guests < 1 || guests > 8) return { error: 'guests' };
  if (!service) return { error: 'service' };
  if (!/^\d{2}:\d{2}$/.test(time)) return { error: 'time' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'date' };

  // the site offers the next 14 days; allow a day either side for time zones
  const day = new Date(date + 'T12:00:00Z');
  const diff = (day - Date.now()) / 864e5;
  if (isNaN(diff) || diff < -2 || diff > 16) return { error: 'date' };

  const dayLabel = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  }).format(day);

  return { ref, replaces, name, phone, note, guests, service, time, dayLabel, vegan: b.vegan === true };
}
