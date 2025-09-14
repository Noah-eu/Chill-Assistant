// netlify/functions/chat.js
// Chat funkce – sdílený parser, TOOL protokol, správná volba „tento měsíc / příští rok“
// i pro jedno datum, robustní volání Apps Scriptu. Běží v Node runtime.

export const config = { runtime: 'node' };

import { parseDatesSmart, resolveFromChoice } from '../../src/lib/date';

// Apps Script EXEC URL – fallback, pokud není SHEETS_API_URL v env
const SHEETS_URL_FALLBACK =
  'https://script.google.com/macros/s/AKfycbzwiAqnD3JOMkMhNG4mew0zCsEp-ySA8WBgutQ38n6ZkF15SBVGU_no6gCPJqPnRAcohg/exec';

export default async (req) => {
  try {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // ---- BODY ----
    let body = {};
    try { body = await req.json(); } catch { return new Response('Bad JSON body', { status: 400 }); }
    const { messages = [] } = body;

    // ---- ENV ----
    const OPENAI_API_KEY = (`${process.env.OPENAI_API_KEY ?? ''}`).trim();
    const SHEETS_API_URL = (`${process.env.SHEETS_API_URL ?? ''}`).trim() || SHEETS_URL_FALLBACK;

    if (!OPENAI_API_KEY) return new Response('Missing OPENAI_API_KEY', { status: 500 });
    try { new URL(SHEETS_API_URL); } catch { return new Response('Invalid SHEETS_API_URL', { status: 500 }); }

    // ---- Načti hotel.json ----
    const base = new URL(req.url);
    const hotelUrl = new URL('/data/hotel.json', `${base.origin}`).toString();
    let HOTEL = {};
    try {
      const r = await fetch(hotelUrl, { headers: { 'cache-control': 'no-cache' } });
      if (!r.ok) throw new Error(`hotel.json ${r.status}`);
      HOTEL = await r.json();
    } catch (e) {
      return new Response(`Cannot load hotel.json: ${String(e)}`, {
        status: 500, headers: { 'content-type': 'text/plain' }
      });
    }

    // ---- Apps Script helpers (robustní JSON/HTML) ----
    async function gsGet(params) {
      const url = new URL(SHEETS_API_URL);
      Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
      const r = await fetch(url.toString());
      const txt = await r.text();
      if (!r.ok) throw new Error(`Sheets GET ${r.status} ${txt.slice(0, 200)}`);
      try { return JSON.parse(txt); } catch { return { ok:false, raw: txt }; }
    }
    async function gsPost(payload) {
      const r = await fetch(SHEETS_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {})
      });
      const txt = await r.text();
      if (!r.ok) throw new Error(`Sheets POST ${r.status} ${txt.slice(0, 200)}`);
      try { return JSON.parse(txt); } catch { return { ok:false, raw: txt }; }
    }

    // ---- Util ----
    const toISODate = (d) => d.toISOString().slice(0, 10);

    // Najdi POSLEDNÍ doptávací zprávu asistenta s ISO (páry i single)
    function findLastAskText(msgs) {
      const m = [...msgs].reverse().find(
        m => m.role === 'assistant' &&
             /\*\*\d{4}-\d{2}-\d{2}(?:\s+až\s+\d{4}-\d{2}-\d{2})?\*\*/i.test(m.content)
      );
      return m?.content || null;
    }

    // Přednačtení dostupnosti pro rozsah (vrátí mapu dní)
    async function buildParkingRange(range) {
      if (!range) return null;
      const { from, to } = range;
      const out = {};
      let cur = new Date(from + 'T00:00:00Z');
      const end = new Date(to + 'T00:00:00Z');
      while (cur <= end) {
        const dISO = toISODate(cur);
        try { out[dISO] = await gsGet({ fn: 'parking', date: dISO }); }
        catch (e) { out[dISO] = { ok:false, error:String(e) }; }
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
      return { from, to, days: out };
    }

    // ---- Parser & ask handling (sdílený) ----
    const lastUserText = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    const parsed = parseDatesSmart(lastUserText);
    let confirmedRange = parsed.confirmed;

    // 1) Pokud parser vyžádal doptání → vrať dotaz a skonči
    if (!confirmedRange && parsed.ask) {
      return new Response(JSON.stringify({ reply: parsed.ask }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }

    // 2) Uživatel odpověděl „tento měsíc / příští rok“ (funguje i bez diakritiky, pro range i single)
    if (!confirmedRange && !parsed.ask) {
      const askText = findLastAskText(messages);
      if (askText) {
        const choiceRange = resolveFromChoice(lastUserText, askText);
        if (choiceRange) confirmedRange = choiceRange;
      }
    }

    // 3) Přednačtení dostupnosti (pokud už máme rozsah)
    let PARKING_RANGE = null;
    if (confirmedRange) {
      PARKING_RANGE = await buildParkingRange(confirmedRange);
    }

    // ---- Instrukce po potvrzení (text se použije po úspěšném zápisu) ----
    const PARKING_INSTRUCTIONS = `
The parking is reserved for you, and it´s right behind the gate in our courtyard. Please note there is a very reasonable 20 euro charge per night. 

Also, please have a look at Google Street View for an idea of how to get into our hotel, as there is a narrow passage to pass through: height of 220cm and width of 220cm.
You can see in the attachment 7 photos of how to find us and how to park. I am not sure from which side you will arrive, but in case you’ll come from the north and you’ll come straight to our street, then drive around us and then around the block and come to our street again from behind the corner.  Then there will be no other cars behind you, and you can use the middle, or even better, the opposite line. Then you can drive perpendicularly to the building and through the narrow passage to our courtyard/parking lot. 
Here you can see a 3D visualization of our hotel. The reception, second entrance (also for cars), laundry in a basement, and the apartments on the 1st floor. On the other floors, the setting is the same.

https://my.matterport.com/show/?m=PTEAUeUbMno

If you have any questions, please do not hesitate to ask.
`.trim();

    // ---- Pravidla pro AI (TOOL protokol) ----
    const rules = `
You are a multilingual, precise assistant for ${HOTEL.name} (${HOTEL.address}, ${HOTEL.city}).
Reply in the user's language. Never invent facts.

DATES:
- If I already asked the user to clarify dates (ASK), wait for clear dates before availability.
- When PARSED_RANGE exists, restate the ISO dates first.

PARKING (Google Sheets):
- Daily availability = free = total_spots - booked.
- Use PARKING_RANGE.days[YYYY-MM-DD] when provided (already fetched).
- For a multi-day request, list availability per-day. If any day has missing data or unknown, say "availability to be confirmed" for that day.
- If free > 0 → say “There appears to be X spot(s) available.”
- If free = 0 → say “fully booked” and offer ${HOTEL.parking?.altUrl || ''}. Mention: ${HOTEL.parking?.weekendFreeTips || ''}.
- If user wants to proceed, ask ONLY:
  • Guest name (required)
  • Car plate / SPZ (required)
  • Arrival time HH:mm (recommended)
- When the user gives those, WRITE via:
  TOOL: reserveParking {"from_date":"<FROM>","to_date":"<TO>","guest_name":"John Doe","channel":"Direct","car_plate":"ABC1234","arrival_time":"18:30","note":""}
- After successful write, say only: "OK" (I will construct the final confirmation with instructions).
- Never invent an ID. If write failed, say: "write_failed".

SELF CHECK-IN/WIFI/TAXI/NEARBY – keep concise using HOTEL data.

TOOL protocol (strict):
- To read parking: "TOOL: parking YYYY-MM-DD"
- To write reservation: "TOOL: reserveParking {...JSON...}"
- After TOOL-RESULT, continue using only that data.
${confirmedRange ? `PARSED_RANGE: ${JSON.stringify(confirmedRange)}` : ''}
`.trim();

    const seed = [
      { role: 'system', content: rules },
      { role: 'system', content: `HOTEL: ${JSON.stringify(HOTEL)}` },
      { role: 'system', content: `PARKING_RANGE: ${JSON.stringify(PARKING_RANGE)}` }
    ];

    // ---- OpenAI helper ----
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

    // ---- 1. průchod AI ----
    let ai = await callOpenAI([...seed, ...messages]);

    // ---- TOOL brancha (read/write) ----
    const toolMatch = /^TOOL:\s*(.+)$/im.exec(ai || '');
    if (toolMatch) {
      const cmd = (toolMatch[1] || '').trim();
      let result, wrote = false;

      if (/^parking\s+\d{4}-\d{2}-\d{2}$/i.test(cmd)) {
        const d = cmd.split(/\s+/)[1];
        result = await gsGet({ fn: 'parking', date: d });

      } else if (/^reserveParking\s+/i.test(cmd)) {
        const json = cmd.replace(/^reserveParking\s+/i, '').trim();
        let payload;
        try { payload = JSON.parse(json); } catch { result = { ok:false, error:'Bad JSON for reserveParking' }; }
        if (!result) {
          payload.fn = 'reserveParking';
          console.log('reserveParking payload:', payload); // DEBUG
          result = await gsPost(payload);
          wrote = true;
        }

      } else {
        result = { ok:false, error:'unknown tool cmd' };
      }

      if (wrote && result && result.ok && result.id) {
        const price = HOTEL.parking?.priceEurPerNight || 20;
        const final = [
          `✅ Rezervace parkování byla potvrzena a zapsána. **ID: ${result.id}**. Cena je ${price} € / noc.`,
          '',
          PARKING_INSTRUCTIONS
        ].join('\n');
        return new Response(JSON.stringify({ reply: final }), {
          status: 200, headers: { 'content-type': 'application/json' }
        });
      }

      const toolMsg = { role: 'system', content: `TOOL-RESULT: ${JSON.stringify(result)}` };
      ai = await callOpenAI([...seed, ...messages, toolMsg]);
    }

    return new Response(JSON.stringify({ reply: ai || 'No reply.' }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });

  } catch (err) {
    return new Response(`Function error: ${String(err)}`, {
      status: 500, headers: { 'content-type': 'text/plain' }
    });
  }
};
