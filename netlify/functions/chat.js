// netlify/functions/chat.js
// - Smart parsování dat + rozřešení volby "tento měsíc" / "příští rok" z předchozí zprávy
// - Čte denní kapacity z Apps Script (GET fn=parking&date=YYYY-MM-DD)
// - Rozsah nocí je [from .. to) => den odjezdu se NEpočítá
// - Deterministický přehled dostupnosti (AI jen hezky podá text)
// - Zápis rezervace (POST fn=reserveParking {...})
// - Po úspěchu hned přidá CZ instrukce + linky na fotky z /data/parking_media.json
// - Volitelně přeloží instrukce do jazyka uživatele

const TRANSLATE_INSTRUCTIONS = false; // chceš-li automatický překlad instrukcí do jazyka hosta, dej true

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

    // ---- PUBLIC DATA ----
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
    const toISODate   = (d) => d.toISOString().slice(0, 10);
    const fmtISO      = (y,m,d) => `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const daysInMonth = (y,m) => new Date(y, m, 0).getDate();
    const clampDay    = (y,m,d) => Math.min(d, daysInMonth(y,m));

    // 1) klasické chytré čtení datumu z textu (vrací from/to nebo ask)
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

      // pokud měsíc už proběhl a rok chyběl → doptat se
      if (!A.hadYear && Aa.mo < CM) {
        const nextYearA   = fmtISO(CY + 1, Aa.mo, clampDay(CY+1, Aa.mo, Aa.d));
        const nextYearB   = fmtISO(CY + 1, Bb.mo, clampDay(CY+1, Bb.mo, Bb.d));
        const thisMonthA  = fmtISO(CY, CM, clampDay(CY, CM, Aa.d));
        const thisMonthB  = fmtISO(CY, CM, clampDay(CY, CM, Bb.d));
        const ask = `Zadal jste měsíc, který už proběhl. Myslíte spíš **${thisMonthA} až ${thisMonthB}** (tento měsíc), nebo **${nextYearA} až ${nextYearB}** (příští rok)? Odpovězte prosím "tento měsíc" nebo "příští rok", případně napište přesná data.`;
        return { confirmed: null, ask, base: { A: Aa, B: Bb, Araw: A, Braw: B } };
      }

      const from = isoA <= isoB ? isoA : isoB;
      const to   = isoA <= isoB ? isoB : isoA;
      return { confirmed: { from, to }, ask: null };
    }

    // 2) najdi v historii poslední zprávu uživatele, kde jsou kalendářní tvary (pro rozřešení volby)
    function findLastDatePatternInHistory(msgs) {
      const re = /(\d{1,2})\s*[.\-\/]\s*(\d{1,2})(?:\s*[.\-\/]\s*(\d{2,4}))?/g;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role !== 'user') continue;
        const text = m.content || '';
        re.lastIndex = 0;
        const hit1 = re.exec(text);
        if (!hit1) continue;
        const hit2 = re.exec(text); // druhé datum, pokud je
        const d1 = Number(hit1[1]), mo1 = Number(hit1[2]), y1 = hit1[3] ? Number(hit1[3]) : null;
        let d2 = d1, mo2 = mo1, y2 = y1;
        if (hit2) {
          d2 = Number(hit2[1]); mo2 = Number(hit2[2]); y2 = hit2[3] ? Number(hit2[3]) : y1;
        }
        return { d1, mo1, y1, d2, mo2, y2, hadYear: !!y1 };
      }
      return null;
    }

    // 3) zjisti, zda poslední zpráva je volba "tento měsíc" / "příští rok"
    function detectChoice(text) {
      const t = (text || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'');
      if (/tento\s+mesic/.test(t)) return 'this_month';
      if (/pristi\s+rok/.test(t) || /příští\s+rok/.test(text || '')) return 'next_year';
      return null;
    }

    // ---- z poslední user zprávy / historie sestav finální rozsah ----
    const lastUserText = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    let parsed = parseDatesSmart(lastUserText);

    if (!parsed.confirmed) {
      const choice = detectChoice(lastUserText);
      if (choice) {
        const baseInfo = findLastDatePatternInHistory(messages);
        if (baseInfo) {
          const now = new Date();
          const CY = now.getFullYear();
          const CM = now.getMonth() + 1;
          let yA, yB, moA, moB, dA, dB;
          if (choice === 'this_month') {
            // stejné dny, ale měsíc = aktuální, rok = aktuální
            yA = CY; yB = CY; moA = CM; moB = CM; dA = baseInfo.d1; dB = baseInfo.d2;
          } else {
            // příští rok: stejné dny i měsíc(y), rok +1 (pokud nebyl uveden)
            yA = (baseInfo.y1 ?? CY) + 1;
            yB = (baseInfo.y2 ?? baseInfo.y1 ?? CY) + 1;
            moA = baseInfo.mo1; moB = baseInfo.mo2;
            dA = baseInfo.d1; dB = baseInfo.d2;
          }
          const isoA = fmtISO(yA, moA, clampDay(yA, moA, dA));
          const isoB = fmtISO(yB, moB, clampDay(yB, moB, dB));
          const from = isoA <= isoB ? isoA : isoB;
          const to   = isoA <= isoB ? isoB : isoA;
          parsed = { confirmed: { from, to }, ask: null };
        }
      }
    }

    // ---- AVAILABILITY [from .. to) ----
    let AVAILABILITY = null;
    if (parsed.confirmed) {
      const { from, to } = parsed.confirmed;

      const out = [];
      const start = new Date(from + 'T00:00:00Z');
      const end   = new Date(to   + 'T00:00:00Z'); // exkluzivně – den odjezdu nepočítáme

      for (let cur = new Date(start); cur < end; cur.setUTCDate(cur.getUTCDate() + 1)) {
        const dISO = toISODate(cur);
        try {
          const day = await gsGet({ fn: 'parking', date: dISO });
          out.push({ date: dISO, ok: !!day.ok, total: day.total_spots ?? null, booked: day.booked ?? null, free: day.free ?? null, note: day.note ?? '' });
        } catch (e) {
          out.push({ date: dISO, ok: false, error: String(e) });
        }
      }

      const lines = out.map(d => {
        if (!d.ok) return `• ${d.date}: dostupnost neznámá`;
        return `• ${d.date}: volno ${Math.max(0, Number(d.free))} (celkem ${Number(d.total)}, obsazeno ${Number(d.booked)})`;
      });
      const anyFull     = out.some(d => d.ok && Number(d.free) <= 0);
      const allKnown    = out.every(d => d.ok);
      const allHaveFree = allKnown && out.every(d => Number(d.free) > 0);

      let header = `Dostupnost pro **${from} → ${to}** (nocí: ${out.length}, den odjezdu se nepočítá):\n${lines.join('\n')}`;
      let tail;
      if (allHaveFree) {
        tail = `\n\nVšechny noci mají volno. Chcete rezervovat? Prosím pošlete:\n- jméno hosta\n- SPZ vozidla\n- čas příjezdu (HH:mm)`;
      } else if (anyFull) {
        tail = `\n\nNěkteré noci jsou plně obsazené. Můžeme hledat jiný termín, nebo zkusit alternativy (např. mrparkit.com).`;
      } else {
        tail = `\n\nU některých nocí nemám potvrzená data – dostupnost bude potřeba ještě ověřit.`;
      }

      AVAILABILITY = {
        from, to,
        nights: out.length,
        days: out,
        allHaveFree, anyFull,
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
      const sample = ([...userMsgs].reverse().find(m => m.role === 'user')?.content || '').slice(0, 500);
      const msgs = [
        { role: 'system', content: 'You are a precise translator. Keep meaning and formatting. If source equals target language, return as is.' },
        { role: 'user', content: `User language sample:\n---\n${sample}\n---\nTranslate the following:\n${text}` }
      ];
      return await callOpenAI(msgs);
    }

    // ---- Instrukce k parkování (CZ) ----
    const parkingInstructionsCZ = `
