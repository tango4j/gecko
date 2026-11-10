// Praat TextGrid loader (long "ooTextFile" and short formats).
//
// Tier roles are inferred from tier names:
//   *words*          -> word timestamps, one tier per speaker  (e.g. speaker_0_words)
//   *utterance*      -> optional grouping of that speaker's words into regions
//   *diar*           -> speaker activity, shown in the RTTM lane
//   phones / *transcription* / *original* tiers are ignored.
// If no tier name contains "word", every remaining interval tier is treated
// as one speaker's word tier (tier name = speaker).
//
// Speaker ids are normalised so "speaker_0_words" -> "spk0", matching the
// CTM converter in tools/speaker_json_to_ctm.py.

const DEFAULT_PAUSE_SEC = 0.6

// Tokens shared by both formats once keys/brackets are dropped:
// quoted strings, bare numbers, and the <exists> flag.
const tokenize = (data) => {
    const tokens = []
    const re = /"((?:[^"]|"")*)"|(?<![\w[.])(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)(?![\w\].])|<exists>|<absent>/g
    let m
    while ((m = re.exec(data)) !== null) {
        if (m[1] !== undefined) tokens.push({ s: m[1].replace(/""/g, '"') })
        else if (m[2] !== undefined) tokens.push({ n: parseFloat(m[2]) })
        else tokens.push({ flag: m[0] })
    }
    return tokens
}

export const parseTiers = (data) => {
    const t = tokenize(data)
    let i = 0
    const next = () => t[i++]
    const str = () => { const x = next(); return x && x.s !== undefined ? x.s : '' }
    const num = () => { const x = next(); return x && x.n !== undefined ? x.n : NaN }

    // header: "ooTextFile" "TextGrid" xmin xmax <exists> size
    while (i < t.length && t[i].flag === undefined) i++
    i++
    const size = num()
    const tiers = []
    for (let k = 0; k < size && i < t.length; k++) {
        const cls = str()
        const name = str()
        num(); num()
        const n = num()
        const items = []
        for (let j = 0; j < n; j++) {
            if (cls === 'IntervalTier') {
                const start = num(); const end = num(); const text = str()
                items.push({ start, end, text })
            } else {
                const time = num(); const text = str()
                items.push({ start: time, end: time, text })
            }
        }
        tiers.push({ cls, name, items })
    }
    return tiers
}

export const speakerFromTierName = (name) => {
    let s = String(name).trim()
        .replace(/[_\s-]*(words?|diarization|diar|utterances?.*|segments?)$/i, '')
    const m = s.match(/^(?:speaker|spk|spkr|s)[_\s-]*(\d+)$/i)
    if (m) return `spk${m[1]}`
    s = s.replace(/[\s_]+/g, '-')
    return s || 'spk'
}

const isIgnored = (name) => /phone|transcription|original|^text$/i.test(name)

export const parse = (data, $parent) => {
    const tiers = parseTiers(data).filter(t => t.cls === 'IntervalTier' && !isIgnored(t.name))
    const hasWordTiers = tiers.some(t => /word/i.test(t.name))
    const wordTiers = tiers.filter(t => hasWordTiers ? /word/i.test(t.name) : !/diar|utter/i.test(t.name))
    const uttTiers = tiers.filter(t => /utter/i.test(t.name))
    const diarTiers = tiers.filter(t => /diar/i.test(t.name))

    const nonEmpty = (items) => items.filter(x => String(x.text).trim() && x.end > x.start)

    const monologues = []
    wordTiers.forEach(tier => {
        const speaker = speakerFromTierName(tier.name)
        const words = nonEmpty(tier.items).map(x => ({ start: x.start, end: x.end, text: String(x.text).trim() }))
        const utt = uttTiers.find(u => speakerFromTierName(u.name) === speaker)
        const uttSpans = utt ? nonEmpty(utt.items) : null

        let current = null
        let currentSpan = -1
        words.forEach(w => {
            let split
            if (uttSpans && uttSpans.length) {
                const mid = (w.start + w.end) / 2
                const span = uttSpans.findIndex(u => mid >= u.start && mid <= u.end)
                split = span !== currentSpan
                currentSpan = span
            } else {
                split = !current || w.start - current.end > DEFAULT_PAUSE_SEC
            }
            if (!current || split) {
                current = { speaker: { id: speaker }, start: w.start, end: w.end, words: [] }
                monologues.push(current)
            }
            current.words.push(w)
            current.end = Math.max(current.end, w.end)
        })
    })
    monologues.sort((a, b) => a.start - b.start)

    if ($parent) {
        $parent.externalDiarization = []
        diarTiers.forEach(tier => {
            const speaker = speakerFromTierName(tier.name)
            nonEmpty(tier.items).forEach(x => $parent.externalDiarization.push({ speaker, start: x.start, end: x.end }))
        })
    }

    return [monologues]
}
