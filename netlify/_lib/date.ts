// netlify/functions/_lib/date.js
// Sdílený parser datumů (CZ), bez závislostí, čisté JS.

export const pad = (n) => String(n).padStart(2, "0");
export const fmtISO = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
export const daysInMonth = (y, m) => new Date(y, m, 0).getDate();
export const clampDay = (y, m, d) => Math.min(d, daysInMonth(y, m));

const normalize = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** @returns {{confirmed: {from:string,to:string}|null, ask:string|null}} */
export function parseDatesSmart(text) {
  const now = new Date();
  const CY = now.getFullYear();
  const CM = now.getMonth() + 1;
  const t = normalize(text);

  // range: "od 15 do 17. 8. 2025" / "15–17.8.2025" / "15 - 17. 8"
  const reRange =
    /(?:od\s*)?(\d{1,2})\s*(?:-|–|až|do)\s*(\d{1,2})\s*[.\-/ ]*\s*(\d{1,2})?(?:[.\-/ ]*\s*(\d{2,4}))?/i;
  let m = reRange.exec(t);
  if (m) {
    let d1 = parseInt(m[1], 10);
    let d2 = parseInt(m[2], 10);
    let mo = m[3] ? parseInt(m[3], 10) : CM;
    let y = m[4] ? String(m[4]) : "";
    if (y && y.length === 2) y = (Number(y) > 50 ? "19" : "20") + y;
    let Y = y ? parseInt(y, 10) : CY;

    const hadYear = !!m[4];
    if (!hadYear && mo < CM) {
      const thisA = fmtISO(CY, CM, clampDay(CY, CM, d1));
      const thisB = fmtISO(CY, CM, clampDay(CY, CM, d2));
      const nextA = fmtISO(CY + 1, mo, clampDay(CY + 1, mo, d1));
      const nextB = fmtISO(CY + 1, mo, clampDay(CY + 1, mo, d2));
      return {
        ask: `Zadal jste měsíc, který už proběhl. Myslíte spíš **${thisA} až ${thisB}** (tento měsíc), nebo **${nextA} až ${nextB}** (příští rok)? Odpovězte prosím "tento měsíc" nebo "příští rok".`,
        confirmed: null,
      };
    }

    const A = fmtISO(Y, mo, clampDay(Y, mo, d1));
    const B = fmtISO(Y, mo, clampDay(Y, mo, d2));
    const from = A <= B ? A : B;
    const to = A <= B ? B : A;
    return { confirmed: { from, to }, ask: null };
  }

  // single day "15. 8. 2025"
  const reSingle = /(\d{1,2})\s*[.\-/ ]\s*(\d{1,2})(?:[.\-/ ]\s*(\d{2,4}))?/i;
  m = reSingle.exec(t);
  if (m) {
    let d = parseInt(m[1], 10);
    let mo = parseInt(m[2], 10);
    let y = m[3] ? String(m[3]) : "";
    if (y && y.length === 2) y = (Number(y) > 50 ? "19" : "20") + y;
    let Y = y ? parseInt(y, 10) : CY;

    if (!m[3] && mo < CM) {
      const thisA = fmtISO(CY, CM, clampDay(CY, CM, d));
      const nextA = fmtISO(CY + 1, mo, clampDay(CY + 1, mo, d));
      return {
        ask: `Zadal jste měsíc, který už proběhl. Myslíte spíš **${thisA}** (tento měsíc), nebo **${nextA}** (příští rok)?`,
        confirmed: null,
      };
    }
    const iso = fmtISO(Y, mo, clampDay(Y, mo, d));
    return { confirmed: { from: iso, to: iso }, ask: null };
  }

  return { confirmed: null, ask: null };
}

/**
 * Podporuje:
 *  - ASK s rozsahem: "**YYYY-MM-DD až YYYY-MM-DD**" (2x: this/next)
 *  - ASK s jedním dnem: "**YYYY-MM-DD**" (2x: this/next)
 * + rozpozná "tento měsíc" i "tento mesic", "příští/pristi rok".
 * @returns {{from:string,to:string}|null}
 */
export function resolveFromChoice(choice, askText) {
  if (!askText) return null;
  const txt = normalize(choice);

  const kind = txt.includes("tento mesic")
    ? "this"
    : txt.includes("pristi rok")
    ? "next"
    : null;
  if (!kind) return null;

  // 1) páry s "až"
  const pairMatches = [
    ...askText.matchAll(
      /\*\*(\d{4}-\d{2}-\d{2})\s+až\s+(\d{4}-\d{2}-\d{2})\*\*/g
    ),
  ].map((m) => ({ from: m[1], to: m[2] }));

  if (pairMatches.length >= 1) {
    if (pairMatches.length === 1) return pairMatches[0];
    return kind === "this" ? pairMatches[0] : pairMatches[1];
  }

  // 2) single ISO datumy
  const singleMatches = [
    ...askText.matchAll(/\*\*(\d{4}-\d{2}-\d{2})\*\*/g),
  ].map((m) => m[1]);

  if (singleMatches.length >= 1) {
    const iso = kind === "this" ? singleMatches[0] : (singleMatches[1] || singleMatches[0]);
    return { from: iso, to: iso };
  }

  return null;
}
