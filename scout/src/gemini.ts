import type { Judge } from "./pipeline.ts";
import { type AssessmentResult, parseAssessment, SYSTEM_PROMPT, type ViewImage } from "./vision.ts";

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
  },
  required: ["usable", "score", "type_match", "color_score", "palette", "best_view_index", "summary", "strengths", "concerns", "tags"],
};

const JSON_INSTRUCTION = `Answer with one JSON object only, with these keys: usable (boolean), score (integer 0-100), type_match (string), color_score (integer 0-100 or null), palette (array of {hex, name}), best_view_index (integer), summary (string), strengths (array of strings), concerns (array of strings), tags (array of strings).`;

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
  error?: { code?: number; message?: string; status?: string; details?: { "@type"?: string; retryDelay?: string; violations?: { quotaId?: string }[] }[] };
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
      if (res.status === 400 && /API key/i.test(message)) throw new GeminiError("De Gemini-sleutel is ongeldig.", 401, true);
      if (res.status === 401 || res.status === 403) throw new GeminiError(`Gemini weigert de sleutel: ${message}`, res.status, true);
      throw new GeminiError(`Gemini: ${message}`, res.status, false);
    }
  }

  private generationConfig() {
    return this.useSchema
      ? { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA, maxOutputTokens: 8192 }
      : { responseMimeType: "application/json", maxOutputTokens: 8192 };
  }

  assess(brief: string, views: ViewImage[], context: string): Promise<AssessmentResult> {
    return this.serial(async () => {
      const parts: object[] = [];
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
