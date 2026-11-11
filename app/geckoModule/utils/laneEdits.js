import { v4 as uuidv4 } from 'uuid'

import * as constants from '../constants'
import { getTracks, markTracksDirty, wordFileIndex, registrySpeakers } from './speakerTracks.js'
import { prepareLegend } from './index.js'

// Edits made from the word / RTTM lanes: insert, text edit, move to another
// speaker. They write straight into Gecko's regions (so Save exports them)
// and push a LANE_EDIT undo entry holding a closure that reverts them.
//
// Regions are referenced by id inside undo closures and deleted regions are
// re-created under their old id with their original word objects, so older
// undo entries keep pointing at the right things.

export const INSERT_DURATION = 0.5
const JOIN_GAP_SEC = 0.3            // a new / moved word joins a same-speaker turn this close

const extOf = (name) => (name || '').toLowerCase().split('?')[0].split('.').pop()
export const rttmFileIndex = (context) => (context.filesData || []).findIndex(f => extOf(f.filename) === 'rttm')

const pushUndo = (context, undo) => {
    context.historyService.undoStack.push([constants.OPERATION_IDS.LANE_EDIT, undo])
}

const changed = (context, region) => {
    context.eventBus.trigger('geckoChanged', { event: 'laneEdit', data: region || null })
    markTracksDirty(context)
    context.$scope.$evalAsync()
}

const refreshTextPanels = (context, region) => {
    context.$timeout(() => {
        if (region) context.resetEditableWords(region.id)
        ;(context.filesData || []).forEach((f, i) => context.resetEditableWords(`main_${i}`))
    })
}

const speakerColor = (context, speaker) => {
    for (const f of context.filesData || []) {
        const e = (f.legend || []).find(l => l.value === speaker)
        if (e && e.color) return e.color
    }
    const n = (context.filesData || []).reduce((a, f) => a + (f.legend || []).filter(l => !l.isDefault).length, 0)
    return constants.SPEAKER_COLORS[n % constants.SPEAKER_COLORS.length]
}

// A speaker must exist in a file's legend before a region of that file can use it.
const ensureLegend = (context, fileIndex, speaker, color) => {
    const file = context.filesData[fileIndex]
    if (!file) return false
    file.legend = file.legend || []
    if (file.legend.find(l => l.value === speaker)) return false
    // same shape and ordering Gecko's own "add speaker" produces
    file.legend.push({ value: speaker, name: '', color: color || speakerColor(context, speaker) })
    file.legend = prepareLegend(file.legend)
    return true
}

const removeFromLegend = (context, fileIndex, speaker) => {
    const file = context.filesData[fileIndex]
    if (!file || !file.legend) return null
    const entry = file.legend.find(l => l.value === speaker)
    if (!entry) return null
    file.legend = prepareLegend(file.legend.filter(l => l !== entry))
    return entry
}

const restoreLegend = (context, removed) => removed.forEach(({ i, entry }) => {
    const f = context.filesData[i]
    if (f && !(f.legend || []).find(l => l.value === entry.value)) {
        f.legend = prepareLegend([...(f.legend || []), entry])
    }
})

// Keep a region spanning its words. Bounds are set directly (no
// region.update / regionUpdated): those run Gecko's fix-ups, which assume
// contiguous non-overlapping words and would clobber overlapping ones.
export const fitRegionToWords = (region) => {
    const timed = (region.data.words || []).filter(w => typeof w.start === 'number' && typeof w.end === 'number')
    if (!timed.length) return
    region.data.words.sort((a, b) => a.start - b.start || a.end - b.end)
    region.start = Math.min(...timed.map(w => w.start))
    region.end = Math.max(...timed.map(w => w.end))
    region.data.regionChanged = true
    region.updateRender()
}

const hasText = (words) => (words || []).some(w => String(w.text || '').trim())

