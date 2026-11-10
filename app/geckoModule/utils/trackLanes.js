import { getTracks, markTracksDirty } from './speakerTracks.js'
import { OPERATION_IDS } from '../constants'

// Two lane displays under the waveform, one row per speaker:
//   #gecko-word-track : a box per word (start..end), text clipped to the box;
//                       edges / body draggable to adjust word timestamps
//   #gecko-diar-track : RTTM / diarization speaker segments; edges draggable
//                       when they come from a loaded .rttm (or TextGrid
//                       diarization tiers), read-only when derived from the
//                       word file's speaker turns
// Both follow the waveform's zoom and horizontal scroll pixel-for-pixel.

export const DEFAULT_WORD_LANE_H = 24
export const DEFAULT_DIAR_LANE_H = 14
export const MIN_LANE_H = 8
export const MAX_LANE_H = 120

const MIN_DUR = 0.02
const HANDLE_PX = 6
const TEXT_MIN_PX = 12          // narrower word boxes hide their text entirely
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

const laneScaffold = (speakers, laneH) => speakers.map((s, i) =>
    `<div class="gk-lane${i % 2 ? ' odd' : ''}" style="top:${i * laneH}px;height:${laneH}px"></div>`
).join('')

const laneLabels = (speakers, colors, laneH) => speakers.map((s, i) =>
    `<div class="gk-lane-label" style="top:${i * laneH}px;height:${laneH}px;line-height:${laneH}px;color:${esc(colors[s])}">${esc(s)}</div>`
).join('')

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
        const cls = width < TEXT_MIN_PX || wordH < 12 ? 'gk-word notext' : 'gk-word'
        const title = `${w.text}  [${entry.speaker}]\n${fmt(w.start)} – ${fmt(w.end)} s  (${fmt(w.end - w.start)} s)`
        boxes += `<div class="${cls}" data-k="${k}" style="left:${left}px;width:${width}px;top:${top}px;height:${wordH - 2 * pad(wordH)}px;line-height:${wordH - 2 * pad(wordH) - 2}px;--c:${esc(tracks.colors[entry.speaker])}" title="${esc(title)}"><span>${esc(w.text)}</span></div>`
    })
    context.laneWords = visibleWords
    word.style.height = `${Math.max(tracks.speakers.length, 1) * wordH}px`
    word.innerHTML = laneScaffold(tracks.speakers, wordH) +
        `<div class="gk-lane-content" style="transform:translateX(${shift}px)">${boxes}</div>` +
        laneLabels(tracks.speakers, tracks.colors, wordH) +
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
        segs += `<div class="gk-seg" data-k="${k}" style="left:${left}px;width:${width}px;top:${top}px;height:${diarH - 2 * pad(diarH)}px;--c:${esc(tracks.colors[d.speaker])}" title="${esc(title)}"></div>`
    })
    context.laneSegs = visibleSegs
    diar.classList.toggle('editable', !!tracks.diarEditable)
    diar.style.height = `${Math.max(tracks.speakers.length, 1) * diarH}px`
    diar.innerHTML = laneScaffold(tracks.speakers, diarH) +
        `<div class="gk-lane-content" style="transform:translateX(${shift}px)">${segs}</div>` +
        laneLabels(tracks.speakers, tracks.colors, diarH) +
        '<div class="gk-track-cursor"></div><div class="gk-drag-label" hidden></div>'

    const wordTitle = document.querySelector('#gecko-word-track .gecko-track-source')
    const diarTitle = document.querySelector('#gecko-diar-track .gecko-track-source')
    const diarHint = document.querySelector('#gecko-diar-track .gecko-track-hint')
    if (wordTitle) wordTitle.textContent = tracks.wordSource || ''
    if (diarTitle) diarTitle.textContent = tracks.diarSource === 'turns' ? 'derived from speaker turns (read-only)' : tracks.diarSource
    if (diarHint) {
        diarHint.textContent = tracks.diarEditable
            ? "drag a segment's edges to adjust start/end, click to seek"
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

const neighbourLimits = (list, item, getStart, getEnd, duration) => {
    const i = list.indexOf(item)
    return {
        lo: i > 0 ? getEnd(list[i - 1]) : 0,
        hi: i >= 0 && i < list.length - 1 ? getStart(list[i + 1]) : duration
    }
}

const pushTimingUndo = (context, regionId, target, oldStart, oldEnd, oldRegionStart, oldRegionEnd) => {
    context.historyService.undoStack.push([
        OPERATION_IDS.TIMING_CHANGED, regionId, target, oldStart, oldEnd, oldRegionStart, oldRegionEnd
    ])
}

// Set region bounds directly: region.update() would run Gecko's no-overlap
// fix-ups against neighbouring regions, which corrupts speaker turns /
// segments that legitimately overlap.
const setRegionBounds = (context, region, start, end) => {
    region.start = start
    region.end = end
    region.data.regionChanged = true
    if (region.data.words && region.data.words.length) {
        context.regionUpdated(region)
    } else {
        region.updateRender()
    }
}

const afterEdit = (context, region) => {
    context.eventBus.trigger('geckoChanged', { event: 'timingChanged', data: region })
    markTracksDirty(context)
    context.$scope.$evalAsync()
}

const wordAdapter = (context, entry) => ({
    label: entry.w.text,
    modes: ['start', 'end', 'move'],
    get: () => ({ start: entry.w.start, end: entry.w.end }),
    set: (s, e) => { entry.w.start = s; entry.w.end = e },
    limits: () => neighbourLimits(getTracks(context).wordsBySpeaker[entry.speaker] || [], entry,
        x => x.w.start, x => x.w.end, context.wavesurfer.getDuration()),
    commit: (s0, e0) => {
        const region = entry.region
        const oldRegionStart = region.start
        const oldRegionEnd = region.end
        const timed = region.data.words.filter(w => typeof w.start === 'number' && typeof w.end === 'number')
        setRegionBounds(context, region, Math.min(...timed.map(w => w.start)), Math.max(...timed.map(w => w.end)))
        pushTimingUndo(context, region.id, entry.w, s0, e0, oldRegionStart, oldRegionEnd)
        afterEdit(context, region)
    }
})

const segAdapter = (context, seg) => ({
    label: seg.speaker,
    // Original Gecko behaviour for segments: resize by the edges, no moving.
    modes: ['start', 'end'],
    get: () => ({ start: seg.start, end: seg.end }),
    set: (s, e) => { seg.start = s; seg.end = e },
    limits: () => neighbourLimits(getTracks(context).diarBySpeaker[seg.speaker] || [], seg,
        x => x.start, x => x.end, context.wavesurfer.getDuration()),
    commit: (s0, e0) => {
        if (seg.region) {
            setRegionBounds(context, seg.region, seg.start, seg.end)
            pushTimingUndo(context, seg.region.id, null, s0, e0, s0, e0)
            afterEdit(context, seg.region)
        } else if (seg.ref) {
            seg.ref.start = seg.start
            seg.ref.end = seg.end
            pushTimingUndo(context, null, seg.ref, s0, e0)
            afterEdit(context, null)
        }
    }
})

const timeAtClientX = (context, clientX, body) => {
    const g = geometry(context)
    if (!g) return null
    const x = clientX - body.getBoundingClientRect().left - context.trackShift
    return Math.min(Math.max(x / g.pps, 0), g.duration)
}

const edgeMode = (box, clientX, modes) => {
    const r = box.getBoundingClientRect()
    const edge = Math.min(HANDLE_PX, r.width / 3)
    const x = clientX - r.left
    if (x < edge && modes.includes('start')) return 'start'
    if (x > r.width - edge && modes.includes('end')) return 'end'
    return modes.includes('move') ? 'move' : null
}

const startDrag = (context, e, body, box, adapter) => {
    const mode = edgeMode(box, e.clientX, adapter.modes)
    const g = geometry(context)
    const { start, end } = adapter.get()
    context.trackDrag = {
        adapter, box, mode, body, pps: g.pps, x0: e.clientX, moved: false,
        start0: start, end0: end, ...adapter.limits(),
        label: body.querySelector('.gk-drag-label')
    }
    box.classList.add('dragging')
}

export const initTrackLanes = (context) => {
    if (context.trackLanesBound) return
    const { word, diar } = els()
    if (!word || !diar) return
    context.trackLanesBound = true

    const hoverCursor = (body, selector, modesFor) => (e) => {
        if (context.trackDrag) return
        const box = e.target.closest(selector)
        if (!box) return
        const modes = modesFor(box)
        const mode = modes ? edgeMode(box, e.clientX, modes) : null
        box.style.cursor = mode === 'start' || mode === 'end' ? 'ew-resize' : (mode === 'move' ? 'grab' : 'pointer')
    }

    word.addEventListener('mousemove', hoverCursor(word, '.gk-word', () => ['start', 'end', 'move']))
    diar.addEventListener('mousemove', hoverCursor(diar, '.gk-seg', () => getTracks(context).diarEditable ? ['start', 'end'] : null))

    word.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return
        const box = e.target.closest('.gk-word')
        const entry = box && context.laneWords[+box.dataset.k]
        if (!entry) {
            const t = timeAtClientX(context, e.clientX, word)
            if (t !== null) context.seek(t)
            context.$scope.$evalAsync()
            return
        }
        e.preventDefault()
        startDrag(context, e, word, box, wordAdapter(context, entry))
    })

    diar.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return
        const box = e.target.closest('.gk-seg')
        const seg = box && context.laneSegs[+box.dataset.k]
        if (seg && getTracks(context).diarEditable && edgeMode(box, e.clientX, ['start', 'end'])) {
            e.preventDefault()
            startDrag(context, e, diar, box, segAdapter(context, seg))
            return
        }
        const t = seg ? seg.start : timeAtClientX(context, e.clientX, diar)
        if (t !== null) context.seek(t)
        context.$scope.$evalAsync()
    })

    window.addEventListener('mousemove', (e) => {
        const d = context.trackDrag
        if (!d) return
        if (!d.moved && Math.abs(e.clientX - d.x0) < 3) return
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
        }
        d.adapter.set(s, en)
        d.box.style.left = `${s * d.pps}px`
        d.box.style.width = `${Math.max((en - s) * d.pps, 1)}px`
        if (d.label) {
            d.label.hidden = false
            d.label.textContent = `${d.adapter.label}  ${fmt(s)} – ${fmt(en)} s`
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
        const changed = Math.abs(now.start - d.start0) > 1e-9 || Math.abs(now.end - d.end0) > 1e-9
        if (d.moved && d.mode) {
            if (changed) d.adapter.commit(d.start0, d.end0)
        } else if (!d.moved) {
            context.seek(d.adapter.get().start)
            context.$scope.$evalAsync()
        }
        renderTrackLanes(context, true)
    })

    window.addEventListener('resize', () => { context.trackRenderKey = null })
}
