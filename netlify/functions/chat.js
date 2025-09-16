// netlify/functions/chat.js
// Kompletní verze s automatickým posláním instrukcí po úspěšné rezervaci.

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
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SHEETS_API_URL = process.env.SHEETS_API_URL;
    if (!OPENAI_API_KEY) return new Response('Missing OPENAI_API_KEY', { status: 500 });
    if (!SHEETS_API_URL) return new Response('Missing SHEETS_API_URL', { status: 500 });

    // ---- HOTEL STATIC (optional) ----
    // Pokud máš public/data/hotel.json, načteme ho (kvůli ceně apod.). Když ne, nastavíme fallback.
    const base = new URL(req.url);
    const hotelUrl = new URL('/data/hotel.json', `${base.origin}`).toString();
    let HOTEL = {
      name: 'CHILL Apartments',
      parking: { priceEurPerNight: 20 }
    };
    try {
      const r = await fetch(hotelUrl, { headers: { 'cache-control': 'no-cache' } });
      if (r.ok) HOTEL = await r.json();
    } catch {}

    // ---- Apps Script helpers ----
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

    // ---- Date utils ----
    const toISODate = (d) => d.toISOString().slice(0, 10);
    const fmtISO    = (y,m,d) => `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const daysInMonth = (y,m) => new Date(y, m, 0).getDate();
    const clampDay = (y,m,d) => Math.min(d, daysInMonth(y,m));

    // ---- Smart date parsing + „tento měsíc / příští rok“ doptání ----
    function parseDatesSmart(text) {
      const now = new Date();
      const CY = now.getFullYear();
      const CM = now.getMonth() + 1;

      const re = /(\d{1,2})\s*[.\-\/]\s*(\d{1,2})(?:\s*[.\-\/]\s*(\d{2,4}))?/g;

      let hits = [];
      let m;
      while ((m = re.exec(text)) !== null) {
        let [ , d, mo, y ] = m;
        let year = y ? (y.length === 2 ? (Number(y) > 50 ? 1900 + Number(y) : 2000 + Number(y)) : Number(y)) : null;
        hits.push({ d: Number(d), mo: Number(mo), y: year, hadYear: !!y });
      }
      if (hits.length === 0) return { confirmed: null, ask: null };

      const A = hits[0];
      const B = hits[1] || hits[0];

      if (!A.y) A.y = CY;
      if (!B.y) B.y = A.y;

      if (!A.mo && B.mo) A.mo = B.mo;
      if (!B.mo && A.mo) B.mo = A.mo;
      if (!A.mo) A.mo = CM;
      if (!B.mo) B.mo = A.mo;

      const Aa = { y: A.y, mo: A.mo, d: clampDay(A.y, A.mo, A.d) };
      const Bb = { y: B.y, mo: B.mo, d: clampDay(B.y, B.mo, B.d) };
      const isoA = fmtISO(Aa.y, Aa.mo, Aa.d);
      const isoB = fmtISO(Bb.y, Bb.mo, Bb.d);

      if (!A.hadYear && Aa.mo < CM) {
        const nextYearA = fmtISO(CY + 1, Aa.mo, clampDay(CY+1, Aa.mo, Aa.d));
        const nextYearB = fmtISO(CY + 1, Bb.mo, clampDay(CY+1, Bb.mo, Bb.d));
        const thisMonthA = fmtISO(CY, CM, clampDay(CY, CM, Aa.d));
        const thisMonthB = fmtISO(CY, CM, clampDay(CY, CM, Bb.d));
        const ask = `Zadal jste měsíc, který už proběhl. Myslíte spíš **${thisMonthA} až ${thisMonthB}** (tento měsíc), nebo **${nextYearA} až ${nextYearB}** (příští rok)? Odpovězte prosím "tento měsíc" nebo "příští rok", případně napište přesná data.`;
        return { confirmed: null, ask };
      }

      const from = isoA <= isoB ? isoA : isoB;
      const to   = isoA <= isoB ? isoB : isoA;
      return { confirmed: { from, to }, ask: null };
    }

    // ---- zkus z poslední user msg vyčíst rozsah ----
    const lastUserText = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    const parsed = parseDatesSmart(lastUserText);

    if (parsed.ask) {
      return new Response(JSON.stringify({ reply: parsed.ask }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }

    // ---- Pokud máme potvrzený rozsah → načti denní data (inclusive) ----
    let PARKING_RANGE = null;
    if (parsed.confirmed) {
      const { from, to } = parsed.confirmed;
      const out = {};
      let cur = new Date(from + 'T00:00:00Z');
      const end = new Date(to + 'T00:00:00Z');
      while (cur <= end) {
        const dISO = toISODate(cur);
        try {
          out[dISO] = await gsGet({ fn: 'parking', date: dISO });
        } catch (e) {
          out[dISO] = { ok:false, error:String(e) };
        }
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
      PARKING_RANGE = { from, to, days: out };
    }

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

    // ---- RULES pro AI (čtení dostupnosti + návod na TOOL) ----
    const rules = `
