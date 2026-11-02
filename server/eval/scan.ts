// Live check of scan transcription (Claude reads scans; decided 2026-11-02). Sends each file in eval/scans/ to the
// model, applies the same readability rule as the intake engine, and prints the start of the transcript for review.
import { readFileSync } from "node:fs";
import { claudeModel } from "../src/engine/model.ts";
import { judgeTranscript } from "../src/engine/intake.ts";

const dir = new URL("./scans/", import.meta.url);
const cases = JSON.parse(readFileSync(new URL("cases.json", dir), "utf8"));
const model = claudeModel(); let failed = 0;
for (const k of cases) {
  const r = await model.transcribe!({ bytes: new Uint8Array(readFileSync(new URL(k.file, dir))), mime: k.mime });
  if (!r.ok) { failed++; console.log(`FAIL ${k.file}: transcription failed: ${r.reason}`); continue; }
  const j = judgeTranscript(r.value);
  const got = j.readable ? "received" : "received_unread";
  const missing = (k.mustContain ?? []).filter((w: string) => !r.value.toUpperCase().includes(w.toUpperCase()));
  const ok = got === k.expect && !missing.length; if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${k.file}: ${got} (want ${k.expect}); letters=${j.letters} illegible=${(100 * j.illegibleShare).toFixed(1)}%${missing.length ? " missing: " + missing.join(", ") : ""}`);
  for (const l of r.value.split("\n").slice(0, 25)) console.log("   │ " + l);
}
console.log(`\n${cases.length - failed}/${cases.length} passed`); process.exit(failed ? 1 : 0);
