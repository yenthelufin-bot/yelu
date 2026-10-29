import type { Judge } from "./pipeline.ts";
import { LOCATION_TYPES } from "./presets.ts";
import type { SearchMode } from "./types.ts";
import { type AssessmentResult, parseAssessment, type ReferenceAnalysis, SYSTEM_PROMPT, type ViewImage } from "./vision.ts";
import { z } from "zod";

// Assessments with Google Gemini on its free tier, over the REST API
// (generateContent). The free tier allows only a few requests per minute and
// a daily maximum, so calls go one at a time, back off when Google says so,
// and stop the search when the day's quota is used up.

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
/** Suggested in the settings screen; the free tier and its limits differ per model. */
export const GEMINI_MODELS = [
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite: snelst, ruimste gratis limiet" },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash: scherper, maar veel minder oproepen per dag gratis" },
];

const API = "https://generativelanguage.googleapis.com/v1beta/models";

/** Gemini's response schema: an OpenAPI subset. */
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    usable: { type: "BOOLEAN", description: "false if the images are indoor, black, blurred or show nothing assessable" },
    score: { type: "INTEGER", description: "0-100 overall fit with the brief" },
    type_match: { type: "STRING", description: "id of the best matching requested location type, or 'geen'" },
    color_score: { type: "INTEGER", nullable: true, description: "0-100 fit with the requested colour setting, null if none was requested" },
    palette: {
      type: "ARRAY",
      description: "3 to 5 dominant colours of the best view",
      items: { type: "OBJECT", properties: { hex: { type: "STRING" }, name: { type: "STRING" } }, required: ["hex", "name"] },
    },
    best_view_index: { type: "INTEGER", description: "0-based index of the image that works best as a shot" },
    summary: { type: "STRING", description: "one or two sentences in Dutch describing the spot as a shoot location" },
    strengths: { type: "ARRAY", items: { type: "STRING" }, description: "short Dutch bullet points" },
    concerns: { type: "ARRAY", items: { type: "STRING" }, description: "short Dutch bullet points: practical or visual problems" },
    tags: { type: "ARRAY", items: { type: "STRING" }, description: "3-6 short Dutch keywords" },
    access: { type: "STRING", enum: ["publiek", "privé", "onduidelijk"], description: "whether the spot looks like public space or private property" },
    access_notes: { type: "STRING", description: "one short Dutch sentence: what you see that tells you" },
    similarity: { type: "INTEGER", nullable: true, description: "0-100 resemblance to the reference photos; null when there are none" },
  },
  required: [
    "usable",
    "score",
    "type_match",
    "color_score",
    "palette",
    "best_view_index",
    "summary",
    "strengths",
    "concerns",
    "tags",
    "access",
    "access_notes",
    "similarity",
  ],
};

const ANALYSIS_SCHEMA = {
  type: "OBJECT",
  properties: {
    description: { type: "STRING", description: "1-2 Dutch sentences on what kind of place this is: setting, materials, mood, colours" },
    location_types: { type: "ARRAY", items: { type: "STRING" }, description: "matching ids from the given list" },
    colors: { type: "ARRAY", items: { type: "STRING" }, description: "3-5 dominant colours as #rrggbb" },
    places_queries: { type: "ARRAY", items: { type: "STRING" }, description: "3-5 short Google Maps searches for places like this" },
    location_guesses: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          query: { type: "STRING", description: "a Google Maps search that finds the guessed place, e.g. a landmark or street with its town" },
          confidence: { type: "INTEGER", description: "0-100" },
          why: { type: "STRING", description: "short Dutch reason" },
        },
        required: ["query", "confidence", "why"],
      },
    },
  },
  required: ["description", "location_types", "colors", "places_queries", "location_guesses"],
};

const AnalysisAnswer = z.object({
  description: z.string().catch(""),
  location_types: z.array(z.string()).catch([]),
  colors: z.array(z.string()).catch([]),
  places_queries: z.array(z.string()).catch([]),
  location_guesses: z.array(z.object({ query: z.string(), confidence: z.number().catch(0), why: z.string().catch("") })).catch([]),
});

function analysisPrompt(mode: SearchMode, hint: string): string {
  const types = LOCATION_TYPES.map((t) => `${t.id} (${t.brief})`).join("; ");
  if (mode === "exact") {
    return `You help a photographer find out WHERE a photo was taken, so they can go and shoot there. Study every clue: landmarks, signs and any readable text, language, house numbers, shop names, architecture, road markings, vegetation, terrain.${hint ? ` The photographer thinks it is around: ${hint}.` : ""}
Return up to 5 location_guesses, best first, each with a query that Google Maps can find (a landmark, a business, or a street with its town) and an honest confidence. If there is nothing to go on, return an empty list rather than inventing places.
Also describe in Dutch what is visible (description). Leave location_types, colors and places_queries empty.
Answer with one JSON object with the keys description, location_types, colors, places_queries, location_guesses.`;
  }
  return `You help a photographer find shoot locations that look like their example photos. Describe what kind of place the photos show, so that similar places can be found: setting, materials, architecture, mood and colours.
Pick the matching location types from this list (ids only): ${types}.
Give 3-5 dominant colours of the place itself as #rrggbb, and 3-5 short Google Maps searches in Dutch that would find places like this (e.g. "graansilo", "betonnen viaduct", "bakstenen loods").${hint ? ` The search area is: ${hint}.` : ""}
Leave location_guesses empty.
Answer with one JSON object with the keys description, location_types, colors, places_queries, location_guesses.`;
}

