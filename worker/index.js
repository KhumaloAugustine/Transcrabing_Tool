import { Buffer } from "node:buffer";

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", ...headers }
});

const error = (detail, status = 400) => json({ detail }, status);
const parse = (value, fallback) => { try { return JSON.parse(value || JSON.stringify(fallback)); } catch { return fallback; } };
const audioExtensions = new Set(["mp3","mp4","mpeg","mpga","m4a","wav","webm","aac","flac","ogg","oga","opus","wma","amr","3gp","aiff","aif","caf","mka"]);
const modelExtensions = new Set(["mp3","mp4","mpeg","mpga","m4a","wav","webm"]);
const transcriptExtensions = new Set(["txt","srt","vtt","csv","json"]);
const extensionOf = name => String(name || "").split(".").pop().toLowerCase();
const inferredType = (name, supplied) => {
  if (supplied && supplied !== "application/octet-stream") return supplied;
  return ({m4a:"audio/mp4",mp4:"audio/mp4",mp3:"audio/mpeg",mpeg:"audio/mpeg",mpga:"audio/mpeg",wav:"audio/wav",webm:"audio/webm",aac:"audio/aac",flac:"audio/flac",ogg:"audio/ogg",oga:"audio/ogg",opus:"audio/ogg",wma:"audio/x-ms-wma",amr:"audio/amr","3gp":"audio/3gpp",aiff:"audio/aiff",aif:"audio/aiff",caf:"audio/x-caf",mka:"audio/x-matroska"})[extensionOf(name)] || "application/octet-stream";
};

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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function geminiRequest(env, path, options = {}) {
  if (!env.GEMINI_API_KEY) throw new HttpError(503, "GEMINI_API_KEY is not configured as a Worker secret");
  const separator=path.includes("?")?"&":"?";
  const response=await fetch(`https://generativelanguage.googleapis.com${path}${separator}key=${encodeURIComponent(env.GEMINI_API_KEY)}`,options);
  const text=await response.text();
  if(!response.ok) throw new HttpError(502,`Gemini provider error: ${text.slice(0,500)}`);
  try{return JSON.parse(text)}catch{return text}
}

async function uploadGeminiFile(env,item,audioBuffer){
  const mime=extensionOf(item.original_name)==="m4a"?"audio/aac":item.content_type;
  const start=await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,{
    method:"POST",headers:{"content-type":"application/json","x-goog-upload-protocol":"resumable","x-goog-upload-command":"start","x-goog-upload-header-content-length":String(audioBuffer.byteLength),"x-goog-upload-header-content-type":mime},body:JSON.stringify({file:{display_name:item.original_name}})
  });
  if(!start.ok)throw new HttpError(502,`Gemini upload error: ${(await start.text()).slice(0,500)}`);
  const uploadUrl=start.headers.get("x-goog-upload-url");
  if(!uploadUrl)throw new HttpError(502,"Gemini did not return an upload URL");
  const finish=await fetch(uploadUrl,{method:"POST",headers:{"content-length":String(audioBuffer.byteLength),"x-goog-upload-offset":"0","x-goog-upload-command":"upload, finalize"},body:audioBuffer});
  if(!finish.ok)throw new HttpError(502,`Gemini upload error: ${(await finish.text()).slice(0,500)}`);
  let file=(await finish.json()).file;
  for(let attempt=0;file?.state==="PROCESSING"&&attempt<30;attempt++){
    await sleep(2000);file=await geminiRequest(env,`/v1beta/${file.name}`);
  }
  if(!file||file.state==="FAILED")throw new HttpError(502,"Gemini could not process this audio format");
  return {...file,mime};
}

