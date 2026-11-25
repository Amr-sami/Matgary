// Speech-to-text provider — Gemini multimodal transcription.
//
// Voice is a pure input modality for the existing Agent:
//   audio bytes → text → dropped into the normal AI chat composer.
//
// There is NO business logic in this module. It does not parse suppliers,
// products, prices, or anything else. It returns the raw transcript and
// hands off to the existing text pipeline (which already handles intent,
// entity resolution, RAG, permissions, staged writes, confirmations, audit).
//
// Implementation note on the model name:
//   The Python example floating around (`gemini-3.5-transcribe`) is not a
//   published Google model. Gemini's audio support is MULTIMODAL — you send
//   an audio part to `generateContent` on a normal Gemini model, with a
//   transcription instruction. That's the documented path, and that's what
//   we use. The model is overridable via `GEMINI_TRANSCRIBE_MODEL` so a
//   future dedicated transcription endpoint can be swapped in without
//   touching this file's shape.

import { GoogleGenAI } from "@google/genai";

const DEFAULT_MODEL =
  process.env.GEMINI_TRANSCRIBE_MODEL ?? process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

/** Max audio bytes we send to the model in one call. The route's upload cap
 *  should be <= this. Keep well under the SDK's inline-data cap (20 MB). */
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Transcription prompt — dialect-agnostic, meaning-preserving.
 *
 * Voice is an input modality for the existing Agent. The prompt's job is to
 * get the Agent the SAME text a user would have typed — no translation, no
 * dialect conversion, no silent rewrites of numbers / codes / names.
 *
 * Covered edge cases (all learned from real user requirements, not theoretical):
 *   • Arabic dialect spectrum (Egyptian, Saudi, Gulf, Levantine, Iraqi,
 *     Maghrebi, MSA) stays as spoken. Agent can handle any of them.
 *   • Code-switching (Arabic + English in one sentence) preserved both ways.
 *   • Numbers preserved in their SPOKEN form: "خمسمية" ≠ "500" ≠ "٥٠٠" at
 *     the token level, even though they mean the same. The Agent's numeric
 *     parser handles conversion; the transcriber must not pre-decide.
 *   • Product codes / SKUs — never flipped or compressed. Uncertainty
 *     marked as "[?]" rather than guessed.
 *   • Self-corrections ("لا، مش 10، 12") kept whole so the Agent sees the
 *     final intent.
 *   • Filler words lightly trimmed only when they carry zero information.
 */
const TRANSCRIPTION_PROMPT = [
  "You are a transcription engine. Your ONLY job is to transcribe the audio.",
  "",
  "Language & dialect:",
  "1. Transcribe VERBATIM in the exact language and dialect the speaker uses.",
  "2. Arabic dialects — Egyptian (مصري), Saudi (سعودي), Gulf (خليجي), Levantine (شامي), Iraqi (عراقي), Maghrebi (مغاربي), Modern Standard (فصحى) — all stay as spoken. Do NOT convert dialect to MSA. Do NOT convert one dialect to another.",
  "3. English speech stays English. Mixed Arabic + English (common in Gulf and Egyptian business speech, e.g., 'عايز أعمل stock count', 'ضيف 10 pieces') — keep both languages exactly where they appear. Do NOT translate either side.",
  "",
  "Numbers & prices:",
  "4. Write numbers exactly as spoken. 'خمسمية' stays 'خمسمية'. '٥٠٠' stays '٥٠٠'. '500' stays '500'. 'ألف وخمسمية' stays 'ألف وخمسمية'. Only output bare digits when the speaker clearly dictates digit-by-digit (e.g., 'اتنين خمسة سبعة' → '257').",
  "5. Currency words ('جنيه', 'ريال', 'درهم', 'EGP', 'SAR') stay as spoken; do not normalize.",
  "",
  "Business tokens:",
  "6. Product codes, SKUs, barcodes, invoice numbers — preserve EXACTLY. 'MF0612G-03' must never become 'MF0612G-30' or 'MF0612G03'. If you cannot clearly hear one character, write that character as '[?]' rather than guessing.",
  "7. Supplier, customer, employee, product, and brand names — preserve as pronounced. Do NOT substitute a similar-sounding alternative because it seems more plausible. If the audio is ambiguous between two candidates, write what you actually heard.",
  "",
  "Faithfulness:",
  "8. Self-corrections stay. 'مش ١٠، ١٢' stays 'مش ١٠، ١٢'. 'استنى، لا، تمانية' stays 'استنى، لا، تمانية'. The Agent reads the whole phrase to determine intent — do not pre-resolve.",
  "9. Filler words ('يعني', 'بص', 'آه', 'طيب', 'uh', 'um') may be lightly trimmed ONLY when they carry zero information. Never drop a word that could change meaning.",
  "10. Do NOT paraphrase, summarize, formalize, fix grammar, or 'improve' the speech.",
  "11. Inaudible sections → write '[...]' and keep transcribing.",
  "",
  "Output:",
  "12. Output ONLY the transcript text. No preamble. No explanation. No markdown. No surrounding quotes. No language tag.",
].join("\n");

