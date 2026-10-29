import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { COLOR_PRESETS, EXTRA_FILTERS, LOCATION_TYPES } from "./presets.ts";
import type { ColorSwatch, SearchRequest } from "./types.ts";

export const MODEL = "claude-opus-5-5";
// USD per million tokens for MODEL, used for the cost shown in the UI.
export const PRICE_INPUT_PER_MTOK = 4;
export const PRICE_OUTPUT_PER_MTOK = 20;

export interface ViewImage {
  heading: number;
  jpeg: Buffer;
}

export interface Assessment {
  usable: boolean;
  score: number;
  typeMatch: string;
  colorScore: number | null;
  palette: ColorSwatch[];
  bestViewIndex: number;
  summary: string;
  strengths: string[];
  concerns: string[];
  tags: string[];
}

export interface AssessmentResult {
  assessment: Assessment | null;
  /** Why there is no assessment: a refusal or an unreadable answer. */
  skippedReason: string | null;
  inputTokens: number;
  outputTokens: number;
}

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["usable", "score", "type_match", "color_score", "palette", "best_view_index", "summary", "strengths", "concerns", "tags"],
  properties: {
    usable: { type: "boolean", description: "false if the images are indoor, black, blurred, or show nothing assessable" },
    score: { type: "integer", description: "0-100 overall fit with the brief" },
    type_match: { type: "string", description: "id of the best matching requested location type, or 'geen'" },
    color_score: { type: ["integer", "null"], description: "0-100 fit with the requested colour setting, null if none was requested" },
    palette: {
      type: "array",
      description: "3 to 5 dominant colours of the best view",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["hex", "name"],
        properties: { hex: { type: "string" }, name: { type: "string" } },
      },
    },
    best_view_index: { type: "integer", description: "0-based index of the image that works best as a shot" },
    summary: { type: "string", description: "one or two sentences in Dutch describing the spot as a shoot location" },
    strengths: { type: "array", items: { type: "string" }, description: "short Dutch bullet points" },
    concerns: { type: "array", items: { type: "string" }, description: "short Dutch bullet points: practical or visual problems" },
    tags: { type: "array", items: { type: "string" }, description: "3-6 short Dutch keywords" },
  },
} as const;

const AnswerSchema = z.object({
  usable: z.boolean(),
  score: z.number(),
  type_match: z.string(),
  color_score: z.number().nullable(),
  palette: z.array(z.object({ hex: z.string(), name: z.string() })),
  best_view_index: z.number().int(),
  summary: z.string(),
  strengths: z.array(z.string()),
  concerns: z.array(z.string()),
  tags: z.array(z.string()),
});

export const SYSTEM_PROMPT = `You are an experienced location scout for photo and video shoots. You get Google Street View images of one spot, taken from the same point in different directions, plus a brief from a photographer. Judge how well this spot would work as a shoot location for that brief.

How to score (0-100):
- 85-100: clearly matches the requested location type and colour setting; a photographer would want to go there.
- 65-84: good match with some compromises (clutter, partial match, ordinary light).
- 40-64: weak or partial match; only worth it if nothing better exists.
- 0-39: does not match the brief.
Judge the spot itself, not the quality of the Street View photo: overcast weather, a low camera position or a car in the frame are temporary. Do penalise permanent problems: heavy traffic roads, fences in front of the subject, construction, clutter that would be in every shot.
For the colour setting, judge the colours of the place itself (buildings, surfaces, vegetation), not the sky or the weather on the day of capture.
Write all text fields in Dutch (Flemish usage is fine), short and practical, as a scout would write them for a photographer.`;

export function buildBrief(req: SearchRequest): string {
  const types = req.locationTypes
    .map((id) => LOCATION_TYPES.find((t) => t.id === id))
    .filter((t) => t !== undefined)
    .map((t) => `- ${t.id}: ${t.brief}`);
  const colors = req.colorPresets
    .map((id) => COLOR_PRESETS.find((c) => c.id === id))
    .filter((c) => c !== undefined)
    .map((c) => c.brief);
  if (req.customColors.length) colors.push(`a palette close to these colours: ${req.customColors.join(", ")}`);
  const extras = req.extraFilters
    .map((id) => EXTRA_FILTERS.find((f) => f.id === id))
    .filter((f) => f !== undefined)
    .map((f) => `- ${f.brief}`);

  const lines = [`Requested location type (any of these):`, ...types];
  if (req.description) lines.push("", `Photographer's own description of what they look for: ${req.description}`);
  if (req.shootType) lines.push("", `Type of shoot: ${req.shootType}`);
  lines.push("", colors.length ? `Requested colour setting: ${colors.join("; ")}` : "No colour setting requested: return color_score null.");
  if (extras.length) lines.push("", "Also weigh these wishes:", ...extras);
  return lines.join("\n");
}

export class LocationJudge {
  private readonly client: Anthropic;

  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic();
  }

  async assess(brief: string, views: ViewImage[], context: string): Promise<AssessmentResult> {
    const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = [];
    views.forEach((view, i) => {
      content.push({ type: "text", text: `Image ${i} — camera heading ${Math.round(view.heading)}° (0 = north, 90 = east)` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: view.jpeg.toString("base64") } });
    });
    content.push({ type: "text", text: `Spot: ${context}\n\nAssess this spot against the brief.` });

    const response: BetaMessage = await this.client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      // On a safety decline, the API retries on Anthropic's recommended fallback model.
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      // The brief is identical for every spot in a search, so it is cached after the first call.
      system: [
        { type: "text", text: SYSTEM_PROMPT },
        { type: "text", text: `The photographer's brief:\n${brief}`, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content }],
    });

    const inputTokens =
      response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0) + (response.usage.cache_read_input_tokens ?? 0);
    const outputTokens = response.usage.output_tokens;
    const result = (assessment: Assessment | null, skippedReason: string | null): AssessmentResult => ({
      assessment,
      skippedReason,
      inputTokens,
      outputTokens,
    });

    if (response.stop_reason === "refusal") return result(null, "geweigerd door het model");
    if (response.stop_reason === "max_tokens") return result(null, "antwoord afgebroken");
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const assessment = parseAssessment(text, views.length);
    return assessment ? result(assessment, null) : result(null, "onleesbaar antwoord");
  }
}

/** Validates a model's JSON answer and clamps it into range; null when it can't be read. */
export function parseAssessment(text: string, viewCount: number): Assessment | null {
  let parsed: z.infer<typeof AnswerSchema>;
  try {
    // Some models wrap JSON in a ```json fence despite being asked not to.
    parsed = AnswerSchema.parse(JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")));
  } catch {
    return null;
  }
  const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
  return {
    usable: parsed.usable,
    score: clamp(parsed.score),
    typeMatch: parsed.type_match,
    colorScore: parsed.color_score === null ? null : clamp(parsed.color_score),
    palette: parsed.palette.filter((p) => /^#[0-9a-f]{6}$/i.test(p.hex)).slice(0, 5),
    bestViewIndex: Math.max(0, Math.min(viewCount - 1, parsed.best_view_index)),
    summary: parsed.summary,
    strengths: parsed.strengths.slice(0, 5),
    concerns: parsed.concerns.slice(0, 5),
    tags: parsed.tags.slice(0, 6),
  };
}
