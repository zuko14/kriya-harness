// L2 Words: a word-level transcript, kept verbatim (ET-HR-08), from the Media
// Runtime's Whisper: mlx-whisper on Apple silicon, faster-whisper elsewhere (EX-04).
// The language is the person's setting, never detected (PERCEPTION §5). The model
// runs offline: weights come with the runtime, or the layer is unavailable.

import { existsSync } from "node:fs"
import { join } from "node:path"

import { decimalFlicks } from "./meta.js"

export const WORDS_VERSION = "l2-1"
export const MODEL = "whisper-large-v3-turbo"

// Prints one JSON line per word; times as fixed decimals, so no float crosses into Node
const SCRIPT = `
import json, sys
audio, engine, model, language = sys.argv[1:5]
def say(text, start, end, p):
    print(json.dumps({"w": text, "s": f"{start:.3f}", "e": f"{end:.3f}", "p": round(float(p), 3)}), flush=True)
if engine == "mlx":
    import mlx_whisper
    result = mlx_whisper.transcribe(audio, path_or_hf_repo=model, language=language, word_timestamps=True, condition_on_previous_text=False)
    for segment in result["segments"]:
        for w in segment.get("words", []):
            say(w["word"], w["start"], w["end"], w.get("probability", 0))
else:
    from faster_whisper import WhisperModel
    segments, _ = WhisperModel(model).transcribe(audio, language=language, word_timestamps=True, condition_on_previous_text=False)
    for segment in segments:
        for w in segment.words or []:
            say(w.word, w.start, w.end, w.probability)
`

/** 16 kHz mono PCM for the recogniser, decoded by our FFmpeg, not the model's. */
export const speechArgs = (source, output) => ["-hide_banner", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "file,pipe", "-i", source, "-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", output]

/**
 * Where the runtime's recogniser is, or why there isn't one.
 * @param {{ dir: string } | null} runtime from activeRuntime()
 */
export function recogniser(runtime, platform = `${process.platform}-${process.arch}`) {
  if (!runtime) return { missing: "Speech-to-text needs the Media Runtime. Run kriya edit setup." }
  const python = join(runtime.dir, "python", "bin", "python")
  const model = join(runtime.dir, "models", MODEL)
  if (!existsSync(python)) return { missing: "The Media Runtime has no Python environment. Run kriya edit setup again." }
  if (!existsSync(model)) return { missing: "The speech model isn't installed with this Media Runtime yet." }
  return { python, model, engine: platform === "darwin-arm64" ? "mlx" : "faster" }
}

export const transcribeArgs = ({ engine, model }, audio, language) => ["-I", "-c", SCRIPT, audio, engine, model, language]

/** The recogniser's lines → words, text kept exactly as heard; only the surrounding space goes. */
export function readWords(text) {
  const words = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    const { w, s, e, p } = JSON.parse(line)
    const body = String(w).trim()
    if (!body) continue
    const start = decimalFlicks(s)
    words.push({ text: body, start, end: Math.max(start, decimalFlicks(e)), conf: typeof p === "number" ? p : null })
  }
  return words
}
