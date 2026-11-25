/**
 * Pascca Heliopolis website + table bookings to Telegram (one Cloudflare Worker)
 *
 * - The website (public/) is served as static files by Cloudflare.
 * - Requests that are not a file reach this code:
 *     POST /api/booking  a guest's table booking -> the restaurant's Telegram chat
 *     GET  /api/check    are the settings right and does the bot answer?
 *     GET  /api/setup    lists who pressed Start in the bot (only while CHAT_ID is empty)
 *
 * Settings (Cloudflare -> Workers & Pages -> pascca-booking-bot -> Settings -> Variables and Secrets):
 *   BOT_TOKEN        Secret  the token from @BotFather
 *   CHAT_ID          Text    who receives the bookings (see /api/setup)
 *   ALLOWED_ORIGINS  Text    optional, extra sites allowed to send bookings, comma separated
 *                            (the site's own address is always allowed)
 */

const MAX = { name: 60, phone: 20, note: 200 };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const origin = req.headers.get('Origin') || '';
    let sameSite = false;
    try {
      sameSite = !!origin && new URL(origin).host === url.host;
    } catch {}
    const okOrigin = !origin || sameSite || allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': okOrigin && origin ? origin : url.origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const reply = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (path === '/api/setup') return pretty(await setup(env));
      if (path === '/api/check') return pretty(await diagnose(env, allowed));
      return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    }

    if (req.method !== 'POST' || (path !== '/api/booking' && path !== '/')) return reply({ ok: false, error: 'not_found' }, 404);
    if (!okOrigin) {
      console.log('blocked origin', JSON.stringify(origin));
      return reply({ ok: false, error: 'origin' }, 403);
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
      return reply({ ok: false, error: 'send' }, 502);
    }
    console.log('booking sent', v.ref);
    return reply({ ok: true, ref: v.ref });
  },
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// the guest's own name and phone number, exactly as they typed them on the site
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
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  } catch (e) {
    return { ok: false, description: 'could not reach Telegram: ' + (e && e.message) };
  }
  const raw = await res.text();
  try {
    return JSON.parse(raw);
  } catch {
    return { ok: false, error_code: res.status, description: `bad answer from Telegram (HTTP ${res.status}): ${raw.replace(/\s+/g, ' ').slice(0, 160)}` };
  }
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
  if (r.ok) return 'OK';
  const d = String(r.description || '');
  if (/BOT_TOKEN is missing/.test(d)) return 'Add BOT_TOKEN in Settings > Variables and Secrets, then Deploy.';
  if (/CHAT_ID is missing/.test(d)) return 'Open /api/setup to find the chat id, then add it as CHAT_ID.';
  if (r.code === 401 || /Unauthorized/i.test(d)) return 'BOT_TOKEN is wrong. Copy it again from @BotFather.';
  if (/chat not found/i.test(d)) return 'CHAT_ID is wrong, or that account never pressed Start in the bot.';
  if (r.code === 403 || /blocked|kicked/i.test(d)) return 'The bot was blocked or removed from that chat. Press Start again, or add it back to the group.';
  if (/upgraded to a supergroup/i.test(d)) return 'The group changed its id. Clear CHAT_ID, open /api/setup again and set the new id.';
  return 'Telegram said: ' + d;
}

// Lists the chats that talked to the bot, so the right CHAT_ID can be copied
async function setup(env) {
  if (env.CHAT_ID) return { ok: true, note: 'CHAT_ID is already set, so this page is off. Open /api/check to test the settings.' };
  const me = await tg(env, 'getMe');
  if (!me.ok) return { ok: false, problem: me.description, hint: hint({ ok: false, code: me.error_code, description: me.description }) };
  const up = await tg(env, 'getUpdates', { limit: 100 });
  const chats = {};
  for (const u of up.result || []) {
    const m = u.message || u.edited_message || u.channel_post || u.my_chat_member;
    const c = m && m.chat;
    if (c)
      chats[c.id] = {
        CHAT_ID: String(c.id),
        name: c.title || [c.first_name, c.last_name].filter(Boolean).join(' '),
        username: c.username ? '@' + c.username : '',
        type: c.type,
      };
  }
  const list = Object.values(chats);
  return {
    ok: list.length > 0,
    bot: '@' + me.result.username,
    chats: list,
    next: list.length
      ? 'Copy the CHAT_ID of the restaurant chat into Settings > Variables (type Text), then Deploy.'
      : `Nobody has written to @${me.result.username} yet. From the restaurant's Telegram, open it, press Start, then reload this page.`,
  };
}

async function diagnose(env, allowed) {
  const out = {
    BOT_TOKEN: env.BOT_TOKEN ? 'set' : 'MISSING',
    CHAT_ID: env.CHAT_ID ? 'set' : 'MISSING (open /api/setup)',
    ALLOWED_ORIGINS: allowed.length ? allowed : 'this site only',
  };
  if (env.BOT_TOKEN) {
    const me = await tg(env, 'getMe');
    out.bot = me.ok ? '@' + me.result.username : { problem: me.description, hint: hint({ ok: false, code: me.error_code, description: me.description }) };
    if (me.ok && env.CHAT_ID) {
      const c = await tg(env, 'getChat', { chat_id: env.CHAT_ID });
      out.chat = c.ok ? 'found' : { problem: c.description, hint: hint({ ok: false, code: c.error_code, description: c.description }) };
    }
  }
  out.ok = typeof out.bot === 'string' && out.chat === 'found';
  return out;
}

function pretty(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
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
