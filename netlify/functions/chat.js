// netlify/functions/chat.js
// PARKING: očekávaný formát rozsahu: "DD.MM.–DD.MM.YYYY" (pomlčka nebo en-dash).

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
    try {
      body = await req.json();
    } catch {
      return new Response("Bad JSON body", { status: 400 });
    }
    const { messages = [] } = body;

    // ---------- ENV ----------
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const PARKING_API_URL = process.env.PARKING_API_URL;
    const PARKING_WRITE_KEY = process.env.PARKING_WRITE_KEY || "";

    if (!PARKING_API_URL) {
      return userErr(
        "Server: chybí PARKING_API_URL. Nastav v Netlify na URL Apps Script WebApp (končící na /exec)."
      );
    }

    // ---------- Public data ----------
    const base = new URL(req.url);
    async function loadJSON(path) {
      try {
        const r = await fetch(new URL(path, base.origin), {
          headers: { "cache-control": "no-cache" },
        });
        if (!r.ok) return null;
        return await r.json();
      } catch {
        return null;
      }
    }
    const MEDIA = (await loadJSON("/data/parking_media.json")) || [];

    // ---------- Helpers: language & translate ----------
    const lastUserText = () =>
      [...messages].reverse().find((m) => m.role === "user")?.content || "";
    const userCount = messages.filter((m) => m.role === "user").length;
    const assistantCount = messages.filter((m) => m.role === "assistant").length;

    // FIX: Onboarding jen při úplně prvním uživatelském vstupu
    const isFirstUserTurn = assistantCount === 0 && userCount === 1;

    async function callOpenAI(msgs) {
      if (!OPENAI_API_KEY) {
        return msgs.find((m) => m.role === "user")?.content || "";
      }
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: msgs,
          temperature: 0.2,
        }),
      });
      const txt = await r.text();
      if (!r.ok) return `Translator error ${r.status}: ${txt}`;
      try {
        const data = JSON.parse(txt);
        return data.choices?.[0]?.message?.content || "";
      } catch {
        return `Translator bad json: ${txt}`;
      }
    }

    async function translateToUserLanguage(text) {
      if (!TRANSLATE_INSTRUCTIONS) return text;
      const sample = lastUserText();
      const msgs = [
        {
          role: "system",
          content:
            "Detect user's language from the sample and translate the provided text fully into that language. Keep formatting and meaning. If already matching, return as is.",
        },
        {
          role: "user",
          content: `User language sample:\n---\n${sample}\n---\nTranslate:\n${text}`,
        },
      ];
      const out = await callOpenAI(msgs);
      return out || text;
    }

    // ---------- Apps Script helpers ----------
    function qs(obj) {
      const u = new URL(PARKING_API_URL);
      Object.entries(obj || {}).forEach(([k, v]) =>
        u.searchParams.set(k, String(v))
      );
      return u.toString();
    }

    async function gsGetParking(dateISO) {
      try {
        const r = await fetch(qs({ fn: "parking", date: dateISO }), {
          redirect: "follow",
        });
        const txt = await r.text();
        if (!r.ok)
          return { ok: false, error: `GET ${r.status}`, raw: txt?.slice(0, 300) };
        try {
          return JSON.parse(txt);
        } catch {
          return { ok: false, error: "Bad JSON from GET", raw: txt?.slice(0, 300) };
        }
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }

    async function gsPostBook(dateISO, who, note) {
      try {
        const r = await fetch(PARKING_API_URL, {
          method: "POST",
          redirect: "follow",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "book",
            date: dateISO,
            who,
            note: note || "",
            apiKey: PARKING_WRITE_KEY || undefined,
          }),
        });
        const txt = await r.text();
        if (!r.ok)
          return {
            ok: false,
            error: `POST ${r.status}`,
            raw: txt?.slice(0, 300),
          };
        try {
          return JSON.parse(txt);
        } catch {
          return {
            ok: false,
            error: "Bad JSON from POST",
            raw: txt?.slice(0, 300),
          };
        }
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }

    async function gsPostCancel(dateISO, who) {
      try {
        const r = await fetch(PARKING_API_URL, {
          method: "POST",
          redirect: "follow",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "cancel",
            date: dateISO,
            who,
            apiKey: PARKING_WRITE_KEY || undefined,
          }),
        });
        const txt = await r.text();
        if (!r.ok)
          return {
            ok: false,
            error: `POST ${r.status}`,
            raw: txt?.slice(0, 300),
          };
        try {
          return JSON.parse(txt);
        } catch {
          return {
            ok: false,
            error: "Bad JSON from POST",
            raw: txt?.slice(0, 300),
          };
        }
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }

    // ---------- Date utils ----------
    const toISODate = (d) => d.toISOString().slice(0, 10);
    const daysInMonth = (y, m) => new Date(y, m, 0).getDate();
    const clamp = (y, m, d) => Math.min(Math.max(1, d), daysInMonth(y, m));
    const fmtISO = (y, m, d) =>
      `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

    function parseDatesStrict(text) {
      const t = (text || "").trim();
      const re =
        /(^|.*?\s)\b(\d{2})\.(\d{2})\.\s*[–-]\s*(\d{2})\.(\d{2})\.(\d{4})\b/;
      const m = re.exec(t);
      if (!m) {
        return {
          confirmed: null,
          ask:
            "Pro rezervaci parkování napište termín **přesně** ve tvaru:\n\n" +
            "**DD.MM.–DD.MM.YYYY** (např. **20.09.–24.09.2025**)\n\n" +
            'Mezi dny použijte pomlčku "-" nebo en-dash "–".',
        };
      }
      const d1 = +m[2],
        m1 = +m[3],
        d2 = +m[4],
        m2 = +m[5],
        y = +m[6];
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
        const m = msgs[i];
        if (!m || !m.content) continue;
        const mm =
          /Dostupnost pro \*\*(\d{4}-\d{2}-\d{2})\s*→\s*(\d{4}-\d{2}-\d{2})\*\*/.exec(
            String(m.content)
          );
        if (mm) return { from: mm[1], to: mm[2] };
      }
      return null;
    }

    // ---------- Onboarding texty (EN jako zdroj; překládáme do jazyka uživatele) ----------
    function onboardingPreambleEN() {
      return `
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
`.trim();
    }

    function fullInstructionsEN() {
      return `
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
`.trim();
    }

    function onboardingBundleEN() {
      return `${onboardingPreambleEN()}

