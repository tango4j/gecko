// export const DEFAULT_TEXT = "";

// export const SEGMENT_DUMMY = {
//     start: null,
//     end: null,
//     speaker: null,
//     text: DEFAULT_TEXT,
//     annotations: []
// }

export const PLAYBACK_SPEED = [
    0.5, 0.75, 1, 1.25, 1.5, 1.75, 2
];

// 8 speaker colors (toned down): blue, green, orange, red, violet, brown,
// grey, magenta. Lanes / blocks derive dark and light shades from these
// (utils/palette.js); a 9th speaker cycles back to blue.
export const SPEAKER_COLORS = [
    "#4e79a7",
    "#5f9e55",
    "#d4863f",
    "#c4524a",
    "#8c6bb1",
    "#8c6d52",
    "#7f858d",
    "#b05a8f"
];

export const UNKNOWN_SPEAKER = "<NA>";

export const EMPTY_TEXT = "<NA>";

export const SPEAKERS_SEPARATOR = "+";

export const NO_CONFIDENCE = -1;

/* var speakers = {
    '[crosstalk]': "#e1c7ff",
    '[dialtone]': "#e1c7ff",
    '[music]': "#e1c7ff",
    '[foreign]': "#e1c7ff",
    '[noise]': "#e1c7ff",
    '[beep]': "#e1c7ff",
    '[laughter]': "#e1c7ff",
    '[bubble]': "#e1c7ff",
    '[recording]': "#e1c7ff"
}; */

export const UNKNOWN_SPEAKER_COLOR = '#808080';

// Non-speech tokens ([noise], [crosstalk], [laughter], [music], [dialtone])
// used to be pre-registered in every legend; this fork lists speakers only.
const speakers = []

export const defaultSpeakers = speakers;


export const MINIMUM_LENGTH = 0.1;

export const OPERATION_IDS = {
    SPEAKER_NAME_CHANGED : '1',
    REGION_TEXT_CHANGED : '2',
    SPEAKER_COLORS_CHANGED : '3',
    SPEAKER_NAME_AND_COLOR_CHANGED : '4',
    SPEAKER_LABEL_ADDED : '5',
    SPEAKER_LABEL_DELETED : '6',
    SPEAKER_LABEL_MERGED : '7',
    TIMING_CHANGED : '8',
    LANE_EDIT : '9',
};

export const NO_SPEAKER_COLOR = 'hsla(0, 0%, 30%, 0.1)';

export const ANNOTATIONS = [
    {name: "Music", id: "music"},
    {name: "Background noise", id: "background_noise"},
    {name: "Simultaneous speech", id: "simultaneous_speech"},
    {name: "Laughter", id: "laughter"},
    {name: "Hesitation", id: "hesitation"}
]

export const THRESHOLD_MS = 200;

export const SAVE_THRESHOLD = 60 * 1000

export const ZOOM = 20;
export const MAX_ZOOM = 500;

export const PANEL_HEIGHT = 300; //px

export const EXTRA_DISCREPANCY_TIME = 1;

export const PUNCTUATIONS = ". ! , … ? ¿ ¡ : ; ◦ 。 、 ？ ・".split(' ');
export const PUNCTUATION_TYPE = "PUNCTUATION"
export const WORD_TYPE = "WORD"

export const TOLERANCE = 0.00001;

export const DEFAULT_GAIN = 1
export const MIN_GAIN = 0
export const MAX_GAIN = 2

export const OLATS_BUFFER_SIZE = 4096

export const DEFAULT_USER_CONFIG = {
    showSegmentLabeling: true,
    showTranscriptDifferences: true,
    showWaveform: true,
    showTranscriptFiles: {},
    showVideo: true,
    showSubtitles: true
}
export const TRANSCRIPT_EXTENSIONS = ['json', 'ctm', 'rttm', 'srt', 'tsv', 'seglst', 'textgrid']

export const TIME_OFFSET = 0.0001

export const COMPARSION_EXTENSIONS = ['json', 'ctm']
