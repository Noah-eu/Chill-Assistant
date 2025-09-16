// netlify/functions/chat.js
import { parseDatesSmart, resolveFromChoice } from './_lib/date.js';

export default async (req) => {
  try {
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    let body = {};
    try { body = await req.json(); } catch { return new Response('Bad JSON body', { status: 400 }); }
    const { messages = [] } = body;

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SHEETS_API_URL = process.env.SHEETS_API_URL;
    if (!OPENAI_API_KEY) return new Response('Missing OPENAI_API_KEY', { status: 500 });
    if (!SHEETS_API_URL) return new Response('Missing SHEETS_API_URL', { status: 500 });

    // hotel.json
    const base = new URL(req.url);
    const hotelUrl = new URL('/data/hotel.json', `${base.origin}`).toString();
    let HOTEL = {};
    try {
      const r = await fetch(hotelUrl, { headers: { 'cache-control': 'no-cache' } });
      if (!r.ok) throw new Error(`hotel.json ${r.status}`);
      HOTEL = await r.json();
    } catch (e) {
      return new Response(`Cannot load hotel.json: ${String(e)}`, { status: 500, headers: { 'content-type': 'text/plain' } });
    }

    // Apps Script helpers
    async function gsGet(params) {
      const url = new URL(SHEETS_API_URL);
      Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
      const r = await fetch(url.toString());
      if (!r.ok) throw new Error(`Sheets GET ${r.status}`);
      return await r.json();
    }
    async function gsPost(payload) {
      const r = await fetch(SHEETS_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {})
      });
      if (!r.ok) throw new Error(`Sheets POST ${r.status}`);
      return await r.json();
    }

    // Smart parsing dat z poslední user zprávy
    const lastUserText = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    const parsed = parseDatesSmart(lastUserText);

    if (parsed.ask) {
      return new Response(JSON.stringify({ reply: parsed.ask }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }

    // Když uživatel odpoví „tento měsíc / příští rok“
    if (!parsed.confirmed) {
      const reply = (txt) => new Response(JSON.stringify({ reply: txt }), { status: 200, headers: { 'content-type': 'application/json' } });
      const choiceMsg = [...messages].reverse().find(m => m.role === 'user' && /tento|příšt|pristi/i.test(m.content || ''));
      if (choiceMsg && parsed.options) {
        const resolved = resolveFromChoice(choiceMsg.content, parsed);
        if (resolved) {
          parsed.confirmed = resolved;
        } else {
          return reply('Prosím, napište „tento měsíc“ nebo „příští rok“, případně přesná ISO data (YYYY-MM-DD až YYYY-MM-DD).');
        }
      }
    }

    // Pokud máme rozsah, načti dostupnost (per-day)
    let PARKING_RANGE = null;
    if (parsed.confirmed) {
      const { from, to } = parsed.confirmed;
      const out = {};
      let cur = new Date(from + 'T00:00:00Z');
      const end = new Date(to + 'T00:00:00Z');
      while (cur <= end) {
        const dISO = cur.toISOString().slice(0, 10);
        try { out[dISO] = await gsGet({ fn: 'parking', date: dISO }); }
        catch (e) { out[dISO] = { ok: false, error: String(e) }; }
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
      PARKING_RANGE = { from, to, days: out };
    }

    const rules = `
You are a multilingual, precise assistant for ${HOTEL.name}.
Reply in the user's language. Never invent facts.

DATES:
- If I already asked the user to clarify dates (ASK), wait for clear dates before availability.
- When PARSED_RANGE exists, restate the ISO dates first.

PARKING (Google Sheets):
- Daily availability = free = total_spots - booked.
- Use PARKING_RANGE.days[YYYY-MM-DD] when provided (already fetched).
- For a multi-day request, list availability per-day.
- If any day has free > 0 → allow reservation (ask for guest name, car plate, arrival time).
- When user provides them, write:
  TOOL: reserveParking {"from_date":"<FROM>","to_date":"<TO>","guest_name":"John Doe","channel":"Direct","car_plate":"ABC1234","arrival_time":"18:30","note":""}
- After success reply: "✅ Rezervace zapsána. ID: <id>. Cena je ${HOTEL.parking?.priceEurPerNight || 20} € / noc."
- If fully booked any day → say fully booked and offer ${HOTEL.parking?.altUrl || ''}.
`.trim();

    const seed = [
      { role: 'system', content: rules },
      { role: 'system', content: `HOTEL: ${JSON.stringify(HOTEL)}` },
      { role: 'system', content: `PARKING_RANGE: ${JSON.stringify(PARKING_RANGE)}` }
    ];

    async function callOpenAI(msgs) {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages: msgs, temperature: 0.2 })
      });
      if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
      const data = await r.json();
      return data.choices?.[0]?.message?.content || '';
    }

    let ai = await callOpenAI([...seed, ...messages]);

    // TOOL protokol
    const mTool = /^TOOL:\s*(.+)$/im.exec(ai || '');
    if (mTool) {
      const cmd = (mTool[1] || '').trim();
      let result;

      if (/^parking\s+\d{4}-\d{2}-\d{2}$/i.test(cmd)) {
        const d = cmd.split(/\s+/)[1];
        result = await gsGet({ fn: 'parking', date: d });

      } else if (/^reserveParking\s+/i.test(cmd)) {
        const json = cmd.replace(/^reserveParking\s+/i, '').trim();
        let payload;
        try { payload = JSON.parse(json); }
        catch { result = { ok: false, error: 'Bad JSON for reserveParking' }; }
        if (!result) {
          payload.fn = 'reserveParking';
          result = await gsPost(payload);
        }

      } else {
        result = { ok: false, error: 'unknown tool cmd' };
      }

      const toolMsg = { role: 'system', content: `TOOL-RESULT: ${JSON.stringify(result)}` };
      ai = await callOpenAI([...seed, ...messages, toolMsg]);
    }

    return new Response(JSON.stringify({ reply: ai || 'No reply.' }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });

  } catch (err) {
    return new Response(`Function error: ${String(err)}`, { status: 500, headers: { 'content-type': 'text/plain' } });
  }
};
