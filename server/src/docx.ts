// Word export for the drafting tool (docs/design/drafting-tool.md § 3). Pure: text in, .docx bytes out.
// Clean copy: the version's text as Word paragraphs. Redline: native tracked changes (w:ins / w:del) between two
// versions, so opposing counsel or a bank can accept or reject each change in Word.
// Markdown handled: #/##/### headings, paragraphs (one per line), **bold**, *italic*, "---" rules. Nothing else.
import { zipSync, strToU8 } from "fflate";

type Seg = { text: string; b: boolean; i: boolean };
type Para = { style: "Title" | "Heading1" | "Heading2" | "Heading3" | "Normal"; segs: Seg[]; rule?: boolean };

const xml = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** Split a markdown line into formatted segments: **bold**, *italic*. Unmatched markers stay as text. */
export function inline(line: string): Seg[] {
  const out: Seg[] = []; const re = /\*\*([^*]+)\*\*|\*([^*]+)\*/g; let at = 0, m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index > at) out.push({ text: line.slice(at, m.index), b: false, i: false });
    out.push(m[1] !== undefined ? { text: m[1], b: true, i: false } : { text: m[2], b: false, i: true });
    at = re.lastIndex;
  }
  if (at < line.length) out.push({ text: line.slice(at), b: false, i: false });
  return out;
}

