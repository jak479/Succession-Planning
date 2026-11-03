// The only path from this server to the model. Zero data retention: this wrapper exposes one call,
// the Messages API with documents inline. No Files API, Batches, Managed Agents, Skills, MCP or code
// execution: those are outside the ZDR arrangement and Anthropic does not block them, so we never build them
// (test/zdr.test.ts fails the build if any appears in server/src).
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { oidcFederationProvider } from "@anthropic-ai/sdk/lib/credentials/oidc-federation";
import type { z } from "zod";

export const MODEL = "claude-opus-5-5";
export type Effort = "low" | "medium" | "high";
export type Result<T> = { ok: true; value: T; model: string } | { ok: false; reason: string };

export interface Model {
  json<S extends z.ZodType>(a: { system: string; user: string; schema: S; effort: Effort; maxTokens: number }): Promise<Result<z.infer<S>>>;
  /** Transcribe a scanned PDF or image. The file goes inline in the request (ZDR-eligible), never to the Files API. */
  transcribe?(a: { bytes: Uint8Array; mime: string }): Promise<Result<string>>;
}

const TRANSCRIBE_SYSTEM = `You transcribe scanned business documents for a law firm's file. Transcribe all text exactly as written, in reading order, page by page, starting each page with [page N]. Keep headings, section numbers, names, dates and amounts exactly. Write [illegible] for any word you cannot read. Do not summarize, correct, interpret or add anything. Output only the transcription.`;
export const TRANSCRIBE_MEDIA = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"]);

// On Google Cloud Run (K_SERVICE is set by Cloud Run), the server proves its identity with a Google-signed token
// from the metadata server and exchanges it for a short-lived Anthropic token: no API key exists anywhere.
// Source: platform.claude.com/docs/en/manage-claude/wif-providers/gcp (read 2026-11-02).
const GCP_IDENTITY = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=https://api.anthropic.com&format=full";
function newClient(): Anthropic {
  if (process.env.K_SERVICE && process.env.ANTHROPIC_FEDERATION_RULE_ID && process.env.ANTHROPIC_ORGANIZATION_ID) {
    return new Anthropic({ credentials: oidcFederationProvider({
      identityTokenProvider: async () => (await fetch(GCP_IDENTITY, { headers: { "Metadata-Flavor": "Google" } })).text(),
      federationRuleId: process.env.ANTHROPIC_FEDERATION_RULE_ID, organizationId: process.env.ANTHROPIC_ORGANIZATION_ID,
      serviceAccountId: process.env.ANTHROPIC_SERVICE_ACCOUNT_ID || undefined, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID || undefined,
      baseURL: "https://api.anthropic.com", fetch,
    }) } as ConstructorParameters<typeof Anthropic>[0]);
  }
  // ENGINE_ANTHROPIC_API_KEY lets the engine's key live under its own name; otherwise the SDK's default chain
  // (ANTHROPIC_API_KEY, or the federation variables with an identity-token file, as in GitHub Actions).
  const k = process.env.ENGINE_ANTHROPIC_API_KEY?.trim();
  const w = process.env.ENGINE_ANTHROPIC_WORKSPACE_ID?.trim();
  return new Anthropic({ ...(k ? { apiKey: k } : {}), ...(w ? { defaultHeaders: { "anthropic-workspace-id": w } } : {}) });
}

export function claudeModel(client?: Anthropic): Model {
  let c = client;
  return {
    async json({ system, user, schema, effort, maxTokens }) {
      try {
        c ??= newClient();
        const r = await c.messages.parse({
          model: MODEL,
          max_tokens: maxTokens,
          cache_control: { type: "ephemeral" },   // ZDR-eligible; the static system prompt and documents are the prefix
          system,
          messages: [{ role: "user", content: user }],
          output_config: { effort, format: zodOutputFormat(schema) },
        });
        if (r.stop_reason === "refusal") return { ok: false, reason: "model declined" + (r.stop_details?.category ? ` (${r.stop_details.category})` : "") };
        if (r.stop_reason === "max_tokens") return { ok: false, reason: "output cut off at max_tokens" };
        if (r.parsed_output == null) return { ok: false, reason: "output did not match the schema" };
        return { ok: true, value: r.parsed_output as z.infer<typeof schema>, model: r.model };
      } catch (e) {
        if (e instanceof Anthropic.APIError) return { ok: false, reason: `API error ${e.status ?? ""}: ${e.message}` };
        return { ok: false, reason: "engine unavailable: " + (e instanceof Error ? e.message : String(e)) };
      }
    },
    async transcribe({ bytes, mime }) {
      try {
        if (!TRANSCRIBE_MEDIA.has(mime)) return { ok: false, reason: `cannot transcribe ${mime}` };
        c ??= newClient();
        const data = Buffer.from(bytes).toString("base64");
        const file = mime === "application/pdf"
          ? { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data } }
          : { type: "image" as const, source: { type: "base64" as const, media_type: mime as "image/png" | "image/jpeg" | "image/gif" | "image/webp", data } };
        const r = await c.messages.stream({
          model: MODEL, max_tokens: 64000, system: TRANSCRIBE_SYSTEM, output_config: { effort: "low" },
          messages: [{ role: "user", content: [file, { type: "text", text: "Transcribe this document." }] }],
        }).finalMessage();
        if (r.stop_reason === "refusal") return { ok: false, reason: "model declined" };
        if (r.stop_reason === "max_tokens") return { ok: false, reason: "document too long to transcribe in full" };
        const text = r.content.map(b => (b.type === "text" ? b.text : "")).join("");
        return { ok: true, value: text, model: r.model };
      } catch (e) {
        if (e instanceof Anthropic.APIError) return { ok: false, reason: `API error ${e.status ?? ""}: ${e.message}` };
        return { ok: false, reason: "engine unavailable: " + (e instanceof Error ? e.message : String(e)) };
      }
    },
  };
}
