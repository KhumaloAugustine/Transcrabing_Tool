const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", ...headers }
});

const error = (detail, status = 400) => json({ detail }, status);
const parse = (value, fallback) => { try { return JSON.parse(value || JSON.stringify(fallback)); } catch { return fallback; } };
const allowedTypes = new Set(["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/wav", "audio/x-wav", "audio/webm", "audio/ogg", "video/mp4"]);

function interview(row) {
  if (!row) return null;
  return {
    ...row,
    zulu_segments: parse(row.zulu_segments, []),
    english_segments: parse(row.english_segments, []),
    audio_url: `/api/interviews/${row.id}/audio`
  };
}

async function getInterview(env, id) {
  const row = await env.DB.prepare("SELECT * FROM interviews WHERE id = ?").bind(id).first();
  return interview(row);
}

async function requireInterview(env, id) {
  const item = await getInterview(env, id);
  if (!item) throw new HttpError(404, "Interview not found");
  return item;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function openAI(env, path, options) {
  if (!env.OPENAI_API_KEY) throw new HttpError(503, "OPENAI_API_KEY is not configured as a Worker secret");
  const response = await fetch(`https://api.openai.com/v1${path}`, {
    ...options,
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, ...(options.headers || {}) }
  });
  const text = await response.text();
  if (!response.ok) throw new HttpError(502, `AI provider error: ${text.slice(0, 500)}`);
  try { return JSON.parse(text); } catch { throw new HttpError(502, "AI provider returned an invalid response"); }
}

async function structuredCompletion(env, system, payload, name, schema) {
  const result = await openAI(env, "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: env.LLM_MODEL || "gpt-4.1-mini",
      temperature: 0.1,
      messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(payload) }],
      response_format: { type: "json_schema", json_schema: { name, strict: true, schema } }
    })
  });
  return JSON.parse(result.choices[0].message.content);
}

async function listInterviews(env) {
  const { results } = await env.DB.prepare("SELECT * FROM interviews ORDER BY created_at DESC").all();
  return json(results.map(interview));
}

async function uploadInterview(request, env) {
  const form = await request.formData();
  const audio = form.get("audio");
  if (!(audio instanceof File)) throw new HttpError(400, "An audio file is required");
  if (!allowedTypes.has(audio.type)) throw new HttpError(415, `Unsupported recording type: ${audio.type || "unknown"}`);
  if (audio.size > 25 * 1024 * 1024) throw new HttpError(413, "This Cloudflare starter currently supports recordings up to 25 MB. Compress or split longer recordings first.");
  const id = crypto.randomUUID();
  const extension = audio.name.includes(".") ? `.${audio.name.split(".").pop().toLowerCase()}` : ".audio";
  const storedName = `${id}${extension}`;
  await env.RECORDINGS.put(storedName, audio.stream(), { httpMetadata: { contentType: audio.type }, customMetadata: { originalName: audio.name } });
  const title = String(form.get("title") || audio.name.replace(/\.[^.]+$/, "")).trim();
  const createdAt = new Date().toISOString();
  try {
    await env.DB.prepare("INSERT INTO interviews (id,title,original_name,stored_name,content_type,created_at) VALUES (?,?,?,?,?,?)")
      .bind(id, title, audio.name, storedName, audio.type, createdAt).run();
  } catch (cause) {
    await env.RECORDINGS.delete(storedName);
    throw cause;
  }
  return json(await getInterview(env, id), 201);
}

