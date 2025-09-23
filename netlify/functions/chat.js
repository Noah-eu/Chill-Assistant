// netlify/functions/chat.js
// Striktní formát dat: "DD.MM.–DD.MM.YYYY" (nebo '-').
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
    try {
      body = await req.json();
    } catch {
      return new Response("Bad JSON body", { status: 400 });
    }
    const { messages = [] } = body;

    // ---------- ENV ----------
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const PARKING_API_URL = process.env.PARKING_API_URL;   // Apps Script /exec
    const PARKING_WRITE_KEY = process.env.PARKING_WRITE_KEY || ""; // volitelné

    if (!PARKING_API_URL)
      return userErr(
        'Server: chybí PARKING_API_URL. Nastav v Netlify (Production) na URL Apps Script WebApp (končící na /exec).'
      );

    // ---------- Public data (statické JSON z /data) ----------
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
    const HOTEL = (await loadJSON("/data/hotel.json")) || {};
    const MEDIA = (await loadJSON("/data/parking_media.json")) || [];

    // ---------- Apps Script helpers ----------
    function qs(obj) {
      const u = new URL(PARKING_API_URL);
      Object.entries(obj || {}).forEach(([k, v]) =>
        u.searchParams.set(k, String(v))
      );
      return u.toString();
    }

    async function gsGetParking(dateISO) {
      // GET ?fn=parking&date=YYYY-MM-DD
      try {
        const r = await fetch(qs({ fn: "parking", date: dateISO }), {
          redirect: "follow",
        });
        const txt = await r.text();

        if (!r.ok) {
          console.error("gsGetParking error", r.status, txt?.slice(0, 300));
          return { ok: false, error: `GET ${r.status}`, raw: txt?.slice(0, 300) };
        }
        try {
          return JSON.parse(txt);
        } catch {
          console.error("gsGetParking bad json", txt?.slice(0, 300));
          return { ok: false, error: "Bad JSON from GET", raw: txt?.slice(0, 300) };
        }
      } catch (e) {
        console.error("gsGetParking exception", e);
        return { ok: false, error: String(e) };
      }
    }

    async function gsPostBook(dateISO, who, note) {
      // POST { action:'book', date, who, note?, apiKey? }
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
        if (!r.ok) {
          console.error("gsPostBook error", r.status, txt?.slice(0, 300));
          return { ok: false, error: `POST ${r.status}`, raw: txt?.slice(0, 300) };
        }
        try {
          return JSON.parse(txt);
        } catch {
          console.error("gsPostBook bad json", txt?.slice(0, 300));
          return { ok: false, error: "Bad JSON from POST", raw: txt?.slice(0, 300) };
        }
      } catch (e) {
        console.error("gsPostBook exception", e);
        return { ok: false, error: String(e) };
      }
    }

    async function gsPostCancel(dateISO, who) {
      // POST { action:'cancel', date, who, apiKey? } – rollback
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
        if (!r.ok) {
          console.error("gsPostCancel error", r.status, txt?.slice(0, 300));
          return { ok: false, error: `POST ${r.status}`, raw: txt?.slice(0, 300) };
        }
        try {
          return JSON.parse(txt);
        } catch {
          console.error("gsPostCancel bad json", txt?.slice(0, 300));
          return { ok: false, error: "Bad JSON from POST", raw: txt?.slice(0, 300) };
        }
      } catch (e) {
        console.error("gsPostCancel exception", e);
        return { ok: false, error: String(e) };
      }
    }

    // ---------- Date utils ----------
    const toISODate = (d) => d.toISOString().slice(0, 10);
    const daysInMonth = (y, m) => new Date(y, m, 0).getDate();
    const clamp = (y, m, d) => Math.min(Math.max(1, d), daysInMonth(y, m));
    const fmtISO = (y, m, d) =>
      `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

    // ---------- STRIKTNÍ PARSER ----------
    function parseDatesStrict(text) {
      const t = (text || "").trim();
      const re =
        /(^|.*?\s)\b(\d{2})\.(\d{2})\.\s*[–-]\s*(\d{2})\.(\d{2})\.(\d{4})\b/;
      const m = re.exec(t);
      if (!m) {
        const ask =
          "Pro rezervaci parkování mi prosím napište datum **pouze** v tomto formátu:\n\n" +
          "**DD.MM.–DD.MM.YYYY** (např. **20.09.–24.09.2025**)\n\n" +
          'Použijte buď pomlčku "-", nebo en-dash "–" mezi dny.';
        return { confirmed: null, ask };
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

    // ---------- EXTRAKCE DETAILŮ (jméno, SPZ, čas) ----------
    function extractDetails(msgs) {
      const t =
        ([...msgs].reverse().find((m) => m.role === "user")?.content || "").trim();
      if (!t) return null;
      const timeMatch = t.match(/(\b\d{1,2}[:.]\d{2}\b)/);
      const arrival = timeMatch ? timeMatch[1].replace(".", ":") : null;
      const parts = t
        .split(/[,;\n]/)
        .map((s) => s.trim())
        .filter(Boolean);

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

    // ---------- Překladač (jen pro instrukce) ----------
    async function callOpenAI(msgs) {
      if (!OPENAI_API_KEY) {
        // Bez klíče překlad přeskočíme — vrátíme originál
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

    async function translateIfNeeded(text, userMsgs) {
      if (!TRANSLATE_INSTRUCTIONS) return text;
      const sample =
        ([...userMsgs].reverse().find((m) => m.role === "user")?.content ||
          "").slice(0, 500);
      const msgs = [
        {
          role: "system",
          content:
            "You are a precise translator. Keep meaning and formatting. If source equals target language, return as is.",
        },
        {
          role: "user",
          content: `User language sample:\n---\n${sample}\n---\nTranslate:\n${text}`,
        },
      ];
      const out = await callOpenAI(msgs);
      return out || text;
    }

    // ---------- Instrukce + média ----------
    const parkingInstructionsCZ = `
