// netlify/functions/parking.ts
// Proxy na Google Apps Script (CHILL Bot Data API) pro dotaz na dostupnost parkování

export default async (req: Request) => {
  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get('q') || '').trim();

    // kontrola datumu: YYYY-MM-DD
    const isISO = /^\d{4}-\d{2}-\d{2}$/.test(q);
    if (!isISO) {
      return json({ ok: false, error: 'bad date format, use YYYY-MM-DD', q }, 400);
    }

    const SHEETS_API_URL = process.env.SHEETS_API_URL;
    if (!SHEETS_API_URL) {
      return json({ ok: false, error: 'Missing SHEETS_API_URL env var' }, 500);
    }

    // volání Apps Script WebApp: GET ?fn=parking&date=YYYY-MM-DD
    const gsUrl = new URL(SHEETS_API_URL);
    gsUrl.searchParams.set('fn', 'parking');
    gsUrl.searchParams.set('date', q);

    const r = await fetch(gsUrl.toString(), { method: 'GET' });
    const text = await r.text();

    // zkus JSON, jinak vrať text pro debug (někdy Apps Script vrátí HTML chybovou stránku)
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* leave data = null */ }

    if (!r.ok) {
      return json({
        ok: false,
        error: `Sheets GET ${r.status}`,
        body: data ?? text
      }, r.status);
    }

    // očekávaný tvar: { ok:true, date, total_spots, booked, free, note }
    return json(data ?? { ok: true, raw: text }, 200);

  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
};

// Netlify route: /api/parking?q=YYYY-MM-DD
export const config = { path: '/api/parking' };

// --- Pomocná funkce pro jednotný JSON výstup ---
function json(obj: any, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
