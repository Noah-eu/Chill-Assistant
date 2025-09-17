// netlify/functions/chat.js
// - Smart parsování dat (řeší i minulý měsíc bez roku)
// - Čte kapacitu z Apps Script (GET fn=parking&date=YYYY-MM-DD)
// - Rozsah [from .. to) = den odjezdu se NEpočítá
// - Deterministická dostupnost (žádné hádání AI)
// - Zápis rezervace (POST fn=reserveParking {...})
// - Po úspěšné rezervaci přidá CZ instrukce + fotky z /data/parking_media.json
// - (Volitelně) umí překládat instrukce do jazyka uživatele

const TRANSLATE_INSTRUCTIONS = false; // přepni na true, chceš-li překládat

export default async (req) => {
  try {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // ---- body ----
    let body = {};
    try { body = await req.json(); } catch { return new Response('Bad JSON body', { status: 400 }); }
    const { messages = [] } = body;

    // ---- env ----
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SHEETS_API_URL = process.env.SHEETS_API_URL;
    if (!OPENAI_API_KEY) return new Response('Missing OPENAI_API_KEY', { status: 500 });
    if (!SHEETS_API_URL) return new Response('Missing SHEETS_API_URL', { status: 500 });

    // ---- public data ----
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

    // ---- date utils ----
    const toISODate  = (d) => d.toISOString().slice(0, 10);
    const fmtISO     = (y,m,d) => `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const daysInMonth= (y,m) => new Date(y, m, 0).getDate();
    const clampDay   = (y,m,d) => Math.min(d, daysInMonth(y,m));

    // smart parser: "20.-25.9.", "17-19.8", "12.9.2025"…
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

      // pokud neuvedl rok a měsíc by už proběhl → doptat se
      if (!A.hadYear && Aa.mo < CM) {
        const nextYearA   = fmtISO(CY + 1, Aa.mo, clampDay(CY+1, Aa.mo, Aa.d));
        const nextYearB   = fmtISO(CY + 1, Bb.mo, clampDay(CY+1, Bb.mo, Bb.d));
        const thisMonthA  = fmtISO(CY, CM, clampDay(CY, CM, Aa.d));
        const thisMonthB  = fmtISO(CY, CM, clampDay(CY, CM, Bb.d));
        const ask = `Zadal jste měsíc, který už proběhl. Myslíte spíš **${thisMonthA} až ${thisMonthB}** (tento měsíc), nebo **${nextYearA} až ${nextYearB}** (příští rok)? Odpovězte prosím "tento měsíc" nebo "příští rok", případně napište přesná data.`;
        return { confirmed: null, ask };
      }

      const from = isoA <= isoB ? isoA : isoB;
      const to   = isoA <= isoB ? isoB : isoA;
      return { confirmed: { from, to }, ask: null };
    }

    // poslední user text → pokus vyčíst rozsah
    const lastUserText = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    const parsed = parseDatesSmart(lastUserText);

    if (parsed.ask) {
      return new Response(JSON.stringify({ reply: parsed.ask }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }

    // ---- přednačtení dostupnosti [from .. to) (den odjezdu se NEzapočítá) ----
    let AVAILABILITY = null;
    if (parsed.confirmed) {
      const { from, to } = parsed.confirmed;

      const out = [];
      const start = new Date(from + 'T00:00:00Z');
      const end   = new Date(to   + 'T00:00:00Z'); // exkluzivní

      for (let cur = new Date(start); cur < end; cur.setUTCDate(cur.getUTCDate() + 1)) {
        const dISO = toISODate(cur);
        try {
          const day = await gsGet({ fn: 'parking', date: dISO });
          out.push({ date: dISO, ok: !!day.ok, total: day.total_spots ?? null, booked: day.booked ?? null, free: day.free ?? null, note: day.note ?? '' });
        } catch (e) {
          out.push({ date: dISO, ok: false, error: String(e) });
        }
      }

      // deterministický text
      const lines = out.map(d => {
        if (!d.ok) return `• ${d.date}: dostupnost neznámá`;
        return `• ${d.date}: volná místa ${Math.max(0, Number(d.free))} (celkem ${Number(d.total)}, obsazená ${Number(d.booked)})`;
        });
      const anyFull = out.some(d => d.ok && Number(d.free) <= 0);
      const allKnown = out.every(d => d.ok);
      const allHaveFree = allKnown && out.every(d => Number(d.free) > 0);

      let header = `Dostupnost pro **${from} → ${to}** (počítají se noci **${out.length}**: dny příjezdu až před odjezdem):\n` + lines.join('\n');

      let tail;
      if (allHaveFree) {
        tail = `\n\nVšechny noci mají volno. Chcete rezervovat? Prosím pošlete:\n- jméno hosta\n- SPZ vozidla\n- doporučený čas příjezdu (HH:mm)`;
      } else if (anyFull) {
        tail = `\n\nNěkteré noci jsou plně obsazené. Můžeme hledat jiný termín, nebo zkusit alternativy (např. mrparkit.com).`;
      } else {
        tail = `\n\nU některých nocí nemám potvrzená data – dostupnost bude potřeba ještě ověřit.`;
      }

      AVAILABILITY = {
        from, to,
        nights: out.length,
        days: out,
        allHaveFree,
        anyFull,
        text: header + tail
      };
    }

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

    // ---- Instrukce k parkování (CZ) – přesně podle zadání ----
    const parkingInstructionsCZ = `
Parkoviště je na našem dvoře v ceně 20 eur (500 Kč) za noc. Odkud přijíždíte? Pokud od jihu, tak až zabočíte na naší ulici, zařaďte se do pravého pruhu a tam pak vyčkejte až bude silnice prázdná. Z něj pak kolmo rovnou do našeho průjezdu na dvůr. Ten průjezd je totiž dost úzký (šířka 220 cm) a z krajního pruhu se do něj nedá vjet. Pokud přijíždíte z druhé strany, objeďte radši ještě náš blok. Bude totiž za vámi velký provoz a nebude možnost zajet do průjezdu z protějšího pruhu. Pokud blok objedete, nepojede za vámi skoro nikdo.
Na dvoře/parkovišti, je hlavní vchod.
`.trim();

    function mediaBlock() {
      if (!Array.isArray(MEDIA) || MEDIA.length === 0) return '';
      const lines = MEDIA.map((m, i) => `- ${m.caption || `Foto ${i+1}`}: ${new URL(`/${m.src}`, `${base.origin}`).toString()}`);
      return `\n\n**Fotky / mapa / animace:**\n${lines.join('\n')}`;
    }

    // ---- RULES pro AI – AI jen "verbalizuje" předpřipravená fakta ----
    const rules = `
You are a multilingual, precise assistant for ${HOTEL.name || 'our hotel'}. Reply in the user's language.

DATES:
- Ranges are hotel-nights in a half-open interval [arrival .. departure), i.e., do NOT count the departure day.

AVAILABILITY:
- When AVAILABILITY is present, read and trust it. Never contradict it.
- Start by restating the ISO dates and number of nights.
- Then show per-day availability as given in AVAILABILITY_TEXT (do not invent).
- If AVAILABILITY.allHaveFree = true → ask ONLY for: guest name, car plate, arrival time (HH:mm).
- If any night is fully booked → say which nights are full and offer alternatives.

TOOLS:
- To write a reservation, use exactly:
  TOOL: reserveParking {"from_date":"<FROM>","to_date":"<TO>","guest_name":"John Doe","channel":"Direct","car_plate":"ABC1234","arrival_time":"18:30","note":""}

AFTER TOOL-RESULT:
- If write ok → say: "✅ Rezervace zapsána. ID: <id>. Cena je 20 € / noc."
- The system will append parking instructions and photo links automatically.
`.trim();

    // seed zprávy
    const seed = [
      { role: 'system', content: rules },
      { role: 'system', content: `HOTEL: ${JSON.stringify(HOTEL)}` },
      { role: 'system', content: `AVAILABILITY_TEXT: ${AVAILABILITY ? AVAILABILITY.text : ''}` },
      { role: 'system', content: `RANGE_META: ${JSON.stringify(AVAILABILITY ? { from: AVAILABILITY.from, to: AVAILABILITY.to, nights: AVAILABILITY.nights, allHaveFree: AVAILABILITY.allHaveFree } : null)}` }
    ];

    // první průchod
    let ai = await callOpenAI([...seed, ...messages]);

    // pokud AI požádá o TOOL
    const mTool = /^TOOL:\s*(.+)$/im.exec(ai || '');
    if (mTool) {
      const cmd = (mTool[1] || '').trim();
      let result;

      if (/^reserveParking\s+/i.test(cmd)) {
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

      // úspěšná rezervace → přidej instrukce + fotky
      if (result && result.ok && result.id) {
        const instr = await translateIfNeeded(parkingInstructionsCZ, messages);
        const withMedia = `${ai}\n\n---\n${instr}${mediaBlock()}`;
        return new Response(JSON.stringify({ reply: withMedia }), {
          status: 200, headers: { 'content-type': 'application/json' }
        });
      }
    }

    // bez TOOLu → vrať běžnou odpověď
    return new Response(JSON.stringify({ reply: ai || (AVAILABILITY ? AVAILABILITY.text : 'Jak vám mohu pomoci?') }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });

  } catch (err) {
    return new Response(`Function error: ${String(err)}`, {
      status: 500, headers: { 'content-type': 'text/plain' }
    });
  }
};
