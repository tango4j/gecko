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
//
// Speaker-annotated TextGrids (e.g. MagicData-RAMC): a speaker-label tier
// (short labels such as A / B, empty = silence) plus a transcription tier on
// the same interval grid. Each labelled interval becomes one utterance box
// on that speaker's row (the whole transcription, tags kept as written);
// unlabelled intervals are silence (<Z>, <S>, ...), shown as hatched spans.
// A label tier with no matching text tier is speaker activity (RTTM display).

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

const MAX_SPEAKER_LABELS = 16

// A tier of a few short, space-free labels (A, B, spk0, ...): speaker labels.
const isLabelTier = (tier) => {
    const labels = new Set(tier.items.map(x => String(x.text).trim()).filter(Boolean))
    return labels.size > 0 && labels.size <= MAX_SPEAKER_LABELS &&
        [...labels].every(l => l.length <= 16 && !/\s/.test(l) && !/^<.*>$/.test(l))
}

const sameGrid = (a, b) => a.items.length === b.items.length &&
    a.items.every((x, i) => Math.abs(x.start - b.items[i].start) < 1e-3 && Math.abs(x.end - b.items[i].end) < 1e-3)

const parseSpeakerAnnotated = (tiers, $parent) => {
    const labelTier = tiers.find(isLabelTier)
    if (!labelTier) return null
    const textTier = tiers.find(t => t !== labelTier && !isLabelTier(t) && sameGrid(t, labelTier))

    const monologues = []
    const silence = []
    const activity = []
    labelTier.items.forEach((x, i) => {
        if (!(x.end > x.start)) return
        const label = String(x.text).trim()
        const text = textTier ? String(textTier.items[i].text).trim() : ''
        if (!label) {
            silence.push({ start: x.start, end: x.end, text })
        } else if (textTier) {
            monologues.push({
                speaker: { id: label },
                start: x.start,
                end: x.end,
                words: [{ start: x.start, end: x.end, text }]
            })
        } else {
            activity.push({ speaker: label, start: x.start, end: x.end })
        }
    })
    const speakers = [...new Set(labelTier.items.map(x => String(x.text).trim()).filter(Boolean))]
    if ($parent) {
        $parent.externalDiarization = activity.length ? activity : null
        $parent.lastParseInfo = {
            format: 'TextGrid',
            unit: textTier ? 'utterance' : 'activity',
            silence,
            speakers,
            tiers: textTier ? [labelTier.name, textTier.name] : [labelTier.name]
        }
    }
    return [monologues]
}

const isIgnored = (name) => /phone|transcription|original|^text$/i.test(name)

export const parse = (data, $parent) => {
    const allTiers = parseTiers(data).filter(t => t.cls === 'IntervalTier')
    // tiers named words / utterance / diar keep the per-speaker-tier layout;
    // otherwise look for a speaker-label tier first
    if (!allTiers.some(t => /word|utter|diar/i.test(t.name))) {
        const annotated = parseSpeakerAnnotated(allTiers, $parent)
        if (annotated) return annotated
    }
    const tiers = allTiers.filter(t => !isIgnored(t.name))
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
        $parent.lastParseInfo = { format: 'TextGrid', unit: 'word', silence: [], tiers: tiers.map(t => t.name) }
        $parent.externalDiarization = []
        diarTiers.forEach(tier => {
            const speaker = speakerFromTierName(tier.name)
            nonEmpty(tier.items).forEach(x => $parent.externalDiarization.push({ speaker, start: x.start, end: x.end }))
        })
    }

    return [monologues]
}

// ------------------------------------------------------------------ export
//
// Writes a long-format ("ooTextFile") Praat TextGrid. Interval tiers must
// tile [0, duration] with no overlaps, so gaps are filled with empty (or
// silence-tagged) intervals and overlaps inside one tier are clipped.
//
//   speaker-annotated TextGrid (loaded as utterances): the same two tiers it
//       came with - speaker labels + transcription - with the original
//       silence tags (<Z>, <S>, ...) put back on the gaps. If utterances of
//       different speakers overlap (one tier can't hold that), each speaker
//       gets its own pair of tiers instead.
//   word-level files (CTM, JSON, TextGrid word tiers): per speaker a
//       "<spk>_words" tier and a "<spk>_utterance" tier (one per region);
//       TextGrid speaker-activity tiers loaded alongside are written as
//       "<spk>_diarization".
//   RTTM: one "<spk>_diarization" tier per speaker.
// All of these load back into Gecko unchanged.

const EPS = 1e-6

const num = (x) => String(Number(x.toFixed(6)))
const quote = (s) => `"${String(s).replace(/"/g, '""')}"`

const naturalSort = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true })

// [{start, end, text}] (sorted, possibly overlapping / gappy) -> tiling of [0, xmax]
const tile = (items, xmax, gapText = () => '') => {
    const sorted = items
        .filter(x => x.end > x.start + EPS)
        .map(x => ({ start: x.start, end: x.end, text: x.text || '' }))
        .sort((a, b) => a.start - b.start || a.end - b.end)
    const out = []
    let t = 0
    sorted.forEach(x => {
        let start = Math.max(x.start, t)
        const end = Math.min(x.end, xmax)
        if (end <= start + EPS) return
        if (start > t + EPS) out.push({ start: t, end: start, text: gapText(t, start) })
        else start = t
        out.push({ start, end, text: x.text })
        t = end
    })
    if (xmax > t + EPS) out.push({ start: t, end: xmax, text: gapText(t, xmax) })
    if (!out.length) out.push({ start: 0, end: xmax, text: '' })
    return out
}

