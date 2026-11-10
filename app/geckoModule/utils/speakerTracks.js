// Per-speaker timeline model shared by the subtitle overlay and the two lane
// displays under the waveform (word timestamps + RTTM / diarization).
//
// Everything is derived from Gecko's live regions, so edits made anywhere
// (text panel, region drags, undo, the word lanes themselves) show up
// everywhere. The model is rebuilt lazily when `context.tracksDirty` is set.

const FALLBACK_COLORS = ['#4fc3f7', '#f48fb1', '#aed581', '#ffd54f', '#ce93d8', '#ff8a65', '#4db6ac', '#90a4ae']

const extOf = (name) => (name || '').toLowerCase().split('?')[0].split('.').pop()

export const speakerSort = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true })

export const markTracksDirty = (context) => {
    context.tracksDirty = true
}

const speakerColor = (context, speaker, index) => {
    for (const f of context.filesData || []) {
        const entry = (f.legend || []).find(l => l.value === speaker)
        if (entry && entry.color) return entry.color
    }
    return FALLBACK_COLORS[index % FALLBACK_COLORS.length]
}

// Index of the file holding word-level timestamps (anything that is not RTTM).
export const wordFileIndex = (context) => {
    const files = context.filesData || []
    const sel = context.selectedFileIndex || 0
    if (files[sel] && extOf(files[sel].filename) !== 'rttm') return sel
    const i = files.findIndex(f => extOf(f.filename) !== 'rttm')
    return i
}

const rttmFileIndex = (context) => (context.filesData || []).findIndex(f => extOf(f.filename) === 'rttm')

const regionSpeakers = (region) => {
    const s = (region.data.speaker || []).filter(x => x)
    return s.length ? s : ['?']
}

const buildTracks = (context) => {
    const words = []          // { speaker, w (live Gecko word object), region }
    const turns = []          // { speaker, start, end, region } – speaker turns from the word file
    const diar = []           // { speaker, start, end }
    const wIndex = wordFileIndex(context)
    const rIndex = rttmFileIndex(context)

    if (wIndex >= 0) {
        context.iterateRegions(region => {
            if (region.data.isDummy) return
            const speakers = regionSpeakers(region)
            speakers.forEach(speaker => turns.push({ speaker, start: region.start, end: region.end, region }))
            // A word belongs to the first speaker of its region (normally the only one).
            ;(region.data.words || []).forEach(w => {
                if (!w || !String(w.text || '').trim()) return
                if (typeof w.start !== 'number' || typeof w.end !== 'number') return
                words.push({ speaker: speakers[0], w, region })
            })
        }, wIndex)
    }

    let diarSource = 'turns'
    if (rIndex >= 0) {
        diarSource = context.filesData[rIndex].filename
        context.iterateRegions(region => {
            if (region.data.isDummy) return
            regionSpeakers(region).forEach(speaker => diar.push({ speaker, start: region.start, end: region.end }))
        }, rIndex)
    } else if (context.externalDiarization && context.externalDiarization.length) {
        diarSource = 'TextGrid diarization tiers'
        context.externalDiarization.forEach(d => diar.push({ ...d }))
    } else {
        turns.forEach(t => diar.push({ speaker: t.speaker, start: t.start, end: t.end }))
    }

    const speakerSet = new Set()
    words.forEach(x => speakerSet.add(x.speaker))
    diar.forEach(x => speakerSet.add(x.speaker))
    const speakers = [...speakerSet].sort(speakerSort)
    const colors = {}
    speakers.forEach((s, i) => { colors[s] = speakerColor(context, s, i) })

    const wordsBySpeaker = {}
    speakers.forEach(s => { wordsBySpeaker[s] = [] })
    words.forEach(x => wordsBySpeaker[x.speaker].push(x))
    Object.values(wordsBySpeaker).forEach(list => list.sort((a, b) => a.w.start - b.w.start))

    const turnsBySpeaker = {}
    speakers.forEach(s => { turnsBySpeaker[s] = [] })
    turns.forEach(t => turnsBySpeaker[t.speaker].push(t))

    diar.sort((a, b) => a.start - b.start)

    return {
        speakers,
        colors,
        words,
        wordsBySpeaker,
        turnsBySpeaker,
        diar,
        diarSource,
        wordSource: wIndex >= 0 && context.filesData[wIndex] ? context.filesData[wIndex].filename : ''
    }
}

export const getTracks = (context) => {
    if (!context.tracksCache || context.tracksDirty) {
        context.tracksCache = buildTracks(context)
        context.tracksDirty = false
        context.tracksVersion = (context.tracksVersion || 0) + 1
    }
    return context.tracksCache
}
