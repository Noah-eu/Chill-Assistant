// netlify/functions/chat.js
// OPRAVA: podporuje i zápis "20-24.9[.2025]" (rozsah dnů v jednom měsíci)
// + stabilní rozsah, 0 nocí se už nestane u "20-24.9", správně: 2025-09-20 → 2025-09-24 (4 noci)

const TRANSLATE_INSTRUCTIONS = false; // zapni pokud chceš instrukce překládat do jazyka hosta

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
      const r = await fetch(new URL(path, base.origin), { headers: { 'cache-control': 'no-cache' } });
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
      const txt = await r.text();
      if (!r.ok) throw new Error(`Sheets POST ${r.status}: ${txt}`);
      try { return JSON.parse(txt); } catch { return { ok:false, error:'bad json from sheets', raw: txt }; }
    }

    // ---- Date utils ----
    const toISODate = (d) => d.toISOString().slice(0, 10);
    const fmtISO = (y,m,d) => `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dim = (y,m) => new Date(y, m, 0).getDate();
    const clamp = (y,m,d) => Math.min(d, dim(y,m));

    // === NOVÝ robustní parser ===
    // Pokrývá:
    // 1) DD–DD.MM[.YYYY]  (např. "20-24.9", "20.–24. 9. 2025")
    // 2) DD.MM[.YYYY] ... DD.MM[.YYYY]
    // 3) "lone day" + plné datum (např. "20. až 24.8.2025")
    function parseDatesSmart(text) {
      const now = new Date();
      const CY = now.getFullYear();
      const CM = now.getMonth() + 1;

      const clean = (text || '').trim();

      // 1) DD–DD.MM[.YYYY]
      //    skupiny: d1, d2, m, y?
      const reRangeOneMonth =
        /(^|[^\d])(\d{1,2})\s*[-–]\s*(\d{1,2})\s*[.\s]\s*(\d{1,2})(?:\s*[.\-\/]\s*(\d{2,4}))?(\D|$)/i;
      const rm = clean.match(reRangeOneMonth);
      if (rm) {
        const d1 = Number(rm[2]); const d2 = Number(rm[3]);
        const m  = Number(rm[4]);
        let y = rm[5] ? (rm[5].length === 2 ? (Number(rm[5]) > 50 ? 1900 + Number(rm[5]) : 2000 + Number(rm[5])) : Number(rm[5])) : null;
        if (!y) y = CY;

        const a = { y, mo: m, d: clamp(y, m, Math.min(d1, d2)) };
        const b = { y, mo: m, d: clamp(y, m, Math.max(d1, d2)) };

        // Pokud rok není uveden a měsíc je menší než aktuální, doptáme se jen tehdy,
        // když v celé větě není explicitní "tento měsíc/příští rok" (řešíme jinde),
        // jinak bereme aktuální rok.
        if (!rm[5] && m < CM) {
          const ask =
            `Zadal jste měsíc, který už proběhl. Myslíte spíš **${fmtISO(CY, CM, clamp(CY, CM, a.d))} až ${fmtISO(CY, CM, clamp(CY, CM, b.d))}** (tento měsíc), ` +
            `nebo **${fmtISO(CY+1, m, clamp(CY+1, m, a.d))} až ${fmtISO(CY+1, m, clamp(CY+1, m, b.d))}** (příští rok)?`;
          return { confirmed: null, ask };
        }
        const isoA = fmtISO(a.y, a.mo, a.d);
        const isoB = fmtISO(b.y, b.mo, b.d);
        return { confirmed: { from: isoA, to: isoB }, ask: null };
      }

      // 2) Dvě plná data (DD.MM[.YYYY] ... DD.MM[.YYYY])
      const reFull = /(\d{1,2})\s*[.\-\/]\s*(\d{1,2})(?:\s*[.\-\/]\s*(\d{2,4}))?/g;
      const full = [];
      let m;
      while ((m = reFull.exec(clean)) !== null) {
        let [, d, mo, y] = m;
        let year = y ? (y.length === 2 ? (Number(y) > 50 ? 1900 + Number(y) : 2000 + Number(y)) : Number(y)) : null;
        full.push({ d: Number(d), mo: Number(mo), y: year, hadYear: !!y, index: m.index });
      }
      if (full.length >= 2) {
        const A = full[0], B = full[1];
        const a = { y: A.y ?? CY, mo: A.mo ?? CM, d: clamp(A.y ?? CY, A.mo ?? CM, A.d) };
        const b = { y: B.y ?? (A.y ?? CY), mo: B.mo ?? (A.mo ?? CM), d: clamp(B.y ?? (A.y ?? CY), B.mo ?? (A.mo ?? CM), B.d) };
        const isoA = fmtISO(a.y, a.mo, a.d);
        const isoB = fmtISO(b.y, b.mo, b.d);

        const anyYear = A.hadYear || B.hadYear;
        if (!anyYear && a.mo < CM) {
          const ask = `Zadal jste měsíc, který už proběhl. Myslíte spíš **${fmtISO(CY, CM, clamp(CY, CM, a.d))} až ${fmtISO(CY, CM, clamp(CY, CM, b.d))}** (tento měsíc), `+
                      `nebo **${fmtISO(CY+1, a.mo, clamp(CY+1, a.mo, a.d))} až ${fmtISO(CY+1, b.mo, clamp(CY+1, b.mo, b.d))}** (příští rok)?`;
          return { confirmed: null, ask };
        }
        const from = isoA <= isoB ? isoA : isoB;
        const to   = isoA <= isoB ? isoB : isoA;
        return { confirmed: { from, to }, ask: null };
      }

      // 3) "lone day" + plné datum (např. "20. až 24.8.2025")
      if (full.length === 1) {
        const B = full[0];
        const loneDayRe = /(^|\D)(\d{1,2})\s*[. ]*(?=(?:až|az|to|–|-)\b)/i;
        const left = clean.slice(0, B.index);
        const mm = left.match(loneDayRe);
        if (mm) {
          const d1 = Number(mm[2]);
          const y = B.y ?? CY, mth = B.mo ?? CM;
          const a = { y, mo: mth, d: clamp(y, mth, Math.min(d1, B.d)) };
          const b = { y, mo: mth, d: clamp(y, mth, Math.max(d1, B.d)) };
          if (!B.hadYear && mth < CM) {
            const ask = `Zadal jste měsíc, který už proběhl. Myslíte spíš **${fmtISO(CY, CM, clamp(CY, CM, a.d))} až ${fmtISO(CY, CM, clamp(CY, CM, b.d))}** (tento měsíc), `+
                        `nebo **${fmtISO(CY+1, mth, clamp(CY+1, mth, a.d))} až ${fmtISO(CY+1, mth, clamp(CY+1, mth, b.d))}** (příští rok)?`;
            return { confirmed: null, ask };
          }
          const isoA = fmtISO(a.y, a.mo, a.d);
          const isoB = fmtISO(b.y, b.mo, b.d);
          return { confirmed: { from: isoA, to: isoB }, ask: null };
        }
      }

      return { confirmed: null, ask: null };
    }

    function findLastDatesInHistory(msgs) {
      const re = /(\d{1,2})\s*[.\-\/]\s*(\d{1,2})(?:\s*[.\-\/]\s*(\d{2,4}))?/g;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role !== 'user') continue;
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
      if (/pristi\s+rok/.test(t)) return 'next_year';
      return null;
    }

    const lastUserText = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    let parsed = parseDatesSmart(lastUserText);

    if (!parsed.confirmed) {
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
          const isoA = fmtISO(yA, moA, clamp(yA, moA, dA));
          const isoB = fmtISO(yB, moB, clamp(yB, moB, dB));
          const from = isoA <= isoB ? isoA : isoB;
          const to   = isoA <= isoB ? isoB : isoA;
          parsed = { confirmed: { from, to }, ask: null };
        }
      }
    }

    // ---- Dostupnost: počítáme NOCI (arrival..departure)
    let AVAILABILITY = null;
    if (parsed.confirmed) {
      const { from, to } = parsed.confirmed;
      const out = [];
      const start = new Date(from + 'T00:00:00Z');
      const end   = new Date(to   + 'T00:00:00Z');
      for (let cur = new Date(start); cur < end; cur.setUTCDate(cur.getUTCDate() + 1)) {
        const iso = toISODate(cur);
        try {
          const d = await gsGet({ fn: 'parking', date: iso });
          out.push({ date: iso, ok: !!d.ok, total: d.total_spots ?? null, booked: d.booked ?? null, free: d.free ?? null, note: d.note ?? '' });
        } catch (e) {
          out.push({ date: iso, ok: false, error: String(e) });
        }
      }
      const lines = out.map(d => d.ok
        ? `• ${d.date}: volno ${Math.max(0, Number(d.free))} / ${Number(d.total)}`
        : `• ${d.date}: dostupnost neznámá`);
      const allKnown = out.every(d => d.ok);
      const allFree  = allKnown && out.every(d => Number(d.free) > 0);
      const anyFull  = out.some(d => d.ok && Number(d.free) <= 0);

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

    // ---- extrakce detailů z poslední user zprávy
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

    // ---- OpenAI helper (jen text)
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
        { role: 'user', content: `User language sample:\n---\n${sample}\n---\nTranslate:\n${text}` }
      ];
      return await callOpenAI(msgs);
    }

    const parkingInstructionsCZ = `