const JSON_INSTRUCTION = `Answer with one JSON object only, with these keys: usable (boolean), score (integer 0-100), type_match (string), color_score (integer 0-100 or null), palette (array of {hex, name}), best_view_index (integer), summary (string), strengths (array of strings), concerns (array of strings), tags (array of strings), access ("publiek", "privé" or "onduidelijk"), access_notes (string), similarity (integer 0-100 or null).`;

export class GeminiError extends Error {
  readonly status: number;
  /** Read by isFatal(): no point continuing the search. */
  readonly fatal: boolean;
  constructor(message: string, status: number, fatal: boolean) {
    super(message);
    this.status = status;
    this.fatal = fatal;
  }
}

interface ErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: { "@type"?: string; reason?: string; retryDelay?: string; violations?: { quotaId?: string }[] }[];
  };
}

/**
 * What went wrong with the key, in plain Dutch, followed by Google's own
 * words so the exact cause is never hidden.
 */
export function explainKeyError(httpStatus: number, body: ErrorBody): string | null {
  const message = body.error?.message ?? "";
  const reason = body.error?.details?.find((d) => d.reason)?.reason ?? body.error?.status ?? "";
  const google = ` (Google: "${message.trim()}"${reason ? `, ${reason}` : ""})`;
  if (reason === "API_KEY_INVALID" || /API key not valid/i.test(message)) {
    return `Google kent deze sleutel niet. Kopieer hem opnieuw, helemaal, uit aistudio.google.com/apikey: klik daar op de sleutel en gebruik de kopieerknop.${google}`;
  }
  if (reason === "API_KEY_EXPIRED" || /expired/i.test(message)) return `Deze sleutel is verlopen. Maak een nieuwe aan in AI Studio.${google}`;
  if (reason === "API_KEY_SERVICE_BLOCKED" || /are blocked/i.test(message)) {
    return `Deze sleutel mag Gemini niet gebruiken. Is het je Google Maps-sleutel? Maak een aparte sleutel aan op aistudio.google.com/apikey.${google}`;
  }
  if (reason === "SERVICE_DISABLED" || /has not been used in project|is disabled/i.test(message)) {
    return `In het project van deze sleutel staat Gemini (de "Generative Language API") uit. Maak de sleutel aan op aistudio.google.com/apikey; daar wordt dat automatisch geregeld.${google}`;
  }
  if (/location is not supported/i.test(message)) return `Gemini is via de API niet beschikbaar vanaf je huidige locatie.${google}`;
  if (httpStatus === 400 && /API key/i.test(message)) return `Er is iets mis met de sleutel.${google}`;
  if (httpStatus === 401 || httpStatus === 403) return `Gemini weigert de sleutel.${google}`;
  return null;
}

/** Seconds Google asks us to wait, from a RetryInfo detail such as "37s". */
export function retryDelaySeconds(body: ErrorBody): number | null {
  const delay = body.error?.details?.find((d) => d.retryDelay)?.retryDelay;
  const seconds = delay ? Number.parseFloat(delay) : NaN;
  return Number.isFinite(seconds) ? seconds : null;
}

/** Whether a 429 is about the day's quota rather than the per-minute rate. */
export function isDailyQuota(body: ErrorBody): boolean {
  const ids = body.error?.details?.flatMap((d) => d.violations ?? []).map((v) => v.quotaId ?? "") ?? [];
  return ids.some((id) => /PerDay/i.test(id)) || /per day|daily/i.test(body.error?.message ?? "");
}

export interface GeminiOptions {
  apiKey: string;
  model?: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Spacing between calls; the free tier allows only a handful per minute. */
  minIntervalMs?: number;
}

export class GeminiJudge implements Judge {
  private readonly apiKey: string;
  readonly model: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minIntervalMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private lastCall = 0;
  private useSchema = true;

  constructor(opts: GeminiOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model || DEFAULT_GEMINI_MODEL;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.minIntervalMs = opts.minIntervalMs ?? 4_000;
  }