const createRegion = (context, fileIndex, speaker, words, id) => {
    ensureLegend(context, fileIndex, speaker)
    const start = words.length ? Math.min(...words.map(w => w.start)) : 0
    const end = words.length ? Math.max(...words.map(w => w.end)) : 0
    const params = {
        start,
        end,
        data: { fileIndex, speaker: [speaker], words, initFinished: true, regionChanged: true },
        drag: false,
        minLength: constants.MINIMUM_LENGTH
    }
    if (id) params.id = id
    return context.wavesurfer.addRegion(params)
}

const createSegmentRegion = (context, fileIndex, speaker, start, end, id) => {
    ensureLegend(context, fileIndex, speaker)
    const params = {
        start,
        end,
        data: { fileIndex, speaker: [speaker], words: [], initFinished: true, regionChanged: true },
        drag: false,
        minLength: constants.MINIMUM_LENGTH
    }
    if (id) params.id = id
    return context.wavesurfer.addRegion(params)
}

const deleteRegion = (context, region) => {
    if (region) context.__deleteRegion(region)
}

// Turn of `speaker` in `fileIndex` that [t0, t1] overlaps or nearly touches.
const findTurn = (context, fileIndex, speaker, t0, t1, exclude) => {
    let best = null
    let bestGap = Infinity
    context.iterateRegions(r => {
        if (r === exclude || r.data.isDummy || (r.data.speaker || [])[0] !== speaker) return
        const gap = Math.max(r.start - t1, t0 - r.end, 0)
        if (gap <= JOIN_GAP_SEC && gap < bestGap) {
            best = r
            bestGap = gap
        }
    }, fileIndex)
    return best
}

// Put word `w` into `speaker`'s turn (joining one nearby or creating one).
// Returns a function undoing exactly that placement.
const placeWord = (context, fileIndex, speaker, w) => {
    const turn = findTurn(context, fileIndex, speaker, w.start, w.end)
    if (turn) {
        const turnId = turn.id
        const oldBounds = [turn.start, turn.end]
        turn.data.words.push(w)
        fitRegionToWords(turn)
        return () => {
            const r = context.getRegion(turnId)
            if (!r) return
            r.data.words = r.data.words.filter(x => x !== w)
            r.start = oldBounds[0]
            r.end = oldBounds[1]
            r.updateRender()
        }
    }
    const region = createRegion(context, fileIndex, speaker, [w])
    const id = region.id
    return () => deleteRegion(context, context.getRegion(id))
}

// Take word `w` out of `region` (deleting the region if no text is left).
// Returns a function putting it back.
const takeWord = (context, region, w) => {
    const regionId = region.id
    const fileIndex = region.data.fileIndex
    const speaker = (region.data.speaker || [])[0]
    const words = region.data.words
    const index = words.indexOf(w)
    const oldBounds = [region.start, region.end]
    words.splice(index, 1)
    if (!hasText(words)) {
        deleteRegion(context, region)
        return () => {
            words.splice(index, 0, w)
            createRegion(context, fileIndex, speaker, words, regionId)
        }
    }
    fitRegionToWords(region)
    return () => {
        const r = context.getRegion(regionId)
        if (!r) return
        r.data.words.splice(index, 0, w)
        r.start = oldBounds[0]
        r.end = oldBounds[1]
        r.updateRender()
    }
}

// ------------------------------------------------------------------ insert

export const currentLaneSpeaker = (context) => {
    const speakers = getTracks(context).speakers
    if (context.laneSpeaker && speakers.includes(context.laneSpeaker)) return context.laneSpeaker
    return speakers[0] || 'spk0'
}

