// netlify/functions/chat.js
// - Rozsah dat = příjezd ve "from" a odjezd v "to" => počítají se noci [from .. to) (den odjezdu se NEpočítá)
// - Předpočítaná denní dostupnost pro noci [from .. to)
// - AI MUSÍ nejdřív vypsat AVAILABILITY_TEXT (den-po-dni), pak pokračuje dotazy/rezervací
// - Po úspěšné rezervaci: instrukce + fotky (Markdown <img>)
// - Smart parsing dat + doptání u minulého měsíce bez roku

const TRANSLATE_INSTRUCTIONS = false;

export default async (req) => {
  try {
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    // ---- BODY ----
    let body = {};
    try { body = await req.json(); } catch { return new Response('Bad JSON body', { status: 400 }); }
    const { messages = [] } = body;

    // ---- ENV ----
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SHEETS_API_URL = process.env.SHEETS_API_URL;
    if (!OPENAI_API_KEY) return new Response('Missing OPENAI_API_KEY', { status: 500 });
    if (!SHEETS_API_URL) return new Response('Missing SHEETS_API_URL', { status: 500 });

    // ---- PUBLIC data ----
    const base = new URL(req.url);
    async function loadJSON(path) {
      const url = new URL(path, `${base.origin}`).toString();
      const r = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
      if (!r.ok) throw new Error(`${path} ${r.status}`);
      return await r.json();
    }
    const HOTEL = await loadJSON('/data/hotel.json').catch(() => ({}));
    const MEDIA = await loadJSON('/data/parking_media.json').catch(() => []);

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

    // ---- Smart parse ----
    function parseDatesSmart(text) {
      const now = new Date();
      const CY = now.getFullYear();
      const CM = now.getMonth() + 1;
      const re = /(\d{1,2})\s*[.\-\/]\s*(\d{1,2})(?:\s*[.\-\/]\s*(\d{2,4}))?/g;

      const hits = [];
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

    const lastUserText = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    const parsed = parseDatesSmart(lastUserText);

    if (parsed.ask) {
      return new Response(JSON.stringify({ reply: parsed.ask }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }

    // ---- Přednačtení denních dat pro noci [from .. to) ----
    let PARKING_RANGE = null;
    let PARKING_LIST = [];
    if (parsed.confirmed) {
      const { from, to } = parsed.confirmed;
      const out = {};
      let cur = new Date(from + 'T00:00:00Z');     // včetně from
      const end = new Date(to + 'T00:00:00Z');     // exkluzivně to
      while (cur < end) {
        const dISO = toISODate(cur);
        try {
          const day = await gsGet({ fn: 'parking', date: dISO });
          out[dISO] = day;
          if (day && day.ok) {
            PARKING_LIST.push({
              date: dISO,
              total: Number(day.total_spots || 0),
              booked: Number(day.booked || 0),
              free: Math.max(0, Number(day.total_spots || 0) - Number(day.booked || 0))
            });
          } else {
            PARKING_LIST.push({ date: dISO, total: null, booked: null, free: null, error: day?.error || 'unknown' });
          }
        } catch (e) {
          out[dISO] = { ok:false, error:String(e) };
          PARKING_LIST.push({ date: dISO, total: null, booked: null, free: null, error: String(e) });
        }
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
      PARKING_RANGE = { from, to, nights: PARKING_LIST.length, days: out };
    }

    // ---- Dostupnost: deterministický text (den-po-dni) ----
    function buildAvailabilityText(list, range) {
      if (!list || list.length === 0 || !range) return '';
      const header = `Rozsah chápeme jako příjezd **${range.from}** a odjezd **${range.to}** ⇒ nocí: **${list.length}** (počítají se noci [from..to) – den odjezdu se neúčtuje).`;
      const lines = list.map(d => {
        if (d.free === null || d.free === undefined) return `• ${d.date}: dostupnost k potvrzení`;
        if (d.free === 0) return `• ${d.date}: plně obsazeno`;
        return `• ${d.date}: volná místa ${d.free} (z ${d.total})`;
      });
      return [header, 'Dostupnost po dnech:', ...lines].join('\n');
    }
    const AVAILABILITY_TEXT = buildAvailabilityText(PARKING_LIST, PARKING_RANGE);

    // ---- OpenAI helpers ----
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

    async function translateIfNeeded(text, userMsgs) {
      if (!TRANSLATE_INSTRUCTIONS) return text;
      const userLangSample = ([...userMsgs].reverse().find(m => m.role === 'user')?.content || '').slice(0, 500);
      const msgs = [
        { role: 'system', content: 'You are a precise translator. Keep meaning and formatting. If source language equals target, return as is.' },
        { role: 'user', content: `User language sample:\n---\n${userLangSample}\n---\nTranslate the following text to the user's language:\n${text}` }
      ];
      return await callOpenAI(msgs);
    }

    // ---- Instrukce (CZ) ----
    const parkingInstructionsCZ = `
Parkoviště je na našem dvoře v ceně 20 eur (500 Kč) za noc. Odkud přijíždíte? Pokud od jihu, tak až zabočíte na naší ulici, zařaďte se do pravého pruhu a tam pak vyčkejte až bude silnice prázdná. Z něj pak kolmo rovnou do našeho průjezdu na dvůr. Ten průjezd je totiž dost úzký (šířka 220 cm) a z krajního pruhu se do něj nedá vjet. Pokud přijíždíte z druhé strany, objeďte radši ještě náš blok. Bude totiž za vámi velký provoz a nebude možnost zajet do průjezdu z protějšího pruhu. Pokud blok objedete, nepojede za vámi skoro nikdo.
Na dvoře/parkovišti, je hlavní vchod.
`.trim();

    // ---- Fotky jako Markdown obrázky ----
    function mediaBlock() {
      if (!Array.isArray(MEDIA) || MEDIA.length === 0) return '';
      const lines = MEDIA.map((m) => {
        const url = new URL(`/${m.src}`, `${base.origin}`).toString();
        const caption = m.caption || '';
        return `![${caption}](${url})`;
      });
      return `\n\n${lines.join('\n')}`;
    }

    // ---- RULES pro AI ----
    const rules = `
You are a multilingual, precise assistant for ${HOTEL.name || 'our hotel'}.
Reply in the user's language. Never invent facts.

IMPORTANT DATE RULE:
- A range "from ... to" means arrival on "from" and departure on "to".
- Nights counted are the half-open interval [from .. to), i.e., days from "from" up to but NOT including "to".

When AVAILABILITY_TEXT is provided, you MUST start your reply by outputting AVAILABILITY_TEXT verbatim.
Then continue naturally (ask for guest name, car plate, arrival time) or proceed with reservation.

PARKING:
- Daily availability = free = total_spots - booked.
- Do not mark the whole range as fully booked unless **every** night in [from..to) has free = 0.
- If the user wants to proceed, ask ONLY: guest name, car plate (SPZ), arrival time HH:mm.
- When the user gives those, WRITE via:
  TOOL: reserveParking {"from_date":"<FROM>","to_date":"<TO>","guest_name":"John Doe","channel":"Direct","car_plate":"ABC1234","arrival_time":"18:30","note":""}
- After successful write, reply: "✅ Reservation recorded. ID: <id>. Price is 20 € / night."
- Do NOT send instructions yourself — the function will append instructions + photos automatically after reservation.

TOOL protocol (strict):
- To read a single day: "TOOL: parking YYYY-MM-DD" (use only when range not pre-fetched).
- To write reservation: "TOOL: reserveParking {...JSON...}"
`.trim();

    // ---- SEED ----
    const seed = [
      { role: 'system', content: rules },
      { role: 'system', content: `HOTEL: ${JSON.stringify(HOTEL)}` },
      { role: 'system', content: `PARSED_RANGE: ${JSON.stringify(parsed.confirmed || null)}` },
      { role: 'system', content: `PARKING_LIST: ${JSON.stringify(PARKING_LIST)}` },
      { role: 'system', content: `AVAILABILITY_TEXT:\n${AVAILABILITY_TEXT}` }
    ];

    // ---- 1. průchod AI ----
    let ai = await callOpenAI([...seed, ...messages]);

    // ---- TOOL požadavek? ----
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
        try { payload = JSON.parse(json); } catch { result = { ok:false, error:'Bad JSON for reserveParking' }; }
        if (!result) {
          payload.fn = 'reserveParking';
          result = await gsPost(payload);
        }

      } else {
        result = { ok:false, error:'unknown tool cmd' };
      }

      const toolMsg = { role: 'system', content: `TOOL-RESULT: ${JSON.stringify(result)}` };
      ai = await callOpenAI([...seed, ...messages, toolMsg]);

      // Po úspěšné rezervaci → instrukce + fotky
      const okReservation = result && result.ok && result.id;
      if (okReservation) {
        const instr = await translateIfNeeded(parkingInstructionsCZ, messages);
        const withMedia = `${ai}\n\n---\n${instr}${mediaBlock()}`;
        return new Response(JSON.stringify({ reply: withMedia }), {
          status: 200, headers: { 'content-type': 'application/json' }
        });
      }
    }

    // Bez TOOLu → běžná odpověď
    return new Response(JSON.stringify({ reply: ai || 'No reply.' }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });

  } catch (err) {
    return new Response(`Function error: ${String(err)}`, {
      status: 500, headers: { 'content-type': 'text/plain' }
    });
  }
};
