import { renderTrackLanes, wordLaneHeight, diarLaneHeight, MIN_LANE_H, MAX_LANE_H } from './trackLanes.js'
import { getTracks } from './speakerTracks.js'

// Drag bars (.gk-resizer[data-resize=...]) under the video, the waveform and
// the word / RTTM lanes. Heights persist in userConfig (localStorage).

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)
const stage = () => document.querySelector('.gecko-video-stage')
const speakerCount = (context) => Math.max(getTracks(context).speakers.length, 1)

export const applyVideoHeight = (context) => {
    const el = stage()
    const h = context.userConfig && context.userConfig.videoHeight
    if (!el || !h) return
    el.style.height = `${h}px`
    el.style.maxWidth = `${h * 16 / 9}px`
}

export const applyWaveHeight = (context) => {
    const h = context.userConfig && context.userConfig.waveHeight
    const ws = context.wavesurfer
    if (!h || !ws || !ws.drawer) return
    if (Math.round(parseFloat(ws.getHeight())) !== Math.round(h)) ws.setHeight(h)
}

const TARGETS = {
    video: {
        get: () => stage().getBoundingClientRect().height,
        set: (context, h) => {
            context.userConfig.videoHeight = Math.round(clamp(h, 80, window.innerHeight * 0.9))
            applyVideoHeight(context)
        }
    },
    wave: {
        get: (context) => parseFloat(context.wavesurfer.getHeight()),
        set: (context, h) => {
            context.userConfig.waveHeight = Math.round(clamp(h, 30, 800))
            applyWaveHeight(context)
        }
    },
    words: {
        get: (context) => speakerCount(context) * wordLaneHeight(context),
        set: (context, h) => {
            context.userConfig.wordLaneHeight = Math.round(clamp(h / speakerCount(context), MIN_LANE_H, MAX_LANE_H))
            renderTrackLanes(context, true)
        }
    },
    rttm: {
        get: (context) => speakerCount(context) * diarLaneHeight(context),
        set: (context, h) => {
            context.userConfig.rttmLaneHeight = Math.round(clamp(h / speakerCount(context), MIN_LANE_H, MAX_LANE_H))
            renderTrackLanes(context, true)
        }
    }
}

export const initResizers = (context) => {
    if (context.resizersBound) return
    context.resizersBound = true

    document.addEventListener('mousedown', (e) => {
        const bar = e.target.closest && e.target.closest('.gk-resizer')
        if (!bar || e.button !== 0) return
        const target = TARGETS[bar.dataset.resize]
        if (!target) return
        e.preventDefault()
        context.resizeDrag = { target, y0: e.clientY, h0: target.get(context), pendingY: null, bar }
        bar.classList.add('active')
        document.body.classList.add('gk-resizing')
    })

    window.addEventListener('mousemove', (e) => {
        const d = context.resizeDrag
        if (!d) return
        d.pendingY = e.clientY
        if (d.raf) return
        d.raf = requestAnimationFrame(() => {
            d.raf = null
            if (context.resizeDrag !== d || d.pendingY === null) return
            d.target.set(context, d.h0 + (d.pendingY - d.y0))
        })
    })

    window.addEventListener('mouseup', () => {
        const d = context.resizeDrag
        if (!d) return
        context.resizeDrag = null
        if (d.pendingY !== null) d.target.set(context, d.h0 + (d.pendingY - d.y0))
        d.bar.classList.remove('active')
        document.body.classList.remove('gk-resizing')
        context.saveUserSettings()
    })
}
