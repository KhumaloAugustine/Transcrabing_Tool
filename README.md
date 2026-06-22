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
