import { getTracks, markTracksDirty } from './speakerTracks.js'
import { OPERATION_IDS } from '../constants'
import { shadeVars } from './palette.js'
import { fitRegionToWords, insertAtCursor, setWordText, moveWordToSpeaker, moveSegmentToSpeaker, currentLaneSpeaker, deleteSelection } from './laneEdits.js'

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

const laneScaffold = (speakers, colors, laneH, selected) => speakers.map((s, i) =>
    `<div class="gk-lane${s === selected ? ' selected' : ''}" style="top:${i * laneH}px;height:${laneH}px;${shadeVars(colors[s])}"></div>`
).join('')

const laneLabels = (speakers, colors, laneH, selected) => speakers.map((s, i) =>
    `<div class="gk-lane-label${s === selected ? ' selected' : ''}" style="top:${i * laneH}px;height:${laneH}px;line-height:${laneH}px;${shadeVars(colors[s])}">${esc(s)}</div>`
).join('')

// ---------------------------------------------------------------- selection
// One click selects a word box or an editable RTTM box; Delete / the trash
// button removes it (laneEdits.deleteSelection).

const isSelectedWord = (context, entry) => {
    const s = context.laneSelection
    return !!s && s.kind === 'word' && s.w === entry.w
}

const isSelectedSeg = (context, seg) => {
    const s = context.laneSelection
    if (!s || s.kind !== 'seg') return false
    return seg.region ? s.regionId === seg.region.id : (!!seg.ref && s.ref === seg.ref)
}

export const setLaneSelection = (context, selection) => {
    context.laneSelection = selection || null
    renderTrackLanes(context, true)
    context.$scope.$evalAsync()
}

export const renderTrackLanes = (context, force = false) => {
    if (context.trackDrag) return
    const g = geometry(context)
    const { word, diar } = els()
    if (!g || !word || !diar) return
    const tracks = getTracks(context)
    const wordH = wordLaneHeight(context)
    const diarH = diarLaneHeight(context)

    const bodyLeft = word.getBoundingClientRect().left
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
    word.innerHTML = laneScaffold(tracks.speakers, tracks.colors, wordH, selected) +
        `<div class="gk-lane-content" style="transform:translateX(${shift}px)">${boxes}</div>` +
        laneLabels(tracks.speakers, tracks.colors, wordH, selected) +
        '<div class="gk-track-cursor"></div><div class="gk-drag-label" hidden></div>'

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
    diar.innerHTML = laneScaffold(tracks.speakers, tracks.colors, diarH, selected) +
        `<div class="gk-lane-content" style="transform:translateX(${shift}px)">${segs}</div>` +
        laneLabels(tracks.speakers, tracks.colors, diarH, selected) +
        '<div class="gk-track-cursor"></div><div class="gk-drag-label" hidden></div>'

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
    const x = clientX - body.getBoundingClientRect().left - context.trackShift
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

const startDrag = (context, e, body, box, adapter, laneH) => {
    const mode = edgeMode(box, e.clientX, adapter.modes)
    const g = geometry(context)
    const { start, end } = adapter.get()
    context.trackDrag = {
        adapter, box, mode, body, laneH, pps: g.pps, x0: e.clientX, y0: e.clientY, moved: false,
        start0: start, end0: end, speaker: adapter.speaker, shownSpeaker: adapter.speaker, ...adapter.limits(),
        label: body.querySelector('.gk-drag-label')
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
        selectLane(context, laneAtClientY(context, word, e.clientY, laneH))
        const box = e.target.closest('.gk-word')
        const entry = box && context.laneWords[+box.dataset.k]
        if (!entry) {
            const t = timeAtClientX(context, e.clientX, word)
            if (t !== null) context.seek(t)
            if (context.laneSelection) setLaneSelection(context, null)
            context.$scope.$evalAsync()
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
        selectLane(context, laneAtClientY(context, diar, e.clientY, laneH))
        const box = e.target.closest('.gk-seg')
        const seg = box && context.laneSegs[+box.dataset.k]
        if (seg && getTracks(context).diarEditable) {
            e.preventDefault()
            startDrag(context, e, diar, diar.querySelector(`.gk-seg[data-k="${box.dataset.k}"]`), segAdapter(context, seg), laneH)
            return
        }
        const t = seg ? seg.start : timeAtClientX(context, e.clientX, diar)
        if (t !== null) context.seek(t)
        if (context.laneSelection) setLaneSelection(context, null)
        context.$scope.$evalAsync()
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
            // vertical: drop onto another speaker's row
            const speakers = getTracks(context).speakers
            d.speaker = laneAtClientY(context, d.body, e.clientY, d.laneH)
            const i = speakers.indexOf(d.speaker)
            const pad = d.laneH >= 12 ? 2 : 1
            d.box.style.top = `${i * d.laneH + pad}px`
            if (d.speaker !== d.shownSpeaker) {
                d.shownSpeaker = d.speaker
                d.box.classList.toggle('to-other-speaker', d.speaker !== d.adapter.speaker)
                d.box.style.cssText += shadeVars(getTracks(context).colors[d.speaker])
            }
        }
        d.adapter.set(s, en)
        d.box.style.left = `${s * d.pps}px`
        d.box.style.width = `${Math.max((en - s) * d.pps, 1)}px`
        if (d.label) {
            d.label.hidden = false
            const who = d.speaker !== d.adapter.speaker ? `→ ${d.speaker}  ` : ''
            d.label.textContent = `${who}${d.adapter.label}  ${fmt(s)} – ${fmt(en)} s`
            d.label.style.left = `${en * d.pps + context.trackShift + 4}px`
            d.label.style.top = d.box.style.top
        }
    })

    window.addEventListener('mouseup', () => {
        const d = context.trackDrag
        if (!d) return
        context.trackDrag = null
        d.box.classList.remove('dragging')
        if (d.label) d.label.hidden = true
        const now = d.adapter.get()
        const timeChanged = Math.abs(now.start - d.start0) > 1e-9 || Math.abs(now.end - d.end0) > 1e-9
        const speakerChanged = d.speaker && d.speaker !== d.adapter.speaker
        if (d.moved && d.mode) {
            if (speakerChanged) {
                d.adapter.moveTo(d.speaker, d.start0, d.end0)
                context.laneSpeaker = d.speaker
            } else if (timeChanged) {
                d.adapter.commit(d.start0, d.end0)
            }
            context.laneSelection = d.adapter.selection()
        } else if (!d.moved) {
            // one click: select the box (and move the cursor to it)
            context.seek(d.adapter.get().start)
            setLaneSelection(context, d.adapter.selection())
        }
        if (d.moved) renderTrackLanes(context, true)
        context.$scope.$evalAsync()
    })

    window.addEventListener('resize', () => { context.trackRenderKey = null })

    document.addEventListener('keydown', (e) => {
        if (!context.laneSelection) return
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
