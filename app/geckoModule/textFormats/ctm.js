import * as constants from '../constants'

export const parse = (data, $parent) => {
    let monologues = [];

    let lines = data.split(/\n/);
    let words = lines.filter((line) => {
        return line !== '';
    }).map((line) => {
        let cells = line.match(/\S+/g);

        let start = parseFloat(cells[2]);
        let duration = parseFloat(cells[3]);
        let end = start + duration;
        let confidence = parseFloat(cells[5])
        if (confidence === constants.NO_CONFIDENCE) {
            confidence = undefined;
        }

        const text = cells[4] !== constants.EMPTY_TEXT ? cells[4] : ''
 
        return {
            speaker: {id: cells[0].split('_')[0]},
            segment_id: parseInt(cells[0].split('_')[1]),
            start: start,
            end: end,
            text,
            confidence: confidence
        }
    });


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
        m.end = Math.max(...m.words.map(w => w.end));
    });
    monologues.sort((a, b) => a.start - b.start);

    $parent.comparsionData.push(words);

    return [ monologues ];
}

export const convert = (app, fileIndex) => {
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