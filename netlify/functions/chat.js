// netlify/functions/chat.js
// Kompletní verze s opravou:
// - Lepší parser rozsahů (15–17. 8, od 15 do 17.8., 15.–17. apod.)
// - Rozlišení "tento měsíc" vs "příští rok" z předchozí doptávací zprávy asistenta
// - Přednačtení dostupnosti ze Sheets a deterministická potvrzovací odpověď s ID + instrukcemi
// Vyžaduje: env OPENAI_API_KEY, SHEETS_API_URL (Apps Script v3 /exec)

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

    // ---- Parser: chytá různé tvary rozsahů ----
    function parseDatesSmart(text) {
      const now = new Date();
      const CY = now.getFullYear();
      const CM = now.getMonth() + 1;

      const t = (text || '').toLowerCase().replace(/\s+/g, ' ').trim();

      // 1) formát "od 15 do 17. 8. 2025" / "15–17.8.2025" / "15 - 17. 8"
      // skupiny: d1, d2, mo?, y?
      const reRange = /(?:od\s*)?(\d{1,2})\s*(?:-|–|až|do)\s*(\d{1,2})\s*[.\-/ ]*\s*(\d{1,2})?(?:[.\-/ ]*\s*(\d{2,4}))?/i;
      let m = reRange.exec(t);
      if (m) {
        let d1 = parseInt(m[1],10);
        let d2 = parseInt(m[2],10);
        let mo = m[3] ? parseInt(m[3],10) : NaN;
        let y  = m[4] ? String(m[4]) : null;
        if (y && y.length === 2) y = (Number(y) > 50 ? '19' : '20') + y;
        let Y = y ? parseInt(y,10) : NaN;

        if (!Number.isFinite(Y)) Y = CY;
        if (!Number.isFinite(mo)) mo = CM;

        // pokud měsíc už proběhl a rok nebyl uveden → doptání
        const hadYear = !!m[4];
        if (!hadYear && mo < CM) {
          const A2 = fmtISO(CY, CM, clampDay(CY, CM, d1));
          const B2 = fmtISO(CY, CM, clampDay(CY, CM, d2));
          const A1 = fmtISO(CY+1, mo, clampDay(CY+1, mo, d1));
          const B1 = fmtISO(CY+1, mo, clampDay(CY+1, mo, d2));
          return {
            ask: `Zadal jste měsíc, který už proběhl. Myslíte spíš **${A2} až ${B2}** (tento měsíc), nebo **${A1} až ${B1}** (příští rok)? Odpovězte prosím "tento měsíc" nebo "příští rok", případně napište přesná data.`,
            confirmed: null
          };
        }

        const A = fmtISO(Y, mo, clampDay(Y, mo, d1));
        const B = fmtISO(Y, mo, clampDay(Y, mo, d2));
        const from = A <= B ? A : B;
        const to   = A <= B ? B : A;
        return { confirmed: { from, to }, ask: null };
      }

      // 2) formát "15. 8. 2025" (jedno datum) → from=to
      const reSingle = /(\d{1,2})\s*[.\-/ ]\s*(\d{1,2})(?:[.\-/ ]\s*(\d{2,4}))?/i;
      m = reSingle.exec(t);
      if (m) {
        let d = parseInt(m[1],10);
        let mo = parseInt(m[2],10);
        let y  = m[3] ? String(m[3]) : null;
        if (y && y.length === 2) y = (Number(y) > 50 ? '19' : '20') + y;
        let Y = y ? parseInt(y,10) : CY;

        if (!m[3] && mo < CM) {
          const A2 = fmtISO(CY, CM, clampDay(CY, CM, d));
          const A1 = fmtISO(CY+1, mo, clampDay(CY+1, mo, d));
          return {
            ask: `Zadal jste měsíc, který už proběhl. Myslíte spíš **${A2}** (tento měsíc), nebo **${A1}** (příští rok)?`,
            confirmed: null
          };
        }

        const iso = fmtISO(Y, mo, clampDay(Y, mo, d));
        return { confirmed: { from: iso, to: iso }, ask: null };
      }

      return { confirmed: null, ask: null };
    }

    // ---- Když uživatel odpoví "tento měsíc / příští rok", vezmeme předchozí doptávací větu asistenta ----
    function resolveRangeFromAsk(allMessages, userText) {
      const txt = (userText || '').toLowerCase();
      const choice = txt.includes('tento měsíc') ? 'this' :
                     txt.includes('pristi rok') || txt.includes('příští rok') ? 'next' : null;
      if (!choice) return null;

      // najdi poslední assistant zprávu, která obsahuje dvě ISO data ve formátu "**YYYY-MM-DD až YYYY-MM-DD**" dvakrát (this/next)
      const lastAsk = [...allMessages].reverse().find(m =>
        m.role === 'assistant' && /\*\*\d{4}-\d{2}-\d{2}\s+až\s+\d{4}-\d{2}-\d{2}\*\*/i.test(m.content)
      )?.content || '';

      if (!lastAsk) return null;

      const isoPairs = [...lastAsk.matchAll(/\*\*(\d{4}-\d{2}-\d{2})\s+až\s+(\d{4}-\d{2}-\d{2})\*\*/g)]
        .map(m => ({ from: m[1], to: m[2] }));

      if (isoPairs.length === 0) return null;
      // očekáváme: [ thisMonthPair, nextYearPair ] v pořadí, jak jsme je generovali
      if (choice === 'this') return isoPairs[0] || null;
      if (choice === 'next') return isoPairs[1] || null;
      return null;
    }

    // ---- Pomocná funkce: vytvoř PARKING_RANGE z potvrzeného rozsahu ----
    async function buildParkingRange(range) {
      if (!range) return null;
      const { from, to } = range;
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
      return { from, to, days: out };
    }

    // ---- Rozhodni rozsah ----
    const lastUserText = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    let parsed = parseDatesSmart(lastUserText);
    let confirmedRange = parsed.confirmed;

    // 1) Pokud parser vyžádal doptání → vrať dotaz a skonči
    if (!confirmedRange && parsed.ask) {
      return new Response(JSON.stringify({ reply: parsed.ask }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }

    // 2) Pokud parser nic nenašel (ani ask), zkusíme, zda uživatel neodpověděl na ask
    if (!confirmedRange && !parsed.ask) {
      const fromAsk = resolveRangeFromAsk(messages, lastUserText);
      if (fromAsk) {
        confirmedRange = fromAsk; // ← TEĎ už máme rozsah z odpovědi „tento měsíc / příští rok“
      }
    }

    // ---- Pokud máme potvrzený rozsah → vytvoř PARKING_RANGE (ať už z parseru, nebo z odpovědi na ask)
    let PARKING_RANGE = null;
    if (confirmedRange) {
      PARKING_RANGE = await buildParkingRange(confirmedRange);
    }

    // ---- Parkovací instrukce (tvůj text) – přilepíme po úspěšném zápisu ----
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

    // ---- Seed zprávy pro AI ----
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
          result = await gsPost(payload);
          wrote = true;
        }

      } else {
        result = { ok:false, error:'unknown tool cmd' };
      }

      // Pokud šlo o zápis a OK → deterministická odpověď s ID + instrukce
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

      // Jinak předej výsledek AI a nech ji dokončit
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
