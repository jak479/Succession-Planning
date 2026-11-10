// Florida statutes confirmed against the official text, with the date read (CLAUDE.md, Conventions). Used by the
// drafting tool's review to flag any citation in a draft that has not been read at the source. Deterministic: this
// check never goes to the model. Add a section here only after reading it on flsenate.gov / Online Sunshine.
const range = (ch: string, from: number, to: number, width: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${ch}.${String(from + i).padStart(width, "0")}`);

export const CONFIRMED: Record<string, string> = Object.fromEntries([
  ...["605.0602", "709.2202"].map(s => [s, "2026-11-01"]),
  ...["605.0405", "605.0102", "605.0406", "605.04091", "605.04092"].map(s => [s, "2026-11-03"]),
  ...["709.2105", "709.2208", "117.209", "117.265", "117.285", "668.50"].map(s => [s, "2026-11-08"]),
  ...[...range("605", 105, 107, 4), "605.0302", "605.0401", "605.0407", ...range("605", 4071, 4074, 5), "605.0408", "605.0504",
      "605.0603", "605.0701", "605.0702", "709.2102", "709.2104", "709.2109", ...range("709", 2111, 2114, 4), "709.2119", "709.2120",
      "709.2201"].map(s => [s, "2026-11-08"]),
  ...["95.11", "95.031", "501.171"].map(s => [s, "2026-11-10"]),
]);

/** Section numbers cited in a text: numbers that follow "§", "§§", "section(s)", "s." or "ss." directly or within an
 *  unbroken list of sections ("§§ 709.2104, 709.2105", "§ 605.0701–605.0713", "§ 605.04091(6)(b) and 605.0405"). */
export function citedSections(text: string): string[] {
  const out = new Set<string>();
  const marker = /(?:§§?|\bsections?\b|\bss?\.)\s*/gi;
  const sec = /(\d{2,3}\.\d{2,6})((?:\([0-9a-z]+\))*)/iy, sep = /\s*(?:,|–|-|\band\b|\bor\b)\s*/iy;
  for (const m of text.matchAll(marker)) {
    let at = m.index! + m[0].length;
    for (;;) {
      sec.lastIndex = at; const s = sec.exec(text); if (!s) break;
      out.add(s[1]); at = sec.lastIndex;
      sep.lastIndex = at; const p = sep.exec(text); if (!p) break; at = sep.lastIndex;
    }
  }
  return [...out].sort();
}

/** Cited sections not in CONFIRMED. Ranges ("§§ 605.0701–605.0713") count both ends. */
export function unconfirmedCitations(text: string): string[] {
  return citedSections(text).filter(s => !CONFIRMED[s]);
}
