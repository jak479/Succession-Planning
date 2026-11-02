// Server-side text extraction for uploaded documents (intake-agent-spec § Infrastructure).
// A document is "received" only if this yields readable text; otherwise it is "received, unread" and goes to the
// attorney's queue. Scanned images are not OCR'd here yet: they land in the queue (rule 6).
import { unzipSync, strFromU8 } from "fflate";

export const MIN_LETTERS = 200;   // below this, treat as unreadable (scan, image, empty, password)

export async function extractText(bytes: Uint8Array, filename: string, mime: string): Promise<{ text: string; readable: boolean; reason?: string }> {
  try {
    let text = "";
    const ext = filename.toLowerCase().split(".").pop() ?? "";
    if (mime === "application/pdf" || ext === "pdf") {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      // Standard-14 fonts (Helvetica, Times) are often not embedded; pdf.js needs its bundled font data to read them.
      const standardFontDataUrl = new URL("../../node_modules/pdfjs-dist/standard_fonts/", import.meta.url).pathname;
      const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: false, verbosity: 0, standardFontDataUrl }).promise;
      const pages: string[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const c = await (await doc.getPage(i)).getTextContent();
        pages.push(`[page ${i}]\n` + c.items.map((it: any) => ("str" in it ? it.str : "")).join(" "));
      }
      text = pages.join("\n\n");
    } else if (ext === "docx" || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      const xml = strFromU8(unzipSync(bytes, { filter: f => f.name === "word/document.xml" })["word/document.xml"] ?? new Uint8Array());
      text = xml.replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    } else if (mime.startsWith("text/") || ext === "txt") {
      text = new TextDecoder().decode(bytes);
    } else {
      return { text: "", readable: false, reason: `unsupported file type (${mime || ext})` };
    }
    const letters = (text.match(/[A-Za-z]/g) ?? []).length;
    return letters >= MIN_LETTERS ? { text, readable: true } : { text, readable: false, reason: "no readable text (scan, image or empty)" };
  } catch (e) {
    return { text: "", readable: false, reason: "could not open: " + (e instanceof Error ? e.message : String(e)) };
  }
}