**Parkování a příjezd**
- Rezervované parkování je k dispozici od **12:00** v den příjezdu.
- V den odjezdu je **check-out z pokoje do 11:00**. Ponechání auta po 11:00 je možné **jen dle dostupnosti** – napište, potvrdíme.
- Průjezd do dvora je **úzký (šířka 220 cm)**, ale **výška je neomezená** – projede i vysoké auto.
- Když je parkoviště plné a potřebujete jen vyložit věci: na **chodníku před domem** (mezi naším a vedlejším vjezdem) lze zastavit cca **10 minut**. (Viz foto níže.)

**Self check-in / klíče**
- Kód do boxu a **číslo apartmánu pošle David** před příjezdem.
- V bagážovně jsou **náhradní klíče** podle čísla apartmánu:
  001→3301, 101→3302, 102→3303, 103→3304, 104→3305, 105→3306,
  201→3307, 202→3308, 203→3309, 204→3310, 205→3311,
  301→3312, 302→3313, 303→3314, 304→3315, 305→3316.
  Po použití prosíme **číselník zamíchat** a klíč **vrátit na místo**.

**Úschovna zavazadel**
- **Příjezd před 11:00**: uložte věci v **bagážovně**.
- **Po check-outu (po 11:00)**: můžete uložit věci v bagážovně, nebo je ponechat v apartmánu a **vrátit se později**. Pokud uvidíte, že je už **uklizeno**, můžete **zůstat**.

**Bezbariérovost / schody**
- Do budovy jsou **2 schody**, do apartmánu **001** v přízemí je **1 schod**. Jinak bez schodů a s **velkým výtahem**.
- Sprchové kouty mají **cca 30 cm** práh vaničky.

**Číslování a balkony**
- První číslo apartmánu = **patro** (001 přízemí, 101 1. patro, …).
- **Balkony** mají: **105, 205, 305**. Ostatní mohou využít **společné balkony** u výtahu na každém patře.

**Elektřina – jističe**
- Nejprve zkontrolujte **jističe v apartmánu** (malá bílá dvířka ve zdi).
- Pokud je problém dál, u balkonu jsou **hlavní troj-jističe**; spadlý bude jako **jediný dole**.

**AC (klimatizace)**
- Režim **Sun = topení**, **Snowflake = chlazení**.
- Pokud **bliká zelená** na AC, je potřeba **restart**: na **balkonu 2. patra** jsou vypínače AC – **vypnout ~30 s, pak zapnout**.

**Wi-Fi (SSID / heslo)**
001→ D384 / 07045318  
101→ CDEA / 51725587  
102→ CF2A / 09341791  
103→ 93EO / 25133820  
104→ D93A / 10661734  
105→ D9E4 / 09464681  
201→ 6A04 / 44791957  
202→ 9B7A / 65302361  
203→ 1CF8 / 31284547  
204→ D8C4 / 73146230  
205→ CD9E / 02420004  
301→ CF20 / 96995242  
302→ 23F0 / 46893345  
303→ B4B4 / 07932908  
304→ DA4E / 03274644  
305→ D5F6 / 45445804

Pokud Wi-Fi nefunguje: zkontrolujte kabely a zkuste **restart** (vytáhnout napájení na 10 s, pak zapnout). Když to nepomůže, napište, **jakou síť vidíte**, pošleme správné heslo.

**Zvířata**
- **Psi jsou vítáni a zdarma**, jen prosíme **ne na postele/gauče**.