// Insert a 0.5 s word box (and RTTM box) for the selected lane's speaker at
// the cursor. Returns the new word object (so the UI can open its editor).
export const insertAtCursor = (context) => {
    const duration = context.wavesurfer.getDuration()
    const start = Math.min(context.wavesurfer.getCurrentTime(), Math.max(duration - INSERT_DURATION, 0))
    const end = Math.min(start + INSERT_DURATION, duration)
    const speaker = currentLaneSpeaker(context)
    const undos = []
    let word = null

    const wIndex = wordFileIndex(context)
    if (wIndex >= 0) {
        word = { start, end, text: 'word', uuid: uuidv4() }
        undos.push(placeWord(context, wIndex, speaker, word))
    }

    const rIndex = rttmFileIndex(context)
    if (rIndex >= 0) {
        const seg = createSegmentRegion(context, rIndex, speaker, start, end)
        const id = seg.id
        undos.push(() => deleteRegion(context, context.getRegion(id)))
    } else if (context.externalDiarization) {
        const d = { speaker, start, end }
        context.externalDiarization.push(d)
        undos.push(() => {
            const i = context.externalDiarization.indexOf(d)
            if (i >= 0) context.externalDiarization.splice(i, 1)
        })
    }

    pushUndo(context, () => undos.reverse().forEach(u => u()))
    refreshTextPanels(context, null)
    changed(context, null)
    return word
}

// ------------------------------------------------------------------ text

// New text for a word. Several words typed into one box split its time
// evenly; empty text deletes the word.
export const setWordText = (context, entry, text) => {
    const w = entry.w
    const region = entry.region
    const tokens = String(text).trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 1 && tokens[0] === w.text) return

    if (!tokens.length) {
        const undoTake = takeWord(context, region, w)
        pushUndo(context, () => undoTake())
        refreshTextPanels(context, region)
        changed(context, region)
        return
    }

    const regionId = region.id
    const oldText = w.text
    const oldEnd = w.end
    const step = (w.end - w.start) / tokens.length
    const extra = tokens.slice(1).map((t, i) => ({
        start: w.start + step * (i + 1),
        end: i === tokens.length - 2 ? oldEnd : w.start + step * (i + 2),
        text: t,
        uuid: uuidv4()
    }))
    w.text = tokens[0]
    if (extra.length) {
        w.end = w.start + step
        region.data.words.push(...extra)
        fitRegionToWords(region)
    }
    pushUndo(context, () => {
        w.text = oldText
        w.end = oldEnd
        const r = context.getRegion(regionId)
        if (r && extra.length) {
            r.data.words = r.data.words.filter(x => !extra.includes(x))
            fitRegionToWords(r)
        }
    })
    refreshTextPanels(context, region)
    changed(context, region)
}

// ------------------------------------------------------------------ move to speaker

// Move a word to another speaker (and/or time). start0/end0: times before the drag.
export const moveWordToSpeaker = (context, entry, speaker, start0, end0) => {
    const w = entry.w
    const fileIndex = entry.region.data.fileIndex
    const newTimes = [w.start, w.end]
    w.start = start0
    w.end = end0
    const undoTake = takeWord(context, entry.region, w)
    w.start = newTimes[0]
    w.end = newTimes[1]
    const undoPlace = placeWord(context, fileIndex, speaker, w)
    pushUndo(context, () => {
        undoPlace()
        w.start = start0
        w.end = end0
        undoTake()
    })
    refreshTextPanels(context, null)
    changed(context, null)
}

// Move an RTTM segment to another speaker (and/or time).
export const moveSegmentToSpeaker = (context, seg, speaker, start0, end0) => {
    if (seg.region) {
        const region = seg.region
        const id = region.id
        const oldSpeaker = region.data.speaker.slice()
        ensureLegend(context, region.data.fileIndex, speaker)
        region.data.speaker = [speaker]
        region.start = seg.start
        region.end = seg.end
        region.data.regionChanged = true
        if (region.data.words && region.data.words.length) {
            region.data.words[0].start = seg.start
            region.data.words[region.data.words.length - 1].end = seg.end
        }
        context.regionUpdated(region)
        pushUndo(context, () => {
            const r = context.getRegion(id)
            if (!r) return
            r.data.speaker = oldSpeaker
            r.start = start0
            r.end = end0
            if (r.data.words && r.data.words.length) {
                r.data.words[0].start = start0
                r.data.words[r.data.words.length - 1].end = end0
            }
            context.regionUpdated(r)
        })
        changed(context, region)
    } else if (seg.ref) {
        const ref = seg.ref
        const old = { speaker: ref.speaker, start: start0, end: end0 }
        ref.speaker = speaker
        ref.start = seg.start
        ref.end = seg.end
        pushUndo(context, () => Object.assign(ref, old))
        changed(context, null)
    }
}

