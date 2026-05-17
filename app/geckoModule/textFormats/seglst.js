/*
 * SegLST (Segment-LST) format support.
 *
 * SegLST is a flat JSON list where every element describes a single
 * speaker turn with a space-separated transcript. Example element:
 *
 *   {
 *     "session_id": "en_0638",
 *     "words":       "for when i move out",
 *     "start_time":  "3.42",
 *     "end_time":    "4.47",
 *     "speaker":     "speaker1"
 *   }
 *
 * Files typically use a `.seglst.json` suffix but the parser also
 * accepts plain `.json` payloads when their shape matches.
 */

import { jsonStringify } from '../utils'

const NUM = (v) => {
    const n = typeof v === 'string' ? parseFloat(v) : v
    return Number.isFinite(n) ? n : 0
}

export const isSegLstPayload = (data) => {
    if (!Array.isArray(data) || data.length === 0) return false
    const sample = data[0]
    if (!sample || typeof sample !== 'object') return false
    const hasWords = typeof sample.words === 'string'
    const hasTimes = sample.start_time !== undefined && sample.end_time !== undefined
    const hasSpeaker = typeof sample.speaker === 'string'
    return hasWords && hasTimes && hasSpeaker
}

export const isSegLstFilename = (filename) => {
    if (!filename) return false
    const lower = filename.toLowerCase()
    return lower.endsWith('.seglst.json') || lower.endsWith('.seglst')
}

// ---------------------------------------------------------------------------
// Multilingual word-timing estimator
// ---------------------------------------------------------------------------
// SegLST carries no word-level timestamps, so we estimate them by spreading
// the segment's [start, end] span across the tokens we extract. The estimator
// is a UI affordance only: the SegLST exporter drops these estimates and
// re-emits the original segment span on save, so the round-trip stays lossless.
//
// The estimator is structured in three stages so it works across scripts:
//
//   1. Tokenize  — use Intl.Segmenter when available (ICU word breaker; handles
//                  CJK, Thai, Khmer, Lao, Burmese, etc. natively). Fall back
//                  to whitespace splitting + per-char CJK splitting otherwise.
//   2. Weight    — score each token by an estimated syllable count picked per
//                  script (Latin/Cyrillic/Greek: vowel groups; Han/kana/Hangul:
//                  one syllable per glyph; abjads and Brahmic: one per
//                  non-combining char as a coarse proxy).
//   3. Pause pad — add a small fractional weight when the token is followed
//                  by a comma/period/etc. so prosodic pauses don't get
//                  swallowed by the next word.
// ---------------------------------------------------------------------------

const CJK_PER_CHAR_RE = /[\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/u

// Punctuation → fractional "syllable" weight. Values are roughly calibrated so
// that a comma adds ~0.3 syllables of silence and a sentence end ~0.7. They
// scale with the segment span automatically because they participate in the
// same proportional split.
const PUNCT_PAUSE = {
    ',': 0.3, ';': 0.4, ':': 0.4,
    '.': 0.7, '!': 0.7, '?': 0.7,
    '—': 0.3, '–': 0.3, '…': 0.7,
    '、': 0.3, '，': 0.3, '；': 0.4, '：': 0.4,
    '。': 0.7, '！': 0.7, '？': 0.7, '．': 0.7
}

const punctPauseWeight = (trailing) => {
    if (!trailing) return 0
    let total = 0
    for (const ch of trailing) total += PUNCT_PAUSE[ch] || 0
    return total
}

// Vowel-letter classes for the major alphabetic scripts. Covers Latin (with
// common diacritics), Cyrillic, and Greek. Used by the Latin/Cyrillic/Greek
// branch of `syllableWeight`.
const VOWEL_GROUP_RE = /[aeiouyàáâãäåæèéêëìíîïòóôõöøùúûüýÿœаеёиоуыэюяαεηιουω]+/gi

// Per-token syllable estimate. The token is expected to be a single word-like
// segment (no whitespace). Combining marks are ignored — they're part of the
// preceding base glyph and don't add syllables on their own.
const syllableWeight = (token) => {
    if (!token) return 1
    let weight = 0
    let latinBuf = ''

    for (const ch of token) {
        const cp = ch.codePointAt(0)
        if (
            (cp >= 0x4E00 && cp <= 0x9FFF) ||   // CJK Unified Ideographs
            (cp >= 0x3400 && cp <= 0x4DBF) ||   // CJK Ext A
            (cp >= 0x20000 && cp <= 0x2A6DF)    // CJK Ext B
        ) {
            weight += 1                                  // Han char ≈ 1 syllable
        } else if (
            (cp >= 0x3040 && cp <= 0x309F) ||   // Hiragana
            (cp >= 0x30A0 && cp <= 0x30FF)      // Katakana
        ) {
            weight += 1                                  // kana ≈ 1 mora
        } else if (cp >= 0xAC00 && cp <= 0xD7AF) {
            weight += 1                                  // Hangul syllable block
        } else if (
            (cp >= 0x0590 && cp <= 0x06FF) ||   // Hebrew + Arabic
            (cp >= 0x0700 && cp <= 0x074F) ||   // Syriac
            (cp >= 0x0750 && cp <= 0x077F) ||   // Arabic Supplement
            (cp >= 0x0900 && cp <= 0x0DFF) ||   // Devanagari → Sinhala
            (cp >= 0x0E00 && cp <= 0x0FFF) ||   // Thai, Lao, Tibetan
            (cp >= 0x1000 && cp <= 0x109F) ||   // Myanmar
            (cp >= 0x1780 && cp <= 0x17FF)      // Khmer
        ) {
            // Abjads and Brahmic scripts: count base consonants/vowels, ignore
            // combining marks. Coarse but the best we can do without a g2p.
            if (!/\p{M}/u.test(ch)) weight += 0.6
        } else if (/\p{L}|\p{N}/u.test(ch)) {
            latinBuf += ch
        }
        // Anything else (punctuation, combining marks, symbols) is skipped.
    }

    if (latinBuf) {
        const groups = (latinBuf.toLowerCase().match(VOWEL_GROUP_RE) || []).length
        // English silent-trailing-e heuristic: harmless for other Latin langs
        // because they rarely end in a lone unstressed `e`.
        const adj = groups > 1 && /[aeiou]e$/i.test(latinBuf) ? groups - 1 : groups
        weight += Math.max(1, adj)
    }

    return Math.max(1, weight)
}

// Split `text` into `[{ text, trailingPunct }]` tokens. Uses Intl.Segmenter
// when available (proper ICU word-break, handles CJK / Thai / etc.) and falls
// back to whitespace + per-char CJK splitting on older runtimes.
const tokenizeMultilingual = (text) => {
    const trimmed = (text || '').trim()
    if (!trimmed) return []

    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
        try {
            const seg = new Intl.Segmenter(undefined, { granularity: 'word' })
            const out = []
            for (const { segment, isWordLike } of seg.segment(trimmed)) {
                if (isWordLike) {
                    out.push({ text: segment, trailingPunct: '' })
                } else if (out.length) {
                    // Stash following whitespace + punctuation onto the previous
                    // word so we can detect "ends-with-comma" later.
                    out[out.length - 1].trailingPunct += segment
                }
            }
            if (out.length) return out
        } catch (_) { /* fall through to manual tokenizer */ }
    }

    const out = []
    for (const raw of trimmed.split(/\s+/).filter(Boolean)) {
        if (CJK_PER_CHAR_RE.test(raw) && !/[A-Za-z]/.test(raw)) {
            // No reliable word boundaries in pure CJK runs without Intl
            // Segmenter — fall back to per-glyph segmentation so each
            // syllable gets its own slice.
            let cur = null
            for (const ch of raw) {
                if (/\p{L}|\p{N}/u.test(ch)) {
                    if (cur) out.push(cur)
                    cur = { text: ch, trailingPunct: '' }
                } else if (cur) {
                    cur.trailingPunct += ch
                }
            }
            if (cur) out.push(cur)
        } else {
            const m = raw.match(/^([\s\S]*?)([\p{P}\p{S}]+)?$/u)
            out.push({
                text: m ? m[1] : raw,
                trailingPunct: m && m[2] ? m[2] : ''
            })
        }
    }
    return out
}

