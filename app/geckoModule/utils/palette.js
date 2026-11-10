import chroma from 'chroma-js'

// Speaker color shades for the lanes and subtitles, derived with chroma.js in
// OKLCH so every speaker's dark lane / light block has the same perceived
// lightness, whatever the base hue (and also for colors picked in the legend).

const cache = new Map()

const shade = (hue, l, c) => chroma.oklch(l, c, hue).hex()

export const speakerShades = (color) => {
    if (cache.has(color)) return cache.get(color)
    let base
    try {
        base = chroma(color)
    } catch (e) {
        base = chroma('#7d8590')
    }
    const [, c, h] = base.oklch()
    const hue = Number.isNaN(h) ? 0 : h
    const chr = (k, cap) => Math.min(c * k, cap)
    const shades = {
        base: base.hex(),
        lane: shade(hue, 0.4, chr(0.6, 0.065)),         // dark track background (light enough to show the hue)
        laneEdge: shade(hue, 0.35, chr(0.55, 0.055)),
        block: shade(hue, 0.935, chr(0.3, 0.03)),       // very light word / segment block
        blockTop: shade(hue, 0.975, chr(0.15, 0.015)),
        border: shade(hue, 0.62, chr(0.7, 0.08)),
        text: shade(hue, 0.3, chr(0.5, 0.05)),          // text inside a light block
        label: shade(hue, 0.84, chr(0.6, 0.07)),        // speaker name on a dark lane
        subtitle: shade(hue, 0.8, chr(0.8, 0.1)),       // [spkN] tag on the video
        subText: shade(hue, 0.92, chr(0.35, 0.04)),     // subtitle words (spoken)
        subDim: chroma.oklch(0.92, chr(0.35, 0.04), hue).alpha(0.58).css(), // words still to come
        subBg: chroma.oklch(0.2, chr(0.45, 0.045), hue).alpha(0.86).css(),  // darker box behind the line
        subEdge: shade(hue, 0.55, chr(0.8, 0.09)),
        glow: base.alpha(0.55).css()
    }
    cache.set(color, shades)
    return shades
}

// CSS custom properties for one speaker's subtitle line. The only non-speaker
// color in a subtitle is the yellow highlight on the word being spoken.
export const subtitleVars = (color) => {
    const s = speakerShades(color)
    return `--sub-bg:${s.subBg};--sub-edge:${s.subEdge};--sub-label:${s.subtitle};--sub-text:${s.subText};--sub-dim:${s.subDim}`
}

// CSS custom properties for one speaker, inlined on lanes / blocks.
export const shadeVars = (color) => {
    const s = speakerShades(color)
    return `--base:${s.base};--lane:${s.lane};--lane-edge:${s.laneEdge};--bg:${s.block};--bg-top:${s.blockTop};` +
        `--bd:${s.border};--fg:${s.text};--label:${s.label};--glow:${s.glow}`
}
