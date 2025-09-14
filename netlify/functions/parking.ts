// netlify/functions/parking.ts
// REST endpoint pro přímé požadavky na parkování (mimo chat UI).
// - parsuje datumy přes sdílený parser
// - doptá "tento měsíc / příští rok"
// - čte dostupnost a zapisuje rezervaci přes Apps Script (SHEETS_API_URL nebo fallback)
// - pokud dostane guest.name + guest.car_plate (+ volitelně guest.email), zapíše a Apps Script může poslat instrukce

export const config = { runtime: 'node' };

import type { Range } from '../../src/lib/date';
import { parseDatesSmart, resolveFromChoice } from '../../src/lib/date';

// Tvůj Apps Script EXEC URL – bezpečný fallback, když není env
const SHEETS_URL_FALLBACK =
  'https://script.google.com/macros/s/AKfycbzwiAqnD3JOMkMhNG4mew0zCsEp-ySA8WBgutQ38n6ZkF15SBVGU_no6gCPJqPnRAcohg/exec';

// Bezpečné načtení env (nevoláme .trim() na undefined)
const SHEETS_API_URL: string =
  (`${process.env.SHEETS_API_URL ?? ''}`).trim() || SHEETS_URL_FALLBACK;

// Validace URL při startu
try { new URL(SHEETS_API_URL); } catch { throw new Error('Invalid SHEETS_API_URL (env + fallback)'); }

export default async (req: Request) => {
  try {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // ---- BODY ----
    let body: any = {};
    try { body = await req.json(); } catch { return new Response('Bad JSON body', { status: 400 }); }
    const { userText = '', choice, guest = {} } = body;

    // ---- Apps Script helpers ----
    const gsGet = async (params: Record<string, string>) => {
      const url = new URL(SHEETS_API_URL);
      Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, String(v)));
      const r = await fetch(url.toString());
      if (!r.ok) throw new Error(`Sheets GET ${r.status} ${await r.text().catch(()=> '')}`);
      return await r.json();
    };
    const gsPost = async (payload: any) => {
      const r = await fetch(SHEETS_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {})
      });
      if (!r.ok) throw new Error(`Sheets POST ${r.status} ${await r.text().catch(()=> '')}`);
      return await r.json();
    };

    // ---- Date utils ----
    const toISO = (d: Date) => d.toISOString().slice(0, 10);

    // ---- 1) Rozsah z textu / doptání ----
    const parsed = parseDatesSmart(userText);
    let range: Range | null = parsed.confirmed;

    if (!range && parsed.ask && !choice) {
      return new Response(JSON.stringify({ ok: true, needChoice: true, message: parsed.ask }), {
        status: 200, headers: { 'content-type': 'application/json' }
      });
    }
    if (!range && parsed.ask && choice) {
      range = resolveFromChoice(choice, parsed.ask);
      if (!range) {
        return new Response(JSON.stringify({ ok:false, error:'bad choice' }), { status: 400 });
      }
    }
    if (!range) {
      return new Response(JSON.stringify({ ok:false, error:'no date found' }), { status: 400 });
    }

    // ---- 2) Předběžná dostupnost den po dni ----
    const days: string[] = [];
    {
      const start = new Date(range.from + 'T00:00:00Z');
      const end   = new Date(range.to   + 'T00:00:00Z');
      for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        days.push(toISO(d));
      }
    }

    const availability = await Promise.all(days.map(async (d) => {
      try { return await gsGet({ fn: 'parking', date: d }); }
      catch (e) { return { ok:false, error:String(e) }; }
    }));

    // ---- 3) Máme jméno + SPZ? Zapiš rezervaci ----
    let wrote: null | { id: string } = null;
    if (guest?.name && guest?.car_plate) {
      const payload = {
        fn: 'reserveParking',
        from_date: range.from,
        to_date: range.to,
        guest_name: guest.name,
        car_plate: guest.car_plate,
        channel: 'Direct',
        arrival_time: guest.arrival_time || '',
        note: guest.note || '',
        guest_email: guest.email || ''
      };
      // DEBUG
      console.log('reserveParking payload:', payload);
      const r = await gsPost(payload);
      if (r && r.ok && r.id) {
        wrote = { id: String(r.id) };
      }
    }

    // ---- 4) Odpověď ----
    const message = wrote
      ? `✅ Rezervace potvrzena. ID: ${wrote.id}.`
      : `Potvrzuji zájem o parkování ${range.from} až ${range.to}. Pro finální potvrzení pošlete jméno a SPZ.`;

    return new Response(JSON.stringify({
      ok: true,
      range,
      days: days.map((d, i) => ({ date: d, sheet: availability[i] })),
      wrote,
      message
    }), { status: 200, headers: { 'content-type': 'application/json' } });

  } catch (err: any) {
    return new Response(`Function error: ${String(err)}`, {
      status: 500, headers: { 'content-type': 'text/plain' }
    });
  }
};