${fullInstructionsEN()}`;
    }

    // ---------- Média blok (volitelný) ----------
    function mediaBlock() {
      if (!Array.isArray(MEDIA) || MEDIA.length === 0) return "";
      const lines = MEDIA.map((m, i) => {
        const url = new URL(`/${m.src}`, base.origin).toString();
        const caption = m.caption || `Photo ${i + 1}`;
        return `![${caption}](${url})`;
      });
      return `\n\n**Photos / map / animation:**\n${lines.join("\n")}`;
    }

    // ---------- Intent detekce ----------
    function wantsParking(text) {
      return /(park|parking|parkování|garáž|garage|auto)/i.test(text || "");
    }
    function wantsTaxi(text) {
      return /(taxi|airport|letiště|pick ?up|transfer)/i.test(text || "");
    }
    function saysOneNight(text) {
      return /(1\s*noc|jednu\s*noc|one\s*night)/i.test(text || "");
    }

    function detectIntent(text) {
      const t = text || "";
      const hasRange =
        /(\d{2})\.(\d{2})\.\s*[–-]\s*(\d{2})\.(\d{2})\.(\d{4})/.test(t);
      if (hasRange || wantsParking(t) || saysOneNight(t)) return "parking";
      if (/(wifi|wi-?fi|internet)/i.test(t)) return "wifi";
      if (wantsTaxi(t)) return "taxi";
      if (/(schod|stairs|handicap|wheelchair|invalid)/i.test(t)) return "stairs";
      if (/\bac\b|klima|air ?con|airconditioning|air-conditioning/i.test(t))
        return "ac";
      if (/(elektr|jistič|fuse|breaker|power|electric)/i.test(t)) return "power";
      if (/(zavazad|bag|luggage|storage|úschov)/i.test(t)) return "luggage";
      if (/(balkon|balcony)/i.test(t)) return "balcony";
      if (
        /(check[- ]?in|check[- ]?out|arrival|příjezd|odjezd|welcome|instructions?)/
          .test(t)
      )
        return "checkin";
      return "unknown";
    }

    // ---------- SECTIONS (CZ) pro potvrzení parkování v rekapitulaci ----------
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

    // ---------- 1) Onboarding: jen při úplně prvním vstupu ----------
    if (isFirstUserTurn) {
      const bundle = onboardingBundleEN();
      const translated = await translateToUserLanguage(bundle);
      return ok(translated);
    }

    // ---------- 2) Router mimo onboarding ----------
    const userText = lastUserText();
    const intent = detectIntent(userText);

    // Non-parking zkrácená odpověď (už po onboardingu)
    if (intent !== "parking" && intent !== "unknown") {
      return ok(
        await translateToUserLanguage(
          "How can I help you further? (Wi-Fi, taxi, parking, AC, power…)"
        )
      );
    }

    // ---------- 3) PARKOVÁNÍ ----------
    function extractArrivalDateTime(text) {
      const t = (text || "").trim();
      const reDT =
        /\b(\d{2})\.(\d{2})\.(\d{4})(?:[ T]+(\d{1,2})[:.](\d{2}))?\b/;
      const m = reDT.exec(t);
      let dateISO = null,
        timeHHMM = null;
      if (m) {
        const d = clamp(+m[3], +m[2], +m[1]);
        dateISO = fmtISO(+m[3], +m[2], d);
        if (m[4] && m[5]) {
          const hh = String(Math.max(0, Math.min(23, +m[4]))).padStart(2, "0");
          const mm = String(Math.max(0, Math.min(59, +m[5]))).padStart(2, "0");
          timeHHMM = `${hh}:${mm}`;
        }
      }
      if (!timeHHMM) {
        const tOnly = /(^|\s)(\d{1,2})[:.](\d{2})(\s|$)/.exec(t);
        if (tOnly) {
          const hh = String(Math.max(0, Math.min(23, +tOnly[2]))).padStart(
            2,
            "0"
          );
          const mm = String(Math.max(0, Math.min(59, +tOnly[3]))).padStart(
            2,
            "0"
          );
          timeHHMM = `${hh}:${mm}`;
        }
      }
      return { arrival_date: dateISO, arrival_time: timeHHMM };
    }

    function deriveOneNightRangeFromArrival(text) {
      const { arrival_date } = extractArrivalDateTime(text);
      if (!arrival_date) return null;
      const start = new Date(arrival_date + "T00:00:00Z");
      const next = new Date(start);
      next.setUTCDate(next.getUTCDate() + 1);
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
        if (/^[A-Za-z0-9-]{5,}$/.test(c)) {
          plate = c.toUpperCase();
          break;
        }
      }
      let name = null;
      for (const p of parts) {
        const clean = p.replace(/\s+/g, " ").trim();
        if (arrival && clean.includes(arrival)) continue;
        if (plate && clean.replace(/\s+/g, "").toUpperCase() === plate) continue;
        if (clean.length >= 3) {
          name = clean;
          break;
        }
      }
      if (!name && !plate && !arrival) return null;
      return {
        guest_name: name || "",
        car_plate: plate || "",
        arrival_time: arrival || "",
      };
    }

    const details = extractDetailsFromFreeText();

    let derived = saysOneNight(userText)
      ? deriveOneNightRangeFromArrival(userText)
      : null;
    let parsed = parseDatesStrict(userText);
    let effectiveRange = derived || parsed.confirmed || rangeFromHistory(messages);

    // Pokud chybí rozsah, nejdřív si vyžádejme termín (neplést do toho instrukce)
    if (intent === "parking" && !effectiveRange) {
      const ask = parsed.ask;
      return ok(ask || "Napište prosím termín parkování ve formátu **DD.MM.–DD.MM.YYYY**.");
    }

    // Máme rozsah – zkontrolujeme dostupnost
    let AVAILABILITY = null;
    if (intent === "parking" && effectiveRange) {
      const { from, to } = effectiveRange;
      const out = [];
      const start = new Date(from + "T00:00:00Z");
      const end = new Date(to + "T00:00:00Z");
      for (let cur = new Date(start); cur < end; cur.setUTCDate(cur.getUTCDate() + 1)) {
        const iso = toISODate(cur);
        const d = await gsGetParking(iso);
        if (!d || !d.ok || typeof d.total_spots === "undefined") {
          out.push({
            date: iso,
            ok: false,
            free: 0,
            total: 0,
            note: d?.error ? `err: ${d.error}` : d?.raw ? `raw: ${String(d.raw).slice(0, 200)}` : "",
          });
        } else {
          out.push({
            date: iso,
            ok: true,
            total: Number(d.total_spots) || 0,
            booked: Number(d.booked) || 0,
            free: Math.max(0, Number(d.free) || 0),
            note: String(d.note || ""),
          });
        }
      }
      const lines = out.map((d) =>
        d.ok
          ? `• ${d.date}: volno ${d.free} / ${d.total}${d.note ? ` (${d.note})` : ""}`
          : `• ${d.date}: dostupnost neznámá${d.note ? ` (${d.note})` : ""}`
      );
      const allKnown = out.every((d) => d.ok);
      const allFree = allKnown && out.every((d) => d.free > 0);
      const anyFull = out.some((d) => d.ok && d.free <= 0);

      AVAILABILITY = {
        from,
        to,
        nights: out.length,
        days: out,
        allKnown,
        allFree,
        anyFull,
        text:
          `Dostupnost pro **${from} → ${to}** (nocí: ${out.length}, den odjezdu se nepočítá)\n` +
          lines.join("\n") +
          `\n\n` +
          (allFree
            ? "Volná místa jsou k dispozici.\n"
            : anyFull
            ? "Některé noci jsou plné. Můžeme hledat jiný termín nebo doporučit alternativy (např. mrparkit.com).\n"
            : "U některých nocí chybí data, dostupnost je potřeba potvrdit.\n"),
      };
    }

    // Pokud chybí některý z detailů (jméno, SPZ, čas), vyžádej je (NEPOSÍLEJ instrukce)
    function missingDetailsPromptCz(details) {
      const need = [];
      if (!details?.guest_name) need.push("jméno hosta");
      if (!details?.car_plate) need.push("SPZ");
      if (!details?.arrival_time) need.push("čas příjezdu (HH:mm)");
      if (!need.length) return null;
      return (
        "Prosím doplňte: " +
        need.join(", ") +
        ".\nMůžete to napsat v jedné zprávě, např.: **Jan Novák, 7AZ 1234, 18:30**."
      );
    }

    if (intent === "parking" && AVAILABILITY) {
      const need = missingDetailsPromptCz(details);
      if (need) {
        // řekni dostupnost + vyžádej chybějící údaje
        return ok(`${AVAILABILITY.text}\n\n${need}`);
      }
    }

    // Máme vše – pokus o zápis rezervace
    if (
      intent === "parking" &&
      AVAILABILITY &&
      AVAILABILITY.allKnown &&
      AVAILABILITY.nights > 0 &&
      details &&
      details.guest_name &&
      details.car_plate
    ) {
      const who = `${details.guest_name} / ${details.car_plate}`.trim();
      const bookedDates = [];
      let failed = null;

      // re-check current free spots
      for (const d of AVAILABILITY.days) {
        const check = await gsGetParking(d.date);
        if (!check?.ok || (Number(check.free) || 0) <= 0) {
          failed = { date: d.date, reason: "No free spot" };
          break;
        }
      }
      // book
      if (!failed) {
        for (const d of AVAILABILITY.days) {
          const res = await gsPostBook(
            d.date,
            who,
            details.arrival_time || ""
          );
          if (!res?.ok) {
            failed = {
              date: d.date,
              reason: res?.error || "Unknown error",
              raw: res?.raw,
            };
            break;
          }
          bookedDates.push(d.date);
        }
      }
      // rollback
      if (failed && bookedDates.length) {
        for (const date of bookedDates.reverse()) {
          await gsPostCancel(date, who).catch(() => {});
        }
      }
      if (!failed) {
        const list = AVAILABILITY.days.map((d) => `• ${d.date}`).join("\n");
        const packCZ = `${SECTIONS_CZ.parkingIntro}\n\n${SECTIONS_CZ.checkinShort}\n\n${SECTIONS_CZ.luggage}${mediaBlock()}`;
        const instr = await translateToUserLanguage(packCZ);
        return ok(
          `✅ Rezervace zapsána (${AVAILABILITY.nights} nocí):\n${list}\n` +
            `Host: ${details.guest_name}, SPZ: ${details.car_plate}, příjezd: ${
              details.arrival_time || "neuvedeno"
            }\n\n${instr}`
        );
      } else {
        const why =
          failed.reason +
          (failed.raw ? `\nRaw: ${String(failed.raw).slice(0, 300)}` : "");
        return userErr(
          `Nepodařilo se zapsat rezervaci pro ${failed.date}: ${why}\n` +
            `Zkusme to prosím znovu, nebo upřesněte jiný termín.`
        );
      }
    }

    // fallback pro parking – sděl dostupnost (bez instrukcí)
    if (intent === "parking" && AVAILABILITY) {
      return ok(AVAILABILITY.text);
    }

    // Nic konkrétního
    return ok(
      await translateToUserLanguage(
        "How can I help you further? (Wi-Fi, taxi, parking, AC, power…)"
      )
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ reply: `⚠️ Server error: ${String(err)}` }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  }
};
