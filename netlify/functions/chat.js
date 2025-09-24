// netlify/functions/chat.js

const TRANSLATE_INSTRUCTIONS = true;

export default async (req) => {
  const ok = (reply) =>
    new Response(JSON.stringify({ reply }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const userErr = (msg) => ok(`⚠️ ${msg}`);

  try {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    // ---------- BODY ----------
    let body = {};
    try { body = await req.json(); } catch { return new Response("Bad JSON body", { status: 400 }); }
    const { messages = [] } = body;

    // ---------- ENV ----------
    const OPENAI_API_KEY   = process.env.OPENAI_API_KEY;
    const PARKING_API_URL  = process.env.PARKING_API_URL;
    const PARKING_WRITE_KEY= process.env.PARKING_WRITE_KEY || "";
    if (!PARKING_API_URL) {
      return userErr('Server: chybí PARKING_API_URL. Nastav v Netlify na URL Apps Script WebApp (končící na /exec).');
    }

    // ---------- Public base ----------
    const base = new URL(req.url);
    const IMG  = (p) => new URL(p, base.origin).toString();

    // ---------- Utils: messages ----------
    const lastUserText = () => [...messages].reverse().find(m=>m.role==='user')?.content || '';
    const userCount = messages.filter(m=>m.role==='user').length;
    const assistantCount = messages.filter(m=>m.role==='assistant').length;

    // ---------- Language handling ----------
    const SUPPORTED = { cs: "Čeština", en: "English", de: "Deutsch", es: "Español" };

    function detectLangFromAssistant(msgs){
      for (let i=msgs.length-1;i>=0;i--){
        const m = msgs[i]; if (m?.role !== 'assistant') continue;
        const t = (m.content||'').toLowerCase();
        if (/[ěščřžýáíéůúĚŠČŘŽÝÁÍÉŮÚ]/.test(t) || /čes|češt|bagáž|pokoj/.test(t)) return "cs";
        if (/\bder\b|\bund\b|straße|\bdeutsch\b/.test(t)) return "de";
        if (/\bel \b| la |\b¿|¡|\bespañol|estacionamiento/.test(t)) return "es";
        if (t) return "en";
      }
      return null;
    }
    function wantsLanguage(text){
      const t = (text||"").trim().toLowerCase();
      if (/^(cs|cz|čeština|cestina|česky)$/.test(t)) return "cs";
      if (/^(en|eng|english)$/.test(t)) return "en";
      if (/^(es|esp|español|spanish)$/.test(t)) return "es";
      if (/^(de|ger|deutsch|german)$/.test(t)) return "de";
      if (/(čeština|cestina|česky)/.test(t)) return "cs";
      if (/\benglish\b/.test(t)) return "en";
      if (/\bespañol|spanish\b/.test(t)) return "es";
      if (/\bdeutsch|german\b/.test(t)) return "de";
      return null;
    }
    async function callOpenAI(msgs){
      if (!OPENAI_API_KEY) return msgs.find(m=>m.role==='user')?.content || '';
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", messages: msgs, temperature: 0.2 })
      });
      const txt = await r.text();
      if (!r.ok) return `Translator error ${r.status}: ${txt}`;
      try { const data = JSON.parse(txt); return data.choices?.[0]?.message?.content || ''; }
      catch { return `Translator bad json: ${txt}`; }
    }
    async function translateTo(text, lang){
      if (!TRANSLATE_INSTRUCTIONS || !lang || lang === "en") return text;
      const msgs = [
        { role: "system", content: `Translate the following text to ${SUPPORTED[lang]}. Keep formatting and meaning. Return only the translated text.` },
        { role: "user", content: text }
      ];
      const out = await callOpenAI(msgs);
      return out || text;
    }

    // ---------- Static texts (EN source) ----------
    const LangQuestionEN =
`Which language would you like to use?
- **Čeština** (reply: "cs")
- **English** (reply: "en")
- **Deutsch** (reply: "de")
- **Español** (reply: "es")

You can also write e.g. "Pošli mi to v češtině" / "Please switch to English".`;

    function onboardingEN(){ return `
Welcome to **CHILL Apartments**! ✨

**Check-in** is from **2:00 p.m.**.

If you need a parking space, let me know as soon as possible.
Parking spaces are limited and depend on availability. The price is **20 EUR/night**.

I can also arrange an airport pick-up.
The cost is **31 EUR** for up to 4 people and **42 EUR** for more than 4 (up to 8), or if your luggage won’t fit into a sedan.
The drive from the airport takes **about 30 minutes**.
If you’d like this service, please tell me your **flight number** and **exact landing time**.

**Self check-in — step by step**
1) **Open the gate** — dial **3142#** on the left wall.  
   ![Gate keypad](${IMG('/img/gate.jpg')})

2) **Luggage room** (if you arrive before check-in) — next to the key box, **same code 3142#**.  
   ![Luggage room door](${IMG('/img/luggage.jpg')})

3) **Key box location** — the **white key box** is in the passage to the courtyard, right after the gate.  
   ![Key box](${IMG('/img/keybox.jpg')})

4) **Apartment key box code** — **David will send the code** before arrival.  
   *(Do not store your key in the box during your stay.)*

5) **Main entrance chip** — the chip opens the **main door** on the right side of the parking area; it also opens the **gate** via the sensor next to the dial pad.  
   ![Main entrance](${IMG('/img/11. Main-entrance.jpg')})
   ![Gate sensor](${IMG('/img/sensor.jpg')})

6) **Gate from inside** — use the **white switch** next to the key box; it **closes automatically** in **2.5 minutes**.  
   ![Parking entry](${IMG('/img/parking-entry.jpg')})

7) **Apartment number** — **David will send your apartment number** before arrival.

**Wi-Fi & TV**  
Wi-Fi name & password are on the **bottom of the router**. The TV has **no channels**, it’s a **Smart TV**.

**AC**  
Mode **Sun** heats, **Snowflake** cools.

**Check-out**  
Check-out is **before 11:00 a.m.** Drop the key into the **white postal box** on the ground floor, opposite the elevator (inside).  
![Self check-out/key drop box](${IMG('/img/12. Box_self-check-out.jpg')})

**House rules**  
All rooms are **strictly non-smoking** (fine **100 EUR**). Balconies on all floors + courtyard available. No **open fire** in the apartment.

_All information is also in your room (blue frame)._

**To get you ready:** please send your **arrival date & time** (e.g. *28.09.2025 18:30*) and whether you **need parking** or an **airport taxi**.
`.trim(); }

    // ---------- Intent detection ----------
    function wantsParking(text){ return /(park|parking|parkování|garáž|garage|auto)/i.test(text||''); }
    function wantsTaxi(text){ return /(taxi|airport|letiště|pick ?up|transfer)/i.test(text||''); }
    function saysOneNight(text){ return /(1\s*noc|jednu\s*noc|one\s*night)/i.test(text||''); }
    function detectIntent(text){
      const t = text || '';
      const hasRange  = /(\d{2})\.(\d{2})\.\s*[–-]\s*(\d{2})\.(\d{2})\.(\d{4})/.test(t);
      const hasSingle = /\b(\d{2})\.(\d{2})\.(\d{4})\b/.test(t);
      if (hasRange || hasSingle || wantsParking(t) || saysOneNight(t)) return "parking";
      if (/(wifi|wi-?fi|internet)/i.test(t)) return "wifi";
      if (wantsTaxi(t)) return "taxi";
      if (/(schod|stairs|handicap|wheelchair|invalid)/i.test(t)) return "stairs";
      if (/\bac\b|klima|air ?con|airconditioning|air-conditioning/i.test(t)) return "ac";
      if (/(elektr|jistič|fuse|breaker|power|electric)/i.test(t)) return "power";
      if (/(zavazad|bag|luggage|storage|úschov)/i.test(t)) return "luggage";
      if (/(balkon|balcony)/i.test(t)) return "balcony";
      if (/(check[- ]?in|check[- ]?out|arrival|příjezd|odjezd|welcome|instructions?)/i.test(t)) return "checkin";
      return "unknown";
    }

    // ---------- Date & parking utils ----------
    const toISODate = (d) => d.toISOString().slice(0,10);
    const daysInMonth = (y,m) => new Date(y, m, 0).getDate();
    const clamp = (y,m,d) => Math.min(Math.max(1,d), daysInMonth(y,m));
    const fmtISO = (y,m,d) => `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;

    function parseDatesStrict(text){
      const t = (text||'').trim();
      const re = /(^|.*?\s)\b(\d{2})\.(\d{2})\.\s*[–-]\s*(\d{2})\.(\d{2})\.(\d{4})\b/;
      const m = re.exec(t);
      if (!m) return { confirmed:null, ask:
        "Pro rezervaci parkování napište termín **přesně** ve tvaru:\n\n**DD.MM.–DD.MM.YYYY** (např. **20.09.–24.09.2025**)\n\nMezi dny použijte pomlčku \"-\" nebo en-dash \"–\"."
      };
      const d1=+m[2], m1=+m[3], d2=+m[4], m2=+m[5], y=+m[6];
      const a={ y, mo:m1, d: clamp(y,m1,d1) };
      const b={ y, mo:m2, d: clamp(y,m2,d2) };
      const isoA = fmtISO(a.y,a.mo,a.d);
      const isoB = fmtISO(b.y,b.mo,b.d);
      const from = isoA<=isoB ? isoA : isoB;
      const to   = isoA<=isoB ? isoB : isoA; // departure excl.
      return { confirmed:{ from, to }, ask:null };
    }

    function parseSingleDateAsOneNight(text){
      const t = (text||'').trim();
      if (/[–-]/.test(t)) return null; // už je to rozsah
      const m = /\b(\d{2})\.(\d{2})\.(\d{4})\b/.exec(t);
      if (!m) return null;
      const d = clamp(+m[3], +m[2], +m[1]);
      const from = fmtISO(+m[3], +m[2], d);
      const next = new Date(from + "T00:00:00Z"); next.setUTCDate(next.getUTCDate()+1);
      const to = toISODate(next);
      return { from, to };
    }

    function rangeFromHistory(msgs){
      const patterns = [
        /Dostupnost pro \*\*(\d{4}-\d{2}-\d{2})\s*→\s*(\d{4}-\d{2}-\d{2})\*\*/,
        /Availability for \*\*(\d{4}-\d{2}-\d{2})\s*→\s*(\d{4}-\d{2}-\d{2})\*\*/
      ];
      for (let i=msgs.length-1;i>=0;i--){
        const c = String(msgs[i]?.content || "");
        for (const re of patterns){
          const mm = re.exec(c);
          if (mm) return { from:mm[1], to:mm[2] };
        }
      }
      return null;
    }

    function qs(obj){ const u = new URL(PARKING_API_URL); Object.entries(obj||{}).forEach(([k,v])=>u.searchParams.set(k,String(v))); return u.toString(); }

    async function gsGetParking(dateISO){
      try{
        const r = await fetch(qs({ fn:'parking', date: dateISO }), { redirect:'follow' });
        const txt = await r.text();
        if (!r.ok) return { ok:false, error:`GET ${r.status}`, raw: txt?.slice(0,300) };
        try { return JSON.parse(txt); } catch { return { ok:false, error:'Bad JSON from GET', raw: txt?.slice(0,300) }; }
      } catch(e){ return { ok:false, error:String(e) }; }
    }

    async function gsPostBook(dateISO, who, note){
      try{
        const r = await fetch(PARKING_API_URL, {
          method:'POST', redirect:'follow',
          headers:{ 'Content-Type':'application/json' },
          body: JSON.stringify({ action:'book', date:dateISO, who, note:note||'', apiKey: PARKING_WRITE_KEY || undefined })
        });
        const txt = await r.text();
        if (!r.ok) return { ok:false, error:`POST ${r.status}`, raw: txt?.slice(0,300) };
        try { return JSON.parse(txt); } catch { return { ok:false, error:'Bad JSON from POST', raw: txt?.slice(0,300) }; }
      } catch(e){ return { ok:false, error:String(e) }; }
    }

    async function gsPostCancel(dateISO, who){
      try{
        const r = await fetch(PARKING_API_URL, {
          method:'POST', redirect:'follow',
          headers:{ 'Content-Type':'application/json' },
          body: JSON.stringify({ action:'cancel', date:dateISO, who, apiKey: PARKING_WRITE_KEY || undefined })
        });
        const txt = await r.text();
        if (!r.ok) return { ok:false, error:`POST ${r.status}`, raw: txt?.slice(0,300) };
        try { return JSON.parse(txt); } catch { return { ok:false, error:'Bad JSON from POST', raw: txt?.slice(0,300) }; }
      } catch(e){ return { ok:false, error:String(e) }; }
    }

    // ---------- Language gate ----------
    const userText = lastUserText();
    let chosenLang = wantsLanguage(userText) || detectLangFromAssistant(messages);

    // první interakce → zeptat se na jazyk
    if (!chosenLang && userCount === 1 && assistantCount === 0) {
      return ok(LangQuestionEN);
    }
    // fallback výběru jazyka + onboarding
    if (!chosenLang) {
      chosenLang = /[ěščřžýáíéůúĚŠČŘŽÝÁÍÉŮÚ]|češtin|česky|cz|cs/i.test(userText) ? "cs" : "en";
      const onboardingTranslated = await translateTo(onboardingEN(), chosenLang);
      const note = await translateTo("Okay, I will continue in this language.", chosenLang);
      return ok(`${note}\n\n${onboardingTranslated}`);
    }
    // explicitní přepnutí jazyka
    const explicitLang = wantsLanguage(userText);
    if (explicitLang) {
      chosenLang = explicitLang;
      const onboardingTranslated = await translateTo(onboardingEN(), chosenLang);
      return ok(onboardingTranslated);
    }

    // ---------- Router ----------
    const intent = detectIntent(userText);
    const priorRange = rangeFromHistory(messages);
    const activeParking = intent === "parking" || !!priorRange;

    if (!activeParking && intent !== "unknown") {
      return ok(await translateTo("How can I help you further? (Wi-Fi, taxi, parking, AC, power…)", chosenLang));
    }

    // ---------- PARKING FLOW ----------
    function extractArrivalDateTime(text) {
      const t = (text || "").trim();
      const reDT = /\b(\d{2})\.(\d{2})\.(\d{4})(?:[ T]+(\d{1,2})[:.](\d{2}))?\b/;
      const m = reDT.exec(t);
      let dateISO=null, timeHHMM=null;
      if (m){
        const d = clamp(+m[3], +m[2], +m[1]);
        dateISO = fmtISO(+m[3], +m[2], d);
        if (m[4] && m[5]) {
          const hh = String(Math.max(0, Math.min(23, +m[4]))).padStart(2,"0");
          const mm = String(Math.max(0, Math.min(59, +m[5]))).padStart(2,"0");
          timeHHMM = `${hh}:${mm}`;
        }
      }
      if (!timeHHMM){
        const tOnly = /(^|\s)(\d{1,2})[:.](\d{2})(\s|$)/.exec(t);
        if (tOnly){
          const hh = String(Math.max(0, Math.min(23, +tOnly[2]))).padStart(2,"0");
          const mm = String(Math.max(0, Math.min(59, +tOnly[3]))).padStart(2,"0");
          timeHHMM = `${hh}:${mm}`;
        }
      }
      return { arrival_date: dateISO, arrival_time: timeHHMM };
    }

    function deriveOneNightRangeFromArrival(text){
      const { arrival_date } = extractArrivalDateTime(text);
      if (!arrival_date) return null;
      const start = new Date(arrival_date + "T00:00:00Z");
      const next  = new Date(start); next.setUTCDate(next.getUTCDate()+1);
      return { from: arrival_date, to: toISODate(next) };
    }

    function extractDetailsFromFreeText() {
      const t = lastUserText().trim();
      if (!t) return null;
      const timeMatch = t.match(/(\b\d{1,2}[:.]\d{2}\b)/);
      const arrival = timeMatch ? t.match(/(\b\d{1,2}[:.]\d{2}\b)/)[0].replace(".", ":") : null;
      const parts = t.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);

      // tolerantní SPZ: povolí mezery a pomlčky, normalizuje na bez mezer
      let plate = null;
      for (const p of parts) {
        if (/^[A-Za-z0-9 -]{5,}$/.test(p)) {
          const normalized = p.replace(/\s+/g,'').toUpperCase();
          if (/^[A-Z0-9-]{5,}$/.test(normalized)) { plate = normalized; break; }
        }
      }

      let name = null;
      for (const p of parts) {
        const clean = p.replace(/\s+/g, " ").trim();
        if (arrival && clean.includes(arrival)) continue;
        if (plate && clean.replace(/\s+/g,'').toUpperCase() === plate) continue;
        if (clean.length >= 3) { name = clean; break; }
      }
      if (!name && !plate && !arrival) return null;
      return { guest_name: name||'', car_plate: plate||'', arrival_time: arrival||'' };
    }

    let derived = (saysOneNight(userText) ? deriveOneNightRangeFromArrival(userText) : null);
    let parsedRange  = parseDatesStrict(userText);
    let singleRange  = parseSingleDateAsOneNight(userText);
    let effectiveRange = derived || singleRange || parsedRange.confirmed || priorRange;

    if (activeParking && !effectiveRange) {
      const ask = parsedRange.ask || "Napište prosím termín parkování ve formátu **DD.MM.–DD.MM.YYYY** (např. **20.09.–24.09.2025**), nebo napište **jedno datum** pro 1 noc (např. **28.09.2025**).";
      return ok(await translateTo(ask, chosenLang));
    }

    let AV = null;
    if (activeParking && effectiveRange) {
      const { from, to } = effectiveRange;
      const out = [];
      const start = new Date(from + "T00:00:00Z");
      const end   = new Date(to   + "T00:00:00Z");
      for (let cur = new Date(start); cur < end; cur.setUTCDate(cur.getUTCDate()+1)) {
        const iso = toISODate(cur);
        const d = await gsGetParking(iso);
        if (!d || !d.ok || typeof d.total_spots === "undefined") {
          out.push({ date: iso, ok:false, free:0, total:0, note: d?.error ? `err: ${d.error}` : (d?.raw ? `raw: ${String(d.raw).slice(0,200)}` : "") });
        } else {
          out.push({ date: iso, ok:true, total: Number(d.total_spots)||0, booked: Number(d.booked)||0, free: Math.max(0, Number(d.free)||0), note: String(d.note||"") });
        }
      }
      const allKnown= out.every(d=>d.ok);
      const allFree = allKnown && out.every(d=>d.free>0);
      const anyFull = out.some(d=>d.ok && d.free<=0);

      const baseTextEN =
`Availability for **${from} → ${to}** (nights: ${out.length}, departure day not counted)
${out.map(d => d.ok ? `• ${d.date}: free ${d.free} / ${d.total}${d.note ? ` (${d.note})` : ""}` : `• ${d.date}: availability unknown${d.note ? ` (${d.note})` : ""}`).join("\n")}
${allFree
  ? "\nAll nights are available. Please send the guest name and license plate. Arrival time (HH:mm) is optional."
  : anyFull
    ? "\nSome nights are full. We can look for another date or suggest alternatives (mrparkit.com)."
    : "\nSome days are unknown; availability needs manual confirmation."}`;

      const baseText = await translateTo(baseTextEN, chosenLang);
      AV = { from, to, nights: out.length, days: out, allKnown, allFree, anyFull, text: baseText };
    }

    const details = extractDetailsFromFreeText();
    function missingDetailsPrompt(details){
      const need = [];
      if (!details?.guest_name) need.push(chosenLang==='cs' ? "jméno hosta" : "guest name");
      if (!details?.car_plate) need.push(chosenLang==='cs' ? "SPZ" : "license plate");
      if (!need.length) return null;
      const example = chosenLang==='cs' ? "Jan Novák, 7AZ 1234, 18:30" : "John Smith, ABC1234, 18:30";
      return `Please provide: ${need.join(", ")}.\nYou can write it in one message, e.g.: **${example}**.`;
    }

    if (activeParking && AV) {
      const need = missingDetailsPrompt(details);
      if (need) {
        return ok(`${AV.text}\n\n${await translateTo(need, chosenLang)}`);
      }
    }

    if (activeParking && AV && AV.allKnown && AV.nights>0 && details && details.guest_name && details.car_plate) {
      const who = `${details.guest_name} / ${details.car_plate}`.trim();
      const bookedDates = []; let failed=null;

      // re-check
      for (const d of AV.days){
        const check = await gsGetParking(d.date);
        if (!check?.ok || (Number(check.free)||0) <= 0){ failed = { date:d.date, reason:'No free spot' }; break; }
      }
      // book
      if (!failed){
        for (const d of AV.days){
          const res = await gsPostBook(d.date, who, details.arrival_time || '');
          if (!res?.ok){ failed = { date:d.date, reason:res?.error || 'Unknown error', raw: res?.raw }; break; }
          bookedDates.push(d.date);
        }
      }
      // rollback
      if (failed && bookedDates.length){
        for (const date of bookedDates.reverse()){ await gsPostCancel(date, who).catch(()=>{}); }
      }
      if (!failed){
        const list = AV.days.map(d=>`• ${d.date}`).join("\n");
        const packCS = `
**Parkování a příjezd**
- Parkování je **20 € / noc**.
- Rezervované parkování je k dispozici od **12:00** v den příjezdu.
- **Check-out z pokoje do 11:00**. Ponechání auta po 11:00 je **jen dle dostupnosti** – napište, potvrdíme.
- Průjezd je **úzký (šířka 220 cm)**, **výška neomezená** – projede i vysoké auto.
- Když je parkoviště plné a potřebujete jen vyložit: můžete zastavit ~**10 minut** na chodníku před domem (mezi naším a vedlejším vjezdem).

**Self check-in**
- **Kód do boxu a číslo apartmánu pošle David** před příjezdem.

**Úschova zavazadel**
- **Před 14:00** — uložte zavazadla do **bagážovny**.
- **Po check-outu (11:00)** — bagážovna je k dispozici.

![Gate keypad](${IMG('/img/gate.jpg')})
![Key box](${IMG('/img/keybox.jpg')})
![Luggage room door](${IMG('/img/luggage.jpg')})
![Main entrance](${IMG('/img/11. Main-entrance.jpg')})
![Gate sensor](${IMG('/img/sensor.jpg')})
![Parking entry](${IMG('/img/parking-entry.jpg')})
![Self check-out/key drop box](${IMG('/img/12. Box_self-check-out.jpg')})`.trim();

        const instr = await translateTo(packCS, chosenLang);
        const confirmEN =
`✅ Parking reservation saved (${AV.nights} night${AV.nights>1?'s':''}):
${list}
Guest: ${details.guest_name}, Plate: ${details.car_plate}, Arrival: ${details.arrival_time || 'n/a'}

${instr}`;
        return ok(await translateTo(confirmEN, chosenLang));
      } else {
        const why = failed.reason + (failed.raw ? `\nRaw: ${String(failed.raw).slice(0,300)}` : '');
        return userErr(await translateTo(`Failed to save reservation for ${failed.date}: ${why}\nPlease try again or specify another date.`, chosenLang));
      }
    }

    if (activeParking && AV) {
      return ok(AV.text);
    }

    return ok(await translateTo("How can I help you further? (Wi-Fi, taxi, parking, AC, power…)", chosenLang));

  } catch (err) {
    return new Response(JSON.stringify({ reply: `⚠️ Server error: ${String(err)}` }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }
};