  /** One call at a time, spaced out, whatever the pipeline's concurrency. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  private async post(body: object): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastCall + this.minIntervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastCall = Date.now();
      const res = await this.fetchFn(`${API}/${encodeURIComponent(this.model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as any;
      if (res.ok) return json;

      const message = json?.error?.message ?? `HTTP ${res.status}`;
      if (res.status === 429) {
        if (isDailyQuota(json)) {
          throw new GeminiError("De gratis daglimiet van Gemini is bereikt. Morgen kan het weer (rond 9 uur Belgische tijd).", 429, true);
        }
        if (attempt < 4) {
          await this.sleep(((retryDelaySeconds(json) ?? 20) + 1) * 1000);
          continue;
        }
        throw new GeminiError("Gemini blijft te druk of de minuutlimiet is bereikt. Probeer het straks opnieuw.", 429, true);
      }
      if (res.status >= 500 && attempt < 2) {
        await this.sleep(5_000 * (attempt + 1));
        continue;
      }
      if (res.status === 404) {
        throw new GeminiError(`Het Gemini-model "${this.model}" bestaat niet of is niet beschikbaar voor je sleutel. Kies een ander model bij Instellingen.`, 404, true);
      }
      const keyProblem = explainKeyError(res.status, json);
      if (keyProblem) throw new GeminiError(keyProblem, 401, true);
      throw new GeminiError(`Gemini: ${message}`, res.status, false);
    }
  }

  private generationConfig() {
    return this.useSchema
      ? { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA, maxOutputTokens: 8192 }
      : { responseMimeType: "application/json", maxOutputTokens: 8192 };
  }

  assess(brief: string, views: ViewImage[], context: string, references: Buffer[] = []): Promise<AssessmentResult> {
    return this.serial(async () => {
      const parts: object[] = [];
      references.forEach((jpeg, i) => {
        parts.push({ text: `Reference photo ${i + 1} (from the photographer, not Street View)` });
        parts.push({ inlineData: { mimeType: "image/jpeg", data: jpeg.toString("base64") } });
      });
      views.forEach((view, i) => {
        parts.push({ text: `Image ${i} — camera heading ${Math.round(view.heading)}° (0 = north, 90 = east)` });
        parts.push({ inlineData: { mimeType: "image/jpeg", data: view.jpeg.toString("base64") } });
      });
      parts.push({ text: `Spot: ${context}\n\nAssess this spot against the brief.` });
      const request = () => ({
        systemInstruction: { parts: [{ text: `${SYSTEM_PROMPT}\n\nThe photographer's brief:\n${brief}\n\n${JSON_INSTRUCTION}` }] },
        contents: [{ role: "user", parts }],
        generationConfig: this.generationConfig(),
      });

      let json: any;
      try {
        json = await this.post(request());
      } catch (err) {
        // Should a model not accept this schema dialect, fall back to plain JSON mode once.
        if (err instanceof GeminiError && err.status === 400 && this.useSchema && /schema/i.test(err.message)) {
          this.useSchema = false;
          json = await this.post(request());
        } else {
          throw err;
        }
      }

      const none = (reason: string): AssessmentResult => ({ assessment: null, skippedReason: reason, inputTokens: 0, outputTokens: 0 });
      if (json.promptFeedback?.blockReason) return none("geweigerd door Gemini");
      const candidate = json.candidates?.[0];
      if (!candidate) return none("geen antwoord van Gemini");
      if (candidate.finishReason === "SAFETY" || candidate.finishReason === "PROHIBITED_CONTENT") return none("geweigerd door Gemini");
      if (candidate.finishReason === "MAX_TOKENS") return none("antwoord afgebroken");
      const text = (candidate.content?.parts ?? [])
        .filter((p: any) => typeof p.text === "string" && !p.thought)
        .map((p: any) => p.text)
        .join("");
      const assessment = parseAssessment(text, views.length);
      // Tokens stay 0: the free tier costs nothing, and the cost shown is for paid APIs only.
      return assessment ? { assessment, skippedReason: null, inputTokens: 0, outputTokens: 0 } : none("onleesbaar antwoord");
    });
  }

  analyzeReferences(references: Buffer[], mode: SearchMode, hint: string): Promise<ReferenceAnalysis> {
    return this.serial(async () => {
      const parts: object[] = references.map((jpeg) => ({ inlineData: { mimeType: "image/jpeg", data: jpeg.toString("base64") } }));
      parts.push({ text: analysisPrompt(mode, hint) });
      const json = await this.post({
        contents: [{ role: "user", parts }],
        generationConfig: this.useSchema
          ? { responseMimeType: "application/json", responseSchema: ANALYSIS_SCHEMA, maxOutputTokens: 4096 }
          : { responseMimeType: "application/json", maxOutputTokens: 4096 },
      });
      const text = (json.candidates?.[0]?.content?.parts ?? [])
        .filter((p: any) => typeof p.text === "string" && !p.thought)
        .map((p: any) => p.text)
        .join("");
      let parsed: z.infer<typeof AnalysisAnswer>;
      try {
        parsed = AnalysisAnswer.parse(JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")));
      } catch {
        // Without an analysis the search still works, it just uses the form as filled in.
        return { description: "", locationTypes: [], colors: [], placesQueries: [], locationGuesses: [] };
      }
      return {
        description: parsed.description.slice(0, 400),
        locationTypes: parsed.location_types,
        colors: parsed.colors,
        placesQueries: parsed.places_queries.slice(0, 5),
        locationGuesses: parsed.location_guesses
          .filter((g) => g.query.trim())
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 5),
      };
    });
  }

  /** A tiny text-only call, to check the key and the model before saving them. */
  async test(): Promise<string | null> {
    try {
      await this.serial(() => this.post({ contents: [{ role: "user", parts: [{ text: "Antwoord met: OK" }] }], generationConfig: { maxOutputTokens: 256 } }));
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
}
