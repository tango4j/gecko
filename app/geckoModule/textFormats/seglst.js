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

const splitWordsEvenly = (text, start, end) => {
    const tokens = (text || '').trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) {
        return [{ start, end, text: '', confidence: 1 }]
    }
    const span = Math.max(0, end - start)
    const slice = span / tokens.length
    return tokens.map((tok, i) => ({
        start: start + i * slice,
        end: start + (i + 1) * slice,
        text: tok,
        confidence: 1
    }))
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
        const words = splitWordsEvenly(entry.words, start, end)

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