You are a multilingual, precise assistant for ${HOTEL.name}.
Reply in the user's language. Never invent facts.

DATES:
- If I already asked the user to clarify dates (ASK), wait for clear dates before availability.
- When PARSED_RANGE exists, restate the ISO dates first.

PARKING (Google Sheets):
- Daily availability = free = total_spots - booked.
- Use PARKING_RANGE.days[YYYY-MM-DD] when provided (already fetched).
- For a multi-day request, list availability per-day. If any day has missing data or unknown, say "availability to be confirmed" for that day.
- If free > 0 → say “There appears to be X spot(s) available.”
- If free = 0 → say “fully booked” and offer mrparkit.com.
- If user wants to proceed, ask ONLY:
  • Guest name (required)
  • Car plate / SPZ (required)
  • Arrival time HH:mm (recommended)
- When the user gives those, WRITE via:
  TOOL: reserveParking {"from_date":"<FROM>","to_date":"<TO>","guest_name":"John Doe","channel":"Direct","car_plate":"ABC1234","arrival_time":"18:30","note":""}
- After successful write, reply with confirmation and include the parking instructions in Czech.

TOOL protocol (strict):
- To read parking: "TOOL: parking YYYY-MM-DD"
- To write reservation: "TOOL: reserveParking {...JSON...}"
After TOOL-RESULT, continue the answer using only that data.
`.trim();

    const seed = [
      { role: 'system', content: rules },
      { role: 'system', content: `HOTEL: ${JSON.stringify(HOTEL)}` },
      { role: 'system', content: `PARKING_RANGE: ${JSON.stringify(PARKING_RANGE)}` }
    ];

    // ---- 1. průchod AI ----
    let ai = await callOpenAI([...seed, ...messages]);

    // ---- Pokud AI požádá o TOOL ----
    const mTool = /^TOOL:\s*(.+)$/im.exec(ai || '');
    if (mTool) {
      const cmd = (mTool[1] || '').trim();
      let result;

      if (/^parking\s+\d{4}-\d{2}-\d{2}$/i.test(cmd)) {
        const d = cmd.split(/\s+/)[1];
        result = await gsGet({ fn: 'parking', date: d });

        const toolMsg = { role: 'system', content: `TOOL-RESULT: ${JSON.stringify(result)}` };
        ai = await callOpenAI([...seed, ...messages, toolMsg]);

      } else if (/^reserveParking\s+/i.test(cmd)) {
        const json = cmd.replace(/^reserveParking\s+/i, '').trim();
        let payload;
        try { payload = JSON.parse(json); } catch { result = { ok:false, error:'Bad JSON for reserveParking' }; }
        if (!result) {
          payload.fn = 'reserveParking';
          result = await gsPost(payload);
        }

        // === NOVÉ: po úspěšném zápisu rovnou pošli potvrzení + instrukce ===
        if (result && result.ok) {
          const price = HOTEL?.parking?.priceEurPerNight ?? 20;
          const i = result.summary || {};
          const confirm =
`✅ Rezervace parkování byla zapsána. ID: ${result.id || ''}.
Termín: ${i.from_date} – ${i.to_date}
Host: ${i.guest_name || ''}, SPZ: ${i.car_plate || ''}, nocí: ${i.nights || ''}.
Cena je ${price} € / noc.

**Instrukce k parkování**
Parkování je rezervováno a nachází se **za vraty ve dvoře**. Poplatek je **${price} € / noc**.

Vjezd je přes úzký průjezd (výška 220 cm, šířka 220 cm). Doporučujeme předem mrknout na Google Street View a 3D vizualizaci pro lepší orientaci:
• 3D vizualizace hotelu (Matterport): https://my.matterport.com/show/?m=PTEAUeUbMno

Tip: Pokud přijedete z horní strany ulice, projeďte blok dokola a přijeďte k nám „zpoza rohu“. Nebudou za vámi auta a můžete si najet kolmo k průjezdu; klidně využijte protisměrný pruh, ať máte lepší nájezd. Průjezdem pomalu vjeďte na dvůr – parkování je hned za vraty.

Máte-li jakékoli otázky, klidně napište.`;

          // Vracíme rovnou hotovou zprávu, bez dalšího kola k AI.
          return new Response(JSON.stringify({ reply: confirm }), {
            status: 200, headers: { 'content-type': 'application/json' }
          });
        }

        // pokud zápis selhal, pošleme AI TOOL-RESULT a necháme ji vysvětlit chybu
        const toolMsg = { role: 'system', content: `TOOL-RESULT: ${JSON.stringify(result)}` };
        ai = await callOpenAI([...seed, ...messages, toolMsg]);

      } else {
        // neznámý TOOL – pošli AI, aby odpověděla lidsky
        const toolMsg = { role: 'system', content: `TOOL-RESULT: {"ok":false,"error":"unknown tool cmd"}` };
        ai = await callOpenAI([...seed, ...messages, toolMsg]);
      }
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
