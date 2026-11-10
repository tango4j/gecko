import videojs from 'video.js'

import { getTracks } from './speakerTracks.js'
import { initTrackLanes, renderTrackLanes, updateTrackCursors } from './trackLanes.js'

// Video stage + per-speaker subtitle overlay + the frame loop that also drives
// the word / RTTM lanes.
//
// Wavesurfer stays the master clock (it owns the decoded audio track); the
// <video> element is muted and slaved to it.

const SUBTITLE_MAX_CHARS = 56      // ~1 line per speaker so overlaps stay compact
const SUBTITLE_MIN_BREAK_CHARS = 28 // allow an early page break after . ? ! once this long
const DRIFT_TOLERANCE_SEC = 0.25
const TURN_TOLERANCE_SEC = 0.00001

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => HTML_ESCAPES[c])

// Some browsers report an empty MIME type for .mkv/.mov etc.
const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'ogv']

export const isVideoFile = (file) => {
    if (!file) return false
    if (file.type && file.type.startsWith('video')) return true
    const ext = (file.name || '').split('.').pop().toLowerCase()
    return VIDEO_EXTENSIONS.includes(ext)
}

const guessVideoMime = (file) => {
    if (file.type) return file.type
    const ext = (file.name || '').split('.').pop().toLowerCase()
    return { webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime', mkv: 'video/webm' }[ext] || 'video/mp4'
}

export const attachVideo = (context, file) => {
    context.videoMode = true
    if (context.videoObjectUrl) {
        URL.revokeObjectURL(context.videoObjectUrl)
    }
    const fileUrl = URL.createObjectURL(file)
    context.videoObjectUrl = fileUrl

    context.videoPlayer = videojs('video-js', {
        controls: false,
        preload: 'auto',
        // Gecko drives playback from the waveform; video.js must not grab
        // the spacebar / click-to-play.
        userActions: { click: false, doubleClick: false, hotkeys: false }
    })
    context.videoPlayer.ready(function () {
        this.src({ type: guessVideoMime(file), src: fileUrl })
        this.load()
        this.muted(true)
    })

    startMediaLoop(context)
}

// One requestAnimationFrame loop: video drift correction, subtitles, lanes.
export const startMediaLoop = (context) => {
    if (context.mediaLoopRaf) return

    const tick = () => {
        context.mediaLoopRaf = requestAnimationFrame(tick)
        if (!context.ready || !context.wavesurfer || !context.wavesurfer.backend) return

        let time
        try {
            time = context.wavesurfer.getCurrentTime()
        } catch (e) {
            return
        }

        const player = context.videoMode && context.videoPlayer
        if (player && context.isPlaying && !player.paused()) {
            if (Math.abs(player.currentTime() - time) > DRIFT_TOLERANCE_SEC) {
                player.currentTime(time)
            }
        }

        initTrackLanes(context)
        renderTrackLanes(context)
        updateTrackCursors(context, time)
        if (context.videoMode) renderSubtitles(context, time)
    }
    tick()
}

// Split an utterance's words into subtitle "pages" no longer than ~2 lines.
export const paginateWords = (words) => {
    const pages = []
    let page = []
    let len = 0
    words.forEach(w => {
        const text = (w.text || '').trim()
        if (!text) return
        if (page.length && len + 1 + text.length > SUBTITLE_MAX_CHARS) {
            pages.push(page)
            page = []
            len = 0
        }
        page.push(w)
        len += (len ? 1 : 0) + text.length
        if (len >= SUBTITLE_MIN_BREAK_CHARS && /[.?!。？！]$/.test(text)) {
            pages.push(page)
            page = []
            len = 0
        }
    })
    if (page.length) pages.push(page)
    return pages
}

const pickPage = (pages, time) => {
    let index = 0
    for (let i = 0; i < pages.length; i++) {
        const first = pages[i][0]
        if (first.start !== undefined && first.start <= time) index = i
        else break
    }
    return pages[index]
}

// One independent line per speaker who is mid-utterance at `time`:
//   [spk0] you don't have the cards
//   [spk1] i know i know
// Lines keep a fixed speaker order so they don't jump around during overlaps.
export const buildSubtitleHtml = (context, time) => {
    const tracks = getTracks(context)
    const lines = []

    tracks.speakers.forEach(speaker => {
        let turn
        ;(tracks.turnsBySpeaker[speaker] || []).forEach(t => {
            if (time < t.start - TURN_TOLERANCE_SEC || time > t.end + TURN_TOLERANCE_SEC) return
            if ((t.region.data.speaker || [])[0] !== speaker) return
            if (!turn || t.start > turn.start) turn = t
        })
        if (!turn) return

        const pages = paginateWords(turn.region.data.words || [])
        if (!pages.length) return
        const page = pickPage(pages, time)

        const body = page.map(w => {
            let cls = 'gecko-sub-word'
            if (typeof w.start === 'number' && typeof w.end === 'number') {
                if (time >= w.end) cls += ' past'
                else if (time >= w.start) cls += ' current'
                else cls += ' future'
            }
            return `<span class="${cls}">${escapeHtml(w.text.trim())}</span>`
        }).join(' ')

        const color = escapeHtml(tracks.colors[speaker] || '#fff')
        lines.push(`<div class="gecko-sub-line"><span class="gecko-sub-speaker" style="color:${color}">[${escapeHtml(speaker)}]</span> ${body}</div>`)
    })

    return lines.join('')
}

export const renderSubtitles = (context, time) => {
    const el = document.getElementById('gecko-subtitles')
    if (!el) return
    const html = context.userConfig && context.userConfig.showSubtitles === false
        ? ''
        : buildSubtitleHtml(context, time)
    if (html !== context.lastSubtitleHtml) {
        el.innerHTML = html
        el.classList.toggle('empty', !html)
        context.lastSubtitleHtml = html
    }
}
