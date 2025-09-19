// netlify/functions/parking.ts
// Jednoduchý proxy endpoint: /api/parking?q=YYYY-MM-DD
// volá Apps Script: ?fn=parking&date=YYYY-MM-DD

export const config = { path: '/api/parking' };

export default async (req: Request) => {
  try {
    const SHEETS_API_URL = process.env.SHEETS_API_URL;
    if (!SHEETS_API_URL) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing SHEETS_API_URL' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }

    const url = new URL(req.url);
    const q = (url.searchParams.get('q') || '').trim(); // očekáváme YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(q)) {
      return new Response(JSON.stringify({ ok: false, error: 'Bad or missing q=YYYY-MM-DD' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }

    // zavoláme Apps Script (POZOR: SHEETS_API_URL MUSÍ být googleusercontent.com/…/echo)
    const gs = new URL(SHEETS_API_URL);
    gs.searchParams.set('fn', 'parking');
    gs.searchParams.set('date', q);

    const r = await fetch(gs.toString(), { method: 'GET' });
    const txt = await r.text();
    // Apps Script vrací JSON string — vrátíme ho dál jak přišel
    return new Response(txt, {
      status: r.ok ? 200 : r.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
};
