// netlify/functions/_lib/date.js
// Utilita pro chytré parsování dat a následné rozřešení volby „tento měsíc / příští rok“

const toISO = (d) => d.toISOString().slice(0, 10);
const fmtISO = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const daysInMonth = (y, m) => new Date(y, m, 0).getDate();
const clampDay = (y, m, d) => Math.min(d, daysInMonth(y, m));

/**
 * parseDatesSmart("15.–17. 8") → { confirmed:{ from:"2025-08-15", to:"2025-08-17" }, ask:null }
 * Pokud je uveden měsíc v minulosti bez roku → vrátí ask (doptání).
 */
export function parseDatesSmart(text, now = new Date()) {
  const CY = now.getFullYear();
  const CM = now.getMonth() + 1;

  // Formáty: 15.8., 15-17.8, 12/09/2025 atd. (rok je volitelný)
  const re = /(\d{1,2})\s*[.\-/]\s*(\d{1,2})(?:\s*[.\-/]\s*(\d{2,4}))?/g;

  let hits = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    let [, d, mo, y] = m;
    let year = y ? (y.length === 2 ? (Number(y) > 50 ? 1900 + Number(y) : 2000 + Number(y)) : Number(y)) : null;
    hits.push({ d: Number(d), mo: Number(mo), y: year, hadYear: !!y });
  }

  if (hits.length === 0) return { confirmed: null, ask: null };

  const A = hits[0];
  const B = hits[1] || hits[0];

  if (!A.y) A.y = CY;
  if (!B.y) B.y = A.y;

  if (!A.mo && B.mo) A.mo = B.mo;
  if (!B.mo && A.mo) B.mo = A.mo;
  if (!A.mo) A.mo = CM;
  if (!B.mo) B.mo = A.mo;

  const Aa = { y: A.y, mo: A.mo, d: clampDay(A.y, A.mo, A.d) };
  const Bb = { y: B.y, mo: B.mo, d: clampDay(B.y, B.mo, B.d) };

  const isoA = fmtISO(Aa.y, Aa.mo, Aa.d);
  const isoB = fmtISO(Bb.y, Bb.mo, Bb.d);
  const from = isoA <= isoB ? isoA : isoB;
  const to   = isoA <= isoB ? isoB : isoA;

  // Pokud uživatel NEnapsal rok a měsíc je v minulosti → doptáme
  if (!A.hadYear && Aa.mo < CM) {
    const thisA = fmtISO(CY, Aa.mo, clampDay(CY, Aa.mo, Aa.d));
    const thisB = fmtISO(CY, Bb.mo, clampDay(CY, Bb.mo, Bb.d));
    const nextA = fmtISO(CY + 1, Aa.mo, clampDay(CY + 1, Aa.mo, Aa.d));
    const nextB = fmtISO(CY + 1, Bb.mo, clampDay(CY + 1, Bb.mo, Bb.d));
    const ask = `Zadal jste měsíc, který už proběhl. Myslíte spíš **${thisA} až ${thisB}** (tento měsíc), nebo **${nextA} až ${nextB}** (příští rok)? Odpovězte prosím "tento měsíc" nebo "příští rok", případně napište přesná data.`;
    return { confirmed: null, ask, options: { thisRange: { from: thisA, to: thisB }, nextRange: { from: nextA, to: nextB } } };
  }

  return { confirmed: { from, to }, ask: null };
}

/**
 * resolveFromChoice("tento měsíc" | "příští rok", parsed, now)
 * Vrátí { from, to } na základě ask-variant z parseDatesSmart.
 */
export function resolveFromChoice(choice, parsed, now = new Date()) {
  if (!parsed || !parsed.options) return null;
  const c = (choice || '').toLowerCase().trim();
  if (c.includes('tento')) return parsed.options.thisRange;
  if (c.includes('příšt') || c.includes('pristi')) return parsed.options.nextRange;
  return null;
}