Parkoviště je na našem dvoře v ceně 20 eur (500 Kč) za noc. Odkud přijíždíte? Pokud od jihu, tak až zabočíte na naší ulici, zařaďte se do pravého pruhu a tam pak vyčkejte až bude silnice prázdná. Z něj pak kolmo rovnou do našeho průjezdu na dvůr. Ten průjezd je totiž dost úzký (šířka 220 cm) a z krajního pruhu se do něj nedá vjet. Pokud přijíždíte z druhé strany, objeďte radši ještě náš blok. Bude totiž za vámi velký provoz a nebude možnost zajet do průjezdu z protějšího pruhu. Pokud blok objedete, nepojede za vámi skoro nikdo.
Na dvoře/parkovišti je hlavní vchod.
`.trim();

    function mediaBlock() {
      if (!Array.isArray(MEDIA) || MEDIA.length === 0) return '';
      const lines = MEDIA.map((m, i) => `- ${m.caption || `Foto ${i+1}`}: ${new URL(`/${m.src}`, base.origin).toString()}`);
      return `\n\n**Fotky / mapa / animace:**\n${lines.join('\n')}`;
    }

    // === REZERVACE
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
          return new Response(JSON.stringify({ reply }), {
            status: 200, headers: { 'content-type': 'application/json' }
          });
        }

        const err = (result && (result.error || result.raw)) ? String(result.error || result.raw) : 'Unknown error';
        const human =
          /fully booked on/i.test(err)
            ? `Bohužel jeden z dnů je už plně obsazený (${err.replace(/^.*on\s+/i,'')}). Zkusíme jiný termín?`
            : `Nepodařilo se zapsat rezervaci (${err}). Zkontrolujme ještě jednou údaje, případně to zkusím znovu.`;
        return new Response(JSON.stringify({ reply: human }), {
          status: 200, headers: { 'content-type': 'application/json' }
        });
      } catch (e) {
        const msg = String(e);
        return new Response(JSON.stringify({ reply: `Nepodařilo se zapsat rezervaci (${msg}). Můžeme to zkusit znovu, nebo vybrat jiný termín.` }), {
          status: 200, headers: { 'content-type': 'application/json' }
        });
      }
    }

    // === sdělení dostupnosti / vyžádání detailů
    if (AVAILABILITY) {
      return new Response(JSON.stringify({ reply: AVAILABILITY.text }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }

    if (!parsed.confirmed && parsed.ask) {
      return new Response(JSON.stringify({ reply: parsed.ask }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ reply: 'Jak vám mohu pomoci?' }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });

  } catch (err) {
    return new Response(`Function error: ${String(err)}`, {
      status: 500, headers: { 'content-type': 'text/plain' }
    });
  }
};
