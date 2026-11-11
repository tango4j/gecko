// Display names of the transcript formats Gecko loads.

const FORMAT_NAMES = { ctm: 'CTM', rttm: 'RTTM', textgrid: 'TextGrid', json: 'JSON', srt: 'SRT', tsv: 'TSV', seglst: 'SegLST' }

export const formatName = (filename) => {
    const lower = (filename || '').toLowerCase().split('?')[0]
    if (/seglst/.test(lower)) return 'SegLST'
    const ext = lower.split('.').pop()
    return FORMAT_NAMES[ext] || ext.toUpperCase()
}
