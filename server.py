import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

load_dotenv()
ROOT = Path(__file__).parent.resolve()
DATA = ROOT / "data"
UPLOADS = DATA / "uploads"
DB = DATA / "lalela.db"
UPLOADS.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Lalela API", version="1.0.0")


def connection():
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    return db


def initialise():
    with connection() as db:
        db.execute("""CREATE TABLE IF NOT EXISTS interviews (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, original_name TEXT NOT NULL,
            stored_name TEXT NOT NULL, content_type TEXT, created_at TEXT NOT NULL,
            duration REAL DEFAULT 0, status TEXT DEFAULT 'uploaded',
            zulu_segments TEXT DEFAULT '[]', english_segments TEXT DEFAULT '[]',
            analysis TEXT DEFAULT '{}')""")


initialise()


def require_key():
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        raise HTTPException(503, "OPENAI_API_KEY is not configured on the server")
    return key


def row_dict(row):
    item = dict(row)
    for field, fallback in (("zulu_segments", []), ("english_segments", []), ("analysis", {})):
        item[field] = json.loads(item[field] or json.dumps(fallback))
    item["audio_url"] = f"/api/interviews/{item['id']}/audio"
    return item


def get_interview(interview_id):
    with connection() as db:
        row = db.execute("SELECT * FROM interviews WHERE id=?", (interview_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Interview not found")
    return row_dict(row)


class TranscriptUpdate(BaseModel):
    language: str
    segments: list[dict]


@app.get("/api/health")
def health():
    return {"ok": True, "ai_configured": bool(os.getenv("OPENAI_API_KEY"))}


@app.get("/api/interviews")
def list_interviews():
    with connection() as db:
        rows = db.execute("SELECT * FROM interviews ORDER BY created_at DESC").fetchall()
    return [row_dict(row) for row in rows]


@app.post("/api/interviews", status_code=201)
async def upload_interview(audio: UploadFile = File(...), title: str = Form("")):
    allowed = {"audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/wav", "audio/x-wav", "audio/webm", "audio/ogg", "video/mp4"}
    if audio.content_type not in allowed:
        raise HTTPException(415, f"Unsupported recording type: {audio.content_type}")
    interview_id = str(uuid.uuid4())
    suffix = Path(audio.filename or "recording").suffix.lower() or ".audio"
    stored_name = f"{interview_id}{suffix}"
    destination = UPLOADS / stored_name
    size = 0
    with destination.open("wb") as output:
        while chunk := await audio.read(1024 * 1024):
            size += len(chunk)
            if size > int(os.getenv("MAX_UPLOAD_MB", "500")) * 1024 * 1024:
                output.close(); destination.unlink(missing_ok=True)
                raise HTTPException(413, "Recording is larger than the configured upload limit")
            output.write(chunk)
    display = title.strip() or Path(audio.filename or "Untitled interview").stem
    now = datetime.now(timezone.utc).isoformat()
    with connection() as db:
        db.execute("INSERT INTO interviews (id,title,original_name,stored_name,content_type,created_at) VALUES (?,?,?,?,?,?)",
                   (interview_id, display, audio.filename, stored_name, audio.content_type, now))
    return get_interview(interview_id)


@app.get("/api/interviews/{interview_id}")
def interview(interview_id: str):
    return get_interview(interview_id)


@app.get("/api/interviews/{interview_id}/audio")
def interview_audio(interview_id: str):
    item = get_interview(interview_id)
    path = UPLOADS / item["stored_name"]
    return FileResponse(path, media_type=item["content_type"], filename=item["original_name"])


@app.post("/api/interviews/{interview_id}/transcribe")
async def transcribe(interview_id: str):
    item = get_interview(interview_id)
    key = require_key()
    path = UPLOADS / item["stored_name"]
    data = {
        "model": os.getenv("TRANSCRIPTION_MODEL", "gpt-4o-transcribe-diarize"),
        "language": "zu",
        "response_format": "diarized_json",
        "chunking_strategy": "auto",
        "prompt": "The recording is a South African research interview in formal isiZulu. Preserve isiZulu wording, names, clinical terms and traditional-health terminology. Do not translate."
    }
    async with httpx.AsyncClient(timeout=3600) as client:
        with path.open("rb") as recording:
            response = await client.post("https://api.openai.com/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {key}"}, data=data,
                files={"file": (item["original_name"], recording, item["content_type"])})
    if response.is_error:
        raise HTTPException(502, f"Transcription provider error: {response.text[:500]}")
    result = response.json()
    raw_segments = result.get("segments") or []
    if not raw_segments and result.get("text"):
        raw_segments = [{"start": 0, "end": 0, "speaker": "Umhlanganyeli", "text": result["text"]}]
    segments = [{"start": float(s.get("start", 0)), "end": float(s.get("end", 0)),
                 "speaker": s.get("speaker") or "Isikhulumi", "text": s.get("text", "").strip()}
                for s in raw_segments if s.get("text", "").strip()]
    duration = max((s["end"] for s in segments), default=0)
    with connection() as db:
        db.execute("UPDATE interviews SET zulu_segments=?,duration=?,status='needs_review' WHERE id=?",
                   (json.dumps(segments, ensure_ascii=False), duration, interview_id))
    return get_interview(interview_id)


@app.patch("/api/interviews/{interview_id}/transcript")
def update_transcript(interview_id: str, update: TranscriptUpdate):
    get_interview(interview_id)
    if update.language not in {"zulu", "english"}:
        raise HTTPException(400, "Language must be zulu or english")
    column = "zulu_segments" if update.language == "zulu" else "english_segments"
    with connection() as db:
        db.execute(f"UPDATE interviews SET {column}=? WHERE id=?", (json.dumps(update.segments, ensure_ascii=False), interview_id))
    return {"saved": True}


async def structured_completion(system: str, payload: dict, schema_name: str, schema: dict):
    key = require_key()
    body = {"model": os.getenv("LLM_MODEL", "gpt-4.1-mini"), "temperature": 0.1,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": json.dumps(payload, ensure_ascii=False)}],
            "response_format": {"type": "json_schema", "json_schema": {"name": schema_name, "strict": True, "schema": schema}}}
    async with httpx.AsyncClient(timeout=600) as client:
        response = await client.post("https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"}, json=body)
    if response.is_error:
        raise HTTPException(502, f"Language model provider error: {response.text[:500]}")
    return json.loads(response.json()["choices"][0]["message"]["content"])


