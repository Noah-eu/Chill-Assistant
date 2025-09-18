// netlify/functions/parking.ts
// Jednoduchý parser => pouze vrací from/to (nocí = departure - arrival)

const fmtISO = (y:number,m:number,d:number) =>
  `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
const dim = (y:number,m:number) => new Date(y, m, 0).getDate();
const clamp = (y:number,m:number,d:number) => Math.min(d, dim(y,m));

function parseStrictRange(q: string) {
  // Očekáváme přesně: DD.MM.–DD.MM.YYYY nebo DD.MM.-DD.MM.YYYY
  // Skupiny: d1 m1 d2 m2 y
  const re = /^\s*(\d{1,2})\.(\d{1,2})\.\s*[–-]\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s*$/;
  const m = q.match(re);
  if (!m) return { confirmed: null, ask: 'Použijte formát DD.MM.–DD.MM.YYYY (např. 20.09.–24.09.2025).' };

  const d1 = Number(m[1]), m1 = Number(m[2]), d2 = Number(m[3]), m2 = Number(m[4]), y = Number(m[5]);

  const a = { y, mo: m1, d: clamp(y, m1, Math.min(d1, d2)) };
  const b = { y, mo: m2, d: clamp(y, m2, Math.max(d1, d2)) };

  const isoA = fmtISO(a.y, a.mo, a.d);
  const isoB = fmtISO(b.y, b.mo, b.d);
  const from = isoA <= isoB ? isoA : isoB;
  const to   = isoA <= isoB ? isoB : isoA;

  return { confirmed: { from, to }, ask: null };
}

export default async (req: Request) => {
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get('q') || '';
    const parsed = parseStrictRange(q);

    return new Response(JSON.stringify({ ok: true, parsed }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  } catch (e:any) {
    return new Response(JSON.stringify({ ok:false, error: String(e) }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }
};

export const config = { path: '/api/parking' };
