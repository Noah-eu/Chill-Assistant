// netlify/functions/chat.js
// CHILL Assistant – parking
// - EU datumy ("20–24.9[.2025]"), den odjezdu se NEPOČÍTÁ (to = departure day, exclusive v cyklu)
// - Po uživatelských detailech bez dat se vezme poslední potvrzený rozsah z historie
// - Rezervace + instrukce + fotky (Markdown obrázky), volitelný překlad

const TRANSLATE_INSTRUCTIONS = true;

export default async (req) => {
  try {
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    // ---------- BODY ----------
    let body = {};
    try { body = await req.json(); } catch { return new Response('Bad JSON body', { status: 400 }); }
    const { messages = [] } = body;

    // ---------- ENV ----------
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SHEETS_API_URL = process.env.SHEETS_API_URL;
    if (!OPENAI_API_KEY) return new Response('Missing OPENAI_API_KEY', { status: 500 });
    if (!SHEETS_API_URL) return new Response('Missing SHEETS_API_URL', { status: 500 });

    // ---------- PUBLIC data ----------
    const base = new URL(req.url);
    async function loadJSON(path) {
      const r = await fetch(new URL(path, base.origin), { headers: { 'cache-control': 'no-cache' } });
      if (!r.ok) throw new Error(`${path} ${r.status}`);
      return await r.json();
    }
    const HOTEL = await loadJSON('/data/hotel.json').catch(() => ({}));
    const MEDIA = await loadJSON('/data/parking_media.json').catch(() => []);

    // ---------- Apps Script ----------
    async function gsGet(params) {
      const url = new URL(SHEETS_API_URL);
      Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
      const r = await fetch(url.toString());
      const txt = await r.text();
      if (!r.ok) throw new Error(`Sheets GET ${r.status}: ${txt}`);
      try { return JSON.parse(txt); } catch { return { ok:false, error:'bad json', raw: txt }; }
    }
    async function gsPost(payload) {
      const r = await fetch(SHEETS_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {})
      });
      const txt = await r.text();
      if (!r.ok) throw new Error(`Sheets POST ${r.status}: ${txt}`);
      try { return JSON.parse(txt); } catch { return { ok:false, error:'bad json from sheets', raw: txt }; }
    }

    // ---------- Date utils ----------
    const toISODate   = (d) => d.toISOString().slice(0, 10);  // UTC yyyy-mm-dd
    const daysInMonth = (y,m) => new Date(y, m, 0).getDate();
    const clamp       = (y,m,d) => Math.min(Math.max(1,d), daysInMonth(y,m));
    const fmtISO      = (y,m,d) => `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;

    // ---------- EU parser ----------
    // Vrací { from: YYYY-MM-DD, to: YYYY-MM-DD } kde "to" = den odjezdu (bez +1).
    function parseDatesSmart(text) {
      const now = new Date();
      const CY = now.getFullYear();
      const CM = now.getMonth() + 1;
      const clean = (text || '').normalize('NFKC').replace(/\s+/g,' ').trim();

      // 1) "DD–DD.MM[.YYYY]"
      let m = /^.*?\b(\d{1,2})\s*[-–]\s*(\d{1,2})\s*[.\-\/ ]\s*(\d{1,2})(?:\s*[.\-\/]\s*(\d{2,4}))?\b.*$/i.exec(clean);
      if (m) {
        let d1 = +m[1], d2 = +m[2], mo = +m[3], y = m[4] ? +m[4] : null;
        if (!y) y = CY;
        if (String(y).length === 2) y = y >= 70 ? 1900 + y : 2000 + y;

        if (!m[4] && mo < CM) {
          const ask = `Zadal jste měsíc, který už proběhl. Myslíte spíš **${fmtISO(CY, CM, clamp(CY, CM, Math.min(d1,d2)))} až ${fmtISO(CY, CM, clamp(CY, CM, Math.max(d1,d2)))}** (tento měsíc), nebo **${fmtISO(CY+1, mo, clamp(CY+1, mo, Math.min(d1,d2))} až ${fmtISO(CY+1, mo, clamp(CY+1, mo, Math.max(d1,d2)))}** (příští rok)? Odpovězte prosím "tento měsíc" nebo "příští rok", případně napište přesná data.`;
          return { confirmed: null, ask };
        }
        const from = fmtISO(y, mo, clamp(y, mo, Math.min(d1,d2)));
        const to   = fmtISO(y, mo, clamp(y, mo, Math.max(d1,d2))); // den odjezdu
        return { confirmed: { from, to }, ask: null };
      }

      // 2) Dvě plná data "DD.MM[.YYYY] ... DD.MM[.YYYY]"
      const reFull = /(\d{1,2})\s*[.\-\/]\s*(\d{1,2})(?:\s*[.\-\/]\s*(\d{2,4}))?/g;
      const list = [];
      let mm;
      while ((mm = reFull.exec(clean)) !== null) {
        let [, d, mo, y] = mm;
        let year = y ? (String(y).length === 2 ? (+y > 50 ? 1900 + +y : 2000 + +y) : +y) : null;
        list.push({ d:+d, mo:+mo, y:year, hadYear:!!y, idx:mm.index });
      }
      if (list.length >= 2) {
        const A = list[0], B = list[1];
        const aY = A.y ?? CY, bY = B.y ?? (A.y ?? CY);
        const aM = A.mo ?? CM, bM = B.mo ?? (A.mo ?? CM);
        const aD = clamp(aY, aM, A.d), bD = clamp(bY, bM, B.d);
        if (!(A.hadYear || B.hadYear) && aM < CM) {
          const ask = `Zadal jste měsíc, který už proběhl. Prosím potvrďte, zda myslíte tento měsíc, nebo příští rok, případně napište přesný rok.`;
          return { confirmed: null, ask };
        }
        const isoA = fmtISO(aY, aM, aD);
        const isoB = fmtISO(bY, bM, bD); // den odjezdu
        const from = isoA <= isoB ? isoA : isoB;
        const to   = isoA <= isoB ? isoB : isoA;
        return { confirmed: { from, to }, ask: null };
      }

      // 3) "20. až 24.8.2025"
      if (list.length === 1) {
        const B = list[0];
        const left = clean.slice(0, B.idx);
        const m2 = /(^|\D)(\d{1,2})\s*[. ]*(?=(?:až|az|to|–|-)\b)/i.exec(left);
        if (m2) {
          const d1 = +m2[2];
          const y = B.y ?? CY, mo = B.mo ?? CM;
          if (!B.hadYear && mo < CM) {
            const ask = `Zadal jste měsíc, který už proběhl. Prosím potvrďte, zda myslíte tento měsíc, nebo příští rok, případně napište přesný rok.`;
            return { confirmed: null, ask };
          }
          const from = fmtISO(y, mo, clamp(y, mo, Math.min(d1, B.d)));
          const to   = fmtISO(y, mo, clamp(y, mo, Math.max(d1, B.d))); // den odjezdu
          return { confirmed: { from, to }, ask: null };
        }
      }
      return { confirmed: null, ask: null };
    }

    // Vytažení posledního potvrzeného rozsahu z HISTORIE („Dostupnost pro **YYYY-MM-DD → YYYY-MM-DD**“)
    function rangeFromHistory(msgs) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (!m || !m.content) continue;
        const t = String(m.content);
        const rx = /Dostupnost pro \*\*(\d{4}-\d{2}-\d{2})\s*→\s*(\d{4}-\d{2}-\d{2})\*\*/;
        const mm = rx.exec(t);
        if (mm) return { from: mm[1], to: mm[2] };
      }
      return null;
    }

    // Pomocné pro „tento měsíc / příští rok“
    function findLastDatesInHistory(msgs) {
      const re = /(\d{1,2})\s*[.\-\/]\s*(\d{1,2})(?:\s*[.\-\/]\s*(\d{2,4}))?/g;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]; if (m.role !== 'user') continue;
        re.lastIndex = 0;
        const t = m.content || '';
        const h1 = re.exec(t); if (!h1) continue;
        const h2 = re.exec(t);
        const d1 = Number(h1[1]), mo1 = Number(h1[2]), y1 = h1[3] ? Number(h1[3]) : null;
        let d2 = d1, mo2 = mo1, y2 = y1;
        if (h2) { d2 = Number(h2[1]); mo2 = Number(h2[2]); y2 = h2[3] ? Number(h2[3]) : y1; }
        return { d1, mo1, y1, d2, mo2, y2 };
      }
      return null;
    }
    function detectChoice(text) {
      const t = (text || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'');
      if (/tento\s+mesic/.test(t)) return 'this_month';
      if (/pristi\s+rok/.test(t))  return 'next_year';
      return null;
    }

    const lastUserText = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    let parsed = parseDatesSmart(lastUserText);

    if (!parsed.confirmed) {
      // 1) „tento měsíc / příští rok“
      const choice = detectChoice(lastUserText);
      if (choice) {
        const last = findLastDatesInHistory(messages);
        if (last) {
          const now = new Date();
          const CY = now.getFullYear();
          const CM = now.getMonth() + 1;
          let yA, yB, moA, moB, dA, dB;
          if (choice === 'this_month') {
            yA = CY; yB = CY; moA = CM; moB = CM; dA = last.d1; dB = last.d2;
          } else {
            yA = (last.y1 ?? CY) + 1; yB = (last.y2 ?? last.y1 ?? CY) + 1;
            moA = last.mo1; moB = last.mo2; dA = last.d1; dB = last.d2;
          }
          const from = fmtISO(yA, moA, clamp(yA, moA, dA));
          const to   = fmtISO(yB, moB, clamp(yB, moB, dB));
          parsed = { confirmed: { from, to }, ask: null };
        }
      }
      // 2) nic? → vezmi poslední potvrzený rozsah z historie
      if (!parsed.confirmed) {
        const r = rangeFromHistory(messages);
        if (r) parsed = { confirmed: r, ask: null };
      }
    }

    // ---------- Dostupnost (počítáme NOCI: for cur < end) ----------
    let AVAILABILITY = null;
    if (parsed.confirmed) {
      const { from, to } = parsed.confirmed;
      const out = [];
      const start = new Date(from + 'T00:00:00Z');
      const end   = new Date(to   + 'T00:00:00Z'); // 'to' = den odjezdu, sem už bez +1
      for (let cur = new Date(start); cur < end; cur.setUTCDate(cur.getUTCDate() + 1)) {
        const iso = toISODate(cur);
        try {
          const d = await gsGet({ fn: 'parking', date: iso });
          if (!d || !d.ok || typeof d.total_spots === 'undefined') {
            out.push({ date: iso, ok: false });
          } else {
            out.push({
              date: iso, ok: true,
              total: Number(d.total_spots) || 0,
              booked: Number(d.booked) || 0,
              free: Math.max(0, Number(d.free) || 0),
              note: String(d.note || '')
            });
          }
        } catch (e) { out.push({ date: iso, ok: false, error: String(e) }); }
      }
      const lines = out.map(d => d.ok
        ? `• ${d.date}: volno ${d.free} / ${d.total}${d.note ? ` (${d.note})` : ''}`
        : `• ${d.date}: dostupnost neznámá`);
      const allKnown = out.every(d => d.ok);
      const allFree  = allKnown && out.every(d => d.free > 0);
      const anyFull  = out.some(d => d.ok && d.free <= 0);

      AVAILABILITY = {
        from, to, nights: out.length, days: out, allKnown, allFree, anyFull,
        text:
`Dostupnost pro **${from} → ${to}** (nocí: ${out.length}, den odjezdu se nepočítá)
${lines.join('\n')}
${allFree
  ? '\nVšechny noci mají volno. Pošlete prosím jméno hosta, SPZ a čas příjezdu (HH:mm).'
  : anyFull
    ? '\nNěkteré noci jsou plné. Můžeme hledat jiný termín nebo doporučit alternativy (mrparkit.com).'
    : '\nU některých nocí chybí data, dostupnost je potřeba potvrdit.'}`
      };
    }

    // ---------- Extrakce detailů ----------
    function extractDetails(msgs) {
      const t = ([...msgs].reverse().find(m => m.role === 'user')?.content || '').trim();
      if (!t) return null;
      const timeMatch = t.match(/(\b\d{1,2}[:.]\d{2}\b)/);
      const arrival = timeMatch ? timeMatch[1].replace('.', ':') : null;
      const parts = t.split(/[,;\n]/).map(s => s.trim()).filter(Boolean);

      let plate = null;
      for (const p of parts) {
        const c = p.replace(/\s+/g,'');
        if (/^[A-Za-z0-9-]{5,}$/.test(c)) { plate = c.toUpperCase(); break; }
      }
      let name = null;
      for (const p of parts) {
        const clean = p.replace(/\s+/g,' ').trim();
        if (arrival && clean.includes(arrival)) continue;
        if (plate && clean.replace(/\s+/g,'').toUpperCase() === plate) continue;
        if (clean.length >= 3) { name = clean; break; }
      }
      if (!name && !plate && !arrival) return null;
      return { guest_name: name || '', car_plate: plate || '', arrival_time: arrival || '' };
    }
    const details = extractDetails(messages);

    // ---------- OpenAI helper (pro překlad) ----------
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
    async function translateIfNeeded(text, userMsgs) {
      if (!TRANSLATE_INSTRUCTIONS) return text;
      const sample = ([...userMsgs].reverse().find(m => m.role === 'user')?.content || '').slice(0, 500);
      const msgs = [
        { role: 'system', content: 'You are a precise translator. Keep meaning and formatting. If source equals target language, return as is.' },
        { role: 'user', content: `User language sample:\n---\n${sample}\n---\nTranslate:\n${text}` }
      ];
      return await callOpenAI(msgs);
    }

    // ---------- Instrukce + média ----------
    const parkingInstructionsCZ = `
Parkoviště je na našem dvoře v ceně 20 eur (500 Kč) za noc. Odkud přijíždíte? Pokud od jihu, tak až zabočíte na naší ulici, zařaďte se do pravého pruhu a tam pak vyčkejte až bude silnice prázdná. Z něj pak kolmo rovnou do našeho průjezdu na dvůr. Ten průjezd je totiž dost úzký (šířka 220 cm) a z krajního pruhu se do něj nedá vjet. Pokud přijíždíte z druhé strany, objeďte radši ještě náš blok. Bude totiž za vámi velký provoz a nebude možnost zajet do průjezdu z protějšího pruhu. Pokud blok objedete, nepojede za vámi skoro nikdo.
Na dvoře/parkovišti je hlavní vchod.
`.trim();

    function mediaBlock() {
      if (!Array.isArray(MEDIA) || MEDIA.length === 0) return '';
      const lines = MEDIA.map((m, i) => {
        const url = new URL(`/${m.src}`, base.origin).toString();
        const caption = m.caption || `Foto ${i+1}`;
        return `![${caption}](${url})`;
      });
      return `\n\n**Fotky / mapa / animace:**\n${lines.join('\n')}`;
    }

    // ---------- Rezervace ----------
    if (AVAILABILITY && AVAILABILITY.allFree && AVAILABILITY.nights > 0 && details && details.guest_name && details.car_plate) {
      try {
        const payload = {
          fn: 'reserveParking',
          from_date: AVAILABILITY.from,
          to_date: AVAILABILITY.to,
          guest_name: details.guest_name,
          channel: 'Direct',
          car_plate: details.car_plate,
          arrival_time: details.arrival_time || '',
          note: ''
        };
        const result = await gsPost(payload);

        if (result && result.ok && result.id) {
          const instr = await translateIfNeeded(parkingInstructionsCZ, messages);
          const reply =
`✅ Rezervace zapsána. ID: ${result.id}. Cena je 20 € / noc.
Termín: ${payload.from_date} → ${payload.to_date}
Host: ${payload.guest_name}, SPZ: ${payload.car_plate}, příjezd: ${payload.arrival_time || 'neuvedeno'}

${instr}${mediaBlock()}`;
          return new Response(JSON.stringify({ reply }), { status: 200, headers: { 'content-type': 'application/json' } });
        }

        const err = (result && (result.error || result.raw)) ? String(result.error || result.raw) : 'Unknown error';
        const human =
          /fully booked on/i.test(err)
            ? `Bohužel jeden z dnů je už plně obsazený (${err.replace(/^.*on\s+/i,'')}). Zkusíme jiný termín?`
            : `Nepodařilo se zapsat rezervaci (${err}). Zkontrolujme ještě jednou údaje, případně to zkusím znovu.`;
        return new Response(JSON.stringify({ reply: human }), { status: 200, headers: { 'content-type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ reply: `Nepodařilo se zapsat rezervaci (${String(e)}). Zkusíme to znovu, nebo vybereme jiný termín?` }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }

    // ---------- Výstup dostupnosti / dotaz ----------
    if (AVAILABILITY) {
      return new Response(JSON.stringify({ reply: AVAILABILITY.text }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (!parsed.confirmed && parsed.ask) {
      return new Response(JSON.stringify({ reply: parsed.ask }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    return new Response(JSON.stringify({ reply: 'Jak vám mohu pomoci?' }), { status: 200, headers: { 'content-type': 'application/json' } });

  } catch (err) {
    return new Response(`Function error: ${String(err)}`, { status: 500, headers: { 'content-type': 'text/plain' } });
  }
};
