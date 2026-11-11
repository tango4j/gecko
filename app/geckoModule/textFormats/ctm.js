import * as constants from '../constants'

// CTM layouts, detected per file:
//   gecko    "<spk>_<segment>_<x> <chan> <start> <dur> <word> [conf]"
//            speaker and segment id come from the first column
//   channel  "<recording> <chan> <start> <dur> <word> [conf]"
//            one recording id for the whole file (or several channels):
//            channels count from 1 (NIST), so channel 3 is speaker index 2
//            -> spk2; a file that uses channel 0 counts from 0
//   field    "<recording> <chan> <start> <dur> <word> <conf> <type> <speaker>"
//            NIST CTM with a speaker column
//   recording  anything else: the first column (up to "_") is the speaker
// Without segment ids, a speaker's words are grouped into one region until
// a pause longer than PAUSE_SEC.

const PAUSE_SEC = 0.6
const GECKO_ID = /^[^_\s]+_\d+(_|$)/

export const detectLayout = (rows) => {
    if (!rows.length) return 'gecko'
    if (rows.some(c => c.length >= 8) && rows.every(c => c.length < 8 || (c[7] && c[7] !== '<NA>'))) return 'field'
    const channels = new Set(rows.map(c => c[1]))
    const recordings = new Set(rows.map(c => c[0]))
    if (rows.every(c => GECKO_ID.test(c[0])) && (recordings.size > 1 || channels.size === 1 && rows[0][1] === '1')) return 'gecko'
    if (channels.size > 1 || recordings.size === 1) return 'channel'
    return 'recording'
}


export const parse = (data, $parent) => {
    let monologues = [];

    const rows = data.split(/\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith(';;'))
        .map(line => line.match(/\S+/g))
        .filter(cells => cells && cells.length >= 5)
    const layout = detectLayout(rows)
    const hasConfidence = rows.some(c => c.length >= 6)
    const channels = [...new Set(rows.map(c => c[1]))]
        .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }))
    const channelBase = channels.every(c => /^\d+$/.test(c)) && !channels.some(c => parseInt(c, 10) === 0) ? 1 : 0
    const channelSpeaker = (chan) => /^\d+$/.test(chan) ? `spk${parseInt(chan, 10) - channelBase}` : `spk${chan}`

    let words = rows.map((cells) => {
        let start = parseFloat(cells[2]);
        let duration = parseFloat(cells[3]);
        let end = start + duration;
        let confidence = parseFloat(cells[5])
        if (confidence === constants.NO_CONFIDENCE || Number.isNaN(confidence)) {
            confidence = undefined;
        }

        const text = cells[4] !== constants.EMPTY_TEXT ? cells[4] : ''

        let speaker
        let segment_id = NaN
        if (layout === 'gecko' || layout === 'recording') {
            speaker = cells[0].split('_')[0]
            segment_id = layout === 'gecko' ? parseInt(cells[0].split('_')[1]) : NaN
        } else if (layout === 'channel') {
            speaker = channelSpeaker(cells[1])
        } else {
            speaker = cells[7]
        }

        return {
            speaker: {id: speaker},
            segment_id,
            start: start,
            end: end,
            text,
            confidence: confidence
        }
    });

    if (layout !== 'gecko') {
        // no segment ids: split each speaker's words at pauses
        const last = {}
        let next = 0
        words.slice().sort((x, y) => x.start - y.start).forEach(w => {
            const prev = last[w.speaker.id]
            if (prev && w.start - prev.end <= PAUSE_SEC) w.segment_id = prev.segment_id
            else w.segment_id = next++
            last[w.speaker.id] = w
        })
    }

    if ($parent) {
        const recordings = [...new Set(rows.map(c => c[0]))]
        $parent.lastParseInfo = {
            format: 'CTM',
            unit: 'word',
            layout,
            hasConfidence,
            channels,
            channelBase,
            recording: recordings[0] || 'audio',
            speakers: [...new Set(words.map(w => w.speaker.id))]
                .sort((x, y) => String(x).localeCompare(String(y), undefined, { numeric: true }))
        }
    }

    // Group words by segment id rather than by runs of equal ids, so a segment
    // whose words interleave with another speaker's (overlapped speech) stays
    // one region instead of being chopped into fragments.
    const bySegment = new Map();

    words.forEach((word) => {
        // No parsable segment id: one region per word, as before.
        const key = Number.isNaN(word.segment_id) ? Symbol() : word.segment_id;
        let monologue = bySegment.get(key);
        if (!monologue) {
            monologue = {
                speaker: word.speaker,
                start: word.start,
                words: []
            };
            bySegment.set(key, monologue);
            monologues.push(monologue);
        }
        monologue.words.push(word);

        // this information is now on the segment/monologue
        delete word.segment_id;
        delete word.speaker;
    });

    monologues.forEach((m) => {
        m.words.sort((x, y) => x.start - y.start);
        m.start = Math.min(...m.words.map(w => w.start));
        m.end = Math.max(...m.words.map(w => w.end));
    });
    monologues.sort((a, b) => a.start - b.start);

    $parent.comparsionData.push(words);

    return [ monologues ];
}

