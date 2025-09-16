// netlify/functions/parking.ts
import { parseDatesSmart } from './_lib/date.js';

export default async (req: Request) => {
  try {
    const url = new URL(req.url);
    const q = url.searchParams.get('q') || '';
    const parsed = parseDatesSmart(q);
    return new Response(JSON.stringify({ ok: true, parsed }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: { 'content-type': 'application/json' }
    });
  }
};

export const config = {
  path: '/api/parking'
};
