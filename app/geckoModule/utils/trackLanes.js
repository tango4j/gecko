import { getTracks, markTracksDirty } from './speakerTracks.js'
import { OPERATION_IDS } from '../constants'
import { shadeVars } from './palette.js'
import { fitRegionToWords, insertAtCursor, setWordText, moveWordToSpeaker, moveSegmentToSpeaker, currentLaneSpeaker, deleteSelection, selectionItems, sameItem, foldUndo } from './laneEdits.js'

// Two lane displays under the waveform, one row per speaker:
//   #gecko-word-track : a box per word (start..end), text clipped to the box;
//                       edges / body draggable to adjust word timestamps
//   #gecko-diar-track : RTTM / diarization speaker segments; edges draggable
//                       when they come from a loaded .rttm (or TextGrid
//                       diarization tiers), read-only when derived from the
//                       word file's speaker turns
// Both follow the waveform's zoom and horizontal scroll pixel-for-pixel.

export const DEFAULT_WORD_LANE_H = 36
export const DEFAULT_DIAR_LANE_H = 14
export const MIN_LANE_H = 8
export const MAX_LANE_H = 120

const MIN_DUR = 0.02
export const DEFAULT_SNAP_PX = 6
// left column holding the speaker labels; the waveform and timeline get the
// same left margin (CSS --gk-gutter) so all views stay aligned
export const GUTTER_PX = 64
const HANDLE_PX = 6
const TEXT_MIN_PX = 12          // narrower word boxes hide their text entirely
const MIN_FONT_PX = 5           // lanes so thin the text would be under this hide it
const CULL_MARGIN_PX = 200

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s) => String(s).replace(/[&<>"']/g, c => HTML_ESCAPES[c])
const fmt = (t) => t.toFixed(3)

export const wordLaneHeight = (context) => (context.userConfig && context.userConfig.wordLaneHeight) || DEFAULT_WORD_LANE_H
export const diarLaneHeight = (context) => (context.userConfig && context.userConfig.rttmLaneHeight) || DEFAULT_DIAR_LANE_H

const geometry = (context) => {
    const ws = context.wavesurfer
    if (!ws || !ws.drawer || !ws.drawer.wrapper || !ws.backend) return null
    const duration = ws.getDuration()
    if (!duration) return null
    const wrapper = ws.drawer.wrapper
    const totalWidth = ws.drawer.width ? ws.drawer.width / (ws.params.pixelRatio || 1) : wrapper.scrollWidth
    return {
        duration,
        pps: totalWidth / duration,
        scrollLeft: wrapper.scrollLeft,
        viewWidth: wrapper.clientWidth,
        wrapperLeft: wrapper.getBoundingClientRect().left
    }
}

const els = () => ({
    word: document.querySelector('#gecko-word-track .gecko-track-body'),
    diar: document.querySelector('#gecko-diar-track .gecko-track-body')
})

const laneScaffold = (speakers, colors, laneH, selected, rowSel) => speakers.map((s, i) =>
    `<div class="gk-lane${s === selected ? ' selected' : ''}${s === rowSel ? ' row-selected' : ''}" style="top:${i * laneH}px;height:${laneH}px;${shadeVars(colors[s])}"></div>`
).join('')

const laneLabels = (speakers, colors, laneH, selected, rowSel) => speakers.map((s, i) =>
    `<div class="gk-lane-label${s === selected ? ' selected' : ''}${s === rowSel ? ' row-selected' : ''}" data-speaker="${esc(s)}" title="Click to select ${esc(s)} (Delete removes the whole speaker)" style="top:${i * laneH}px;height:${laneH}px;line-height:${laneH}px;${shadeVars(colors[s])}">${esc(s)}</div>`
).join('')

// ---------------------------------------------------------------- selection
// One click selects a word box or an editable RTTM box (the cursor stays
// where it is); Shift+click adds / removes boxes. Delete / the trash button
// removes the selection, the scissors split it at the cursor (laneEdits).

const isSelectedWord = (context, entry) =>
    selectionItems(context).some(s => s.kind === 'word' && s.w === entry.w)

const isSelectedSeg = (context, seg) => selectionItems(context).some(s => s.kind === 'seg' &&
    (seg.region ? s.regionId === seg.region.id : (!!seg.ref && s.ref === seg.ref)))

// selection: null, one item, or a list of items
export const setLaneSelection = (context, selection) => {
    const list = !selection ? [] : (Array.isArray(selection) ? selection : [selection])
    context.laneSelection = list.length ? list : null
    renderTrackLanes(context, true)
    context.$scope.$evalAsync()
}

// Shift+click: add the item, or remove it if already selected. A whole
// speaker selection is replaced rather than mixed with boxes.
const toggleLaneSelection = (context, item) => {
    const current = selectionItems(context).filter(s => s.kind !== 'speaker')
    const i = current.findIndex(s => sameItem(s, item))
    if (i >= 0) current.splice(i, 1)
    else current.push(item)
    setLaneSelection(context, current)
}

// Snap distance in seconds for the current zoom (0 = snapping off).
const snapSeconds = (context, pps) => {
    const raw = context.userConfig ? context.userConfig.snapPx : undefined
    const px = raw === undefined || raw === null || raw === '' ? DEFAULT_SNAP_PX : +raw
    return px > 0 && pps > 0 ? px / pps : 0
}

export const renderTrackLanes = (context, force = false) => {
    if (context.trackDrag) return
    const g = geometry(context)
    const { word, diar } = els()
    if (!g || !word || !diar) return
    const tracks = getTracks(context)
    const wordH = wordLaneHeight(context)
    const diarH = diarLaneHeight(context)

    const bodyLeft = word.getBoundingClientRect().left + GUTTER_PX
    const shift = g.wrapperLeft - bodyLeft - g.scrollLeft
    const key = [context.tracksVersion, g.pps.toFixed(4), g.scrollLeft, g.viewWidth, Math.round(shift), wordH, diarH].join('|')
    if (!force && key === context.trackRenderKey) return
    context.trackRenderKey = key
    context.trackShift = shift

    const t0 = (g.scrollLeft - CULL_MARGIN_PX) / g.pps
    const t1 = (g.scrollLeft + g.viewWidth + CULL_MARGIN_PX) / g.pps
    const laneOf = {}
    tracks.speakers.forEach((s, i) => { laneOf[s] = i })
    const pad = (h) => (h >= 12 ? 2 : 1)

    // ---- word lane ----
    const visibleWords = []
    let boxes = ''
    tracks.words.forEach(entry => {
        const w = entry.w
        if (w.end < t0 || w.start > t1) return
        const k = visibleWords.push(entry) - 1
        const left = w.start * g.pps
        const width = Math.max((w.end - w.start) * g.pps, 1)
        const top = laneOf[entry.speaker] * wordH + pad(wordH)
        // text height follows the box: font size = a third of the box height
        const boxH = wordH - 2 * pad(wordH)
        const fontPx = Math.round(boxH / 3 * 10) / 10
        let cls = width < Math.max(TEXT_MIN_PX, fontPx * 1.2) || fontPx < MIN_FONT_PX ? 'gk-word notext' : 'gk-word'
        if (isSelectedWord(context, entry)) cls += ' selected'
        const title = `${w.text}  [${entry.speaker}]\n${fmt(w.start)} – ${fmt(w.end)} s  (${fmt(w.end - w.start)} s)`
        boxes += `<div class="${cls}" data-k="${k}" style="left:${left}px;width:${width}px;top:${top}px;height:${boxH}px;font-size:${fontPx}px;line-height:${Math.max(boxH - 2, 1)}px;${shadeVars(tracks.colors[entry.speaker])}" title="${esc(title)}"><span>${esc(w.text)}</span></div>`
    })
    context.laneWords = visibleWords
    word.style.height = `${Math.max(tracks.speakers.length, 1) * wordH}px`
    const selected = currentLaneSpeaker(context)
    const rowSelItem = selectionItems(context).find(s => s.kind === 'speaker')
    const rowSel = rowSelItem ? rowSelItem.speaker : null
    word.innerHTML = laneScaffold(tracks.speakers, tracks.colors, wordH, selected, rowSel) +
        `<div class="gk-lane-clip"><div class="gk-lane-content" style="transform:translateX(${shift}px)">${boxes}</div>` +
        '<div class="gk-track-cursor"></div><div class="gk-drag-label" hidden></div></div>' +
        laneLabels(tracks.speakers, tracks.colors, wordH, selected, rowSel)

    // ---- RTTM / diarization lane ----
    const visibleSegs = []
    let segs = ''
    tracks.diar.forEach(d => {
        if (d.end < t0 || d.start > t1 || laneOf[d.speaker] === undefined) return
        const k = visibleSegs.push(d) - 1
        const left = d.start * g.pps
        const width = Math.max((d.end - d.start) * g.pps, 1)
        const top = laneOf[d.speaker] * diarH + pad(diarH)
        const lock = tracks.diarEditable ? '' : '\n(read-only: derived from the word file — load an .rttm to edit)'
        const title = `${d.speaker}\n${fmt(d.start)} – ${fmt(d.end)} s  (${fmt(d.end - d.start)} s)${lock}`
        segs += `<div class="gk-seg${isSelectedSeg(context, d) ? ' selected' : ''}" data-k="${k}" style="left:${left}px;width:${width}px;top:${top}px;height:${diarH - 2 * pad(diarH)}px;${shadeVars(tracks.colors[d.speaker])}" title="${esc(title)}"></div>`
    })
    context.laneSegs = visibleSegs
    diar.classList.toggle('editable', !!tracks.diarEditable)
    diar.style.height = `${Math.max(tracks.speakers.length, 1) * diarH}px`
    diar.innerHTML = laneScaffold(tracks.speakers, tracks.colors, diarH, selected, rowSel) +
        `<div class="gk-lane-clip"><div class="gk-lane-content" style="transform:translateX(${shift}px)">${segs}</div>` +
        '<div class="gk-track-cursor"></div><div class="gk-drag-label" hidden></div></div>' +
        laneLabels(tracks.speakers, tracks.colors, diarH, selected, rowSel)

    const wordTitle = document.querySelector('#gecko-word-track .gecko-track-source')
    const diarTitle = document.querySelector('#gecko-diar-track .gecko-track-source')
    const diarHint = document.querySelector('#gecko-diar-track .gecko-track-hint')
    if (wordTitle) wordTitle.textContent = tracks.wordSource || ''
    if (diarTitle) diarTitle.textContent = tracks.diarSource === 'turns' ? 'derived from speaker turns (read-only)' : tracks.diarSource
    const target = document.querySelector('#gecko-word-track .gecko-track-target')
    if (target) target.textContent = `insert → ${selected}`
    if (diarHint) {
        diarHint.textContent = tracks.diarEditable
            ? "drag edges to adjust start/end, drag the body to move it or onto another speaker's row"
            : 'load an .rttm file to edit speaker segments; click to seek'
    }
}

export const updateTrackCursors = (context, time) => {
    const g = geometry(context)
    if (!g || context.trackShift === undefined) return
    const x = time * g.pps + context.trackShift
    document.querySelectorAll('#gecko-tracks .gk-track-cursor').forEach(c => {
        c.style.transform = `translateX(${x}px)`
    })
}

// ---------------------------------------------------------------- editing
//
// A drag target is described by an adapter so words and RTTM segments share
// one drag engine:
//   get()      -> { start, end }
//   set(s, e)     live update while dragging
//   limits()   -> { lo, hi }   same-speaker neighbours (no overlap within a speaker)
//   commit(s0, e0)  persist + push an undo entry

const pushTimingUndo = (context, regionId, target, oldStart, oldEnd, oldRegionStart, oldRegionEnd) => {
    context.historyService.undoStack.push([
        OPERATION_IDS.TIMING_CHANGED, regionId, target, oldStart, oldEnd, oldRegionStart, oldRegionEnd
    ])
}

// Set bounds of an RTTM-file region directly: region.update() would run
// Gecko's no-overlap fix-ups against neighbouring regions.
const setSegmentBounds = (context, region, start, end) => {
    region.start = start
    region.end = end
    region.data.regionChanged = true
    if (region.data.words && region.data.words.length) {
        region.data.words[0].start = start
        region.data.words[region.data.words.length - 1].end = end
    }
    region.updateRender()
}

const afterEdit = (context, region) => {
    context.eventBus.trigger('geckoChanged', { event: 'timingChanged', data: region })
    markTracksDirty(context)
    context.$scope.$evalAsync()
}

// Words of one speaker may overlap (transparent boxes show it), so drags
// are only bounded by the file itself.
const fileLimits = (context) => ({ lo: 0, hi: context.wavesurfer.getDuration() })

const wordAdapter = (context, entry) => ({
    label: entry.w.text,
    // edges of this speaker's other word boxes (snap targets)
    edgesFor: (speaker, skip) => (getTracks(context).wordsBySpeaker[speaker] || [])
        .filter(x => x.w !== entry.w && !(skip && skip({ kind: 'word', w: x.w }))).flatMap(x => [x.w.start, x.w.end]),
    speaker: entry.speaker,
    modes: ['start', 'end', 'move'],
    get: () => ({ start: entry.w.start, end: entry.w.end }),
    set: (s, e) => { entry.w.start = s; entry.w.end = e },
    limits: () => fileLimits(context),
    commit: (s0, e0) => {
        const region = entry.region
        const oldRegionStart = region.start
        const oldRegionEnd = region.end
        fitRegionToWords(region)
        pushTimingUndo(context, region.id, entry.w, s0, e0, oldRegionStart, oldRegionEnd)
        afterEdit(context, region)
    },
    moveTo: (speaker, s0, e0) => moveWordToSpeaker(context, entry, speaker, s0, e0),
    selection: () => ({ kind: 'word', w: entry.w })
})

const segAdapter = (context, seg) => ({
    label: seg.speaker,
    // edges of this speaker's other RTTM boxes (snap targets)
    edgesFor: (speaker, skip) => (getTracks(context).diarBySpeaker[speaker] || [])
        .filter(x => !((seg.region && x.region && x.region.id === seg.region.id) || (seg.ref && x.ref === seg.ref)))
        .filter(x => !(skip && skip(x.region ? { kind: 'seg', regionId: x.region.id } : { kind: 'seg', ref: x.ref })))
        .flatMap(x => [x.start, x.end]),
    speaker: seg.speaker,
    modes: ['start', 'end', 'move'],
    get: () => ({ start: seg.start, end: seg.end }),
    set: (s, e) => { seg.start = s; seg.end = e },
    limits: () => fileLimits(context),
    commit: (s0, e0) => {
        if (seg.region) {
            setSegmentBounds(context, seg.region, seg.start, seg.end)
            pushTimingUndo(context, seg.region.id, null, s0, e0, s0, e0)
            afterEdit(context, seg.region)
        } else if (seg.ref) {
            seg.ref.start = seg.start
            seg.ref.end = seg.end
            pushTimingUndo(context, null, seg.ref, s0, e0)
            afterEdit(context, null)
        }
    },
    moveTo: (speaker, s0, e0) => moveSegmentToSpeaker(context, seg, speaker, s0, e0),
    selection: () => (seg.region ? { kind: 'seg', regionId: seg.region.id } : { kind: 'seg', ref: seg.ref })
})

const timeAtClientX = (context, clientX, body) => {
    const g = geometry(context)
    if (!g) return null
    const x = clientX - body.getBoundingClientRect().left - GUTTER_PX - context.trackShift
    return Math.min(Math.max(x / g.pps, 0), g.duration)
}

const laneAtClientY = (context, body, clientY, laneH) => {
    const speakers = getTracks(context).speakers
    const i = Math.floor((clientY - body.getBoundingClientRect().top) / laneH)
    return speakers[Math.min(Math.max(i, 0), speakers.length - 1)]
}

const selectLane = (context, speaker) => {
    if (speaker && speaker !== context.laneSpeaker) {
        context.laneSpeaker = speaker
        renderTrackLanes(context, true)
    }
}

const edgeMode = (box, clientX, modes) => {
    const r = box.getBoundingClientRect()
    const edge = Math.min(HANDLE_PX, r.width / 3)
    const x = clientX - r.left
    if (x < edge && modes.includes('start')) return 'start'
    if (x > r.width - edge && modes.includes('end')) return 'end'
    return modes.includes('move') ? 'move' : null
}

// The other selected boxes that move along when one selected box is dragged
// by its body: each gets its own adapter, start times, row and DOM box.
const buildGroup = (context, grabbedItem) => {
    const items = selectionItems(context).filter(i => i.kind !== 'speaker' && !sameItem(i, grabbedItem))
    if (!items.length || !selectionItems(context).some(i => sameItem(i, grabbedItem))) return null
    const tracks = getTracks(context)
    const { word, diar } = els()
    const members = []
    items.forEach(item => {
        let adapter = null
        let box = null
        let body = null
        let laneH = 0
        if (item.kind === 'word') {
            const entry = tracks.words.find(x => x.w === item.w)
            if (!entry) return
            adapter = wordAdapter(context, entry)
            const k = context.laneWords.indexOf(entry)
            box = k >= 0 ? word.querySelector(`.gk-word[data-k="${k}"]`) : null
            body = word
            laneH = wordLaneHeight(context)
        } else if (tracks.diarEditable) {
            const seg = tracks.diar.find(x => (item.regionId && x.region && x.region.id === item.regionId) || (item.ref && x.ref === item.ref))
            if (!seg) return
            adapter = segAdapter(context, seg)
            const k = context.laneSegs.indexOf(seg)
            box = k >= 0 ? diar.querySelector(`.gk-seg[data-k="${k}"]`) : null
            body = diar
            laneH = diarLaneHeight(context)
        }
        if (!adapter) return
        const { start, end } = adapter.get()
        members.push({ adapter, box, body, laneH, start0: start, end0: end, idx0: tracks.speakers.indexOf(adapter.speaker), speaker: adapter.speaker })
        if (box) box.classList.add('dragging')
    })
    return members.length ? members : null
}

const startDrag = (context, e, body, box, adapter, laneH) => {
    const mode = edgeMode(box, e.clientX, adapter.modes)
    const g = geometry(context)
    const { start, end } = adapter.get()
    const group = mode === 'move' ? buildGroup(context, adapter.selection()) : null
    const speakers = getTracks(context).speakers
    const idx0 = speakers.indexOf(adapter.speaker)
    const all = [{ start0: start, end0: end, idx0 }, ...(group || [])]
    context.trackDrag = {
        adapter, box, mode, body, laneH, pps: g.pps, x0: e.clientX, y0: e.clientY, moved: false,
        start0: start, end0: end, speaker: adapter.speaker, shownSpeaker: adapter.speaker, shift: e.shiftKey, ...adapter.limits(),
        label: body.querySelector('.gk-drag-label'),
        group, idx0,
        // the whole group must stay inside the file and inside the speaker rows
        shiftLo: Math.max(...all.map(m => -m.start0)),
        shiftHi: Math.min(...all.map(m => g.duration - m.end0)),
        laneLo: Math.max(...all.map(m => -m.idx0)),
        laneHi: Math.min(...all.map(m => speakers.length - 1 - m.idx0)),
        skip: group ? (item) => group.some(m => sameItem(m.adapter.selection(), item)) : null
    }
    box.classList.add('dragging')
}

// ---------------------------------------------------------------- text editor

const openWordEditor = (context, entry) => {
    const { word } = els()
    const k = context.laneWords.indexOf(entry)
    const box = k >= 0 && word.querySelector(`.gk-word[data-k="${k}"]`)
    if (!box) return
    closeWordEditor(context, false)
    const host = word.parentElement
    const hostRect = host.getBoundingClientRect()
    const r = box.getBoundingClientRect()
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'gk-word-editor'
    input.value = entry.w.text
    input.spellcheck = false
    input.style.left = `${Math.max(r.left - hostRect.left, 0)}px`
    input.style.top = `${r.top - hostRect.top}px`
    input.style.height = `${Math.max(r.height, 18)}px`
    input.style.width = `${Math.max(r.width, 90)}px`
    input.style.fontSize = `${Math.max(r.height / 3, 11)}px`
    input.style.cssText += shadeVars(getTracks(context).colors[entry.speaker])
    host.appendChild(input)
    context.wordEditor = { input, entry }
    input.addEventListener('keydown', (e) => {
        e.stopPropagation()
        if (e.key === 'Enter') { e.preventDefault(); closeWordEditor(context, true) }
        if (e.key === 'Escape') { e.preventDefault(); closeWordEditor(context, false) }
    })
    input.addEventListener('blur', () => closeWordEditor(context, true))
    input.focus()
    input.select()
}

const closeWordEditor = (context, save) => {
    const ed = context.wordEditor
    if (!ed) return
    context.wordEditor = null
    const value = ed.input.value
    ed.input.remove()
    if (save) setWordText(context, ed.entry, value)
    renderTrackLanes(context, true)
}

export const insertAndEdit = (context) => {
    closeWordEditor(context, true)
    const w = insertAtCursor(context)
    // bring the cursor (and so the new box) into view before opening its editor
    const ws = context.wavesurfer
    const g = geometry(context)
    if (w && g) {
        const x = w.start * g.pps
        if (x < g.scrollLeft || x > g.scrollLeft + g.viewWidth - 40) {
            ws.drawer.wrapper.scrollLeft = Math.max(x - g.viewWidth / 2, 0)
        }
    }
    renderTrackLanes(context, true)
    if (!w) return
    const entry = context.laneWords.find(x => x.w === w)
    if (entry) openWordEditor(context, entry)
}

// ---------------------------------------------------------------- events

export const initTrackLanes = (context) => {
    if (context.trackLanesBound) return
    const { word, diar } = els()
    if (!word || !diar) return
    context.trackLanesBound = true

    const hoverCursor = (selector, modesFor) => (e) => {
        if (context.trackDrag) return
        const box = e.target.closest(selector)
        if (!box) return
        const modes = modesFor(box)
        const mode = modes ? edgeMode(box, e.clientX, modes) : null
        box.style.cursor = mode === 'start' || mode === 'end' ? 'ew-resize' : (mode === 'move' ? 'grab' : 'pointer')
    }

    word.addEventListener('mousemove', hoverCursor('.gk-word', () => ['start', 'end', 'move']))
    diar.addEventListener('mousemove', hoverCursor('.gk-seg', () => getTracks(context).diarEditable ? ['start', 'end', 'move'] : null))

    word.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return
        const laneH = wordLaneHeight(context)
        const rowSpeaker = laneAtClientY(context, word, e.clientY, laneH)
        selectLane(context, rowSpeaker)
        const label = e.target.closest('.gk-lane-label')
        if (label) {
            // speaker name on the far left: select the whole speaker
            e.preventDefault()
            setLaneSelection(context, { kind: 'speaker', speaker: label.dataset.speaker })
            return
        }
        const box = e.target.closest('.gk-word')
        const entry = box && context.laneWords[+box.dataset.k]
        if (!entry) {
            // silence in a speaker's row: move the cursor and select that speaker
            const t = timeAtClientX(context, e.clientX, word)
            if (t !== null) context.seek(t)
            setLaneSelection(context, rowSpeaker ? { kind: 'speaker', speaker: rowSpeaker } : null)
            return
        }
        e.preventDefault()
        if (e.detail >= 2) {
            // double click: edit the word's text in place
            openWordEditor(context, entry)
            return
        }
        startDrag(context, e, word, word.querySelector(`.gk-word[data-k="${box.dataset.k}"]`), wordAdapter(context, entry), laneH)
    })

    diar.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return
        const laneH = diarLaneHeight(context)
        const rowSpeaker = laneAtClientY(context, diar, e.clientY, laneH)
        selectLane(context, rowSpeaker)
        const label = e.target.closest('.gk-lane-label')
        if (label) {
            e.preventDefault()
            setLaneSelection(context, { kind: 'speaker', speaker: label.dataset.speaker })
            return
        }
        const box = e.target.closest('.gk-seg')
        const seg = box && context.laneSegs[+box.dataset.k]
        if (seg && getTracks(context).diarEditable) {
            e.preventDefault()
            startDrag(context, e, diar, diar.querySelector(`.gk-seg[data-k="${box.dataset.k}"]`), segAdapter(context, seg), laneH)
            return
        }
        const t = timeAtClientX(context, e.clientX, diar)
        if (t !== null) context.seek(t)
        // silence in a speaker's row selects that speaker; a read-only box just seeks
        setLaneSelection(context, !seg && rowSpeaker ? { kind: 'speaker', speaker: rowSpeaker } : null)
    })

    window.addEventListener('mousemove', (e) => {
        const d = context.trackDrag
        if (!d) return
        if (!d.moved && Math.abs(e.clientX - d.x0) < 3 && Math.abs(e.clientY - d.y0) < 3) return
        d.moved = true
        if (!d.mode) return
        const dt = (e.clientX - d.x0) / d.pps
        let s = d.start0
        let en = d.end0
        if (d.mode === 'start') {
            s = Math.min(Math.max(d.start0 + dt, d.lo), d.end0 - MIN_DUR)
        } else if (d.mode === 'end') {
            en = Math.max(Math.min(d.end0 + dt, d.hi), d.start0 + MIN_DUR)
        } else {
            const len = d.end0 - d.start0
            s = Math.min(Math.max(d.start0 + dt, d.lo), d.hi - len)
            en = s + len
            // vertical: drop onto another speaker's row (a group keeps its spacing)
            const speakers = getTracks(context).speakers
            const want = speakers.indexOf(laneAtClientY(context, d.body, e.clientY, d.laneH))
            d.laneDelta = Math.min(Math.max(want - d.idx0, d.laneLo), d.laneHi)
            d.speaker = speakers[d.idx0 + d.laneDelta]
            const i = d.idx0 + d.laneDelta
            const pad = d.laneH >= 12 ? 2 : 1
            d.box.style.top = `${i * d.laneH + pad}px`
            if (d.speaker !== d.shownSpeaker) {
                d.shownSpeaker = d.speaker
                d.box.classList.toggle('to-other-speaker', d.speaker !== d.adapter.speaker)
                d.box.style.cssText += shadeVars(getTracks(context).colors[d.speaker])
            }
        }
        // snap the dragged edge(s) to the cursor or to the edges of the
        // speaker's preceding / following boxes, whichever is closest
        let snapped = null
        const snap = snapSeconds(context, d.pps)
        if (snap) {
            const spk = d.speaker || d.adapter.speaker
            d.edgeCache = d.edgeCache || {}
            if (!d.edgeCache[spk]) d.edgeCache[spk] = d.adapter.edgesFor(spk, d.skip)
            const cursorT = context.wavesurfer.getCurrentTime()
            const nearest = (v) => {
                let best = { t: cursorT, what: 'cursor', dist: Math.abs(v - cursorT) }
                for (const t of d.edgeCache[spk]) {
                    const dist = Math.abs(v - t)
                    if (dist < best.dist) best = { t, what: 'segment edge', dist }
                }
                return best.dist <= snap ? best : null
            }
            if (d.mode === 'start') {
                const n = nearest(s)
                if (n && n.t < en - MIN_DUR) { s = n.t; snapped = n.what }
            } else if (d.mode === 'end') {
                const n = nearest(en)
                if (n && n.t > s + MIN_DUR) { en = n.t; snapped = n.what }
            } else {
                const ns = nearest(s)
                const ne = nearest(en)
                const pick = !ns ? (ne && { shift: ne.t - en, what: ne.what })
                    : !ne ? { shift: ns.t - s, what: ns.what }
                        : (ns.dist <= ne.dist ? { shift: ns.t - s, what: ns.what } : { shift: ne.t - en, what: ne.what })
                if (pick && s + pick.shift >= d.lo && en + pick.shift <= d.hi) {
                    s += pick.shift
                    en += pick.shift
                    snapped = pick.what
                }
            }
        }
        if (d.group) {
            // keep the whole group inside the file, then move every member by
            // the same time shift and the same number of rows
            const shift = Math.min(Math.max(s - d.start0, d.shiftLo), d.shiftHi)
            s = d.start0 + shift
            en = d.end0 + shift
            const speakers = getTracks(context).speakers
            const colors = getTracks(context).colors
            d.group.forEach(m => {
                const ms = m.start0 + shift
                const me = m.end0 + shift
                m.adapter.set(ms, me)
                m.speaker = speakers[m.idx0 + (d.laneDelta || 0)]
                if (m.box) {
                    m.box.style.left = `${ms * d.pps}px`
                    m.box.style.width = `${Math.max((me - ms) * d.pps, 1)}px`
                    const pad = m.laneH >= 12 ? 2 : 1
                    m.box.style.top = `${speakers.indexOf(m.speaker) * m.laneH + pad}px`
                    if (m.speaker !== m.shownSpeaker) {
                        m.shownSpeaker = m.speaker
                        m.box.classList.toggle('to-other-speaker', m.speaker !== m.adapter.speaker)
                        m.box.style.cssText += shadeVars(colors[m.speaker])
                    }
                }
            })
        }
        d.box.classList.toggle('snapped', !!snapped)
        d.adapter.set(s, en)
        d.box.style.left = `${s * d.pps}px`
        d.box.style.width = `${Math.max((en - s) * d.pps, 1)}px`
        if (d.label) {
            d.label.hidden = false
            const who = (d.group ? `${d.group.length + 1} boxes  ` : '') + (d.speaker !== d.adapter.speaker ? `→ ${d.speaker}  ` : '')
            d.label.textContent = `${who}${d.adapter.label}  ${fmt(s)} – ${fmt(en)} s${snapped ? `  ⇥ ${snapped}` : ''}`
            d.label.style.left = `${en * d.pps + context.trackShift + 4}px`
            d.label.style.top = d.box.style.top
        }
    })

    window.addEventListener('mouseup', () => {
        const d = context.trackDrag
        if (!d) return
        context.trackDrag = null
        d.box.classList.remove('dragging', 'snapped')
        if (d.group) d.group.forEach(m => m.box && m.box.classList.remove('dragging', 'to-other-speaker'))
        if (d.label) d.label.hidden = true
        const now = d.adapter.get()
        const timeChanged = Math.abs(now.start - d.start0) > 1e-9 || Math.abs(now.end - d.end0) > 1e-9
        const speakerChanged = d.speaker && d.speaker !== d.adapter.speaker
        if (d.moved && d.mode && d.group) {
            // one undo step for the whole group
            const before = context.historyService.undoStack.length
            const commitOne = (adapter, speaker, s0, e0) => {
                const t = adapter.get()
                if (speaker !== adapter.speaker) adapter.moveTo(speaker, s0, e0)
                else if (Math.abs(t.start - s0) > 1e-9 || Math.abs(t.end - e0) > 1e-9) adapter.commit(s0, e0)
            }
            commitOne(d.adapter, d.speaker || d.adapter.speaker, d.start0, d.end0)
            d.group.forEach(m => commitOne(m.adapter, m.speaker, m.start0, m.end0))
            foldUndo(context, before)
            if (speakerChanged) context.laneSpeaker = d.speaker
        } else if (d.moved && d.mode) {
            if (speakerChanged) {
                d.adapter.moveTo(d.speaker, d.start0, d.end0)
                context.laneSpeaker = d.speaker
            } else if (timeChanged) {
                d.adapter.commit(d.start0, d.end0)
            }
            const item = d.adapter.selection()
            if (!selectionItems(context).some(s => sameItem(s, item))) context.laneSelection = [item]
        } else if (!d.moved) {
            // one click selects the box; the cursor stays where it is (so a
            // split lands exactly where the cursor was placed)
            if (d.shift) toggleLaneSelection(context, d.adapter.selection())
            else setLaneSelection(context, d.adapter.selection())
        }
        if (d.moved) renderTrackLanes(context, true)
        context.$scope.$evalAsync()
    })

    window.addEventListener('resize', () => { context.trackRenderKey = null })

    document.addEventListener('keydown', (e) => {
        if (!selectionItems(context).length) return
        const t = e.target
        const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|EDITABLE-WORDS)$/.test(t.tagName))
        if (typing) return
        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault()
            e.stopPropagation()
            deleteSelection(context)
            renderTrackLanes(context, true)
        } else if (e.key === 'Escape') {
            setLaneSelection(context, null)
        }
    }, true)
}
