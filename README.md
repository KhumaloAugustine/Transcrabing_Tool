# Lalela

Lalela is a local web application for processing real isiZulu research interviews. It stores multiple recordings, creates timestamped speaker-aware isiZulu transcripts, supports human correction while listening, translates reviewed transcripts to English, and produces evidence-linked suggestions for Medical Pluralism and Health Belief Model analysis.

No interview or transcript sample data is included.

## Setup

1. Create a virtual environment and install the backend:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

2. Copy `.env.example` to `.env` and place your API key in `.env`:

```text
OPENAI_API_KEY=your-project-key
```

The key remains on the server and is never returned to browser code. Both AI model names are configurable in `.env`.

3. Start the application:

```powershell
python -m uvicorn server:app --reload --port 8091
```

4. Open `http://127.0.0.1:8091`.

## Research workflow

1. Upload one or many recordings.
2. Select an interview and choose **Transcribe isiZulu**.
3. Play the original recording and correct speaker labels and wording.
4. Mark the isiZulu transcript as reviewed.
5. Generate and review the English translation.
6. Run framework analysis across reviewed transcripts.
7. Check every proposed code, interpretation and quotation against the isiZulu source before using it in findings.

## Storage and privacy

Recordings and the SQLite database are stored under `data/`, which is excluded from Git. This is suitable for local development, not yet for a deployed research system. Before handling participant data in production, add authentication, role-based access, encryption at rest, backups, audit logs, retention/deletion controls, consent records, antivirus scanning, database migrations and institutional ethics/POPIA review.

The AI analysis is deliberately framed as researcher-support. It does not invent findings and should never replace isiZulu-speaking human review or methodological interpretation.

## Cloudflare deployment

The repository also includes a Cloudflare-native backend under `worker/`. It replaces Python/FastAPI in the hosted environment with:

- Workers for the API and frontend
- D1 for interview metadata and transcripts
- Private R2 storage for recordings
- Cloudflare Workers AI for hosted transcription, translation and analysis
- An optional Worker secret for the OpenAI provider

The hosted application accepts common recorder formats including M4A, MP3, MP4, MPEG, MPGA, WAV, WEBM, AAC, FLAC, OGG, OPUS, WMA, AMR, 3GP, AIFF, CAF and MKA for private storage. Direct model transcription currently supports MP3, MP4, MPEG, MPGA, M4A, WAV and WEBM. Cloudflare AI recordings can be up to 70 MB; uploads are capped at 95 MB.

Existing isiZulu transcripts can be attached to a recording in TXT, SRT, VTT, CSV or JSON format. Imported and generated transcripts both enter the same mandatory review workflow.

### First deployment

After signing in to a Cloudflare account, run:

```powershell
npm install
npx wrangler login
npx wrangler d1 create lalela-db
npx wrangler r2 bucket create lalela-recordings
```

Copy the D1 `database_id` returned by Cloudflare into `wrangler.jsonc`. Then initialise the remote database and deploy:

```powershell
npx wrangler d1 migrations apply lalela-db --remote
npx wrangler deploy
```

Cloudflare Workers AI operates without an OpenAI key. To use OpenAI as an optional provider, run `npx wrangler secret put OPENAI_API_KEY`. Never place that key inside `wrangler.jsonc`, `.env.example`, Git, or Cloudflare static asset variables.

### Higher-quality isiZulu audio transcription

The hosted Worker supports Gemini direct-audio transcription as its preferred engine when a Gemini key is configured. It uploads the recording to the temporary Gemini Files API, processes the interview in overlapping five-minute windows to avoid truncated output and language drift, merges timestamped isiZulu-only segments, and deletes the temporary Gemini file after processing. Configure it securely with:

```powershell
npx wrangler secret put GEMINI_API_KEY
```

The interface then offers **Re-transcribe** and displays which AI provider generated the transcript. Existing transcripts are replaced only after explicit confirmation. Never commit the Gemini key to Git.
