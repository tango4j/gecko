# Installation & Deployment

> This is the installation guide for the [`tango4j/gecko`](https://github.com/tango4j/gecko) fork. A live build is hosted at <https://tango4j.github.io/gecko/> — you only need to install locally if you want to develop against the codebase or run Gecko in server mode (S3 integration, etc.).

## Requirements

* Node.js ≥ 18 LTS (tested on Node 20)
* npm ≥ 9

The previous upstream targeted Node 10 / npm 6; the dependency refresh in this fork (Webpack 5, modern loaders, `Intl.Segmenter`-based tokenization) requires a current LTS Node.

## Usage

1. Install packages: `npm install`
2. Run the dev server: `npm run dev` — then open <http://localhost:8080>.
3. Production build: `npm run build` — outputs to `./build/`.

### Loading transcripts via URL

You can pre-populate Gecko by passing transcript files as query params, including the new SegLST format:

```
http://localhost:8080/?audio=path/to/file.wav&json=path/to/file.seglst.json
```

The `json=` param accepts any of `.json`, `.seglst`, `.seglst.json`, `.rttm`, `.ctm`, `.srt`, or `.tsv` — Gecko will auto-detect SegLST payloads by their shape (`session_id` / `words` / `start_time` / `end_time` / `speaker`).

## Configuration

When running Gecko in server mode, you'll be able to configure the host port, create a .env file with:

```bash
GECKO_SERVER_CONTAINER_PORT=<<<host port>>
```

### AWS integration

#### S3 storage

You can use a S3 storage account to:

* Load audio & annotation from a bucket
* Save annotations to a bucket

You need to add these environment variables to your .env file:

```bash
AWS_BUCKET=<<<put your aws bucket name here>>>
AWS_REGION=<<<put the region where your bucket is, something like us-east-3>>>
AWS_ACCESS_KEY_ID=<<<aws access key id>>>
AWS_SECRET_ACCESS_KEY=<<<aws secret access key>>>
AWS_FOLDER=<<<the folder containing your files (audio & annotations)>>>
```

At this point, you can load data from S3 Storage using this url:

`http://localhost:8080/?save_mode=server&audio=http://localhost:8080/s3_files/file.mp3&json=http://localhost:8080/s3_files/annotation.json`

Notes:

1. Gecko will aggregate the AWS_FOLDER with the file name, do not use the object key S3 gives you, only the file name is required.
2. You can use any annotation format available in Gecko, just replace the key of the parameter, for exemple with rttm : `http://localhost:8080/?save_mode=server&audio=http://localhost:8080/s3_files/file.mp3&rttm=http://localhost:8080/s3_files/annotation.rttm`
3. On save, Gecko will override the annotation file and save another file with a timestamp, to maintain some kind of primitive history mechanism.
4. You can have multiple annotation files, just aggregate them using `;` : `http://localhost:8080/?save_mode=server&audio=http://localhost:8080/s3_files/file.mp3&json=http://localhost:8080/s3_files/annotation_1.json;http://localhost:8080/s3_files/annotation_2.json`

Example: 

For an audio file and corresponding annotation file:
`s3://example-audio-bucket/my-audio/file.mp3` 
and 
`s3://example-audio-bucket/my-audio/annotation.json`
the .env file would be: 

```bash
AWS_BUCKET=example-audio-bucket
AWS_REGION=<<<something like us-east-3>>>
AWS_ACCESS_KEY_ID=<<<aws access key id>>>
AWS_SECRET_ACCESS_KEY=<<<aws secret access key>>>
AWS_FOLDER=my-audio # no leading or trailing "/"
```

## Deploy

### Client mode

`npm run build`

Copy the `build` folder to an annotator machine.

Run `index.html`

### Server mode

`npm run build`

`npm run server`

Annotator can now access the server remotely, and can use S3 integration if configured.

### GitHub Pages (this fork)

The fork is auto-deployed to <https://tango4j.github.io/gecko/> via the [`gh-pages.yml`](.github/workflows/gh-pages.yml) workflow on every push to `master` or `mod_v1`. To deploy to your own GitHub Pages site:

1. Fork the repo.
2. Update the `homepage` field in `package.json` to `https://<your-user>.github.io/gecko/`.
3. In repo Settings → Pages, set the source to **GitHub Actions**.
4. Push to `master`; the workflow will build with `npm run build` and publish `./build/` to Pages.
