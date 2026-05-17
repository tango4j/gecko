import { setLineEndings } from '../utils'

import { parse as parseCTM, convert as convertCTM } from './ctm'
import { parse as parseRTTM, convert as convertRTTM } from './rttm'
// import { parse as parseTSV, convert as convertTSV } from './tsv'
import { parse as parseJSON, convert as convertJSON } from './json'
import { parse as parseSRT, convert as convertSRT } from './srt'
import {
    parse as parseSegLST,
    convert as convertSegLST,
    isSegLstFilename,
    isSegLstPayload
} from './seglst'

const parseJSONOrSegLST = (data, app, parserOptions, ...args) => {
    // Auto-detect SegLST list shape inside generic .json files.
    let payload = data
    if (typeof payload === 'string') {
        try {
            payload = JSON.parse(payload)
        } catch (e) {
            payload = null
        }
    }
    if (isSegLstPayload(payload)) {
        return parseSegLST(payload, app, parserOptions, ...args)
    }
    return parseJSON(data, app, parserOptions, ...args)
}

const parse = (filename, data, app, parserOptions, ...args) => {
    const lowerName = (filename || '').toLowerCase()
    const ext = lowerName.substr(lowerName.lastIndexOf('.') + 1);

    if (ext !== 'json') {
        data = setLineEndings(data, 'LF')
    }

    if (isSegLstFilename(lowerName)) {
        return parseSegLST(data, app, parserOptions, ...args)
    }

    switch (ext) {
        case 'rttm':
            return parseRTTM(data, app, parserOptions, ...args)
        /* case 'tsv':
            return parseTSV(data, app, parserOptions, ...args) */
        case 'json':
            return parseJSONOrSegLST(data, app, parserOptions, ...args)
        case 'ctm':
            return parseCTM(data, app, parserOptions, ...args)
        case 'srt':
            return parseSRT(data, app, parserOptions, ...args)
        default:
            alert('format ' + ext + ' is not supported')
            return undefined
    }
}

const convert = (format, parent, parserOptions, ...args) => {
    switch (format) {
        case 'rttm':
            return (fileIndex) => convertRTTM(parent, fileIndex, parserOptions)
        /* case 'tsv':
            return (fileIndex) => convertTSV(parent, fileIndex, parserOptions) */
        case 'json':
            return (fileIndex) => convertJSON(parent, fileIndex, parserOptions)
        case 'ctm':
            return (fileIndex) => convertCTM(parent, fileIndex, parserOptions)
        case 'srt':
            return (fileIndex) => convertSRT(parent, fileIndex, parserOptions)
        case 'seglst':
        case 'seglst.json':
            return (fileIndex) => convertSegLST(parent, fileIndex, parserOptions)
        default:
            alert('format ' + format + ' is not supported')
            return () => ''
    }
}

export { parse, convert }