const estimateWordTimings = (text, start, end) => {
    const tokens = tokenizeMultilingual(text)
    if (tokens.length === 0) {
        return [{ start, end, text: '', confidence: 1 }]
    }

    const weights = tokens.map((t) => syllableWeight(t.text) + punctPauseWeight(t.trailingPunct))
    const totalWeight = weights.reduce((a, b) => a + b, 0) || tokens.length
    const span = Math.max(0, end - start)
    let cursor = start

    const out = tokens.map((tok, i) => {
        const dur = (weights[i] / totalWeight) * span
        // Re-attach trailing punctuation so the visible text matches the
        // original transcript glyphs.
        const display = (tok.text + tok.trailingPunct).trim() || tok.text
        const w = { start: cursor, end: cursor + dur, text: display, confidence: 1 }
        cursor += dur
        return w
    })
    // Snap the final end to the segment boundary so float accumulation can't
    // drift past it.
    out[out.length - 1].end = end
    return out
}

export const parse = (data, $parent) => {
    if (typeof data === 'string') {
        data = JSON.parse(data)
    }

    if (!Array.isArray(data)) {
        throw new Error('SegLST payload must be a JSON array')
    }

    const monologues = data.map((entry) => {
        const start = NUM(entry.start_time)
        const end = NUM(entry.end_time)
        const speakerId = entry.speaker || ''
        const words = estimateWordTimings(entry.words, start, end)

        return {
            speaker: { id: speakerId },
            start,
            end,
            words
        }
    })

    if ($parent && $parent.comparsionData) {
        const flatWords = monologues.reduce(
            (acc, m) => (m.words ? [...acc, ...m.words] : acc),
            []
        )
        $parent.comparsionData.push(flatWords)
    }

    return [monologues, null]
}

const deriveSessionId = (app, fileIndex) => {
    try {
        const filename = app.filesData[fileIndex].filename || ''
        const base = filename.split('/').pop()
        return base
            .replace(/\.seglst\.json$/i, '')
            .replace(/\.json$/i, '')
            .replace(/\.seglst$/i, '')
    } catch (e) {
        return ''
    }
}

export const convert = (app, fileIndex) => {
    const sessionId = deriveSessionId(app, fileIndex)
    const out = []

    app.iterateRegions((region) => {
        const words = (region.data.words || [])
            .map((w) => (w && w.text ? String(w.text) : ''))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim()

        out.push({
            session_id: sessionId,
            words,
            start_time: region.start.toFixed(2),
            end_time: region.end.toFixed(2),
            speaker: app.formatSpeaker(region.data.speaker)
        })
    }, fileIndex, true)

    return jsonStringify(out)
}