// ------------------------------------------------------------------ delete

// Can the current lane selection be deleted? (Read-only RTTM segments
// derived from the word file are never selected.)
export const canDeleteSelection = (context) => selectionItems(context).length > 0

// The lane selection is a list of items:
//   { kind: 'word', w }            a word box (its live word object)
//   { kind: 'seg', regionId }      a box of a loaded .rttm file
//   { kind: 'seg', ref }           a TextGrid diarization interval
//   { kind: 'speaker', speaker }   a whole speaker row (selected alone)
export const selectionItems = (context) => context.laneSelection || []

export const sameItem = (a, b) => !!a && !!b && a.kind === b.kind && (
    a.kind === 'word' ? a.w === b.w
        : a.kind === 'speaker' ? a.speaker === b.speaker
            : (a.regionId ? a.regionId === b.regionId : a.ref === b.ref))

const regionOfWord = (context, w) => {
    let region = null
    context.iterateRegions(r => {
        if (!region && (r.data.words || []).includes(w)) region = r
    })
    return region
}

// Remove one word / segment; returns a function undoing it (or null).
const removeItem = (context, item) => {
    if (item.kind === 'word') {
        const region = regionOfWord(context, item.w)
        return region ? takeWord(context, region, item.w) : null
    }
    if (item.kind === 'seg' && item.regionId) {
        const region = context.getRegion(item.regionId)
        if (!region) return null
        const keep = {
            id: region.id,
            fileIndex: region.data.fileIndex,
            speaker: (region.data.speaker || [])[0],
            start: region.start,
            end: region.end
        }
        deleteRegion(context, region)
        return () => createSegmentRegion(context, keep.fileIndex, keep.speaker, keep.start, keep.end, keep.id)
    }
    if (item.kind === 'seg' && item.ref && context.externalDiarization) {
        const list = context.externalDiarization
        const i = list.indexOf(item.ref)
        if (i < 0) return null
        list.splice(i, 1)
        return () => list.splice(i, 0, item.ref)
    }
    return null
}

// Delete everything selected (one undo step for the whole selection).
export const deleteSelection = (context) => {
    const items = selectionItems(context)
    if (!items.length) return false
    context.laneSelection = null

    const speaker = items.find(i => i.kind === 'speaker')
    if (speaker) return deleteSpeaker(context, speaker.speaker)

    const undos = items.map(item => removeItem(context, item)).filter(Boolean)
    if (!undos.length) return false
    pushUndo(context, () => undos.reverse().forEach(u => u()))
    refreshTextPanels(context, null)
    changed(context, null)
    return true
}

// ------------------------------------------------------------------ split

const MIN_PART_SEC = 0.01

const itemTimes = (context, item) => {
    if (item.kind === 'word') return { start: item.w.start, end: item.w.end }
    if (item.kind === 'seg' && item.regionId) {
        const r = context.getRegion(item.regionId)
        return r ? { start: r.start, end: r.end } : null
    }
    if (item.kind === 'seg' && item.ref) return { start: item.ref.start, end: item.ref.end }
    return null
}

// Selected boxes the cursor lies inside (these are what Split cuts).
export const splittableItems = (context) => {
    const t = context.wavesurfer ? context.wavesurfer.getCurrentTime() : NaN
    return selectionItems(context).filter(item => {
        const tm = item.kind !== 'speaker' && itemTimes(context, item)
        return tm && t > tm.start + MIN_PART_SEC && t < tm.end - MIN_PART_SEC
    })
}

// Characters of a word divided at the same fraction as its time span.
const splitText = (text, frac) => {
    const chars = [...String(text)]
    if (chars.length < 2) return [text, text]
    const k = Math.min(Math.max(Math.round(chars.length * frac), 1), chars.length - 1)
    return [chars.slice(0, k).join(''), chars.slice(k).join('')]
}

