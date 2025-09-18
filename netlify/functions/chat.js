// netlify/functions/chat.js
// CHILL Assistant – jednoduchý režim: POUZE formát "DD.MM.–DD.MM.YYYY" (nebo s '-')
// Př.: "20.09.–24.09.2025"  → from=2025-09-20, to=2025-09-24 (den odjezdu se nepočítá)
// - Dostupnost počítá noci cur < to
// - Když host pošle jen jméno/SPZ/čas, vezmeme poslední potvrzený rozsah z historie
// - Po úspěšné rezervaci pošleme instrukce + fotky

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

    // ---------- STRIKTNÍ PARSER ----------
    // Povolen jen formát: "DD.MM.–DD.MM.YYYY" nebo "DD.MM-DD.MM.YYYY"
    // (en-dash U+2013 nebo minus -)
    function parseDatesStrict(text) {
      const t = (text || '').trim();
      //  dd.mm . [–|-] . dd.mm . yyyy
      const re = /(^|.*?\s)\b(\d{2})\.(\d{2})\.\s*[–-]\s*(\d{2})\.(\d{2})\.(\d{4})\b/;
      const m = re.exec(t);
      if (!m) {
        const ask = 'Pro rezervaci parkování mi prosím napište datum **pouze** v tomto formátu:\n\n' +
                    '**DD.MM.–DD.MM.YYYY** (např. **20.09.–24.09.2025**)\n\n' +
                    'Použijte buď pomlčku "-", nebo en-dash "–" mezi dny.';
        return { confirmed: null, ask };
      }
      const d1 = +m[2], m1 = +m[3], d2 = +m[4], m2 = +m[5], y = +m[6];
      const a = { y, mo: m1, d: clamp(y, m1, d1) };
      const b = { y, mo: m2, d: clamp(y, m2, d2) };
      const isoA = fmtISO(a.y, a.mo, a.d);
      const isoB = fmtISO(b.y, b.mo, b.d);
      const from = isoA <= isoB ? isoA : isoB;
      const to   = isoA <= isoB ? isoB : isoA; // den odjezdu (exkluzivní pro smyčku)
      return { confirmed: { from, to }, ask: null };
    }

    // poslední potvrzený rozsah z odpovědi bota („Dostupnost pro **YYYY-MM-DD → YYYY-MM-DD**“)
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

    // ---------- EXTRAKCE DETAILŮ (jméno, SPZ, čas) ----------
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

    const lastUserText = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    let parsed = parseDatesStrict(lastUserText);

    // ---------- DOSTUPNOST (počítáme NOCI: for cur < to) ----------
    let AVAILABILITY = null;
    if (parsed.confirmed) {
      const { from, to } = parsed.confirmed;
      const out = [];
      const start = new Date(from + 'T00:00:00Z');
      const end   = new Date(to   + 'T00:00:00Z'); // 'to' = den odjezdu
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

    const details = extractDetails(messages);

    // ---------- Překladač (jen pro instrukce) ----------
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
    // a) už máme dostupnost i detaily (jméno + SPZ) → rovnou zapiš
    if (AVAILABILITY && AVAILABILITY.allFree && AVAILABILITY.nights > 0 && details && details.guest_name && details.car_plate) {
      // fallback: pokud uživatel neposlal znovu data, vezmeme poslední rozsah z historie
      let from = AVAILABILITY.from, to = AVAILABILITY.to;
      if (!from || !to) {
        const hist = rangeFromHistory(messages);
        if (hist) { from = hist.from; to = hist.to; }
      }

      try {
        const payload = {
          fn: 'reserveParking',
          from_date: from,
          to_date: to,
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

    // b) máme dostupnost, ale chybí detail(y) → vypiš dostupnost a vyžádej si je
    if (AVAILABILITY) {
      return new Response(JSON.stringify({ reply: AVAILABILITY.text }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    // c) nemáme platný formát → vypiš instrukci s požadovaným formátem
    if (!parsed.confirmed && parsed.ask) {
      return new Response(JSON.stringify({ reply: parsed.ask }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    // fallback
    return new Response(JSON.stringify({ reply: 'Pro rezervaci napište prosím datum ve formátu **DD.MM.–DD.MM.YYYY** (např. **20.09.–24.09.2025**).' }), { status: 200, headers: { 'content-type': 'application/json' } });

  } catch (err) {
    return new Response(`Function error: ${String(err)}`, { status: 500, headers: { 'content-type': 'text/plain' } });
  }
};