export interface TranscribeInput {
  /** Raw audio bytes. */
  audio: Uint8Array;
  /** MIME type — one of audio/m4a, audio/mp4, audio/mpeg, audio/wav, audio/webm, audio/ogg. */
  mimeType: string;
  /** Optional language hint (ISO 639-1). Default "ar" covers every Arabic
   *  dialect (Gemini auto-detects dialect; the hint only biases detection
   *  tied-break cases). */
  languageHint?: string;
}

export interface TranscribeResult {
  text: string;
  /** Model ID that produced it, for client telemetry. Never leaks a key. */
  model: string;
  /** Bytes sent — the route uses this for rate-limit accounting. */
  audioBytes: number;
}

export class TranscribeError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "NO_PROVIDER_KEY"
      | "AUDIO_TOO_LARGE"
      | "UNSUPPORTED_MIME"
      | "PROVIDER_ERROR"
      | "EMPTY_TRANSCRIPT",
  ) {
    super(message);
    this.name = "TranscribeError";
  }
}

const ALLOWED_MIME = new Set([
  "audio/m4a",
  "audio/mp4", // expo-audio on iOS reports this for AAC in an mp4 container
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/ogg",
  "audio/aac",
  "audio/flac",
]);

/**
 * Transcribe audio to text using the Gemini multimodal API.
 *
 * Reuses the SAME `GEMINI_API_KEY` the chat provider uses (no second key).
 * For a small clip (< 10 MB) we pass the audio inline — one round-trip,
 * no file-lifecycle to manage. For larger clips we'd switch to
 * `ai.files.upload()`, but the mobile mic button caps recording well below
 * that threshold.
 */
export async function transcribeAudio(input: TranscribeInput): Promise<TranscribeResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new TranscribeError(
      "GEMINI_API_KEY is not set — transcription is disabled.",
      "NO_PROVIDER_KEY",
    );
  }
  if (!ALLOWED_MIME.has(input.mimeType)) {
    throw new TranscribeError(
      `Unsupported audio mime type: ${input.mimeType}`,
      "UNSUPPORTED_MIME",
    );
  }
  if (input.audio.byteLength > MAX_AUDIO_BYTES) {
    throw new TranscribeError(
      `Audio exceeds max size (${input.audio.byteLength} > ${MAX_AUDIO_BYTES} bytes).`,
      "AUDIO_TOO_LARGE",
    );
  }

  const client = new GoogleGenAI({ apiKey });
  const base64Audio = Buffer.from(input.audio).toString("base64");

  let response;
  try {
    response = await client.models.generateContent({
      model: DEFAULT_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: input.mimeType,
                data: base64Audio,
              },
            },
            { text: TRANSCRIPTION_PROMPT },
          ],
        },
      ],
      config: {
        // Low temperature → more deterministic transcription.
        temperature: 0,
        // Transcripts are capped at a generous length; a 2-minute Arabic clip
        // comfortably fits inside 2K output tokens.
        maxOutputTokens: 4000,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TranscribeError(`Gemini transcription failed: ${msg}`, "PROVIDER_ERROR");
  }

  // `text` is a getter on the GenerateContentResponse that joins all text
  // parts. Falls back to candidates[0].content.parts[*].text if needed.
  const raw = response.text ?? "";
  const text = raw.trim();
  if (!text) {
    throw new TranscribeError("Transcript came back empty.", "EMPTY_TRANSCRIPT");
  }

  return {
    text,
    model: DEFAULT_MODEL,
    audioBytes: input.audio.byteLength,
  };
}
