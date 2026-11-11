import { selectionItems } from './laneEdits.js'
import { getTracks } from './speakerTracks.js'

// PLAY SEGMENT with a lane selection: play the selected boxes in time order,
// over and over. Overlapping / touching boxes are merged into one stretch, so
// playback runs straight through an overlap instead of jumping back to the
// start of the next box. Pausing (or pressing PLAY SEGMENT again) stops it;
// seeking somewhere outside the selection cancels the loop.

const SEEK_TOLERANCE_SEC = 0.12

// Time spans of the current selection (a whole speaker = all its segments).
export const selectionSpans = (context) => {
    const tracks = getTracks(context)
    const spans = []
    selectionItems(context).forEach(item => {
        if (item.kind === 'word') {
            spans.push([item.w.start, item.w.end])
        } else if (item.kind === 'seg') {
            const live = item.regionId ? context.getRegion(item.regionId) : item.ref
            if (live) spans.push([live.start, live.end])
        } else if (item.kind === 'speaker') {
            (tracks.diarBySpeaker[item.speaker] || []).forEach(d => spans.push([d.start, d.end]))
        }
    })
    return spans
}

// Sort and merge overlapping or touching spans.
export const mergeSpans = (spans) => {
    const sorted = spans.filter(s => s[1] > s[0]).map(s => [s[0], s[1]]).sort((a, b) => a[0] - b[0])
    const out = []
    sorted.forEach(s => {
        const last = out[out.length - 1]
        if (last && s[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], s[1])
        else out.push(s)
    })
    return out
}

const jumpTo = (context, t) => {
    const ws = context.wavesurfer
    context.selectionLoop.jumping = t
    ws.seekTo(Math.min(Math.max(t / ws.getDuration(), 0), 1))
}

export const stopSelectionLoop = (context, pause = false) => {
    if (!context.selectionLoop) return
    context.selectionLoop = null
    if (pause && context.wavesurfer.isPlaying()) context.wavesurfer.pause()
    context.$scope.$evalAsync()
}

export const startSelectionLoop = (context) => {
    const intervals = mergeSpans(selectionSpans(context))
    if (!intervals.length) return false
    context.selectionLoop = { intervals, i: 0, jumping: null }
    jumpTo(context, intervals[0][0])
    context.wavesurfer.play()
    context.$scope.$evalAsync()
    return true
}

export const toggleSelectionLoop = (context) => {
    if (context.selectionLoop) stopSelectionLoop(context, true)
    else startSelectionLoop(context)
}

// Called every animation frame from the media loop.
export const tickSelectionLoop = (context, t) => {
    const loop = context.selectionLoop
    if (!loop) return
    if (!context.isPlaying) {
        stopSelectionLoop(context)
        return
    }
    const n = loop.intervals.length
    if (loop.jumping !== null) {
        // wait until our own seek has landed before judging the position
        if (Math.abs(t - loop.jumping) > SEEK_TOLERANCE_SEC) return
        loop.jumping = null
    }
    const [start, end] = loop.intervals[loop.i]
    if (t >= end && t <= end + SEEK_TOLERANCE_SEC) {
        // reached the end of this stretch: on to the next one (wrapping round)
        loop.i = (loop.i + 1) % n
        jumpTo(context, loop.intervals[loop.i][0])
    } else if (t > end || t < start - SEEK_TOLERANCE_SEC) {
        // the user moved the playhead: follow it if it is inside the selection
        const k = loop.intervals.findIndex(([s, e]) => t >= s && t < e)
        if (k >= 0) loop.i = k
        else stopSelectionLoop(context)
    }
}