export function paragraphs(md: string): Para[] {
  return md.split("\n").map(l => l.trimEnd()).filter(l => l.length).map(l => {
    if (/^-{3,}$/.test(l)) return { style: "Normal" as const, segs: [], rule: true };
    const h = /^(#{1,3})\s+(.*)$/.exec(l);
    if (h) return { style: (["Heading1", "Heading2", "Heading3"] as const)[h[1].length - 1], segs: inline(h[2]) };
    return { style: "Normal" as const, segs: inline(l) };
  });
}

const rPr = (s: Seg) => s.b || s.i ? `<w:rPr>${s.b ? "<w:b/>" : ""}${s.i ? "<w:i/>" : ""}</w:rPr>` : "";
const run = (s: Seg, del = false) => `<w:r>${rPr(s)}<w:${del ? "delText" : "t"} xml:space="preserve">${xml(s.text)}</w:${del ? "delText" : "t"}></w:r>`;
const pPr = (p: Para) => `<w:pPr>${p.style !== "Normal" ? `<w:pStyle w:val="${p.style}"/>` : ""}${p.rule ? '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr>' : ""}</w:pPr>`;

type Mark = { author: string; date: string; id: () => number };
const ins = (m: Mark, body: string) => body ? `<w:ins w:id="${m.id()}" w:author="${xml(m.author)}" w:date="${m.date}">${body}</w:ins>` : "";
const del = (m: Mark, body: string) => body ? `<w:del w:id="${m.id()}" w:author="${xml(m.author)}" w:date="${m.date}">${body}</w:del>` : "";

/** Longest-common-subsequence diff over any token list. */
export function diff<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): { op: "=" | "-" | "+"; a?: T; b?: T }[] {
  const n = a.length, m = b.length, L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = eq(a[i], b[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: { op: "=" | "-" | "+"; a?: T; b?: T }[] = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (eq(a[i], b[j])) { out.push({ op: "=", a: a[i], b: b[j] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: "-", a: a[i++] });
    else out.push({ op: "+", b: b[j++] });
  }
  while (i < n) out.push({ op: "-", a: a[i++] });
  while (j < m) out.push({ op: "+", b: b[j++] });
  return out;
}

// Words, whitespace and punctuation are separate tokens, so "[Name]," against "Luis Herrera," changes only the name.
const words = (segs: Seg[]): Seg[] => segs.flatMap(s => s.text.split(/(\s+|[,.;:()"“”])/).filter(Boolean).map(t => ({ ...s, text: t })));
const sameSeg = (x: Seg, y: Seg) => x.text === y.text && x.b === y.b && x.i === y.i;
const samePara = (x: Para, y: Para) => x.style === y.style && !!x.rule === !!y.rule && x.segs.length === y.segs.length && x.segs.every((s, k) => sameSeg(s, y.segs[k]));
/** Join runs of tokens with the same formatting, so Word gets few runs. */
const runs = (toks: Seg[], d = false) => toks.reduce<Seg[]>((acc, t) => { const l = acc[acc.length - 1]; if (l && l.b === t.b && l.i === t.i) l.text += t.text; else acc.push({ ...t }); return acc; }, []).map(s => run(s, d)).join("");

function changedPara(m: Mark, a: Para, b: Para): string {
  const ops = diff(words(a.segs), words(b.segs), sameSeg);
  // Blocks of equal text and of changes. A whitespace-only equal block between two changes joins them, so one
  // replacement reads as one deletion and one insertion.
  type Block = { eq: boolean; old: Seg[]; neu: Seg[] };
  const blocks: Block[] = [];
  for (const o of ops) {
    const eq = o.op === "=", last = blocks[blocks.length - 1];
    const blk = last && last.eq === eq ? last : (blocks.push({ eq, old: [], neu: [] }), blocks[blocks.length - 1]);
    if (o.op !== "+") blk.old.push(o.a!); if (o.op !== "-") blk.neu.push(o.b!);
  }
  const merged: Block[] = [];
  for (let k = 0; k < blocks.length; k++) {
    const x = blocks[k], prev = merged[merged.length - 1], next = blocks[k + 1];
    if (x.eq && prev && !prev.eq && next && !next.eq && x.neu.every(s => /^\s+$/.test(s.text))) {
      prev.old.push(...x.old, ...next.old); prev.neu.push(...x.neu, ...next.neu); k++; continue;
    }
    if (!x.eq && prev && !prev.eq) { prev.old.push(...x.old); prev.neu.push(...x.neu); continue; }
    merged.push({ eq: x.eq, old: [...x.old], neu: [...x.neu] });
  }
  const body = merged.map(x => x.eq ? runs(x.neu) : del(m, runs(x.old, true)) + ins(m, runs(x.neu))).join("");
  return `<w:p>${pPr(b)}${body}</w:p>`;
}
// A wholly inserted or deleted paragraph also marks its paragraph mark, so accepting or rejecting removes the line.
const insPara = (m: Mark, p: Para) => `<w:p><w:pPr>${pPr(p).slice(7, -8)}<w:rPr><w:ins w:id="${m.id()}" w:author="${xml(m.author)}" w:date="${m.date}"/></w:rPr></w:pPr>${ins(m, runs(p.segs))}</w:p>`;
const delPara = (m: Mark, p: Para) => `<w:p><w:pPr>${pPr(p).slice(7, -8)}<w:rPr><w:del w:id="${m.id()}" w:author="${xml(m.author)}" w:date="${m.date}"/></w:rPr></w:pPr>${del(m, runs(p.segs, true))}</w:p>`;

function body(md: string): string { return paragraphs(md).map(p => `<w:p>${pPr(p)}${runs(p.segs)}</w:p>`).join(""); }

function redlineBody(oldMd: string, newMd: string, author: string, date: string): string {
  let n = 1; const m: Mark = { author, date, id: () => n++ };
  const ops = diff(paragraphs(oldMd), paragraphs(newMd), samePara);
  let out = "";
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].op === "=") { const p = ops[k].b!; out += `<w:p>${pPr(p)}${runs(p.segs)}</w:p>`; continue; }
    // Pair a run of deletions with the insertions that follow, line for line, so small edits show word by word.
    const dels: Para[] = [], adds: Para[] = [];
    while (k < ops.length && ops[k].op === "-") dels.push(ops[k++].a!);
    while (k < ops.length && ops[k].op === "+") adds.push(ops[k++].b!);
    k--;
    const pairs = Math.min(dels.length, adds.length);
    for (let x = 0; x < pairs; x++) out += changedPara(m, dels[x], adds[x]);
    for (let x = pairs; x < dels.length; x++) out += delPara(m, dels[x]);
    for (let x = pairs; x < adds.length; x++) out += insPara(m, adds[x]);
  }
  return out;
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="264" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:jc w:val="center"/><w:spacing w:before="240"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>
</w:styles>`;

function pack(bodyXml: string, opts: { title: string; track: boolean }): Uint8Array {
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${bodyXml}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`),
    "word/_rels/document.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>`),
    "word/document.xml": strToU8(doc),
    "word/styles.xml": strToU8(STYLES),
    // Redlines open with Track Changes on, so the reader's own edits are tracked too.
    "word/settings.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings ${W}>${opts.track ? "<w:trackRevisions/>" : ""}</w:settings>`),
    "docProps/core.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xml(opts.title)}</dc:title></cp:coreProperties>`),
  });
}

/** Clean Word copy of a version's text. */
export function docxClean(md: string, title: string): Uint8Array { return pack(body(md), { title, track: false }); }
/** Word redline from `oldMd` to `newMd`, with native tracked changes attributed to `author` at `date` (ISO). */
export function docxRedline(oldMd: string, newMd: string, title: string, author: string, date: string): Uint8Array {
  return pack(redlineBody(oldMd, newMd, author, date.replace(/\.\d{3}Z$/, "Z")), { title, track: true });
}
