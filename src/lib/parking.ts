// Minimal client for Parking WebApp (Apps Script)
export type ParkingStatus = {
  ok: boolean;
  date: string;
  total_spots: number;
  booked: number;
  free: number;
  note: string;
  reservations: string[];
  error?: string;
};

const BASE_URL = 'https://script.google.com/macros/s/AKfycbwT-0NYJtJFGzHnZJwQv1psvOKS9qfKrx_qBPy3DgJlO7A-gIDvmUC1cujVDzdxq2pzRw/exec'; // ← sem dej tvůj webapp URL
const WRITE_API_KEY = ''; // pokud jsi nastavil v code.gs, vyplň i tady

function assertOk(res: Response) {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function getParking(date: string): Promise<ParkingStatus> {
  const u = new URL(BASE_URL);
  u.searchParams.set('fn', 'parking');
  u.searchParams.set('date', date);
  const r = await fetch(u.toString(), { method: 'GET' });
  assertOk(r);
  return r.json();
}

export async function setTotal(date: string, total: number): Promise<ParkingStatus> {
  const u = new URL(BASE_URL);
  u.searchParams.set('fn', 'set_total');
  u.searchParams.set('date', date);
  u.searchParams.set('total', String(total));
  const r = await fetch(u.toString(), { method: 'GET' });
  assertOk(r);
  return r.json();
}

type BookPayload = {
  date: string;
  who: string;           // jméno/ID/SPZ
  note?: string;         // optional – přepíše poznámku v listu
  total_spots?: number;  // optional – změní B:total_spots pro daný den
};

export async function bookSpot(p: BookPayload): Promise<ParkingStatus> {
  const r = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'book',
      date: p.date,
      who: p.who,
      note: p.note,
      total_spots: p.total_spots,
      apiKey: WRITE_API_KEY || undefined
    }),
  });
  assertOk(r);
  return r.json();
}

export async function cancelSpot(date: string, who: string): Promise<ParkingStatus> {
  const r = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'cancel',
      date,
      who,
      apiKey: WRITE_API_KEY || undefined
    }),
  });
  assertOk(r);
  return r.json();
}

/** Příklad použití:
(async () => {
  console.log(await getParking('2025-09-25'));
  console.log(await bookSpot({ date:'2025-09-25', who:'Room 301 / ABC-1234' }));
  console.log(await cancelSpot('2025-09-25', 'Room 301 / ABC-1234'));
})();
*/
