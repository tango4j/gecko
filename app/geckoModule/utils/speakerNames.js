// One set of speakers across the loaded files.
//
// When a word file (CTM, JSON, ...) and an RTTM number the same speakers
// with different prefixes (spk2 / speaker2 / speaker_2), the word file takes
// the RTTM's names, keeping the number. Files whose names aren't all
// "<prefix><number>" with one prefix are left alone.

const NUMBERED = /^(.*?)(\d+)$/

const splitName = (name) => {
    const m = NUMBERED.exec(String(name))
    return m ? { prefix: m[1], digits: m[2] } : null
}

const fileSpeakers = (file) => [...new Set((file.data || [])
    .map(m => m && m.speaker && m.speaker.id)
    .filter(Boolean))]

// the single prefix shared by all names, or null
const sharedPrefix = (names) => {
    if (!names.length) return null
    const parts = names.map(splitName)
    if (parts.some(p => !p)) return null
    return parts.every(p => p.prefix === parts[0].prefix) ? parts[0].prefix : null
}

export const reconcileSpeakerNames = (files) => {
    const ref = (files || []).find(f => /\.rttm$/i.test(f.filename || ''))
    if (!ref) return
    const refPrefix = sharedPrefix(fileSpeakers(ref))
    if (refPrefix === null) return

    files.forEach(file => {
        if (file === ref || !Array.isArray(file.data)) return
        const names = fileSpeakers(file)
        const prefix = sharedPrefix(names)
        if (prefix === null || prefix === refPrefix) return
        const rename = {}
        names.forEach(n => { rename[n] = refPrefix + splitName(n).digits })
        file.data.forEach(m => {
            if (m && m.speaker && rename[m.speaker.id]) m.speaker.id = rename[m.speaker.id]
        })
        const info = file.formatInfo || {}
        file.formatInfo = Object.assign({}, info, {
            speakers: (info.speakers || names).map(n => rename[n] || n),
            renamedTo: { from: prefix, to: refPrefix, ref: ref.filename }
        })
    })
}