async function transcribeWithGemini(env,item,audioBuffer){
  const file=await uploadGeminiFile(env,item,audioBuffer);
  const schema={type:"object",properties:{segments:{type:"array",items:{type:"object",properties:{start:{type:"number"},end:{type:"number"},speaker:{type:"string"},text:{type:"string"}},required:["start","end","speaker","text"]}}},required:["segments"]};
  const prompt="Transcribe this South African research interview verbatim in isiZulu. Do not translate, summarise, correct grammar, or invent inaudible speech. Preserve names, code-switching, medical terminology, traditional-health terms, repetitions and uncertainty. Separate speaker turns, label speakers consistently as Umcwaningi, Umhlanganyeli, or Isikhulumi N when identity is uncertain, and provide accurate start/end times in seconds.";
  try{
    const result=await geminiRequest(env,`/v1beta/models/${env.GEMINI_MODEL||"gemini-3.5-flash"}:generateContent`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({contents:[{parts:[{text:prompt},{file_data:{mime_type:file.mime,file_uri:file.uri}}]}],generationConfig:{temperature:0,responseMimeType:"application/json",responseJsonSchema:schema}})});
    const text=result.candidates?.[0]?.content?.parts?.map(part=>part.text||"").join("")||"";
    const parsed=JSON.parse(text);return parsed.segments||[];
  }finally{
    try{await geminiRequest(env,`/v1beta/${file.name}`,{method:"DELETE"})}catch(cause){console.warn("Gemini temporary-file cleanup failed",cause.message)}
  }
}

async function structuredCompletion(env, system, payload, name, schema) {
  if (!env.OPENAI_API_KEY) {
    const model=env.CLOUDFLARE_LLM_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    const messages=[{ role: "system", content: system }, { role: "user", content: JSON.stringify(payload) }];
    let result;
    try {
      result=await env.AI.run(model,{messages,response_format:{type:"json_schema",json_schema:schema},temperature:0.1,max_tokens:8000});
    } catch (cause) {
      result=await env.AI.run(model,{messages:[{role:"system",content:`${system}\nReturn JSON only. It must match this schema: ${JSON.stringify(schema)}`},messages[1]],response_format:{type:"json_object"},temperature:0.1,max_tokens:8000});
    }
    const value = result.response ?? result;
    return typeof value === "string" ? JSON.parse(value) : value;
  }
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
  const extension = extensionOf(audio.name);
  if (!audioExtensions.has(extension) && !String(audio.type).startsWith("audio/")) throw new HttpError(415, "The selected file is not recognised as an audio recording");
  if (audio.size > 95 * 1024 * 1024) throw new HttpError(413, "Recordings must currently be smaller than 95 MB. Split or compress this recording first.");
  const id = crypto.randomUUID();
  const suffix = audio.name.includes(".") ? `.${extension}` : ".audio";
  const storedName = `${id}${suffix}`;
  const contentType = inferredType(audio.name, audio.type);
  await env.RECORDINGS.put(storedName, audio.stream(), { httpMetadata: { contentType }, customMetadata: { originalName: audio.name } });
  const title = String(form.get("title") || audio.name.replace(/\.[^.]+$/, "")).trim();
  const createdAt = new Date().toISOString();
  try {
    await env.DB.prepare("INSERT INTO interviews (id,title,original_name,stored_name,content_type,created_at) VALUES (?,?,?,?,?,?)")
      .bind(id, title, audio.name, storedName, contentType, createdAt).run();
  } catch (cause) {
    await env.RECORDINGS.delete(storedName);
    throw cause;
  }
  return json(await getInterview(env, id), 201);
}

