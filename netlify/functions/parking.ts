// netlify/functions/parking.ts (DEBUG)
export const config = { path: '/api/parking' };

export default async (req: Request) => {
  try {
    const SHEETS_API_URL = process.env.SHEETS_API_URL || '';

    const url = new URL(req.url);
    const q = (url.searchParams.get('q') || '').trim();
    const debug = url.searchParams.get('debug') === '1';

    if (!q || !/^\d{4}-\d{2}-\d{2}$/.test(q)) {
      return json({ ok:false, error:'Bad or missing q=YYYY-MM-DD', got:q }, 400);
    }
    if (!SHEETS_API_URL) {
      return json({ ok:false, error:'Missing SHEETS_API_URL' }, 500);
    }

    // Postavit cílovou URL z SHEETS_API_URL
    // (musí to být googleusercontent.com/.../echo?...&lib=..., my přidáme fn & date)
    let built = '';
    let respTxt = '';
    let respCT = '';
    let status = 0;

    try {
      const gs = new URL(SHEETS_API_URL);      // ZDE se hned projeví, pokud je v env špatná URL
      gs.searchParams.set('fn', 'parking');
      gs.searchParams.set('date', q);

      built = gs.toString();

      const r = await fetch(built, { method:'GET' });
      status = r.status;
      respCT = r.headers.get('content-type') || '';
      respTxt = await r.text();

      // Ověřit, že je to JSON (jinak je to nejspíš HTML z Drive)
      const looksJSON = respCT.includes('application/json') || /^[\s]*\{/.test(respTxt);
      if (!looksJSON) {
        return json({
          ok:false,
          error:'Apps Script did not return JSON (pravděpodobně špatná URL v SHEETS_API_URL).',
          note:'SHEETS_API_URL MUSÍ být googleusercontent.com/.../echo?...&lib=...',
          status,
          respCT,
          sample: respTxt.slice(0, 200),
          SHEETS_API_URL,
          built
        }, 502);
      }

      // Pokud debugujeme, vraťte diagnostiku
      if (debug) {
        return json({
          ok:true,
          debug:true,
          status,
          respCT,
          respFirst200: respTxt.slice(0, 200),
          SHEETS_API_URL,
          built
        });
      }

      // jinak vraťte, co vrátil Apps Script
      return new Response(respTxt, {
        status: r.ok ? 200 : r.status,
        headers: { 'content-type': 'application/json', 'cache-control':'no-store' }
      });
    } catch (e:any) {
      return json({
        ok:false,
        error:String(e?.message || e),
        SHEETS_API_URL,
        built
      }, 500);
    }
  } catch (e:any) {
    return json({ ok:false, error:String(e?.message || e) }, 500);
  }
};

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control':'no-store' }
  });
}
