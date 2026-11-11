import { getTracks } from './speakerTracks.js'
import { selectionItems } from './laneEdits.js'
import { speakerShades } from './palette.js'

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

// [start, end, speaker] of a selection item, read live (so drags show).
const selectedSpans = (context, tracks) => {
    const out = []
    selectionItems(context).forEach(item => {
        if (item.kind === 'word') {
            const e = tracks.words.find(x => x.w === item.w)
            if (e) out.push([item.w.start, item.w.end, e.speaker])
        } else if (item.kind === 'seg') {
            const seg = tracks.diar.find(x => (item.regionId && x.region && x.region.id === item.regionId) || (item.ref && x.ref === item.ref))
            if (seg) {
                const live = item.regionId ? context.getRegion(item.regionId) : item.ref
                out.push([live ? live.start : seg.start, live ? live.end : seg.end, seg.speaker])
            }
        } else if (item.kind === 'speaker') {
            (tracks.diarBySpeaker[item.speaker] || []).forEach(d => out.push([d.start, d.end, item.speaker]))
        }
    })
    return out
}

const playingSpans = (context, tracks, time) => tracks.diar
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

    const key = pps.toFixed(4) + '|' + sel.map(x => x.join(',')).join(';') + '|' + play.map(x => x.join(',')).join(';')
    if (key === context.waveOverlayKey) return
    context.waveOverlayKey = key

    const box = (cls, [start, end, speaker]) => {
        const s = speakerShades(tracks.colors[speaker] || '#7f858d')
        const left = start * pps
        const width = Math.max((end - start) * pps, 1)
        return `<div class="${cls}" data-speaker="${esc(speaker)}" style="left:${left}px;width:${width}px;--base:${s.base};--glow:${s.glow}"></div>`
    }
    layer.innerHTML = play.map(x => box('gk-wave-play', x)).join('') + sel.map(x => box('gk-wave-sel', x)).join('')
}