@app.post("/api/interviews/{interview_id}/review")
def review(interview_id: str):
    item = get_interview(interview_id)
    if not item["zulu_segments"]:
        raise HTTPException(409, "Transcribe the recording before marking it reviewed")
    with connection() as db:
        db.execute("UPDATE interviews SET status='reviewed' WHERE id=?", (interview_id,))
    return get_interview(interview_id)


@app.post("/api/interviews/{interview_id}/translate")
async def translate(interview_id: str):
    item = get_interview(interview_id)
    if item["status"] != "reviewed":
        raise HTTPException(409, "The isiZulu transcript must be reviewed before translation")
    schema = {"type":"object","properties":{"segments":{"type":"array","items":{"type":"object","properties":{
        "start":{"type":"number"},"end":{"type":"number"},"speaker":{"type":"string"},"text":{"type":"string"}},
        "required":["start","end","speaker","text"],"additionalProperties":False}}},"required":["segments"],"additionalProperties":False}
    result = await structured_completion(
        "Translate the supplied isiZulu research-interview segments into faithful, natural English. Preserve timestamps, speaker identity, cultural meaning, uncertainty, traditional-health concepts and medical nuance. Do not summarise or add facts.",
        {"segments": item["zulu_segments"]}, "translated_transcript", schema)
    with connection() as db:
        db.execute("UPDATE interviews SET english_segments=? WHERE id=?", (json.dumps(result["segments"], ensure_ascii=False), interview_id))
    return get_interview(interview_id)


@app.post("/api/analysis")
async def analyse():
    with connection() as db:
        rows = db.execute("SELECT id,title,zulu_segments,english_segments FROM interviews WHERE status='reviewed'").fetchall()
    if not rows:
        raise HTTPException(409, "No reviewed transcripts are available for analysis")
    transcripts = [{"id":r["id"],"title":r["title"],"isizulu":json.loads(r["zulu_segments"]),"english":json.loads(r["english_segments"])} for r in rows]
    theme = {"type":"object","properties":{"name":{"type":"string"},"interpretation":{"type":"string"},"interview_id":{"type":"string"},"start":{"type":"number"},"supporting_quote_isizulu":{"type":"string"},"supporting_quote_english":{"type":"string"}},"required":["name","interpretation","interview_id","start","supporting_quote_isizulu","supporting_quote_english"],"additionalProperties":False}
    schema = {"type":"object","properties":{"medical_pluralism":{"type":"array","items":theme},"health_belief_model":{"type":"array","items":theme}},"required":["medical_pluralism","health_belief_model"],"additionalProperties":False}
    result = await structured_completion(
        "You support, but never replace, a qualitative researcher. Code only evidence explicitly present in the supplied interviews. Medical Pluralism covers navigation among biomedical, traditional, spiritual and informal care. Health Belief Model covers perceived susceptibility, severity, benefits, barriers, cues to action and self-efficacy. Quotes must be verbatim. Return cautious interpretations and preserve contradictory cases.",
        {"reviewed_transcripts": transcripts}, "framework_analysis", schema)
    return result


@app.get("/", include_in_schema=False)
def frontend():
    return FileResponse(ROOT / "index.html", media_type="text/html")


@app.get("/styles.css", include_in_schema=False)
def frontend_styles():
    return FileResponse(ROOT / "styles.css", media_type="text/css")


@app.get("/app.js", include_in_schema=False)
def frontend_script():
    return FileResponse(ROOT / "app.js", media_type="text/javascript")
