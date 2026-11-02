// The only path from this server to the model. Zero data retention: this wrapper exposes one call,
// the Messages API with documents inline. No Files API, Batches, Managed Agents, Skills, MCP or code
// execution: those are outside the ZDR arrangement and Anthropic does not block them, so we never build them
// (test/zdr.test.ts fails the build if any appears in server/src).
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

export const MODEL = "claude-opus-5-5";
export type Effort = "low" | "medium" | "high";
export type Result<T> = { ok: true; value: T; model: string } | { ok: false; reason: string };

export interface Model {
  json<S extends z.ZodType>(a: { system: string; user: string; schema: S; effort: Effort; maxTokens: number }): Promise<Result<z.infer<S>>>;
}

export function claudeModel(client?: Anthropic): Model {
  let c = client;
  return {
    async json({ system, user, schema, effort, maxTokens }) {
      try {
        // ENGINE_ANTHROPIC_API_KEY lets the engine's key live under its own name, apart from any key the
        // hosting platform or a developer tool uses. Falls back to the SDK's default (ANTHROPIC_API_KEY).
        const k = process.env.ENGINE_ANTHROPIC_API_KEY?.trim();   // a pasted key often carries a trailing space or newline
        c ??= new Anthropic(k ? { apiKey: k } : {});
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
  };
}
