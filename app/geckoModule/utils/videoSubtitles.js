import videojs from 'video.js'

// Video stage + subtitle overlay.
//
// Wavesurfer stays the master clock (it owns the decoded audio track); the
// <video> element is muted and slaved to it. A requestAnimationFrame loop keeps
// the two in sync and repaints the subtitle overlay from the live regions, so
// edits made in the transcript panels show up on the video immediately.

const SUBTITLE_MAX_CHARS = 84      // ~2 lines of subtitle text per page
const SUBTITLE_MIN_BREAK_CHARS = 28 // allow an early page break after . ? ! once this long
const DRIFT_TOLERANCE_SEC = 0.25
const REGION_TOLERANCE_SEC = 0.00001

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

    startVideoSync(context)
}

export const startVideoSync = (context) => {
    if (context.videoSyncRaf) return

    const tick = () => {
        context.videoSyncRaf = requestAnimationFrame(tick)
        if (!context.videoMode || !context.wavesurfer || !context.wavesurfer.backend) return

        let time
        try {
            time = context.wavesurfer.getCurrentTime()
        } catch (e) {
            return
        }
        const player = context.videoPlayer
        if (player && context.isPlaying && !player.paused()) {
            if (Math.abs(player.currentTime() - time) > DRIFT_TOLERANCE_SEC) {
                player.currentTime(time)
            }
        }
        renderSubtitles(context, time)
    }
    tick()
}

const MAX_SUBTITLE_LINES = 3

// All regions active at `time`. Normally one, but per-speaker transcripts with
// overlapped speech can have several; each gets its own subtitle line.
const findRegionsAt = (context, fileIndex, time) => {
    const found = []
    context.iterateRegions(r => {
        if (r.data.isDummy) return
        if (time >= r.start - REGION_TOLERANCE_SEC && time <= r.end + REGION_TOLERANCE_SEC) {
            found.push(r)
        }
    }, fileIndex)
    found.sort((a, b) => a.start - b.start)
    // When one region ends exactly where the next begins, show only the newer one.
    const active = found.filter(r => !found.some(o => o !== r && o.start > r.start && Math.abs(o.start - r.end) <= REGION_TOLERANCE_SEC * 10))
    return active.slice(-MAX_SUBTITLE_LINES)
}

// Split a region's words into subtitle "pages" no longer than ~2 lines.
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

const speakerHtml = (context, region) => {
    const fileData = context.filesData[region.data.fileIndex]
    const legend = (fileData && fileData.legend) || []
    const speakers = region.data.speaker || []
    if (!speakers.length) return ''
    return speakers.map(s => {
        const entry = legend.find(l => l.value === s)
        const color = entry ? entry.color : '#ccc'
        return `<span class="gecko-sub-speaker" style="color:${escapeHtml(color)}">${escapeHtml(s)}</span>`
    }).join('<span class="gecko-sub-speaker-sep">+</span>')
}

const regionLineHtml = (context, region, time) => {
    const words = region.data.words || []
    const pages = paginateWords(words)
    if (!pages.length) return ''
    const page = pickPage(pages, time)

    const body = page.map(w => {
        let cls = 'gecko-sub-word'
        if (w.start !== undefined && w.end !== undefined) {
            if (time >= w.end) cls += ' past'
            else if (time >= w.start) cls += ' current'
            else cls += ' future'
        }
        return `<span class="${cls}">${escapeHtml(w.text.trim())}</span>`
    }).join(' ')

    const speaker = speakerHtml(context, region)
    return `<div class="gecko-sub-line">${speaker ? speaker + '<span class="gecko-sub-colon">:</span> ' : ''}${body}</div>`
}

export const buildSubtitleHtml = (context, time) => {
    const fileIndex = context.selectedFileIndex || 0
    return findRegionsAt(context, fileIndex, time)
        .map(r => regionLineHtml(context, r, time))
        .join('')
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
