# Gecko (`tango4j` fork)

> ## Fork notice
>
> This is a maintained fork of the original [`gong-io/gecko`](https://github.com/gong-io/gecko) project, which has been deprecated upstream. It is hosted live at **<https://tango4j.github.io/gecko/>** and is intended to keep Gecko usable on modern toolchains and to add formats the original didn't support.
>
> ### What this fork adds / changes
>
> - **SegLST format support** — load and save the segment-LST JSON format used by NVIDIA-NeMo-style diarization workflows. `.seglst.json` files are auto-detected, and the `Save` menu now offers a `SegLST` option. Saving back to SegLST is a lossless round-trip at the segment level.
> - **Multilingual word-timing estimator** — because SegLST carries no per-word timestamps, the loader synthesizes them by spreading each segment span across its words. The estimator uses `Intl.Segmenter` (ICU word breaker) for proper segmentation of Chinese, Japanese, Thai, Khmer, etc., and weights each token by an estimated syllable count tuned per script (vowel groups for Latin/Cyrillic/Greek, one syllable per glyph for Han/kana/Hangul, consonant-cluster proxies for abjads and Brahmic scripts). A small punctuation-pause bonus is added at commas and sentence boundaries so prosodic pauses aren't swallowed.
> - **Modern Webpack 5 build** — the asset pipeline has been migrated off the deprecated `url-loader` / `file-loader` to native Webpack 5 Asset Modules (`type: 'asset/resource'`). This fixes a regression where Glyphicon fonts were being emitted as broken 82-byte JS stubs (the "tofu boxes" bug). Output filenames now include a content hash for proper cache busting on redeploys.
> - **Dependency refresh** — npm dependencies have been bumped to current non-breaking versions and `npm audit` vulnerabilities triaged. AngularJS 1.x and `wavesurfer.js` are deliberately not touched to preserve compatibility.
> - **NVIDIA-green theme** — the original purple palette has been replaced with NVIDIA green (`#76B900`), black, and light-green accents across the navbar, buttons, links, and speaker color defaults.
> - **GitHub Pages CI** — a unified `gh-pages.yml` workflow builds and deploys to GitHub Pages on every push to `master` or `mod_v1`.
>
> The upstream feature set (RTTM, CTM, JSON, CSV, SRT, TSV import/export, S3 integration, etc.) is preserved unchanged.

---

# Gecko - A Tool for Effective Annotation of Human Conversations

![Comparison](./docs/Comparison.png)

 Gecko allows efficient and effective segmentation of the voice signal by speaker as well as annotation of the linguistic content of the conversation. A key feature of Gecko is the presentation of the output of automatic segmentation and transcription systems in an intuitive user interface for editing. Gecko allows annotation of Voice Activity Detection (VAD), Diarization, Speaker Identiﬁcation and ASR outputs on a large scale, and leads to faster and more accurate annotated datasets.

 Gecko was originally introduced in [this Medium post](https://medium.com/gong-tech-blog/introducing-gecko-an-open-source-solution-for-effective-annotation-of-conversations-2ecec0909941).
For an overview of the main features, see this [video](https://youtu.be/CBYA0YC1NBI) and the corresponding [paper](./docs/gecko_interspeech_2019_paper.pdf). \
You can try this fork on the live working platform at **<https://tango4j.github.io/gecko/>**.

## Features

* Supports the annotating process of different stages of a conversation: voice detection, diarization, identification and transcription.
* Provides an efficient and convenient tool for annotating audio files.
* Visualize the annotation of several different sources at once.
* Refine existing annotation files.
* Compare different annotating files to find discrepancies between different systems or annotators.
* No server side is needed — easy installation.
* Supports RTTM, CTM, JSON, CSV, SRT, TSV, and **SegLST** formats.
* Increased productivity using keyboard shortcuts.

![Poster](./docs/Poster_interspeech2019.jpg)

## Technological Stack

Gecko is written in JavaScript on top of AngularJS 1.x. The audio player uses the popular [wavesurfer.js](https://github.com/katspaugh/wavesurfer.js) library. The build pipeline is Webpack 5 with native Asset Modules.

## Deployment and Installation

See [INSTALLATION.md](INSTALLATION.md).

## Publications

Gecko was presented at Interspeech 2019. See this [video](https://youtu.be/CBYA0YC1NBI) for an overview and the accepted [paper](./docs/Gecko_intersepeech2019_proposal.pdf).

## Citation

If you use `Gecko` please cite the original paper:

```bibtex
    @inproceedings{Gecko2019,
      Author = {Golan Levy, Raquel Sitman, Ido Amir, Eduard Golshtein, Ran Mochary, Eilon Reshef, Reichart, Omri Allouche},
      Title = {GECKO - A Tool for Effective Annotation of Human Conversations},
      Booktitle = {20th Annual Conference of the International Speech Communication Association, Interspeech 2019},
      Year = {2019},
      Month = {September},
      Address = {Herzliya, Israel},
      Url = {https://github.com/gong-io/gecko/blob/master/docs/gecko_interspeech_2019_paper.pdf}
    }
```

## Contribution

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Contact

For issues specific to this fork (SegLST, theming, build), please open an issue on [`tango4j/gecko`](https://github.com/tango4j/gecko/issues). For questions about the original project, see [the original team at Gong.io](https://github.com/gong-io).