**Taxi (letiště)**
- Pro objednání potřebujeme: **číslo letu**, **čas příletu**, **telefon**, **počet osob a kufrů**, a zda **stačí sedan** nebo je potřeba **větší vůz**.  
- Na cestu **z hotelu na letiště** stačí čas vyzvednutí u hotelu.  
- **Ráno 8–9** a **15–17** mohou být **zácpy** (počítejte až **60 min**).  
- **Dětské sedačky** máme – napište **věk dítěte**.  
- Potvrzení:  
  *“I arranged the pick-up for you. The driver will be waiting in the arrival hall with your name on a sign. In case you can’t find each other, please call +420 722 705 919. The price is 31 EUR / 750 CZK (cash or card to the driver).”*  
  (Pro 5–8 osob nebo hodně zavazadel: **42 EUR / 1000 CZK**.)
`.trim();

    function mediaBlock() {
      if (!Array.isArray(MEDIA) || MEDIA.length === 0) return "";
      const lines = MEDIA.map((m, i) => {
        const url = new URL(`/${m.src}`, base.origin).toString();
        const caption = m.caption || `Foto ${i + 1}`;
        return `![${caption}](${url})`;
      });
      return `\n\n**Fotky / mapa / animace:**\n${lines.join("\n")}`;
    }

    // ---------- LOGIKA ----------
    const lastUserText =
      [...messages].reverse().find((m) => m.role === "user")?.content || "";
    let parsed = parseDatesStrict(lastUserText);

    // když datum není v poslední zprávě, zkusit vzít rozsah z historie
    let effectiveRange = parsed.confirmed || rangeFromHistory(messages);

    // načíst dostupnost pro každou NOC (from..to-1)
    let AVAILABILITY = null;
    if (effectiveRange) {
      const { from, to } = effectiveRange;
      const out = [];
      const start = new Date(from + "T00:00:00Z");
      const end = new Date(to + "T00:00:00Z"); // to = den odjezdu (exkluzivně)
      for (let cur = new Date(start); cur < end; cur.setUTCDate(cur.getUTCDate() + 1)) {
        const iso = toISODate(cur);
        const d = await gsGetParking(iso);
        if (!d || !d.ok || typeof d.total_spots === "undefined") {
          out.push({
            date: iso,
            ok: false,
            free: 0,
            total: 0,
            note: d?.error ? `err: ${d.error}` : (d?.raw ? `raw: ${String(d.raw).slice(0,200)}` : ""),
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
          (allFree
            ? "\n\nVšechny noci mají volno. Pošlete prosím jméno hosta, SPZ a čas příjezdu (HH:mm)."
            : anyFull
            ? "\n\nNěkteré noci jsou plné. Můžeme hledat jiný termín nebo doporučit alternativy (mrparkit.com)."
            : "\n\nU některých nocí chybí data, dostupnost je potřeba potvrdit."),
      };
    }

    // extrahovat detaily (jméno/SPZ/čas)
    const details = extractDetails(messages);

    // pokus o rezervaci, pokud máme všechno
    if (
      AVAILABILITY &&
      AVAILABILITY.allFree &&
      AVAILABILITY.nights > 0 &&
      details &&
      details.guest_name &&
      details.car_plate
    ) {
      const who = `${details.guest_name} / ${details.car_plate}`.trim(); // ukládáme jako "Jméno / SPZ"
      const bookedDates = [];
      let failed = null;

      // 1) ještě jednou ověřit volno pro každý den (race condition)
      for (const d of AVAILABILITY.days) {
        const check = await gsGetParking(d.date);
        if (!check?.ok || (Number(check.free) || 0) <= 0) {
          failed = { date: d.date, reason: "No free spot" };
          break;
        }
      }

      // 2) book po dnech
      if (!failed) {
        for (const d of AVAILABILITY.days) {
          const res = await gsPostBook(d.date, who, details.arrival_time || "");
          if (!res?.ok) {
            failed = { date: d.date, reason: res?.error || "Unknown error", raw: res?.raw };
            break;
          }
          bookedDates.push(d.date);
        }
      }

      // 3) rollback, pokud něco spadlo
      if (failed && bookedDates.length) {
        for (const date of bookedDates.reverse()) {
          await gsPostCancel(date, who).catch(() => {});
        }
      }

      if (!failed) {
        const list = AVAILABILITY.days.map((d) => `• ${d.date}`).join("\n");
        const instr = await translateIfNeeded(parkingInstructionsCZ, messages);

        const reply =
`✅ Rezervace zapsána (${AVAILABILITY.nights} nocí):
${list}
Host: ${details.guest_name}, SPZ: ${details.car_plate}, příjezd: ${details.arrival_time || "neuvedeno"}

${instr}${mediaBlock()}`;
        return ok(reply);
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

    // pokud máme dostupnost, ale ne detaily → vypiš dostupnost
    if (AVAILABILITY) return ok(AVAILABILITY.text);

    // pokud nemáme nic → ukaž formát dat
    if (!parsed.confirmed && parsed.ask) return ok(parsed.ask);

    return ok(
      "Pro rezervaci napište prosím datum ve formátu **DD.MM.–DD.MM.YYYY** (např. **20.09.–24.09.2025**)."
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ reply: `⚠️ Server error: ${String(err)}` }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
};
