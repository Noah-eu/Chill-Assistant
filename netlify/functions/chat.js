// netlify/functions/chat.js
// Striktní formát dat pro PARKING: "DD.MM.–DD.MM.YYYY" (nebo '-').
// Př.: "20.09.–24.09.2025" → from=2025-09-20, to=2025-09-24 (nocí: 4).
// „Měkký pád“: nikdy 500; vždy vrací 200 s JSON { reply } k zobrazení.

const TRANSLATE_INSTRUCTIONS = true;

export default async (req) => {
  const ok = (reply) =>
    new Response(JSON.stringify({ reply }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const userErr = (msg) => ok(`⚠️ ${msg}`);

  try {
    if (req.method !== "POST")
      return new Response("Method Not Allowed", { status: 405 });

    // ---------- BODY ----------
    let body = {};
    try { body = await req.json(); }
    catch { return new Response("Bad JSON body", { status: 400 }); }
    const { messages = [] } = body;

    // ---------- ENV ----------
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const PARKING_API_URL = process.env.PARKING_API_URL;           // Apps Script /exec
    const PARKING_WRITE_KEY = process.env.PARKING_WRITE_KEY || ""; // volitelné

    if (!PARKING_API_URL)
      return userErr('Server: chybí PARKING_API_URL. Nastav v Netlify (Production) na URL Apps Script WebApp (končící na /exec).');

    // ---------- Public data ----------
    const base = new URL(req.url);
    async function loadJSON(path) {
      try {
        const r = await fetch(new URL(path, base.origin), { headers: { "cache-control": "no-cache" } });
        if (!r.ok) return null;
        return await r.json();
      } catch { return null; }
    }
    const HOTEL = (await loadJSON("/data/hotel.json")) || {};
    const MEDIA = (await loadJSON("/data/parking_media.json")) || [];

    // ---------- Jazyk & překlad ----------
    function lastUserTextOf(msgs){ return [...msgs].reverse().find(m=>m.role==='user')?.content || ''; }

    async function callOpenAI(msgs) {
      if (!OPENAI_API_KEY) {
        // Bez klíče prostě vrátíme text, který měl být přeložen.
        return msgs.find((m) => m.role === "user")?.content || "";
      }
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-4o-mini", messages: msgs, temperature: 0.2 }),
      });
      const txt = await r.text();
      if (!r.ok) return `Translator error ${r.status}: ${txt}`;
      try {
        const data = JSON.parse(txt);
        return data.choices?.[0]?.message?.content || "";
      } catch { return `Translator bad json: ${txt}`; }
    }

    // VŽDY se snažíme přeložit do jazyka uživatele (podle jeho poslední zprávy).
    async function translateToUserLanguage(text, userMsgs) {
      if (!TRANSLATE_INSTRUCTIONS) return text;
      const sample = lastUserTextOf(userMsgs);
      const msgs = [
        { role: "system", content: "You are a precise translator. Detect the user's language from the sample. Translate the provided text fully into the user's language. Keep formatting and meaning. If it already matches, return as is." },
        { role: "user", content: `User language sample:\n---\n${sample}\n---\nTranslate:\n${text}` },
      ];
      const out = await callOpenAI(msgs);
      return out || text;
    }

    // ---------- Apps Script helpers ----------
    function qs(obj) {
      const u = new URL(PARKING_API_URL);
      Object.entries(obj || {}).forEach(([k, v]) => u.searchParams.set(k, String(v)));
      return u.toString();
    }
    async function gsGetParking(dateISO) {
      try {
        const r = await fetch(qs({ fn: "parking", date: dateISO }), { redirect: "follow" });
        const txt = await r.text();
        if (!r.ok) return { ok: false, error: `GET ${r.status}`, raw: txt?.slice(0, 300) };
        try { return JSON.parse(txt); } catch { return { ok:false, error:"Bad JSON from GET", raw: txt?.slice(0,300) }; }
      } catch (e) { return { ok:false, error:String(e) }; }
    }
    async function gsPostBook(dateISO, who, note) {
      try {
        const r = await fetch(PARKING_API_URL, {
          method: "POST", redirect: "follow",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "book", date: dateISO, who, note: note || "", apiKey: PARKING_WRITE_KEY || undefined }),
        });
        const txt = await r.text();
        if (!r.ok) return { ok:false, error:`POST ${r.status}`, raw: txt?.slice(0,300) };
        try { return JSON.parse(txt); } catch { return { ok:false, error:"Bad JSON from POST", raw: txt?.slice(0,300) }; }
      } catch (e) { return { ok:false, error:String(e) }; }
    }
    async function gsPostCancel(dateISO, who) {
      try {
        const r = await fetch(PARKING_API_URL, {
          method: "POST", redirect: "follow",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "cancel", date: dateISO, who, apiKey: PARKING_WRITE_KEY || undefined }),
        });
        const txt = await r.text();
        if (!r.ok) return { ok:false, error:`POST ${r.status}`, raw: txt?.slice(0,300) };
        try { return JSON.parse(txt); } catch { return { ok:false, error:"Bad JSON from POST", raw: txt?.slice(0,300) }; }
      } catch (e) { return { ok:false, error:String(e) }; }
    }

    // ---------- Date utils ----------
    const toISODate = (d) => d.toISOString().slice(0, 10);
    const daysInMonth = (y, m) => new Date(y, m, 0).getDate();
    const clamp = (y, m, d) => Math.min(Math.max(1, d), daysInMonth(y, m));
    const fmtISO = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

    // PARKING – striktní rozsah nocí
    function parseDatesStrict(text) {
      const t = (text || "").trim();
      const re = /(^|.*?\s)\b(\d{2})\.(\d{2})\.\s*[–-]\s*(\d{2})\.(\d{2})\.(\d{4})\b/;
      const m = re.exec(t);
      if (!m) return { confirmed: null, ask:
        "Pro rezervaci parkování napište datum **přesně** ve tvaru:\n\n" +
        "**DD.MM.–DD.MM.YYYY** (např. **20.09.–24.09.2025**)\n\n" +
        'Mezi dny použijte pomlčku "-" nebo en-dash "–".'
      };
      const d1 = +m[2], m1 = +m[3], d2 = +m[4], m2 = +m[5], y = +m[6];
      const a = { y, mo: m1, d: clamp(y, m1, d1) };
      const b = { y, mo: m2, d: clamp(y, m2, d2) };
      const isoA = fmtISO(a.y, a.mo, a.d);
      const isoB = fmtISO(b.y, b.mo, b.d);
      const from = isoA <= isoB ? isoA : isoB;
      const to = isoA <= isoB ? isoB : isoA; // den odjezdu (exkluzivně)
      return { confirmed: { from, to }, ask: null };
    }
    function rangeFromHistory(msgs) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]; if (!m || !m.content) continue;
        const mm = /Dostupnost pro \*\*(\d{4}-\d{2}-\d{2})\s*→\s*(\d{4}-\d{2}-\d{2})\*\*/.exec(String(m.content));
        if (mm) return { from: mm[1], to: mm[2] };
      }
      return null;
    }

    // ---------- Onboarding extrakce ----------
    function extractArrivalDateTime(text) {
      const t = (text || "").trim();
      // "DD.MM.YYYY HH:mm" nebo bez času
      const reDT = /\b(\d{2})\.(\d{2})\.(\d{4})(?:[ T]+(\d{1,2})[:.](\d{2}))?\b/;
      const m = reDT.exec(t);
      let dateISO = null, timeHHMM = null;
      if (m) {
        const d = clamp(+m[3], +m[2], +m[1]);
        dateISO = fmtISO(+m[3], +m[2], d);
        if (m[4] && m[5]) {
          const hh = String(Math.max(0, Math.min(23, +m[4]))).padStart(2, "0");
          const mm = String(Math.max(0, Math.min(59, +m[5]))).padStart(2, "0");
          timeHHMM = `${hh}:${mm}`;
        }
      }
      // samostatný čas
      if (!timeHHMM) {
        const timeOnly = /(^|\s)(\d{1,2})[:.](\d{2})(\s|$)/.exec(t);
        if (timeOnly) {
          const hh = String(Math.max(0, Math.min(23, +timeOnly[2]))).padStart(2, "0");
          const mm = String(Math.max(0, Math.min(59, +timeOnly[3]))).padStart(2, "0");
          timeHHMM = `${hh}:${mm}`;
        }
      }
      return { arrival_date: dateISO, arrival_time: timeHHMM };
    }
    function wantsParking(text) { return /(park|parking|parkování|garáž|garage|auto)/i.test(text || ""); }
    function wantsTaxi(text)    { return /(taxi|airport|letiště|pick ?up|transfer)/i.test(text || ""); }
    function saysOneNight(text) { return /(1\s*noc|jednu\s*noc|one\s*night)/i.test(text || ""); }

    // Pomocné: odvoď rozsah (1 noc) z data příjezdu
    function deriveOneNightRangeFromArrival(text) {
      const { arrival_date } = extractArrivalDateTime(text);
      if (!arrival_date) return null;
      const start = new Date(arrival_date + "T00:00:00Z");
      const next = new Date(start); next.setUTCDate(next.getUTCDate() + 1);
      return { from: arrival_date, to: toISODate(next) };
    }

    // ---------- Intenty ----------
    function detectIntent(text) {
      const t = (text || "");
      // pokud má "jednu noc" + datum → ber jako parking (abychom netrvali na rozsahu)
      if (saysOneNight(t) && extractArrivalDateTime(t).arrival_date) return "parking";
      const hasParkingRange = /(\d{2})\.(\d{2})\.\s*[–-]\s*(\d{2})\.(\d{2})\.(\d{4})/.test(t);
      const parkingKW = wantsParking(t);
      if (hasParkingRange || parkingKW) return "parking";
      if (/(wifi|wi-?fi|internet)/i.test(t)) return "wifi";
      if (wantsTaxi(t)) return "taxi";
      if (/(schod|stairs|handicap|wheelchair|invalid)/i.test(t)) return "stairs";
      if (/\bac\b|klima|air ?con|airconditioning|air-conditioning/i.test(t)) return "ac";
      if (/(elektr|jistič|fuse|breaker|power|electric)/i.test(t)) return "power";
      if (/(zavazad|bag|luggage|storage|úschov)/i.test(t)) return "luggage";
      if (/(balkon|balcony)/i.test(t)) return "balcony";
      if (/(pes|dog|pet|zvíř|animals)/i.test(t)) return "pets";
      if (/(check[- ]?in|check[- ]?out|arrival|příjezd|odjezd|welcome|instructions?)/i.test(t)) return "checkin";
      return "onboarding";
    }

    // ---------- Sekce (CZ) – parkovací část pro potvrzení rezervace ----------
    const SECTIONS_CZ = {
      parkingIntro: `
**Parkování a příjezd**
- Parkování je za **20 € / noc**.
- Rezervované parkování je k dispozici od **12:00** v den příjezdu.
- V den odjezdu je **check-out z pokoje do 11:00**. Ponechání auta po 11:00 je možné **jen dle dostupnosti** – napište, potvrdíme.
- Průjezd do dvora je **úzký (šířka 220 cm)**, ale **výška je neomezená** – projede i vysoké auto.
- Když je parkoviště plné a potřebujete jen vyložit věci: na **chodníku před domem** (mezi naším a vedlejším vjezdem) lze zastavit cca **10 minut**.
`.trim(),
      checkinShort: `
**Self check-in**
- Kód do boxu a **číslo apartmánu pošle David** před příjezdem.
`.trim(),
      luggage: `
**Úschova zavazadel**
- **Příjezd před 14:00** – uložte zavazadla do **bagážovny**.
- **Po check-outu (11:00)** – lze uložit v **bagážovně**.
`.trim(),
    };

    function mediaBlock() {
      if (!Array.isArray(MEDIA) || MEDIA.length === 0) return "";
      const lines = MEDIA.map((m, i) => {
        const url = new URL(`/${m.src}`, base.origin).toString();
        const caption = m.caption || `Photo ${i + 1}`;
        return `![${caption}](${url})`;
      });
      return `\n\n**Photos / map / animation:**\n${lines.join("\n")}`;
    }

    // ---------- ÚVODNÍ PREAMBULE (EN jako zdroj; vždy překládáme do jazyka uživatele) ----------
    function onboardingPreambleEN() {
      return `
Please let me know what time you will be arriving.
Check-in time is from 2:00 p.m.

In case you need a parking space, let me know as soon as possible.
Parking spaces are limited and depend upon availability. The price is 20 euros/night.

I can also arrange an airport pick-up for you.
The cost is 31 EUR for up to 4 people & 42 EUR for more than 4 people (up to 8), or if you will not fit your luggage into a normal, sedan car.
The drive from the airport to our apartments takes about 30 minutes.
If you would like to order this service, please let me know the number of your flight and the exact landing time.

I’m sending you the check-in instructions below. (The key box code and the apartment number will be sent later by David.)
`.trim();
    }

    // ---------- CELÉ INSTRUKCE (EN jako zdroj; vždy překládáme) ----------
    function fullInstructionsEN() {
      return `
Thank you for choosing **CHILL Apartments**!

You can have breakfast in the **La Mouka** restaurant with a **10% discount** using promo code **CHILL**. It’s open from **9:00** and it’s just around the corner.

We have a **laundry room** in the basement. Free of charge and accessible **non-stop**.

**Self check-in**
I will leave a key from the apartment in a **white key box** which is located in the passage to the courtyard, right after the gate.  
To open the gate, dial code **3142#** on the left wall (see picture).  
If you come **before the check-in time**, please store your **luggage in the luggage room**. It’s next to the key box. The code is the same as for the gate (**3142#**). Please make sure the door is closed after.  
Right next to it is the **box for the keys** (picture). **Your number is 1** and the code is **(code#)**. After you take the keys, **close the box door**. You will find there **one key and one chip**.  
The chip is for the **main door** located on the right side of the parking lot (picture). You can also use it for **opening the gate during your stay** with a sensor next to the dial box (picture).  
To open the gate from the inside, use a **white switch** next to the key box. The gate **closes automatically** in **2.5 minutes**.  
The key is from your apartment. The number is **(apartment number)**. You will find it on the **(floor)** floor.  
Please, don’t use the key box as a storage for your key during your stay – it is used **only for arrivals**.

**Wi-Fi & TV**
You’ll find the Wi-Fi name and password on the **bottom side of the router**.  
The TV has **no channels**, but it is a **Smart TV**.

**AC**
AC mode **Sun** is for heating and **Snowflake** is for cooling.

**Check-out**
Check-out time is **before 11:00 a.m.**  
Please throw the key into the **white postal box** on the ground floor, opposite the elevator (inside the building – see picture).  
You can use the **luggage room after the check-out** as well.

**House rules**
All rooms are **strictly non-smoking** under a fine of **100 euros**.  
There are balconies on all floors and a courtyard to use.  
Please, do **not use open fire** in the apartment.

You can also find all the information in the room on the shelf in the **blue frame**.

Here you can see a **3D visualization** of our hotel (reception, second entrance also for cars, laundry in the basement, apartments on the 1st floor; other floors are the same):
https://my.matterport.com/show/?m=PTEAUeUbMno
`.trim();
    }

    function onboardingBundleEN() {
      // Preambule + plné instrukce + případná fotogalerie
      return `${onboardingPreambleEN()}

${fullInstructionsEN()}${mediaBlock()}`;
    }

    // ---------- LOGIKA ----------
    const lastUser = lastUserTextOf(messages);
    const intent = detectIntent(lastUser);

    // === 1) ONBOARDING ===
    if (intent === "onboarding") {
      const bundle = onboardingBundleEN(); // zdroj v EN
      const translated = await translateToUserLanguage(bundle, messages); // vždy do jazyka uživatele
      return ok(translated);
    }

    // === 2) NE-PARKOVACÍ SEKCE ===
    if (intent && !["parking","onboarding"].includes(intent)) {
      // V tuto chvíli nechceme rozepisovat všechny sekce znovu – onboarding už obsahuje vše podstatné.
      // Pokud chceš speciální bloky (wifi, taxi…) vracet i samostatně, lze doplnit texty a přeložit:
      return ok(await translateToUserLanguage("How can I help you further? (Wi-Fi, taxi, parking, AC, power…)", messages));
    }

    // === 3) PARKING FLOW ===
    // 3a) pokud host píše "jen jednu noc" + datum → odvoď rozsah
    let derived = null;
    if (saysOneNight(lastUser)) derived = deriveOneNightRangeFromArrival(lastUser);

    // 3b) standardní parser nebo historie
    let parsed = parseDatesStrict(lastUser);
    let effectiveRange = derived || parsed.confirmed || rangeFromHistory(messages);

    // načíst dostupnost pro každou NOC (from..to-1)
    let AVAILABILITY = null;
    if (effectiveRange) {
      const { from, to } = effectiveRange;
      const out = [];
      const start = new Date(from + "T00:00:00Z");
      const end   = new Date(to   + "T00:00:00Z"); // to = den odjezdu (exkluzivně)
      for (let cur = new Date(start); cur < end; cur.setUTCDate(cur.getUTCDate() + 1)) {
        const iso = toISODate(cur);
        const d = await gsGetParking(iso);
        if (!d || !d.ok || typeof d.total_spots === "undefined") {
          out.push({ date: iso, ok:false, free:0, total:0, note: d?.error ? `err: ${d.error}` : (d?.raw ? `raw: ${String(d.raw).slice(0,200)}` : "") });
        } else {
          out.push({ date: iso, ok:true, total: Number(d.total_spots)||0, booked: Number(d.booked)||0, free: Math.max(0, Number(d.free)||0), note: String(d.note||"") });
        }
      }
      const lines = out.map((d) => d.ok
        ? `• ${d.date}: volno ${d.free} / ${d.total}${d.note ? ` (${d.note})` : ""}`
        : `• ${d.date}: dostupnost neznámá${d.note ? ` (${d.note})` : ""}`
      );
      const allKnown = out.every((d) => d.ok);
      const allFree  = allKnown && out.every((d) => d.free > 0);
      const anyFull  = out.some((d) => d.ok && d.free <= 0);

      AVAILABILITY = {
        from, to, nights: out.length, days: out, allKnown, allFree, anyFull,
        text:
`Dostupnost pro **${from} → ${to}** (nocí: ${out.length}, den odjezdu se nepočítá)
${lines.join("\n")}
${allFree
  ? "\n\nVšechny noci mají volno. Pošlete prosím jméno hosta, SPZ a čas příjezdu (HH:mm)."
  : anyFull
    ? "\n\nNěkteré noci jsou plné. Můžeme hledat jiný termín nebo doporučit alternativy (mrparkit.com)."
    : "\n\nU některých nocí chybí data, dostupnost je potřeba potvrdit."}`
      };
    }

    // extrakce detailů (jméno/SPZ/čas) pro rychlý zápis
    function extractDetails(msgs) {
      const t = lastUserTextOf(msgs).trim();
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
      return { guest_name: name || "", car_plate: plate || "", arrival_time: arrival || "" };
    }
    const details = extractDetails(messages);

    // pokus o rezervaci, pokud máme všechno
    if (AVAILABILITY && AVAILABILITY.allFree && AVAILABILITY.nights > 0 && details && details.guest_name && details.car_plate) {
      const who = `${details.guest_name} / ${details.car_plate}`.trim();
      const bookedDates = [];
      let failed = null;

      // re-check volno
      for (const d of AVAILABILITY.days) {
        const check = await gsGetParking(d.date);
        if (!check?.ok || (Number(check.free) || 0) <= 0) { failed = { date: d.date, reason: "No free spot" }; break; }
      }

      // book po dnech
      if (!failed) {
        for (const d of AVAILABILITY.days) {
          const res = await gsPostBook(d.date, who, details.arrival_time || "");
          if (!res?.ok) { failed = { date: d.date, reason: res?.error || "Unknown error", raw: res?.raw }; break; }
          bookedDates.push(d.date);
        }
      }

      // rollback
      if (failed && bookedDates.length) {
        for (const date of bookedDates.reverse()) { await gsPostCancel(date, who).catch(() => {}); }
      }

      if (!failed) {
        const list = AVAILABILITY.days.map((d) => `• ${d.date}`).join("\n");
        const packEN = `${SECTIONS_CZ.parkingIntro}\n\n${SECTIONS_CZ.checkinShort}\n\n${SECTIONS_CZ.luggage}${mediaBlock()}`;
        const instr = await translateToUserLanguage(packEN, messages);
        const reply =
`✅ Rezervace zapsána (${AVAILABILITY.nights} nocí):
${list}
Host: ${details.guest_name}, SPZ: ${details.car_plate}, příjezd: ${details.arrival_time || "neuvedeno"}

${instr}`;
        return ok(reply);
      } else {
        const why = failed.reason + (failed.raw ? `\nRaw: ${String(failed.raw).slice(0, 300)}` : "");
        return userErr(`Nepodařilo se zapsat rezervaci pro ${failed.date}: ${why}\nZkusme to prosím znovu, nebo upřesněte jiný termín.`);
      }
    }

    // pokud máme dostupnost, ale ne detaily → vypiš dostupnost
    if (AVAILABILITY) return ok(AVAILABILITY.text);

    // pokud dotaz je o parkování, ale nebyl rozpoznán rozsah → popros o formát
    if (intent === "parking") {
      if (saysOneNight(lastUser) && !extractArrivalDateTime(lastUser).arrival_date) {
        return ok("Napište prosím **datum příjezdu (DD.MM.YYYY)** a že je to **na 1 noc**. Pak to hned ověřím.");
      }
      const ask = parseDatesStrict(lastUser).ask;
      return ok(ask || "Napište prosím termín parkování ve formátu **DD.MM.–DD.MM.YYYY**.");
    }

    // fallback
    return ok(await translateToUserLanguage("How can I help you further? (Wi-Fi, taxi, parking, AC, power…)", messages));
  } catch (err) {
    return new Response(JSON.stringify({ reply: `⚠️ Server error: ${String(err)}` }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }
};