async function serveAudio(request, env, item) {
  const rangeHeader = request.headers.get("range");
  let range;
  if (rangeHeader) {
    const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      range = match[2] ? { offset: start, length: Number(match[2]) - start + 1 } : { offset: start };
    }
  }
  const object = await env.RECORDINGS.get(item.stored_name, range ? { range } : {});
  if (!object) throw new HttpError(404, "Recording not found in private storage");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(item.original_name)}`);
  if (range && object.range) {
    const offset = object.range.offset || 0, length = object.range.length || object.size;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("content-length", String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("content-length", String(object.size));
  return new Response(object.body, { headers });
}

async function transcribe(env, item) {
  const object = await env.RECORDINGS.get(item.stored_name);
  if (!object) throw new HttpError(404, "Recording not found in private storage");
  const extension = extensionOf(item.original_name);
  if (!modelExtensions.has(extension)) throw new HttpError(415, `The original .${extension || "unknown"} file is stored safely, but the transcription model accepts MP3, MP4, MPEG, MPGA, M4A, WAV or WEBM. Convert it to M4A or MP3, then upload it again.`);
  if (env.OPENAI_API_KEY && object.size > 25 * 1024 * 1024) throw new HttpError(413, "The recording is stored successfully, but the configured OpenAI transcription endpoint accepts a maximum of 25 MB per request. Compress it as M4A/MP3 or split it into smaller recordings.");
  if (!env.OPENAI_API_KEY && object.size > 70 * 1024 * 1024) throw new HttpError(413, "The recording is stored successfully, but it is too large for safe in-memory Cloudflare AI processing. Compress it as M4A/MP3 or split it into smaller recordings.");
  const audioBuffer = await object.arrayBuffer();
  let result,provider;
  if(env.GEMINI_API_KEY){
    const geminiSegments=await transcribeWithGemini(env,item,audioBuffer);
    result={segments:geminiSegments};provider=`Gemini ${env.GEMINI_MODEL||"gemini-3.5-flash"}`;
  } else if (env.OPENAI_API_KEY) {
    const form = new FormData();
    form.append("file", new File([audioBuffer], item.original_name, { type: item.content_type }));
    form.append("model", env.TRANSCRIPTION_MODEL || "gpt-4o-transcribe-diarize");
    form.append("language", "zu");
    form.append("response_format", "diarized_json");
    form.append("chunking_strategy", "auto");
    form.append("prompt", "This is a South African research interview in formal isiZulu. Preserve isiZulu wording, names, clinical terms and traditional-health terminology. Do not translate.");
    result = await openAI(env, "/audio/transcriptions", { method: "POST", body: form });provider=env.TRANSCRIPTION_MODEL||"gpt-4o-transcribe-diarize";
  } else {
    result = await env.AI.run(env.CLOUDFLARE_TRANSCRIPTION_MODEL || "@cf/openai/whisper-large-v3-turbo", {
      audio: Buffer.from(audioBuffer).toString("base64"), task: "transcribe", vad_filter: true,
      initial_prompt: "Ingxoxo yocwaningo ngesiZulu esemthethweni ngezempilo, ukwelashwa kwasesibhedlela, imithi yesintu nezangoma."
    });provider=env.CLOUDFLARE_TRANSCRIPTION_MODEL||"Cloudflare Whisper";
  }
  const raw = result.segments || (result.text ? [{ start: 0, end: 0, speaker: "Isikhulumi", text: result.text }] : []);
  const segments = raw.filter(s => String(s.text || "").trim()).map(s => ({
    start: Number(s.start) || 0, end: Number(s.end) || 0,
    speaker: s.speaker || "Isikhulumi", text: String(s.text).trim()
  }));
  const duration = segments.reduce((max, s) => Math.max(max, s.end), 0);
  await env.DB.prepare("UPDATE interviews SET zulu_segments=?,duration=?,status='needs_review',transcription_provider=? WHERE id=?")
    .bind(JSON.stringify(segments), duration, provider, item.id).run();
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

const timestampSeconds = value => {
  const clean = String(value || "").trim().replace(",", ".");
  const parts = clean.split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0];
};

function parseTranscriptFile(name, text) {
  const extension = extensionOf(name);
  if (!transcriptExtensions.has(extension)) throw new HttpError(415, "Transcript imports support TXT, SRT, VTT, CSV and JSON");
  if (extension === "json") {
    const parsed = JSON.parse(text), rows = Array.isArray(parsed) ? parsed : parsed.segments;
    if (!Array.isArray(rows)) throw new HttpError(400, "JSON transcript must be an array or contain a segments array");
    return rows.map((s, i) => ({ start:Number(s.start)||i, end:Number(s.end)||Number(s.start)||i, speaker:String(s.speaker||"Isikhulumi"), text:String(s.text||"").trim() })).filter(s=>s.text);
  }
  if (extension === "srt" || extension === "vtt") {
    return text.replace(/^WEBVTT[^\n]*\n/i, "").split(/\r?\n\s*\r?\n/).map(block => {
      const lines=block.trim().split(/\r?\n/).filter(Boolean), timingIndex=lines.findIndex(line=>line.includes("-->"));
      if (timingIndex<0) return null;
      const [from,to]=lines[timingIndex].split("-->").map(timestampSeconds), body=lines.slice(timingIndex+1).join(" ").trim();
      const speakerMatch=body.match(/^([^:]{1,60}):\s*(.+)$/);
      return {start:from,end:to,speaker:speakerMatch?speakerMatch[1]:"Isikhulumi",text:speakerMatch?speakerMatch[2]:body};
    }).filter(s=>s&&s.text);
  }
  if (extension === "csv") {
    const lines=text.split(/\r?\n/).filter(Boolean), header=lines.shift().split(",").map(h=>h.trim().toLowerCase());
    return lines.map((line,i)=>{const values=(line.match(/("(?:[^"]|"")*"|[^,]*)(?:,|$)/g)||[]).map(v=>v.replace(/,$/,"").replace(/^"|"$/g,"").replace(/""/g,'"'));const row=Object.fromEntries(header.map((h,n)=>[h,values[n]||""]));return {start:timestampSeconds(row.start||row.time||i),end:timestampSeconds(row.end||row.start||i),speaker:row.speaker||"Isikhulumi",text:(row.text||row.transcript||"").trim()}}).filter(s=>s.text);
  }
  return text.split(/\r?\n/).map((line,i)=>{const match=line.trim().match(/^(?:\[([^\]]+)\]\s*)?(?:([^:]{1,60}):\s*)?(.+)$/);return match?{start:timestampSeconds(match[1]||i),end:timestampSeconds(match[1]||i),speaker:match[2]||"Isikhulumi",text:match[3].trim()}:null}).filter(s=>s&&s.text);
}

async function importTranscript(request, env, item) {
  const form=await request.formData(), file=form.get("transcript");
  if (!(file instanceof File)) throw new HttpError(400, "A transcript file is required");
  if (file.size > 5 * 1024 * 1024) throw new HttpError(413, "Transcript files must be smaller than 5 MB");
  let segments;
  try { segments=parseTranscriptFile(file.name, await file.text()); } catch (cause) { if(cause instanceof HttpError) throw cause; throw new HttpError(400, `Could not parse transcript: ${cause.message}`); }
  if (!segments.length) throw new HttpError(400, "No transcript passages were found in the selected file");
  const duration=segments.reduce((max,s)=>Math.max(max,s.end),item.duration||0);
  await env.DB.prepare("UPDATE interviews SET zulu_segments=?,duration=?,status='needs_review' WHERE id=?").bind(JSON.stringify(segments),duration,item.id).run();
  return json(await getInterview(env,item.id));
}

async function deleteInterview(env, item) {
  await env.RECORDINGS.delete(item.stored_name);
  await env.DB.prepare("DELETE FROM interviews WHERE id=?").bind(item.id).run();
  return new Response(null,{status:204});
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
  if (path === "/api/health" && request.method === "GET") return json({ ok: true, ai_configured: Boolean(env.GEMINI_API_KEY||env.OPENAI_API_KEY||env.AI), ai_provider: env.GEMINI_API_KEY?"gemini":env.OPENAI_API_KEY?"openai":"cloudflare-workers-ai", platform: "cloudflare" });
  if (path === "/api/interviews" && request.method === "GET") return listInterviews(env);
  if (path === "/api/interviews" && request.method === "POST") return uploadInterview(request, env);
  if (path === "/api/analysis" && request.method === "POST") return analyse(env);
  const match = path.match(/^\/api\/interviews\/([^/]+)(?:\/(audio|transcribe|transcript|transcript-import|review|translate))?$/);
  if (!match) throw new HttpError(404, "API route not found");
  const item = await requireInterview(env, match[1]), action = match[2];
  if (!action && request.method === "GET") return json(item);
  if (!action && request.method === "DELETE") return deleteInterview(env,item);
  if (action === "audio" && request.method === "GET") return serveAudio(request, env, item);
  if (action === "transcribe" && request.method === "POST") return transcribe(env, item);
  if (action === "transcript" && request.method === "PATCH") return updateTranscript(request, env, item);
  if (action === "transcript-import" && request.method === "POST") return importTranscript(request,env,item);
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