const num6 = (x) => String(Number(x.toFixed(6)))

// channel / field layouts: write the file back the way it came in
const convertPlain = (app, fileIndex, info) => {
    // speaker -> channel: the speaker's own number (spk3 -> 3, speaker_5 -> 5)
    // unless another speaker has it already, then the next free channel
    const chanOf = {}
    const used = new Set()
    const speakerChannel = (spk) => {
        if (chanOf[spk] !== undefined) return chanOf[spk]
        const m = /(\d+)$/.exec(spk)
        const base = info.channelBase === undefined ? 1 : info.channelBase
        let ch = m ? parseInt(m[1], 10) + base : base
        while (used.has(ch)) ch++
        used.add(ch)
        chanOf[spk] = ch
        return ch
    }
    const rows = []
    app.iterateRegions((region) => {
        const speaker = app.formatSpeaker(region.data.speaker)
        ;(region.data.words || []).forEach((word) => {
            const text = word.text && word.text.length ? word.text : constants.EMPTY_TEXT
            const conf = (word.confidence === undefined || word.confidence === null ? constants.NO_CONFIDENCE : word.confidence).toFixed(2)
            let line
            if (info.layout === 'channel') {
                line = `${info.recording} ${speakerChannel(speaker)} ${num6(word.start)} ${num6(word.end - word.start)} ${text}` + (info.hasConfidence ? ` ${conf}` : '')
            } else {
                line = `${info.recording} 1 ${num6(word.start)} ${num6(word.end - word.start)} ${text} ${conf} lex ${speaker}`
            }
            rows.push({ start: word.start, line })
        })
    }, fileIndex, true)
    rows.sort((a, b) => a.start - b.start)
    return rows.map(r => r.line).join('\n')
}

export const convert = (app, fileIndex) => {
    const file = (app.filesData || [])[fileIndex] || {}
    const info = file.formatInfo || {}
    if (info.format === 'CTM' && (info.layout === 'channel' || info.layout === 'field')) {
        return convertPlain(app, fileIndex, info)
    }
    var self = app;
    var segment_id = 0;
    const output = []

    app.iterateRegions((region) => {
        let speaker = self.formatSpeaker(region.data.speaker);

        region.data.words.forEach((word) => {
            let confidence = word.confidence || constants.NO_CONFIDENCE;
            output.push(`${speaker}_${segment_id.toString().padStart(5, '0')}_audio 1 ${word.start.toFixed(2).padStart(8, '0')} ${(word.end - word.start).toFixed(2)} ${word.text.length ? word.text : constants.EMPTY_TEXT} ${confidence.toFixed(2)}`)
        });

        segment_id++;
    }, fileIndex, true);

    return output.sort().join('\n')
}