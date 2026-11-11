
export default (parent) => {
    parent.buffOla.position = ~~(parent.wavesurfer.backend.getPlayedPercents() * parent.length)
    parent.buffOla.alpha = 1 / parent.wavesurfer.getPlaybackRate()

    parent.wavesurfer.backend.disconnectFilters()
    
    if (parent.wavesurfer.getPlaybackRate() === 1) {
        parent.wavesurfer.backend.setFilters([parent.gainNode])
    } else {
        parent.wavesurfer.backend.setFilters([parent.olatsNode, parent.gainNode])
    }

    if (parent.videoPlayer) {
        const wavesurferTime = parent.wavesurfer.getCurrentTime()
        parent.videoPlayer.currentTime(wavesurferTime)
        // a seek while playing pauses + resumes; the muted video's pending
        // play() is then interrupted, which is harmless
        const p = parent.videoPlayer.play()
        if (p && p.catch) p.catch(() => {})
    }

    parent.isPlaying = true
    parent.$scope.$evalAsync()
}