// Split every selected word / RTTM box that contains the cursor, at the
// cursor. Both halves stay selected. One undo step.
export const splitSelection = (context) => {
    const t = context.wavesurfer.getCurrentTime()
    const items = splittableItems(context)
    if (!items.length) return 0
    const undos = []
    const newSelection = []

    items.forEach(item => {
        if (item.kind === 'word') {
            const w = item.w
            const region = regionOfWord(context, w)
            if (!region) return
            const regionId = region.id
            const old = { end: w.end, text: w.text }
            const [head, tail] = splitText(w.text, (t - w.start) / (w.end - w.start))
            const second = { start: t, end: w.end, text: tail, uuid: uuidv4() }
            w.end = t
            w.text = head
            region.data.words.splice(region.data.words.indexOf(w) + 1, 0, second)
            fitRegionToWords(region)
            newSelection.push(item, { kind: 'word', w: second })
            undos.push(() => {
                w.end = old.end
                w.text = old.text
                const r = context.getRegion(regionId)
                if (r) {
                    r.data.words = r.data.words.filter(x => x !== second)
                    fitRegionToWords(r)
                }
            })
        } else if (item.regionId) {
            const region = context.getRegion(item.regionId)
            if (!region) return
            const oldEnd = region.end
            const speaker = (region.data.speaker || [])[0]
            const second = createSegmentRegion(context, region.data.fileIndex, speaker, t, oldEnd)
            const secondId = second.id
            region.end = t
            if (region.data.words && region.data.words.length) region.data.words[region.data.words.length - 1].end = t
            region.data.regionChanged = true
            region.updateRender()
            newSelection.push(item, { kind: 'seg', regionId: secondId })
            undos.push(() => {
                deleteRegion(context, context.getRegion(secondId))
                const r = context.getRegion(item.regionId)
                if (r) {
                    r.end = oldEnd
                    if (r.data.words && r.data.words.length) r.data.words[r.data.words.length - 1].end = oldEnd
                    r.updateRender()
                }
            })
        } else if (item.ref && context.externalDiarization) {
            const ref = item.ref
            const oldEnd = ref.end
            const second = { speaker: ref.speaker, start: t, end: oldEnd }
            ref.end = t
            const list = context.externalDiarization
            list.splice(list.indexOf(ref) + 1, 0, second)
            newSelection.push(item, { kind: 'seg', ref: second })
            undos.push(() => {
                ref.end = oldEnd
                const i = list.indexOf(second)
                if (i >= 0) list.splice(i, 1)
            })
        }
    })

    if (!undos.length) return 0
    pushUndo(context, () => undos.reverse().forEach(u => u()))
    context.laneSelection = newSelection
    refreshTextPanels(context, null)
    changed(context, null)
    return undos.length
}

// ------------------------------------------------------------------ speakers

// Next speaker name following the names already in use: the most common
// "<prefix><number>" pattern continues from its highest number, keeping any
// zero padding (speaker_5 -> speaker_6, spk2 -> spk3, S09 -> S10).
export const nextSpeakerName = (names) => {
    const groups = {}
    names.forEach(n => {
        const m = /^(.*?)(\d+)$/.exec(String(n))
        if (!m) return
        const g = groups[m[1]] = groups[m[1]] || { count: 0, max: -1, width: 1 }
        g.count++
        if (+m[2] > g.max) { g.max = +m[2]; g.width = m[2].length }
    })
    const best = Object.entries(groups).sort((a, b) => b[1].count - a[1].count || b[1].max - a[1].max)[0]
    let prefix = 'speaker_'
    let n = names.length
    let width = 1
    if (best) {
        prefix = best[0]
        n = best[1].max + 1
        width = String(best[1].max).length < best[1].width ? best[1].width : 1
    }
    let name = prefix + String(n).padStart(width, '0')
    while (names.includes(name)) name = prefix + String(++n).padStart(width, '0')
    return name
}

const unusedColor = (context) => {
    const used = new Set()
    ;(context.filesData || []).forEach(f => (f.legend || []).forEach(l => used.add(l.color)))
    const free = constants.SPEAKER_COLORS.find(c => !used.has(c))
    return free || constants.SPEAKER_COLORS[registrySpeakers(context).length % constants.SPEAKER_COLORS.length]
}

