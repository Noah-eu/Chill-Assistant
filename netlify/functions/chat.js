// netlify/functions/chat.js
export default async (req) => {
  try {
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    // ---- body ----
    let body = {};
    try { body = await req.json(); } catch { return new Response('Bad JSON body', { status: 400 }); }
    const { messages = [] } = body;

    // ---- env ----
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SHEETS_API_URL = process.env.SHEETS_API_URL;
    if (!OPENAI_API_KEY) return new Response('Missing OPENAI_API_KEY', { status: 500 });
    if (!SHEETS_API_URL) return new Response('Missing SHEETS_API_URL', { status: 500 });

    // ---- load static hotel.json ----
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

    // ---- utils ----
    const toISO = (d) => d.toISOString().slice(0,10);
    const fmtISO = (y,m,d)=>`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const daysInMonth=(y,m)=>new Date(y,m,0).getDate();
    const clampDay=(y,m,d)=>Math.min(d, daysInMonth(y,m));
    const ISO_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
    const stripAccents = (s) => (s||'').normalize('NFD').replace(/\p{Diacritic}/gu,'');
    const DEFAULT_TOTAL = Number(HOTEL?.parking?.totalSpots || 4);

    const extractISOs = (text) => (text ? (text.match(ISO_RE) || []) : []);

    // ---- smart date parsing + disambiguation ----
    function parseDatesSmart(text) {
      const now = new Date();
      const today = new Date(toISO(now));
      const CY = today.getFullYear();
      const CM = today.getMonth() + 1;

      // „15.–17. 8“, „od 15. do 17.8.“, „12.9.2025“, atd.
      const re = /(\d{1,2})\s*[\.\-]?\s*(\d{1,2})?(?:\.\s*(\d{2,4}))?/g;
      const tokens = [];
      let m;
      while ((m = re.exec(text)) !== null) {
        const D1 = parseInt(m[1],10);
        const M1 = m[2] ? parseInt(m[2],10) : null;
        let Y1 = m[3] ? m[3] : null;
        if (Y1 && Y1.length === 2) Y1 = (Number(Y1) > 50 ? '19' : '20') + Y1;
        tokens.push({ d: D1, mo: M1, y: Y1?parseInt(Y1,10):null, hadYear: !!m[3] });
      }
      if (tokens.length === 0) return { confirmed: null, ask: null };

      if (tokens.length >= 2) {
        const A = tokens[0], B = tokens[1];
        if (!A.mo && B.mo) A.mo = B.mo;
        if (!B.mo && A.mo) B.mo = A.mo;
        if (!A.y && B.y) A.y = B.y;
        if (!B.y && A.y) B.y = A.y;
      }

      tokens.forEach(t => {
        if (!t.y) t.y = CY;
        if (!t.mo) t.mo = tokens[1]?.mo || CM;
      });

      let A = tokens[0], B = tokens[1] || tokens[0];
      A = { ...A, d: clampDay(A.y, A.mo, A.d) };
      B = { ...B, d: clampDay(B.y, B.mo, B.d) };

      const isoA = fmtISO(A.y, A.mo, A.d);
      const isoB = fmtISO(B.y, B.mo, B.d);

      const userProvidedAnyYear = tokens.some(t => t.hadYear);
      if (!userProvidedAnyYear && A.mo < CM) {
        const isoA1 = fmtISO(A.y+1, A.mo, clampDay(A.y+1, A.mo, A.d));
        const isoB1 = fmtISO(B.y+1, B.mo, clampDay(B.y+1, B.mo, B.d));
        const isoA2 = fmtISO(CY, CM, clampDay(CY, CM, A.d));
        const isoB2 = fmtISO(CY, CM, clampDay(CY, CM, B.d));
        const ask = `Zadal jste měsíc, který už proběhl. Myslíte spíš **${isoA2} až ${isoB2}** (tento měsíc), nebo **${isoA1} až ${isoB1}** (příští rok)? Odpovězte prosím "tento měsíc" nebo "příští rok", případně napište přesná data.`;
        return { confirmed: null, ask, options: [isoA2, isoB2, isoA1, isoB1] };
      }

      const from = (isoA <= isoB) ? isoA : isoB;
      const to   = (isoA <= isoB) ? isoB : isoA;
      return { confirmed: { from, to }, ask: null };
    }

    // ---- poslední zprávy
    const lastUser = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')?.content || '';

    // 1) zkus datumy z poslední user zprávy
    let parsed = parseDatesSmart(lastUser);

    // 2) když user odpoví „tento měsíc / příští rok“, vezmeme ISO z minulé asistentovy nabídky
    if (!parsed.confirmed) {
      const lu = stripAccents(lastUser.toLowerCase());
      if (lu.includes('tento mesic') || lu.includes('pristi rok')) {
        const allIsos = extractISOs(lastAssistant);
        if (allIsos.length >= 4) {
          const thisMonth = { from: allIsos[0], to: allIsos[1] };
          const nextYear  = { from: allIsos[2], to: allIsos[3] };
          parsed.confirmed = lu.includes('tento mesic') ? thisMonth : nextYear;
          parsed.ask = null;
        } else if (allIsos.length >= 2) {
          parsed.confirmed = { from: allIsos[0], to: allIsos[1] };
          parsed.ask = null;
        }
      }
    }

    // 3) pokud je třeba upřesnit → rovnou vrať dotaz
    if (parsed.ask) {
      return new Response(JSON.stringify({ reply: parsed.ask }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }

    // ---- když máme rozsah → načti dny PARALELNĚ a spočti free serverem
    let PARKING_RANGE = null;
    let SERVER_AVAIL = null;

    if (parsed.confirmed) {
      const { from, to } = parsed.confirmed;

      // seznam dat (včetně konce)
      const dates = [];
      let cur = new Date(from + 'T00:00:00');
      const end = new Date(to + 'T00:00:00');
      while (cur <= end) { dates.push(toISO(cur)); cur.setDate(cur.getDate()+1); }

      const results = await Promise.all(dates.map(async d => {
        try {
          const data = await gsGet({ fn:'parking', date:d });
          const total = Number(data?.total_spots ?? DEFAULT_TOTAL);
          const booked = Number(data?.booked ?? 0);
          const free = Math.max(0, total - booked);
          return [d, { ok: true, total, booked, free, note: data?.note || '' }];
        } catch (e) {
          return [d, { ok:false, error:String(e), total:DEFAULT_TOTAL, booked:0, free:DEFAULT_TOTAL }];
        }
      }));
      const days = Object.fromEntries(results);
      const all_free = Object.values(days).every(v => v.ok && v.free > 0);
      SERVER_AVAIL = { from, to, days, all_free };
      PARKING_RANGE = { from, to, days: Object.fromEntries(Object.entries(days).map(([k,v])=>[k,{ ok:true, total_spots:v.total, booked:v.booked }] )) };
    }

    // ---- pravidla pro AI (auto-confirm varianta)
    const rules = `
You are a multilingual assistant for ${HOTEL.name} (${HOTEL.address}, ${HOTEL.city}). Reply in the user's language. Do not invent facts.

DATES:
- Use the ISO dates from PARSED_RANGE/SERVER_AVAIL exactly.

PARKING:
- Trust SERVER_AVAIL. If SERVER_AVAIL.all_free is true, say that parking appears available for the whole range and politely ask ONLY:
  • Guest name (required)
  • Car plate / SPZ (required)
  • Arrival time HH:mm (recommended)
- After the guest provides those, immediately write via:
  TOOL: reserveParking {"from_date":"<FROM>","to_date":"<TO>","guest_name":"<NAME>","channel":"Direct","car_plate":"<SPZ>","arrival_time":"<HH:mm>","note":""}
  Then confirm: "✅ Rezervace parkování byla potvrzena a zapsána. ID: <ID>. Cena je ${HOTEL.parking?.priceEurPerNight || 20} € / noc."
- If any day has free = 0, list availability by day and offer ${HOTEL.parking?.altUrl}. Mention: ${HOTEL.parking?.weekendFreeTips || ''}.
- Never claim availability without using SERVER_AVAIL.

CHECK-IN/OUT: concise steps; include photos from HOTEL.links/photos when helpful.
WIFI: use HOTEL.wifi; suggest alternates on the same floor if SSID not visible.
TAXI: Small ≤4p = ${HOTEL.transfer?.smallEur} €, Large 5–8p = ${HOTEL.transfer?.largeEur} €; ask for flight no. + landing time; say you'll pass to David.
NEARBY: only curated places; otherwise suggest Google Maps near "${HOTEL.address}".

If you need fresh data, ask me with:
"TOOL: parking YYYY-MM-DD" or write: "TOOL: reserveParking {JSON}". I will respond with "TOOL-RESULT: <json>" and then you continue using ONLY that data.
`.trim();

    const seed = [
      { role: 'system', content: rules },
      { role: 'system', content: `HOTEL: ${JSON.stringify(HOTEL)}` },
      { role: 'system', content: `PARSED_RANGE: ${JSON.stringify(parsed.confirmed || null)}` },
      { role: 'system', content: `SERVER_AVAIL: ${JSON.stringify(SERVER_AVAIL || null)}` }
    ];

    async function callOpenAI(msgs) {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages: msgs, temperature: 0.2 })
      });
      if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
      const data = await r.json();
      return data.choices?.[0]?.message?.content || '';
    }

    // ---- 1. průchod
    let ai = await callOpenAI([...seed, ...messages]);

    // ---- TOOL obsluha (rezervace = auto-confirm)
    const toolReq = /^TOOL:\s*(.+)$/im.exec(ai || '');
    if (toolReq) {
      const cmd = (toolReq[1] || '').trim();
      let res;

      if (/^parking\s+\d{4}-\d{2}-\d{2}$/i.test(cmd)) {
        const d = cmd.split(/\s+/)[1];
        res = await gsGet({ fn: 'parking', date: d });

      } else if (/^reserveParking\s+/i.test(cmd)) {
        const jsonPart = cmd.replace(/^reserveParking\s+/i, '').trim();
        let payload = {};
        try { payload = JSON.parse(jsonPart); } catch (e) { res = { ok:false, error:'Bad JSON for reserveParking' }; }
        if (!res) {
          payload.fn = 'reserveParking';
          if (!payload.channel) payload.channel = 'Direct';
          res = await gsPost(payload);   // Apps Script: auto-confirm (zapíše + bump booked)
        }

      } else {
        res = { error: 'unknown tool cmd' };
      }

      // přidej TOOL-RESULT pro model, aby mohl vrátit ID uživateli
      const toolMsg = { role: 'system', content: `TOOL-RESULT: ${JSON.stringify(res)}` };
      ai = await callOpenAI([...seed, ...messages, toolMsg]);
    }

    return new Response(JSON.stringify({ reply: ai || 'No reply.' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });

  } catch (err) {
    return new Response(`Function error: ${String(err)}`, { status: 500, headers: { 'content-type': 'text/plain' } });
  }
};