Parkoviště je na našem dvoře v ceně 20 eur (500 Kč) za noc. Odkud přijíždíte? Pokud od jihu, tak až zabočíte na naší ulici, zařaďte se do pravého pruhu a tam pak vyčkejte až bude silnice prázdná. Z něj pak kolmo rovnou do našeho průjezdu na dvůr. Ten průjezd je totiž dost úzký (šířka 220 cm) a z krajního pruhu se do něj nedá vjet. Pokud přijíždíte z druhé strany, objeďte radši ještě náš blok. Bude totiž za vámi velký provoz a nebude možnost zajet do průjezdu z protějšího pruhu. Pokud blok objedete, nepojede za vámi skoro nikdo.
Na dvoře/parkovišti je hlavní vchod.
`.trim();

    function mediaBlock() {
      if (!Array.isArray(MEDIA) || MEDIA.length === 0) return '';
      const lines = MEDIA.map((m, i) => `- ${m.caption || `Foto ${i+1}`}: ${new URL(`/${m.src}`, `${base.origin}`).toString()}`);
      return `\n\n**Fotky / mapa / animace:**\n${lines.join('\n')}`;
    }

    // ---- RULES pro AI ----
    const rules = `
You are a multilingual, precise assistant for ${HOTEL.name || 'our hotel'}. Reply in the user's language.

