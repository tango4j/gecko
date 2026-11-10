import { getTracks, markTracksDirty } from './speakerTracks.js'
import { OPERATION_IDS } from '../constants'

// Two lane displays under the waveform, one row per speaker:
//   #gecko-word-track : a box per word (start..end), text clipped to the box,
//                       edges / body draggable to adjust word timestamps
//   #gecko-diar-track : RTTM / diarization speaker segments
// Both follow the waveform's zoom and horizontal scroll pixel-for-pixel.

const WORD_LANE_H = 24
const DIAR_LANE_H = 14
const MIN_WORD_DUR = 0.02
const HANDLE_PX = 6
const TEXT_MIN_PX = 12          // narrower boxes hide their text entirely
const CULL_MARGIN_PX = 200

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s) => String(s).replace(/[&<>"']/g, c => HTML_ESCAPES[c])
const fmt = (t) => t.toFixed(3)

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

const laneScaffold = (speakers, colors, laneH) => speakers.map((s, i) =>
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

    const bodyLeft = word.getBoundingClientRect().left
    const shift = g.wrapperLeft - bodyLeft - g.scrollLeft
    const key = [context.tracksVersion, g.pps.toFixed(4), g.scrollLeft, g.viewWidth, Math.round(shift)].join('|')
    if (!force && key === context.trackRenderKey) return
    context.trackRenderKey = key
    context.trackShift = shift

    const t0 = (g.scrollLeft - CULL_MARGIN_PX) / g.pps
    const t1 = (g.scrollLeft + g.viewWidth + CULL_MARGIN_PX) / g.pps
    const laneOf = {}
    tracks.speakers.forEach((s, i) => { laneOf[s] = i })

    // ---- word lane ----
    const visibleWords = []
    let boxes = ''
    tracks.words.forEach(entry => {
        const w = entry.w
        if (w.end < t0 || w.start > t1) return
        const k = visibleWords.push(entry) - 1
        const left = w.start * g.pps
        const width = Math.max((w.end - w.start) * g.pps, 1)
        const top = laneOf[entry.speaker] * WORD_LANE_H + 2
        const cls = width < TEXT_MIN_PX ? 'gk-word notext' : 'gk-word'
        const title = `${w.text}  [${entry.speaker}]\n${fmt(w.start)} – ${fmt(w.end)} s  (${fmt(w.end - w.start)} s)`
        boxes += `<div class="${cls}" data-k="${k}" style="left:${left}px;width:${width}px;top:${top}px;height:${WORD_LANE_H - 4}px;--c:${esc(tracks.colors[entry.speaker])}" title="${esc(title)}"><span>${esc(w.text)}</span></div>`
    })
    context.laneWords = visibleWords
    word.style.height = `${Math.max(tracks.speakers.length, 1) * WORD_LANE_H}px`
    word.innerHTML = laneScaffold(tracks.speakers, tracks.colors, WORD_LANE_H) +
        `<div class="gk-lane-content" style="transform:translateX(${shift}px)">${boxes}</div>` +
        laneLabels(tracks.speakers, tracks.colors, WORD_LANE_H) +
        '<div class="gk-track-cursor"></div><div class="gk-drag-label" hidden></div>'

    // ---- RTTM / diarization lane ----
    let segs = ''
    tracks.diar.forEach(d => {
        if (d.end < t0 || d.start > t1 || laneOf[d.speaker] === undefined) return
        const left = d.start * g.pps
        const width = Math.max((d.end - d.start) * g.pps, 1)
        const top = laneOf[d.speaker] * DIAR_LANE_H + 2
        const title = `${d.speaker}\n${fmt(d.start)} – ${fmt(d.end)} s  (${fmt(d.end - d.start)} s)`
        segs += `<div class="gk-seg" data-start="${d.start}" style="left:${left}px;width:${width}px;top:${top}px;height:${DIAR_LANE_H - 4}px;--c:${esc(tracks.colors[d.speaker])}" title="${esc(title)}"></div>`
    })
    diar.style.height = `${Math.max(tracks.speakers.length, 1) * DIAR_LANE_H}px`
    diar.innerHTML = laneScaffold(tracks.speakers, tracks.colors, DIAR_LANE_H) +
        `<div class="gk-lane-content" style="transform:translateX(${shift}px)">${segs}</div>` +
        laneLabels(tracks.speakers, tracks.colors, DIAR_LANE_H) +
        '<div class="gk-track-cursor"></div>'

    const wordTitle = document.querySelector('#gecko-word-track .gecko-track-source')
    const diarTitle = document.querySelector('#gecko-diar-track .gecko-track-source')
    if (wordTitle) wordTitle.textContent = tracks.wordSource || ''
    if (diarTitle) diarTitle.textContent = tracks.diarSource === 'turns' ? 'derived from speaker turns' : tracks.diarSource
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

const neighbours = (context, entry) => {
    const list = getTracks(context).wordsBySpeaker[entry.speaker] || []
    const i = list.indexOf(entry)
    return {
        prevEnd: i > 0 ? list[i - 1].w.end : 0,
        nextStart: i >= 0 && i < list.length - 1 ? list[i + 1].w.start : context.wavesurfer.getDuration()
    }
}

const commitWordEdit = (context, d) => {
    const region = d.entry.region
    const oldRegionStart = region.start
    const oldRegionEnd = region.end
    const timed = region.data.words.filter(w => typeof w.start === 'number' && typeof w.end === 'number')
    // Region spans its words. Set the bounds directly: region.update() would run
    // Gecko's no-overlap fix-ups against neighbouring regions, which corrupts
    // speaker turns that legitimately overlap.
    region.start = Math.min(...timed.map(w => w.start))
    region.end = Math.max(...timed.map(w => w.end))
    region.data.regionChanged = true
    context.regionUpdated(region)
    context.historyService.undoStack.push([
        OPERATION_IDS.WORD_TIMING_CHANGED, region.id, d.entry.w, d.start0, d.end0, oldRegionStart, oldRegionEnd
    ])
    context.eventBus.trigger('geckoChanged', { event: 'wordTimingChanged', data: region })
    markTracksDirty(context)
    context.$scope.$evalAsync()
}

const timeAtClientX = (context, clientX, body) => {
    const g = geometry(context)
    if (!g) return null
    const x = clientX - body.getBoundingClientRect().left - context.trackShift
    return Math.min(Math.max(x / g.pps, 0), g.duration)
}

export const initTrackLanes = (context) => {
    if (context.trackLanesBound) return
    const { word, diar } = els()
    if (!word || !diar) return
    context.trackLanesBound = true

    diar.addEventListener('mousedown', (e) => {
        const seg = e.target.closest('.gk-seg')
        const t = seg ? parseFloat(seg.dataset.start) : timeAtClientX(context, e.clientX, diar)
        if (t !== null) context.seek(t)
        context.$scope.$evalAsync()
    })

    word.addEventListener('mousemove', (e) => {
        if (context.trackDrag) return
        const box = e.target.closest('.gk-word')
        if (!box) return
        const r = box.getBoundingClientRect()
        const edge = Math.min(HANDLE_PX, r.width / 3)
        const x = e.clientX - r.left
        box.style.cursor = (x < edge || x > r.width - edge) ? 'ew-resize' : 'grab'
    })

    word.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return
        const box = e.target.closest('.gk-word')
        if (!box) {
            const t = timeAtClientX(context, e.clientX, word)
            if (t !== null) context.seek(t)
            context.$scope.$evalAsync()
            return
        }
        e.preventDefault()
        const entry = context.laneWords[+box.dataset.k]
        if (!entry) return
        const g = geometry(context)
        const r = box.getBoundingClientRect()
        const edge = Math.min(HANDLE_PX, r.width / 3)
        const x = e.clientX - r.left
        const mode = x < edge ? 'start' : (x > r.width - edge ? 'end' : 'move')
        const label = word.querySelector('.gk-drag-label')
        context.trackDrag = {
            entry, box, mode, label, pps: g.pps, x0: e.clientX, moved: false,
            start0: entry.w.start, end0: entry.w.end, ...neighbours(context, entry)
        }
        box.classList.add('dragging')
    })

    window.addEventListener('mousemove', (e) => {
        const d = context.trackDrag
        if (!d) return
        const dt = (e.clientX - d.x0) / d.pps
        if (!d.moved && Math.abs(e.clientX - d.x0) < 3) return
        d.moved = true
        const w = d.entry.w
        let s = d.start0
        let en = d.end0
        if (d.mode === 'start') {
            s = Math.min(Math.max(d.start0 + dt, d.prevEnd), d.end0 - MIN_WORD_DUR)
        } else if (d.mode === 'end') {
            en = Math.max(Math.min(d.end0 + dt, d.nextStart), d.start0 + MIN_WORD_DUR)
        } else {
            const len = d.end0 - d.start0
            s = Math.min(Math.max(d.start0 + dt, d.prevEnd), d.nextStart - len)
            en = s + len
        }
        w.start = s
        w.end = en
        d.box.style.left = `${s * d.pps}px`
        d.box.style.width = `${Math.max((en - s) * d.pps, 1)}px`
        if (d.label) {
            d.label.hidden = false
            d.label.textContent = `${w.text}  ${fmt(s)} – ${fmt(en)} s`
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
        if (d.moved) {
            commitWordEdit(context, d)
        } else {
            context.seek(d.entry.w.start)
            context.$scope.$evalAsync()
        }
        renderTrackLanes(context, true)
    })

    window.addEventListener('resize', () => { context.trackRenderKey = null })
}