async function serveAudio(request, env, item) {
  const object = await env.RECORDINGS.get(item.stored_name, { onlyIf: request.headers });
  if (!object) throw new HttpError(404, "Recording not found in private storage");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(item.original_name)}`);
  return new Response(object.body, { headers });
}

async function transcribe(env, item) {
  const object = await env.RECORDINGS.get(item.stored_name);
  if (!object) throw new HttpError(404, "Recording not found in private storage");
  const form = new FormData();
  form.append("file", new File([await object.arrayBuffer()], item.original_name, { type: item.content_type }));
  form.append("model", env.TRANSCRIPTION_MODEL || "gpt-4o-transcribe-diarize");
  form.append("language", "zu");
  form.append("response_format", "diarized_json");
  form.append("chunking_strategy", "auto");
  form.append("prompt", "This is a South African research interview in formal isiZulu. Preserve isiZulu wording, names, clinical terms and traditional-health terminology. Do not translate.");
  const result = await openAI(env, "/audio/transcriptions", { method: "POST", body: form });
  const raw = result.segments || (result.text ? [{ start: 0, end: 0, speaker: "Isikhulumi", text: result.text }] : []);
  const segments = raw.filter(s => String(s.text || "").trim()).map(s => ({
    start: Number(s.start) || 0, end: Number(s.end) || 0,
    speaker: s.speaker || "Isikhulumi", text: String(s.text).trim()
  }));
  const duration = segments.reduce((max, s) => Math.max(max, s.end), 0);
  await env.DB.prepare("UPDATE interviews SET zulu_segments=?,duration=?,status='needs_review' WHERE id=?")
    .bind(JSON.stringify(segments), duration, item.id).run();
  return json(await getInterview(env, item.id));
}

async function updateTranscript(request, env, item) {
  const body = await request.json();
  if (!['zulu', 'english'].includes(body.language) || !Array.isArray(body.segments)) throw new HttpError(400, "A valid language and segments array are required");
  const query = body.language === "zulu"
    ? "UPDATE interviews SET zulu_segments=? WHERE id=?"
    : "UPDATE interviews SET english_segments=? WHERE id=?";
  await env.DB.prepare(query).bind(JSON.stringify(body.segments), item.id).run();
  return json({ saved: true });
}

async function review(env, item) {
  if (!item.zulu_segments.length) throw new HttpError(409, "Transcribe the recording before marking it reviewed");
  await env.DB.prepare("UPDATE interviews SET status='reviewed' WHERE id=?").bind(item.id).run();
  return json(await getInterview(env, item.id));
}

const segmentSchema = {
  type: "object", properties: {
    start: { type: "number" }, end: { type: "number" }, speaker: { type: "string" }, text: { type: "string" }
  }, required: ["start", "end", "speaker", "text"], additionalProperties: false
};

async function translate(env, item) {
  if (item.status !== "reviewed") throw new HttpError(409, "The isiZulu transcript must be reviewed before translation");
  const schema = { type: "object", properties: { segments: { type: "array", items: segmentSchema } }, required: ["segments"], additionalProperties: false };
  const result = await structuredCompletion(env,
    "Translate the supplied isiZulu research-interview segments into faithful, natural English. Preserve timestamps, speaker identity, cultural meaning, uncertainty, traditional-health concepts and medical nuance. Do not summarise or add facts.",
    { segments: item.zulu_segments }, "translated_transcript", schema);
  await env.DB.prepare("UPDATE interviews SET english_segments=? WHERE id=?").bind(JSON.stringify(result.segments), item.id).run();
  return json(await getInterview(env, item.id));
}

async function analyse(env) {
  const { results } = await env.DB.prepare("SELECT id,title,zulu_segments,english_segments FROM interviews WHERE status='reviewed'").all();
  if (!results.length) throw new HttpError(409, "No reviewed transcripts are available for analysis");
  const theme = { type: "object", properties: {
    name: { type: "string" }, interpretation: { type: "string" }, interview_id: { type: "string" }, start: { type: "number" },
    supporting_quote_isizulu: { type: "string" }, supporting_quote_english: { type: "string" }
  }, required: ["name", "interpretation", "interview_id", "start", "supporting_quote_isizulu", "supporting_quote_english"], additionalProperties: false };
  const schema = { type: "object", properties: { medical_pluralism: { type: "array", items: theme }, health_belief_model: { type: "array", items: theme } }, required: ["medical_pluralism", "health_belief_model"], additionalProperties: false };
  const transcripts = results.map(row => ({ id: row.id, title: row.title, isizulu: parse(row.zulu_segments, []), english: parse(row.english_segments, []) }));
  return json(await structuredCompletion(env,
    "You support, but never replace, a qualitative researcher. Code only explicit evidence. Medical Pluralism covers navigation among biomedical, traditional, spiritual and informal care. Health Belief Model covers perceived susceptibility, severity, benefits, barriers, cues to action and self-efficacy. Quotes must be verbatim. Preserve contradictions.",
    { reviewed_transcripts: transcripts }, "framework_analysis", schema));
}

async function route(request, env) {
  const url = new URL(request.url), path = url.pathname;
  if (path === "/api/health" && request.method === "GET") return json({ ok: true, ai_configured: Boolean(env.OPENAI_API_KEY), platform: "cloudflare" });
  if (path === "/api/interviews" && request.method === "GET") return listInterviews(env);
  if (path === "/api/interviews" && request.method === "POST") return uploadInterview(request, env);
  if (path === "/api/analysis" && request.method === "POST") return analyse(env);
  const match = path.match(/^\/api\/interviews\/([^/]+)(?:\/(audio|transcribe|transcript|review|translate))?$/);
  if (!match) throw new HttpError(404, "API route not found");
  const item = await requireInterview(env, match[1]), action = match[2];
  if (!action && request.method === "GET") return json(item);
  if (action === "audio" && request.method === "GET") return serveAudio(request, env, item);
  if (action === "transcribe" && request.method === "POST") return transcribe(env, item);
  if (action === "transcript" && request.method === "PATCH") return updateTranscript(request, env, item);
  if (action === "review" && request.method === "POST") return review(env, item);
  if (action === "translate" && request.method === "POST") return translate(env, item);
  throw new HttpError(405, "Method not allowed");
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) return await route(request, env);
      return env.ASSETS.fetch(request);
    } catch (cause) {
      console.error(cause);
      return error(cause.message || "Unexpected server error", cause instanceof HttpError ? cause.status : 500);
    }
  }
};