const hasOverlap = (items) => {
    const sorted = items.slice().sort((a, b) => a.start - b.start)
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].start < sorted[i - 1].end - EPS) return true
    }
    return false
}

const writeTextGrid = (tiers, xmax) => {
    const lines = [
        'File type = "ooTextFile"',
        'Object class = "TextGrid"',
        '',
        'xmin = 0',
        `xmax = ${num(xmax)}`,
        'tiers? <exists>',
        `size = ${tiers.length}`,
        'item []:'
    ]
    tiers.forEach((tier, i) => {
        lines.push(
            `    item [${i + 1}]:`,
            '        class = "IntervalTier"',
            `        name = ${quote(tier.name)}`,
            '        xmin = 0',
            `        xmax = ${num(xmax)}`,
            `        intervals: size = ${tier.intervals.length}`
        )
        tier.intervals.forEach((x, j) => {
            lines.push(
                `        intervals [${j + 1}]:`,
                `            xmin = ${num(x.start)}`,
                `            xmax = ${num(x.end)}`,
                `            text = ${quote(x.text)}`
            )
        })
    })
    return lines.join('\n') + '\n'
}

const regionText = (region) => (region.data.words || [])
    .map(w => String(w.text || '').trim()).filter(Boolean).join(' ')

export const convert = (app, fileIndex) => {
    const file = app.filesData[fileIndex] || {}
    const info = file.formatInfo || {}
    const isRttm = /\.rttm$/i.test(file.filename || '')

    const regions = []
    app.iterateRegions(region => {
        if (region.data.isDummy) return
        regions.push(region)
    }, fileIndex, true)
    const speakerOf = (region) => (region.data.speaker || []).filter(Boolean)[0] || 'unknown'

    let xmax = app.wavesurfer && app.wavesurfer.getDuration ? app.wavesurfer.getDuration() || 0 : 0
    regions.forEach(r => { xmax = Math.max(xmax, r.end) })
    ;(app.externalDiarization || []).forEach(d => { xmax = Math.max(xmax, d.end) })

    const speakers = [...new Set(regions.map(speakerOf))].sort(naturalSort)
    const tiers = []

    if (info.unit === 'utterance') {
        const utts = regions.map(r => ({ start: r.start, end: r.end, speaker: speakerOf(r), text: regionText(r) }))
        const silence = info.silence || []
        // the original tag of the silence interval covering most of the gap
        const silenceTag = (a, b) => {
            let best = ''
            let bestOverlap = 0
            silence.forEach(s => {
                const o = Math.min(b, s.end) - Math.max(a, s.start)
                if (o > bestOverlap + EPS) { bestOverlap = o; best = s.text }
            })
            return best
        }
        const [labelName, textName] = info.tiers && info.tiers.length === 2 ? info.tiers : ['speaker', 'transcription']
        if (!hasOverlap(utts)) {
            tiers.push({ name: labelName, intervals: tile(utts.map(u => ({ start: u.start, end: u.end, text: u.speaker })), xmax) })
            tiers.push({ name: textName, intervals: tile(utts, xmax, silenceTag) })
        } else {
            speakers.forEach(spk => {
                const mine = utts.filter(u => u.speaker === spk)
                tiers.push({ name: `${spk}_speaker`, intervals: tile(mine.map(u => ({ start: u.start, end: u.end, text: spk })), xmax) })
                tiers.push({ name: `${spk}_transcription`, intervals: tile(mine, xmax, silenceTag) })
            })
        }
    } else if (isRttm) {
        speakers.forEach(spk => {
            const segs = regions.filter(r => speakerOf(r) === spk).map(r => ({ start: r.start, end: r.end, text: spk }))
            tiers.push({ name: `${spk}_diarization`, intervals: tile(segs, xmax) })
        })
    } else {
        speakers.forEach(spk => {
            const mine = regions.filter(r => speakerOf(r) === spk)
            const words = []
            mine.forEach(r => (r.data.words || []).forEach(w => {
                const text = String(w.text || '').trim()
                if (text && typeof w.start === 'number' && typeof w.end === 'number') words.push({ start: w.start, end: w.end, text })
            }))
            tiers.push({ name: `${spk}_words`, intervals: tile(words, xmax) })
            tiers.push({ name: `${spk}_utterance`, intervals: tile(mine.map(r => ({ start: r.start, end: r.end, text: regionText(r) })), xmax) })
        })
        const diar = app.externalDiarization || []
        ;[...new Set(diar.map(d => d.speaker))].sort(naturalSort).forEach(spk => {
            const segs = diar.filter(d => d.speaker === spk).map(d => ({ start: d.start, end: d.end, text: spk }))
            tiers.push({ name: `${spk}_diarization`, intervals: tile(segs, xmax) })
        })
    }

    if (!tiers.length) tiers.push({ name: 'transcription', intervals: tile([], xmax) })
    return writeTextGrid(tiers, xmax)
}
