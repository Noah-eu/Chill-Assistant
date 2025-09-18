// netlify/functions/chat.js
// Strictní formát dat: "DD.MM.–DD.MM.YYYY" (nebo '-')
// Př.: "20.09.–24.09.2025" → from=2025-09-20, to=2025-09-24 (nocí: 4)
// Verze s "měkkým pádem": NIKDY 500; vždy vrací JSON s chybou k zobrazení.

const TRANSLATE_INSTRUCTIONS = true;

export default async (req) => {
  // helper na jednotné OK odpovědi
  const ok = (reply) => new Response(JSON.stringify({ reply }), {
    status: 200, headers: { 'content-type': 'application/json' }
  });
  // helper na uživatelskou chybovou zprávu
  const userErr = (msg) => ok(`⚠️ ${msg}`);

  try {
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    // ---------- BODY ----------
    let body = {};
    try { body = await req.json(); } catch { return new Response('Bad JSON body', { status: 400 }); }
    const { messages = [] } = body;

    // ---------- ENV ----------
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SHEETS_API_URL = process.env.SHEETS_API_URL;
    if (!OPENAI_API_KEY) return userErr('Server: chybí OPENAI_API_KEY.');
    if (!SHEETS_API_URL) return userErr('Server: chybí SHEETS_API_URL.');

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
      try {
        const url = new URL(SHEETS_API_URL);
        Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
        const r = await fetch(url.toString(), { redirect: 'follow' });
        const txt = await r.text();
        if (!r.ok) return { ok:false, error:`Sheets GET ${r.status}`, raw: txt };
        try { return JSON.parse(txt); } catch { return { ok:false, error:'Bad JSON from Sheets GET', raw: txt }; }
      } catch (e) { return { ok:false, error:String(e) }; }
    }
    async function gsPost(payload) {
      try {
        const r = await fetch(SHEETS_API_URL, {
          method: 'POST',
          redirect: 'follow',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload || {})
        });
        const txt = await r.text();
        if (!r.ok) return { ok:false, error:`Sheets POST ${r.status}`, raw: txt };
        try { return JSON.parse(txt); } catch { return { ok:false, error:'Bad JSON from Sheets POST', raw: txt }; }
      } catch (e) { return { ok:false, error:String(e) }; }
    }

    // ---------- Date utils ----------
    const toISODate   = (d) => d.toISOString().slice(0, 10);
    const daysInMonth = (y,m) => new Date(y, m, 0).getDate();
    const clamp       = (y,m,d) => Math.min(Math.max(1,d), daysInMonth(y,m));
    const fmtISO      = (y,m,d) => `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;

    // ---------- STRIKTNÍ PARSER ----------
    function parseDatesStrict(text) {
      const t = (text || '').trim();
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
      const to   = isoA <= isoB ? isoB : isoA; // den odjezdu (exkluzivní)
      return { confirmed: { from, to }, ask: null };
    }

    // poslední potvrzený rozsah z historie: „Dostupnost pro **YYYY-MM-DD → YYYY-MM-DD**“
    function rangeFromHistory(msgs) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]; if (!m || !m.content) continue;
        const mm = /Dostupnost pro \*\*(\d{4}-\d{2}-\d{2})\s*→\s*(\d{4}-\d{2}-\d{2})\*\*/.exec(String(m.content));
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

    // ---------- Překladač (jen pro instrukce) ----------
    async function callOpenAI(msgs) {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages: msgs, temperature: 0.2 })
      });
      const txt = await r.text();
      if (!r.ok) return `Translator error ${r.status}: ${txt}`;
      try {
        const data = JSON.parse(txt);
        return data.choices?.[0]?.message?.content || '';
      } catch { return `Translator bad json: ${txt}`; }
    }
    async function translateIfNeeded(text, userMsgs) {
      if (!TRANSLATE_INSTRUCTIONS) return text;
      const sample = ([...userMsgs].reverse().find(m => m.role === 'user')?.content || '').slice(0, 500);
      const msgs = [
        { role: 'system', content: 'You are a precise translator. Keep meaning and formatting. If source equals target language, return as is.' },
        { role: 'user', content: `User language sample:\n---\n${sample}\n---\nTranslate:\n${text}` }
      ];
      const out = await callOpenAI(msgs);
      return out || text;
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

    // ---------- LOGIKA ----------

    const lastUserText = [...messages].reverse().find(m => m.role === 'user')?.content || '';
    let parsed = parseDatesStrict(lastUserText);

    // když datum není v poslední zprávě, zkusit vzít rozsah z historie
    let effectiveRange = parsed.confirmed || rangeFromHistory(messages);

    // načíst dostupnost pro každou NOC (from..to-1)
    let AVAILABILITY = null;
    if (effectiveRange) {
      const { from, to } = effectiveRange;
      const out = [];
      const start = new Date(from + 'T00:00:00Z');
      const end   = new Date(to   + 'T00:00:00Z'); // to = den odjezdu (exkluzivně)
      for (let cur = new Date(start); cur < end; cur.setUTCDate(cur.getUTCDate() + 1)) {
        const iso = toISODate(cur);
        const d = await gsGet({ fn: 'parking', date: iso });
        if (!d || !d.ok || typeof d.total_spots === 'undefined') {
          out.push({ date: iso, ok: false, free: 0, total: 0, note: d?.raw ? `Sheets raw: ${String(d.raw).slice(0,200)}` : '' });
        } else {
          out.push({ date: iso, ok: true, total: Number(d.total_spots)||0, booked: Number(d.booked)||0, free: Math.max(0, Number(d.free)||0), note: String(d.note||'') });
        }
      }
      const lines = out.map(d => d.ok ? `• ${d.date}: volno ${d.free} / ${d.total}${d.note ? ` (${d.note})` : ''}` : `• ${d.date}: dostupnost neznámá`);
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

    // extrahovat detaily (jméno/SPZ/čas)
    const details = extractDetails(messages);

    // pokus o rezervaci, pokud máme všechno
    if (AVAILABILITY && AVAILABILITY.allFree && AVAILABILITY.nights > 0 && details && details.guest_name && details.car_plate) {
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
        return ok(reply);
      } else {
        const err = result?.error || 'Neznámá chyba';
        const raw = result?.raw ? `\nRaw: ${String(result.raw).slice(0,500)}` : '';
        return userErr(`Nepodařilo se zapsat rezervaci: ${err}.${raw}\n\nZkontrolujme SHEETS_API_URL (musí být "script.googleusercontent.com/.../exec" – tj. cílová adresa po přesměrování).`);
      }
    }

    // pokud máme dostupnost, ale ne detaily → vypiš dostupnost
    if (AVAILABILITY) return ok(AVAILABILITY.text);

    // pokud nemáme nic → ukaž formát dat
    if (!parsed.confirmed && parsed.ask) return ok(parsed.ask);

    return ok('Pro rezervaci napište prosím datum ve formátu **DD.MM.–DD.MM.YYYY** (např. **20.09.–24.09.2025**).');

  } catch (err) {
    // měkký pád — vrátíme chybovou zprávu, ale 200
    return new Response(JSON.stringify({ reply: `⚠️ Server error: ${String(err)}` }), {
      status: 200, headers: { 'content-type': 'application/json' }
    });
  }
};