// "+ Speaker": register the next speaker in every file's Segment Labeling
// list; the lanes give it an empty row, ready for boxes.
export const addSpeaker = (context) => {
    const known = [...new Set([...registrySpeakers(context), ...getTracks(context).speakers])]
    const name = nextSpeakerName(known)
    const color = unusedColor(context)
    const added = []
    ;(context.filesData || []).forEach((f, i) => { if (ensureLegend(context, i, name, color)) added.push(i) })
    const previousTarget = context.laneSpeaker
    context.laneSpeaker = name
    pushUndo(context, () => {
        added.forEach(i => removeFromLegend(context, i, name))
        context.laneSpeaker = previousTarget
    })
    changed(context, null)
    return name
}

const recreateRegion = (context, rec) => {
    ensureLegend(context, rec.fileIndex, rec.speaker[0])
    return context.wavesurfer.addRegion({
        id: rec.id,
        start: rec.start,
        end: rec.end,
        data: { fileIndex: rec.fileIndex, speaker: rec.speaker, words: rec.words, initFinished: true, regionChanged: true },
        drag: false,
        minLength: constants.MINIMUM_LENGTH
    })
}

// Remove a speaker everywhere: its word turns, its RTTM segments (loaded
// .rttm regions or TextGrid diarization intervals) and its row.
export const deleteSpeaker = (context, speaker) => {
    const removedRegions = []     // whole regions of this speaker
    const trimmedRegions = []     // multi-speaker regions that just lose this speaker
    Object.values(context.wavesurfer.regions.list).forEach(r => {
        const spk = r.data.speaker || []
        if (!spk.includes(speaker) || r.data.isDummy) return
        if (spk.length === 1) {
            removedRegions.push({ id: r.id, fileIndex: r.data.fileIndex, speaker: spk.slice(), start: r.start, end: r.end, words: r.data.words })
            context.__deleteRegion(r)
        } else {
            trimmedRegions.push({ id: r.id, speaker: spk.slice() })
            r.data.speaker = spk.filter(s => s !== speaker)
            r.data.regionChanged = true
            context.regionUpdated(r)
        }
    })
    const removedDiar = []
    if (context.externalDiarization) {
        context.externalDiarization = context.externalDiarization.filter((d, i) => {
            if (d.speaker !== speaker) return true
            removedDiar.push({ i, d })
            return false
        })
    }
    // unregister from every file's Segment Labeling list
    const legendRemoved = []
    ;(context.filesData || []).forEach((f, i) => {
        const entry = removeFromLegend(context, i, speaker)
        if (entry) legendRemoved.push({ i, entry })
    })
    const previousTarget = context.laneSpeaker
    if (context.laneSpeaker === speaker) context.laneSpeaker = null

    pushUndo(context, () => {
        // registry first: recreated regions need their speaker in the legend
        restoreLegend(context, legendRemoved)
        removedRegions.forEach(rec => recreateRegion(context, rec))
        trimmedRegions.forEach(rec => {
            const r = context.getRegion(rec.id)
            if (r) { r.data.speaker = rec.speaker; context.regionUpdated(r) }
        })
        if (removedDiar.length) {
            context.externalDiarization = context.externalDiarization || []
            removedDiar.forEach(({ i, d }) => context.externalDiarization.splice(i, 0, d))
        }
        context.laneSpeaker = previousTarget
    })
    refreshTextPanels(context, null)
    changed(context, null)
    return true
}

// Fold every undo entry pushed since `fromLength` into a single undo step
// (used when a group of selected boxes is dragged together).
export const foldUndo = (context, fromLength) => {
    const hs = context.historyService
    const entries = hs.undoStack.splice(fromLength)
    if (entries.length <= 1) {
        hs.undoStack.push(...entries)
        return
    }
    pushUndo(context, () => {
        entries.slice().reverse().forEach(entry => {
            hs.undoStack.push(entry)
            hs.undo(context)
        })
    })
}
