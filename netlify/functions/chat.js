// netlify/functions/chat.js

const TRANSLATE_INSTRUCTIONS = true;
const VERSION = "chatjs-2025-09-24-langflow-v3";

export default async (req) => {
  const ok = (reply) =>
    new Response(JSON.stringify({ reply: reply + `\n\n— ${VERSION}` }), {
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

    // ---------- Public data ----------
    const base = new URL(req.url);
    async function loadJSON(path) {
      try {
        const r = await fetch(new URL(path, base.origin), { headers: { "cache-control": "no-cache" } });
        if (!r.ok) return null;
        return await r.json();
      } catch { return null; }
    }
    const MEDIA = (await loadJSON("/data/parking_media.json")) || [];

    // ---------- Utils: messages ----------
    const lastUserText = () => [...messages].reverse().find(m=>m.role==='user')?.content || '';
    const userCount = messages.filter(m=>m.role==='user').length;

    // ---------- Language handling ----------
    const SUPPORTED = { cs: "Čeština", en: "English", de: "Deutsch", es: "Español" };

    function getChosenLangFromHistory(msgs){
      for (let i=msgs.length-1;i>=0;i--){
        const c = msgs[i]?.content || "";
        const m = /⟦lang:(cs|en|de|es)⟧/.exec(String(c));
        if (m) return m[1];
      }
      return null;
    }
    function hasAskedLang(msgs){
      return msgs.some(m => /⟦asklang⟧/.test(String(m?.content || "")));
    }
    function wantsLanguage(text){
      const t = (text||"").trim().toLowerCase();
      if (/^(cs|cz|čeština|cestina|česky)$/.test(t)) return "cs";
      if (/^(en|eng|english)$/.test(t)) return "en";
      if (/^(es|esp|español|spanish)$/.test(t)) return "es";
      if (/^(de|ger|deutsch|german)$/.test(t)) return "de";
      // tolerantní zachycení vět
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

    function onboardingPreambleEN(){ return `
Welcome to **CHILL Apartments**! ✨

Please tell me your **arrival date & time** (e.g. 28.09.2025 18:30),
whether you **need parking**, and if you want an **airport taxi**.

**Check-in** is from **2:00 p.m.**.

If you need a parking space, let me know as soon as possible.
Parking spaces are limited and depend on availability. The price is **20 EUR/night**.

I can also arrange an airport pick-up.
The cost is **31 EUR** for up to 4 people and **42 EUR** for more than 4 (up to 8), or if your luggage won’t fit into a sedan.
The drive from the airport takes **about 30 minutes**.
If you’d like this service, please tell me your **flight number** and **exact landing time**.
`.trim(); }

    function fullInstructionsEN(){ return `
**Self check-in**
The key will be in a **white key box** in the passage to the courtyard, right after the gate.  
Gate code: **3142#** (left wall).  
If you arrive **before check-in**, store your **luggage** in the luggage room next to the key box. Code is the same (**3142#**).  
Next to it is the **key box** for your apartment (**#1**, code **(code#)**). Inside: **one key + one chip**.  
The chip opens the **main door** (right side of the parking area) and can open the **gate** during your stay (sensor next to the dial box).  
To open the gate from inside, use the **white switch** next to the key box; it **closes automatically** in **2.5 minutes**.  
Your apartment number is **(apartment number)** on the **(floor)** floor.  
Please don’t store your key in the key box during your stay.

**Wi-Fi & TV**
You’ll find the Wi-Fi name & password on the **bottom of the router**.  
The TV has **no channels**, but it’s a **Smart TV**.

**AC**
Mode **Sun** heats, **Snowflake** cools.

**Check-out**
Check-out is **before 11:00 a.m.**  
Please drop the key into the **white postal box** on the ground floor, opposite the elevator (inside the building).  
You can use the **luggage room after check-out** as well.

**House rules**
All rooms are **strictly non-smoking** (fine **100 EUR**).  
Balconies on all floors + courtyard available.  
No **open fire** in the apartment.

All information is also in your room (blue frame).
`.trim(); }

    function onboardingBundleEN(){ return `${onboardingPreambleEN()}

${fullInstructionsEN()}`; }

    function mediaBlock() {
      if (!Array.isArray(MEDIA) || MEDIA.length === 0) return "";
      const lines = MEDIA.map((m, i) => {
        const url = new URL(`/${m.src}`, base.origin).toString();
        const caption = m.caption || `Photo ${i + 1}`;
        return `![${caption}](${url})`;
      });
      return `\n\n**Photos / map / animation:**\n${lines.join("\n")}`;
    }

    // ---------- Intent detection ----------
    function wantsParking(text){ return /(park|parking|parkování|garáž|garage|auto)/i.test(text||''); }
    function wantsTaxi(text){ return /(taxi|airport|letiště|pick ?up|transfer)/i.test(text||''); }
    function saysOneNight(text){ return /(1\s*noc|jednu\s*noc|one\s*night)/i.test(text||''); }
    function detectIntent(text){
      const t = text || '';
      const hasRange = /(\d{2})\.(\d{2})\.\s*[–-]\s*(\d{2})\.(\d{2})\.(\d{4})/.test(t);
      if (hasRange || wantsParking(t) || saysOneNight(t)) return "parking";
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
      if (!m) {
        return { confirmed:null, ask:
          "Pro rezervaci parkování napište termín **přesně** ve tvaru:\n\n" +
          "**DD.MM.–DD.MM.YYYY** (např. **20.09.–24.09.2025**)\n\n" +
          'Mezi dny použijte pomlčku "-" nebo en-dash "–".'
        };
      }
      const d1=+m[2], m1=+m[3], d2=+m[4], m2=+m[5], y=+m[6];
      const a={ y, mo:m1, d: clamp(y,m1,d1) };
      const b={ y, mo:m2, d: clamp(y,m2,d2) };
      const isoA = fmtISO(a.y,a.mo,a.d);
      const isoB = fmtISO(b.y,b.mo,b.d);
      const from = isoA<=isoB ? isoA : isoB;
      const to   = isoA<=isoB ? isoB : isoA; // den odjezdu exkl.
      return { confirmed:{ from, to }, ask:null };
    }

    function rangeFromHistory(msgs){
      for (let i=msgs.length-1;i>=0;i--){
        const m = msgs[i];
        if (!m || !m.content) continue;
        const mm = /Dostupnost pro \*\*(\d{4}-\d{2}-\d{2})\s*→\s*(\d{4}-\d{2}-\d2)\*\*/.exec(String(m.content));
        if (mm) return { from:mm[1], to:mm[2] };
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

    // ---------- Onboarding (EN source) ----------
    function onboardingForLang(){ return onboardingBundleEN(); }

    // ---------- Language gate ----------
    const userText = lastUserText();
    let chosenLang = getChosenLangFromHistory(messages);
    const requestedLang = wantsLanguage(userText);
    const askedBefore = hasAskedLang(messages);

    // 1) Pokud uživatel jasně napsal jazyk → PŘEPNI HNED + pošli onboarding (v jedné odpovědi)
    if (requestedLang && requestedLang !== chosenLang) {
      chosenLang = requestedLang;
      const bundleEN = onboardingForLang();
      const onboardingTranslated = await translateTo(bundleEN, chosenLang);
      const confirm = await translateTo("Language switched.", chosenLang);
      return ok(`⟦lang:${chosenLang}⟧\n${confirm}\n\n${onboardingTranslated}`);
    }

    // 2) Není zvolen jazyk a ještě jsme se neptali → pošli JEDNOU dotaz (s markerem)
    if (!chosenLang && !askedBefore) {
      return ok(`⟦asklang⟧\n${LangQuestionEN}`);
    }

    // 3) Po dotazu uživatel odpověděl něčím nejasným → nastav heuristicky a pošli onboarding
    if (!chosenLang && askedBefore) {
      const guess = /[ěščřžýáíéůúĚŠČŘŽÝÁÍÉŮÚ]|češtin|česky|cz|cs/i.test(userText) ? "cs" : "en";
      const bundleEN = onboardingForLang();
      const onboardingTranslated = await translateTo(bundleEN, guess);
      const note = await translateTo("Okay, I will continue in this language.", guess);
      return ok(`⟦lang:${guess}⟧\n${note}\n\n${onboardingTranslated}`);
    }

    // ---------- Router (all replies translated to chosenLang) ----------
    const intent = detectIntent(userText);

    // Non-parking short helper
    if (intent !== "parking" && intent !== "unknown") {
      return ok(await translateTo("How can I help you further? (Wi-Fi, taxi, parking, AC, power…)", chosenLang));
    }

    // ---------- PARKING FLOW ----------
    // ... (zbytek je stejný jako v tvé verzi v2, vše proháníme přes translateTo(..., chosenLang))
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
      const arrival = timeMatch ? timeMatch[1].replace(".", ":") : null;
      const parts = t.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
      let plate = null;
      for (const p of parts) {
        const c = p.replace(/\s+/g, "");
        if (/^[A-Za-z0-9-]{5,}$/.test(c)) { plate = c.toUpperCase(); break; }
      }
      let name = null;
      for (const p of parts) {
        const clean = p.replace(/\s+/g, " ").trim();
        if (arrival && clean.includes(arrival)) continue;
        if (plate && clean.replace(/\s+/g, "").toUpperCase() === plate) continue;
        if (clean.length >= 3) { name = clean; break; }
      }
      if (!name && !plate && !arrival) return null;
      return { guest_name: name||'', car_plate: plate||'', arrival_time: arrival||'' };
    }

    let derived = (saysOneNight(userText) ? deriveOneNightRangeFromArrival(userText) : null);
    let parsed  = parseDatesStrict(userText);
    let effectiveRange = derived || parsed.confirmed || rangeFromHistory(messages);

    if (intent === "parking" && !effectiveRange) {
      const ask = parsed.ask || "Napište prosím termín parkování ve formátu **DD.MM.–DD.MM.YYYY**.";
      return ok(await translateTo(ask, chosenLang));
    }

    let AV = null;
    if (intent === "parking" && effectiveRange) {
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
      const lines   = out.map(d => d.ok ? `• ${d.date}: free ${d.free} / ${d.total}${d.note ? ` (${d.note})` : ""}` : `• ${d.date}: availability unknown${d.note ? ` (${d.note})` : ""}`);
      const allKnown= out.every(d=>d.ok);
      const allFree = allKnown && out.every(d=>d.free>0);
      const anyFull = out.some(d=>d.ok && d.free<=0);

      const baseText =
`Availability for **${from} → ${to}** (nights: ${out.length}, departure day not counted)
${lines.join("\n")}
${allFree
  ? "\nAll nights are available. Please send the guest name, license plate and arrival time (HH:mm)."
  : anyFull
    ? "\nSome nights are full. We can look for another date or suggest alternatives (mrparkit.com)."
    : "\nSome days are unknown; availability needs manual confirmation."}`;

      AV = { from, to, nights: out.length, days: out, allKnown, allFree, anyFull, text: await translateTo(baseText, chosenLang) };
    }

    const details = extractDetailsFromFreeText();
    function missingDetailsPrompt(details){
      const need = [];
      if (!details?.guest_name) need.push(chosenLang==='cs' ? "jméno hosta" : "guest name");
      if (!details?.car_plate) need.push(chosenLang==='cs' ? "SPZ" : "license plate");
      if (!details?.arrival_time) need.push(chosenLang==='cs' ? "čas příjezdu (HH:mm)" : "arrival time (HH:mm)");
      if (!need.length) return null;
      const example = chosenLang==='cs' ? "Jan Novák, 7AZ 1234, 18:30" : "John Smith, ABC1234, 18:30";
      const base = `Please provide: ${need.join(", ")}.\nYou can write it in one message, e.g.: **${example}**.`;
      return base;
    }

    if (intent === "parking" && AV) {
      const need = missingDetailsPrompt(details);
      if (need) {
        return ok(`${AV.text}\n\n${await translateTo(need, chosenLang)}`);
      }
    }

    if (intent === "parking" && AV && AV.allKnown && AV.nights>0 && details && details.guest_name && details.car_plate) {
      const who = `${details.guest_name} / ${details.car_plate}`.trim();
      const bookedDates = []; let failed=null;

      for (const d of AV.days){
        const check = await gsGetParking(d.date);
        if (!check?.ok || (Number(check.free)||0) <= 0){ failed = { date:d.date, reason:'No free spot' }; break; }
      }
      if (!failed){
        for (const d of AV.days){
          const res = await gsPostBook(d.date, who, details.arrival_time || '');
          if (!res?.ok){ failed = { date:d.date, reason:res?.error || 'Unknown error', raw: res?.raw }; break; }
          bookedDates.push(d.date);
        }
      }
      if (failed && bookedDates.length){
        for (const date of bookedDates.reverse()){ await gsPostCancel(date, who).catch(()=>{}); }
      }
      if (!failed){
        const list = AV.days.map(d=>`• ${d.date}`).join("\n");
        const packEN = `
**Parking & arrival**
- Parking is **20 € / night**.
- Reserved parking is available from **12:00** on arrival day.
- Room **check-out is by 11:00**. Keeping the car after 11:00 is **subject to availability** — message us to confirm.
- The passage is **narrow (width 220 cm)**, **height is unlimited** — tall cars fit.
- If the lot is full and you just need to unload: you can stop for ~**10 minutes** on the sidewalk in front of the house (between our and the next gate).

**Self check-in**
- **Access code and apartment number will be sent by David** before arrival.

**Luggage storage**
- **Before 14:00** — store luggage in the **luggage room**.
- **After check-out (11:00)** — luggage room is available as well.
${mediaBlock()}`.trim();

        const instr = await translateTo(packEN, chosenLang);
        const confirmEN =
`✅ Reservation saved (${AV.nights} nights):
${list}
Guest: ${details.guest_name}, Plate: ${details.car_plate}, Arrival: ${details.arrival_time || 'n/a'}

${instr}`;
        return ok(await translateTo(confirmEN, chosenLang));
      } else {
        const why = failed.reason + (failed.raw ? `\nRaw: ${String(failed.raw).slice(0,300)}` : '');
        return userErr(await translateTo(`Failed to save reservation for ${failed.date}: ${why}\nPlease try again or specify another date.`, chosenLang));
      }
    }

    if (intent === "parking" && AV) {
      return ok(AV.text);
    }

    return ok(await translateTo("How can I help you further? (Wi-Fi, taxi, parking, AC, power…)", chosenLang));

  } catch (err) {
    return new Response(JSON.stringify({ reply: `⚠️ Server error: ${String(err)}` }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }
};
