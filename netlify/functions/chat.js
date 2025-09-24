// netlify/functions/chat.js

const TRANSLATE_INSTRUCTIONS = true;
// Přidej verzi pro kontrolu
const VERSION = "chatjs-2025-09-24-langflow-v1";

export default async (req) => {
  const ok = (reply) =>
    new Response(JSON.stringify({ reply: reply + `\n\n— ${VERSION}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const userErr = (msg) => ok(`⚠️ ${msg}`);

  try {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    let body = {};
    try { body = await req.json(); } catch { return new Response("Bad JSON body", { status: 400 }); }
    const { messages = [] } = body;

    const OPENAI_API_KEY   = process.env.OPENAI_API_KEY;
    const PARKING_API_URL  = process.env.PARKING_API_URL;
    const PARKING_WRITE_KEY= process.env.PARKING_WRITE_KEY || "";
    if (!PARKING_API_URL) return userErr('Server: chybí PARKING_API_URL. Nastav v Netlify na URL Apps Script WebApp (končící na /exec).');

    const base = new URL(req.url);
    async function loadJSON(path) {
      try {
        const r = await fetch(new URL(path, base.origin), { headers: { "cache-control": "no-cache" } });
        if (!r.ok) return null;
        return await r.json();
      } catch { return null; }
    }
    const MEDIA = (await loadJSON("/data/parking_media.json")) || [];

    const lastUserText = () => [...messages].reverse().find(m=>m.role==='user')?.content || '';
    const userCount = messages.filter(m=>m.role==='user').length;
    const assistantCount = messages.filter(m=>m.role==='assistant').length;

    // ========= JAZYK =========
    const SUPPORTED = { cs: "Čeština", en: "English", de: "Deutsch", es: "Español" };

    function getChosenLangFromHistory(msgs){
      for (let i=msgs.length-1;i>=0;i--){
        const c = msgs[i]?.content || "";
        const m = /⟦lang:(cs|en|de|es)⟧/.exec(String(c));
        if (m) return m[1];
      }
      return null;
    }
    function wantsLanguage(text){
      const t = (text||"").toLowerCase();
      if (/(čeština|cestina|česky|cz|cs)\b/.test(t)) return "cs";
      if (/\ben(glish)?\b|\ben\b/.test(t)) return "en";
      if (/\bespañol|\bes\b|span(ish)?/.test(t)) return "es";
      if (/\bdeutsch|\bger(man)?|\bde\b/.test(t)) return "de";
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
      const sample = Object.values(SUPPORTED).join(", ");
      const msgs = [
        { role: "system", content: `Translate to ${SUPPORTED[lang]}. Keep formatting and meaning.` },
        { role: "user", content: text }
      ];
      const out = await callOpenAI(msgs);
      return out || text;
    }

    // ========= TEXTY =========
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

    // Intenty (beze změn)
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

    // ======= Datumové utility & parking – (ponechávám tvoje existující funkce) =======
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
      const to   = isoA<=isoB ? isoB : isoA;
      return { confirmed:{ from, to }, ask:null };
    }

    function rangeFromHistory(msgs){
      for (let i=msgs.length-1;i>=0;i--){
        const m = msgs[i];
        if (!m || !m.content) continue;
        const mm = /Dostupnost pro \*\*(\d{4}-\d{2}-\d{2})\s*→\s*(\d{4}-\d{2}-\d{2})\*\*/.exec(String(m.content));
        if (mm) return { from:mm[1], to:mm[2] };
      }
      return null;
    }

    async function gsGetParking(dateISO){ /* ... beze změn ... */ }
    async function gsPostBook(dateISO, who, note){ /* ... beze změn ... */ }
    async function gsPostCancel(dateISO, who){ /* ... beze změn ... */ }

    // ======= Onboarding varianty =======
    function onboardingForLang(lang){
      // anglický zdroj > překlad do cíle
      return onboardingBundleEN();
    }

    // ======= 0) Vyhodnocení jazyka (nejdřív) =======
    const userText = lastUserText();
    let chosenLang = getChosenLangFromHistory(messages);

    // Pokud uživatel explicitně požádá o jazyk, přepneme
    const requestedLang = wantsLanguage(userText);
    if (requestedLang && requestedLang !== chosenLang) {
      chosenLang = requestedLang;
      const reply = await translateTo("Language switched.", chosenLang);
      return ok(`⟦lang:${chosenLang}⟧\n${reply}`);
    }

    // Pokud není zvolen jazyk a je to první zpráva uživatele → zeptej se na jazyk
    const isFirstUserTurn = userCount === 1; // UI bublina nevadí
    if (!chosenLang && isFirstUserTurn) {
      return ok(`${LangQuestionEN}`);
    }

    // Pokud stále není jazyk zvolen (uživatel neodpověděl kódem), zkus rozumné výchozí:
    if (!chosenLang) {
      // heuristika: když text obsahuje diakritiku typu "Pošleš mi to v češtině", přepni cs, jinak en
      chosenLang = /[ěščřžýáíéůúĚŠČŘŽÝÁÍÉŮÚ]|češtin|česky|cz|cs/i.test(userText) ? "cs" : "en";
      // zapíšeme marker, aby se držel
      const note = await translateTo("Okay, I will continue in this language.", chosenLang);
      return ok(`⟦lang:${chosenLang}⟧\n${note}`);
    }

    // ======= 1) Onboarding: když už máme zvolený jazyk a jde o první interakci po výběru =======
    const userHasOnlyLangChoice = userCount === 2 && /⟦lang:/.test(messages.map(m=>m.content).join(""));
    if (userHasOnlyLangChoice || (isFirstUserTurn && chosenLang)) {
      const bundleEN = onboardingForLang(chosenLang);
      const translated = await translateTo(bundleEN, chosenLang);
      return ok(translated);
    }

    // ======= 2) Dál už router (vždy překládej do chosenLang) =======
    const intent = detectIntent(userText);

    // Ne-parkovací stručná odpověď
    if (intent !== "parking" && intent !== "unknown") {
      return ok(await translateTo("How can I help you further? (Wi-Fi, taxi, parking, AC, power…)", chosenLang));
    }

    // ======= 3) Parking flow (stejné, ale výstupy překládat do chosenLang) =======
    // ... (tvoje existující parking logika)
    // kde dřív bylo např.:
    // return ok(AVAILABILITY.text);
    // teď dělej:
    // return ok(await translateTo(AVAILABILITY.text, chosenLang));

    // Ukázka dvou míst, která určitě přelož:
    // a) žádost o termín
    const parsed = parseDatesStrict(userText);
    if (intent === "parking" && !parsed.confirmed && !rangeFromHistory(messages)) {
      const ask = parsed.ask || "Napište prosím termín parkování ve formátu **DD.MM.–DD.MM.YYYY**.";
      return ok(await translateTo(ask, chosenLang));
    }

    // ... (doplníš překlady i u potvrzení rezervace, chybových hlášek, atd.)

    // fallback
    return ok(await translateTo("How can I help you further? (Wi-Fi, taxi, parking, AC, power…)", chosenLang));

  } catch (err) {
    return new Response(JSON.stringify({ reply: `⚠️ Server error: ${String(err)}` }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  }
};