DATES:
- Ranges are hotel nights in a half-open interval [arrival .. departure). Do NOT count the departure day.

AVAILABILITY:
- If AVAILABILITY is provided, trust it and read it aloud; do not invent numbers.
- Start by restating ISO dates and the number of nights.
- If AVAILABILITY.allHaveFree = true → ask ONLY for: guest name, car plate, arrival time (HH:mm).
- If any night is full → say which and offer alternatives.

TOOL to write reservation:
TOOL: reserveParking {"from_date":"<FROM>","to_date":"<TO>","guest_name":"John Doe","channel":"Direct","car_plate":"ABC1234","arrival_time":"18:30","note":""}

After TOOL-RESULT ok → say: "✅ Rezervace zapsána. ID: <id>. Cena je 20 € / noc."
(System will append parking instructions + photo links automatically.)
`.trim();

    const seed = [
      { role: 'system', content: rules },
      { role: 'system', content: `HOTEL: ${JSON.stringify(HOTEL)}` },
      { role: 'system', content: `AVAILABILITY_TEXT: ${AVAILABILITY ? AVAILABILITY.text : ''}` },
      { role: 'system', content: `RANGE_META: ${JSON.stringify(AVAILABILITY ? { from: AVAILABILITY.from, to: AVAILABILITY.to, nights: AVAILABILITY.nights, allHaveFree: AVAILABILITY.allHaveFree } : null)}` }
    ];

    // Pokud jsme uživatelovi dřív poslali "ask", ale teď nemáme confirmed a není choice,
    // rovnou mu to "ask" zopakujeme (lepší UX).
    if (!parsed.confirmed && parsed.ask) {
      return new Response(JSON.stringify({ reply: parsed.ask }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }

    // 1. průchod AI (s už předpočítaným textem dostupnosti)
    let ai = await callOpenAI([...seed, ...messages]);

    // Pokud AI chce TOOL (zápis rezervace)
    const mTool = /^TOOL:\s*(.+)$/im.exec(ai || '');
    if (mTool) {
      const cmd = (mTool[1] || '').trim();
      let result;

      if (/^reserveParking\s+/i.test(cmd)) {
        const json = cmd.replace(/^reserveParking\s+/i, '').trim();
        let payload;
        try { payload = JSON.parse(json); } catch { result = { ok:false, error:'Bad JSON for reserveParking' }; }
        if (!result) { payload.fn = 'reserveParking'; result = await gsPost(payload); }
      } else {
        result = { ok:false, error:'unknown tool cmd' };
      }

      const toolMsg = { role: 'system', content: `TOOL-RESULT: ${JSON.stringify(result)}` };
      ai = await callOpenAI([...seed, ...messages, toolMsg]);

      if (result && result.ok && result.id) {
        const instr = await translateIfNeeded(parkingInstructionsCZ, messages);
        const withMedia = `${ai}\n\n---\n${instr}${mediaBlock()}`;
        return new Response(JSON.stringify({ reply: withMedia }), {
          status: 200, headers: { 'content-type': 'application/json' }
        });
      }
    }

    // Bez TOOLu → vrať odpověď (nebo aspoň dostupnost / výzvu k upřesnění)
    const fallback = AVAILABILITY ? AVAILABILITY.text : (parsed.ask || 'Jak vám mohu pomoci?');
    return new Response(JSON.stringify({ reply: ai || fallback }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });

  } catch (err) {
    return new Response(`Function error: ${String(err)}`, {
      status: 500, headers: { 'content-type': 'text/plain' }
    });
  }
};
