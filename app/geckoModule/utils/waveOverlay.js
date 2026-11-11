import { getTracks } from './speakerTracks.js'
import { selectionItems } from './laneEdits.js'
import { speakerShades } from './palette.js'
import { startWaveEdgeDrag } from './trackLanes.js'

// Speaker-colored boxes drawn over the waveform:
//   - one per selected word / RTTM box (outlined)
//   - while playing, one per RTTM segment (or speaker turn) under the
//     playhead, lightly tinted; gone when paused
// The layer lives inside wavesurfer's scrolling wrapper, so boxes positioned
// in seconds * px-per-second follow zoom and scroll for free.

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s) => String(s).replace(/[&<>"']/g, c => HTML_ESCAPES[c])

const layerFor = (context) => {
    const ws = context.wavesurfer
    if (!ws || !ws.drawer || !ws.drawer.wrapper) return null
    const wrapper = ws.drawer.wrapper
    let layer = wrapper.querySelector(':scope > .gk-wave-overlay')
    if (!layer) {
        layer = document.createElement('div')
        layer.className = 'gk-wave-overlay'
        wrapper.appendChild(layer)
        // start / end handles of selected boxes (the layer itself lets
        // clicks through to the waveform; only the handles catch them)
        layer.addEventListener('mousedown', (e) => {
            const h = e.target.closest('.gk-wave-handle')
            if (!h || e.button !== 0) return
            const item = (context.waveSelItems || [])[+h.dataset.i]
            if (!item) return
            e.preventDefault()
            e.stopPropagation()
            startWaveEdgeDrag(context, item, h.dataset.edge, e)
        })
        layer.addEventListener('click', (e) => {
            if (e.target.closest('.gk-wave-handle')) e.stopPropagation()
        })
    }
    return layer
}

const pxPerSec = (context) => {
    const ws = context.wavesurfer
    const d = ws.getDuration()
    if (!d || !ws.drawer) return 0
    const w = ws.drawer.width ? ws.drawer.width / (ws.params.pixelRatio || 1) : ws.drawer.wrapper.scrollWidth
    return w / d
}

// [start, end, speaker, item|null] of the selection, read live (so drags
// show). item is set for boxes whose edges can be dragged on the waveform.
const selectedSpans = (context, tracks) => {
    const out = []
    selectionItems(context).forEach(item => {
        if (item.kind === 'word') {
            const e = tracks.words.find(x => x.w === item.w)
            if (e) out.push([item.w.start, item.w.end, e.speaker, item])
        } else if (item.kind === 'seg') {
            const seg = tracks.diar.find(x => (item.regionId && x.region && x.region.id === item.regionId) || (item.ref && x.ref === item.ref))
            if (seg) {
                const live = item.regionId ? context.getRegion(item.regionId) : item.ref
                out.push([live ? live.start : seg.start, live ? live.end : seg.end, seg.speaker, tracks.diarEditable ? item : null])
            }
        } else if (item.kind === 'speaker') {
            const segs = tracks.showDiar ? tracks.diarBySpeaker[item.speaker] : tracks.turnsBySpeaker[item.speaker]
            ;(segs || []).forEach(d => out.push([d.start, d.end, item.speaker, null]))
        }
    })
    return out
}

const playingSpans = (context, tracks, time) => (tracks.showDiar ? tracks.diar : tracks.turns)
    .filter(d => time >= d.start && time <= d.end)
    .map(d => [d.start, d.end, d.speaker])

export const updateWaveOverlay = (context, time) => {
    const layer = layerFor(context)
    if (!layer) return
    const pps = pxPerSec(context)
    if (!pps) return
    const tracks = getTracks(context)
    const sel = selectedSpans(context, tracks)
    const play = context.isPlaying ? playingSpans(context, tracks, time) : []

    const key = pps.toFixed(4) + '|' + sel.map(x => x.slice(0, 3).join(',') + (x[3] ? 'h' : '')).join(';') + '|' + play.map(x => x.join(',')).join(';')
    if (key === context.waveOverlayKey) return
    context.waveOverlayKey = key

    context.waveSelItems = []
    const box = (cls, [start, end, speaker, item]) => {
        const s = speakerShades(tracks.colors[speaker] || '#7f858d')
        const left = start * pps
        const width = Math.max((end - start) * pps, 1)
        let handles = ''
        if (item) {
            const i = context.waveSelItems.push(item) - 1
            handles = `<div class="gk-wave-handle start" data-i="${i}" data-edge="start" title="Drag to change the start time"></div>` +
                `<div class="gk-wave-handle end" data-i="${i}" data-edge="end" title="Drag to change the end time"></div>`
        }
        return `<div class="${cls}" data-speaker="${esc(speaker)}" style="left:${left}px;width:${width}px;--base:${s.base};--glow:${s.glow}">${handles}</div>`
    }
    layer.innerHTML = play.map(x => box('gk-wave-play', x)).join('') + sel.map(x => box('gk-wave-sel', x)).join('')
}
