let recordings=[], current=null, currentLang="zulu", filter="all", history=[], saveTimer, toastTimer;
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const escapeHtml=value=>String(value??"").replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
const formatTime=value=>{const n=Math.max(0,Math.floor(Number(value)||0));return `${String(Math.floor(n/60)).padStart(2,"0")}:${String(n%60).padStart(2,"0")}`};
const statusLabel=s=>({uploaded:"Ready to transcribe",transcribing:"Transcribing",needs_review:"Needs review",reviewed:"Reviewed"}[s]||s);

async function api(path,options={}){
  const response=await fetch(path,options);let data={};try{data=await response.json()}catch{}
  if(!response.ok)throw new Error(data.detail||`Request failed (${response.status})`);return data;
}
function showToast(message,error=false){const t=$("#toast");t.textContent=message;t.style.background=error?"#8d382d":"";t.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove("show"),3500)}
function setBusy(button,busy,label){if(!button)return;button.disabled=busy;if(busy){button.dataset.label=button.textContent;button.textContent=label}else button.textContent=button.dataset.label||button.textContent}

async function loadRecordings(selectId){
  try{recordings=await api("/api/interviews");renderList();updateCounts();if(selectId)selectRecording(selectId);else if(current){current=recordings.find(r=>r.id===current.id)||null;renderEditor()}else if(recordings.length)selectRecording(recordings[0].id);else renderEditor()}
  catch(error){showToast(`Cannot reach the Lalela server: ${error.message}`,true)}
}
function updateCounts(){
  const reviewed=recordings.filter(r=>r.status==="reviewed").length,needs=recordings.filter(r=>r.status==="needs_review").length;
  $("#recordingCount").textContent=`${recordings.length} file${recordings.length===1?"":"s"}`;$("#projectCount").textContent=`${recordings.length} interview${recordings.length===1?"":"s"} · isiZulu`;
  $("#allCount").textContent=recordings.length;$("#needsCount").textContent=needs;$("#reviewedCount").textContent=reviewed;$("#totalCount").textContent=`/ ${recordings.length}`;
  $("#attentionCount").textContent=recordings.length?`${recordings.length-reviewed} still need attention`:"No recordings uploaded";$("#analysisIncluded").textContent=reviewed;
}
function renderList(){
  const q=$("#searchInput").value.toLowerCase(),items=recordings.filter(r=>(filter==="all"||r.status==="needs_review")&&r.title.toLowerCase().includes(q));
  $("#recordingList").innerHTML=items.length?items.map((r,i)=>`<div class="recording-item ${current?.id===r.id?"active":""}" data-id="${r.id}"><span class="rec-number">${String(recordings.indexOf(r)+1).padStart(2,"0")}</span><div class="rec-copy"><strong>${escapeHtml(r.title)}</strong><small>${new Date(r.created_at).toLocaleDateString()} · ${r.duration?formatTime(r.duration):"New"}</small></div><span class="rec-status ${r.status==="needs_review"?"review":""}">${escapeHtml(statusLabel(r.status))}</span></div>`).join(""):'<div class="empty-transcript">No recordings here yet.</div>';
  $$(".recording-item").forEach(el=>el.onclick=()=>selectRecording(el.dataset.id));
}
function selectRecording(id){current=recordings.find(r=>r.id===id)||null;currentLang="zulu";renderList();renderEditor()}
function renderEditor(){
  const available=!!current;$("#playBtn").disabled=!available;$("#transcribeBtn").disabled=!available;$("#generateBtn").disabled=!available;
  if(!current){$("#editorTitle").textContent="Choose a recording";$("#editorMeta").textContent="Upload one or more interviews to begin";$("#editorStatus").textContent="Not started";$("#audioElement").removeAttribute("src");$("#transcript").innerHTML='<div class="empty-transcript"><strong>No interview selected</strong>Upload recordings to create your project.</div>';return}
  $("#editorTitle").textContent=current.title;$("#editorMeta").textContent=`${new Date(current.created_at).toLocaleString()} · ${current.original_name}${current.transcription_provider?` · AI: ${current.transcription_provider}`:""}`;$("#editorStatus").textContent=statusLabel(current.status);$("#editorStatus").className=`status-chip ${current.status==="needs_review"?"review":""}`;
  $("#duration").textContent=current.duration?formatTime(current.duration):"--:--";$("#audioElement").src=current.audio_url;$("#zuluState").textContent=current.status==="reviewed"?"✓ Reviewed":statusLabel(current.status);$("#englishState").textContent=current.english_segments.length?"✓ Ready":"Generate";
  $("#transcribeBtn").style.display="inline-block";$("#transcribeBtn").textContent=current.zulu_segments.length?"↻ Re-transcribe":"✦ Transcribe isiZulu";renderTranscript();paintWave(0)
}
function segments(){return current?(currentLang==="zulu"?current.zulu_segments:current.english_segments):[]}
function renderTranscript(){
  const data=segments();if(!data.length){$("#transcript").innerHTML=`<div class="empty-transcript"><strong>${currentLang==="zulu"?"No isiZulu transcript yet":"No English translation yet"}</strong>${currentLang==="zulu"?"Click “Transcribe isiZulu” to process this recording.":"Review the isiZulu transcript, then generate English."}</div>`;return}
  $("#transcript").innerHTML=data.map((s,i)=>`<div class="segment" data-index="${i}"><time>${formatTime(s.start)}</time><span class="speaker" contenteditable="true" spellcheck="false">${escapeHtml(s.speaker)}</span><p contenteditable="true" spellcheck="true">${escapeHtml(s.text)}</p></div>`).join("");
  $$(".segment time").forEach(t=>t.onclick=()=>{const index=+t.parentElement.dataset.index,a=$("#audioElement");a.currentTime=data[index].start;a.play()});
  $$(".segment p").forEach(p=>{p.onfocus=()=>history.push(JSON.stringify(segments()));p.oninput=e=>{segments()[+e.target.parentElement.dataset.index].text=e.target.textContent;scheduleSave()}})
  $$(".segment .speaker").forEach(s=>{s.onfocus=()=>history.push(JSON.stringify(segments()));s.oninput=e=>{segments()[+e.target.parentElement.dataset.index].speaker=e.target.textContent.trim();scheduleSave()}})
}
function scheduleSave(){clearTimeout(saveTimer);$(".editor-footer span").innerHTML="<i></i> Saving…";saveTimer=setTimeout(saveTranscript,700)}
async function saveTranscript(){try{await api(`/api/interviews/${current.id}/transcript`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({language:currentLang,segments:segments()})});$(".editor-footer span").innerHTML="<i></i> Saved just now"}catch(e){showToast(e.message,true)}}
function paintWave(progress=0){const heights=[8,13,19,11,22,16,8,20,13,24,17,9,15,21,12,7,19,24,14,10,18,12,22,8,16,20,11,24,14,9,18,13,21,7,16,23,12,19,9,15,22,11,18,8,20,14,23,10,16,21,12,7,19,15,22,11,17,24,9,15,20,12,18,8,23,14,19,10,16,21,11,18];$("#waveform").innerHTML=heights.map((h,i)=>`<i class="${i/heights.length<progress?"played":""}" style="height:${h}px"></i>`).join("")}
async function audioDuration(file){return new Promise(resolve=>{const audio=document.createElement("audio"),url=URL.createObjectURL(file),done=value=>{URL.revokeObjectURL(url);resolve(Number.isFinite(value)?value:0)};audio.preload="metadata";audio.onloadedmetadata=()=>done(audio.duration);audio.onerror=()=>done(0);audio.src=url;setTimeout(()=>done(0),8000)})}
async function uploadFiles(files){for(const file of files){const form=new FormData();form.append("audio",file);form.append("title",file.name.replace(/\.[^.]+$/,""));form.append("duration",String(await audioDuration(file)));try{showToast(`Uploading ${file.name}…`);await api("/api/interviews",{method:"POST",body:form})}catch(e){showToast(`${file.name}: ${e.message}`,true)}}await loadRecordings();showToast(`${files.length} recording${files.length===1?"":"s"} uploaded`)}
async function importTranscript(file){if(!current)return showToast("Select an interview first",true);const form=new FormData();form.append("transcript",file);const button=$("#importTranscriptBtn");setBusy(button,true,"Importing…");try{current=await api(`/api/interviews/${current.id}/transcript-import`,{method:"POST",body:form});await loadRecordings(current.id);showToast(`${file.name} imported — review it against the audio`)}catch(e){showToast(e.message,true)}finally{setBusy(button,false);$("#transcriptInput").value=""}}
async function runAction(button,path,working,success){if(!current)return;setBusy(button,true,working);try{current=await api(path,{method:"POST"});await loadRecordings(current.id);showToast(success)}catch(e){showToast(e.message,true)}finally{setBusy(button,false)}}
function renderThemes(target,themes){$(target).innerHTML=themes.length?themes.map((t,i)=>`<div><span>${String(i+1).padStart(2,"0")}</span><p><strong>${escapeHtml(t.name)}</strong><small>${escapeHtml(t.interpretation)}</small><small>“${escapeHtml(t.supporting_quote_isizulu)}”</small></p></div>`).join(""):'<div class="empty-transcript">No evidence-supported themes found.</div>'}
function download(type){if(!current){showToast("Select an interview first",true);return}const rows=segments();let content,name,mime;if(type==="csv"){content="start,end,speaker,text\n"+rows.map(s=>[s.start,s.end,s.speaker,s.text].map(v=>`"${String(v).replaceAll('"','""')}"`).join(",")).join("\n");name=`${current.title}-${currentLang}.csv`;mime="text/csv"}else{content=rows.map(s=>`[${formatTime(s.start)}] ${s.speaker}: ${s.text}`).join("\n\n");name=`${current.title}-${currentLang}.txt`;mime="text/plain"}const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([content],{type:mime}));a.download=name;a.click();URL.revokeObjectURL(a.href)}

$$(".nav-item").forEach(btn=>btn.onclick=()=>{$$(".nav-item,.view").forEach(x=>x.classList.remove("active"));btn.classList.add("active");$(`#${btn.dataset.view}View`).classList.add("active")});
$$(".filter").forEach(btn=>btn.onclick=()=>{$$(".filter").forEach(x=>x.classList.remove("active"));btn.classList.add("active");filter=btn.dataset.filter;renderList()});
$$(".lang-tab").forEach(btn=>btn.onclick=()=>{currentLang=btn.dataset.lang;$$(".lang-tab").forEach(x=>x.classList.toggle("active",x===btn));renderTranscript()});
$("#searchInput").oninput=renderList;$("#uploadBtn").onclick=$("#smallUpload").onclick=()=>$("#fileInput").click();$("#fileInput").onchange=e=>uploadFiles(e.target.files);
$("#importTranscriptBtn").onclick=()=>{if(current)$("#transcriptInput").click();else showToast("Select an interview first",true)};$("#transcriptInput").onchange=e=>{if(e.target.files[0])importTranscript(e.target.files[0])};
$("#deleteBtn").onclick=async()=>{if(!current)return;const title=current.title;if(!confirm(`Delete “${title}” and its recording permanently?`))return;try{await api(`/api/interviews/${current.id}`,{method:"DELETE"});current=null;await loadRecordings();showToast(`${title} deleted`)}catch(e){showToast(e.message,true)}};
$("#transcribeBtn").onclick=()=>{if(current.zulu_segments.length&&!confirm("Re-transcribing will replace the current isiZulu transcript. Continue?"))return;runAction($("#transcribeBtn"),`/api/interviews/${current.id}/transcribe`,"Transcribing…","IsiZulu transcript created — review it against the audio")};
$("#generateBtn").onclick=()=>runAction($("#generateBtn"),`/api/interviews/${current.id}/translate`,"Translating…","English translation created — please review it");
$("#markReviewed").onclick=()=>runAction($("#markReviewed"),`/api/interviews/${current.id}/review`,"Saving…","IsiZulu transcript marked as reviewed");
$("#playBtn").onclick=()=>{const a=$("#audioElement");if(a.paused){a.play();$("#playBtn").textContent="❚❚"}else{a.pause();$("#playBtn").textContent="▶"}};$("#audioElement").ontimeupdate=e=>{if(e.target.duration){$("#seekBar").value=e.target.currentTime/e.target.duration*100;$("#currentTime").textContent=formatTime(e.target.currentTime);paintWave(e.target.currentTime/e.target.duration)}};$("#audioElement").onloadedmetadata=e=>$("#duration").textContent=formatTime(e.target.duration);$("#seekBar").oninput=e=>{const a=$("#audioElement");if(a.duration)a.currentTime=a.duration*e.target.value/100};
$("#speedBtn").onclick=()=>{const a=$("#audioElement"),speeds=[1,1.25,1.5,.75],next=speeds[(speeds.indexOf(a.playbackRate)+1)%speeds.length];a.playbackRate=next;$("#speedBtn").textContent=`${next}×`};
$("#undoBtn").onclick=()=>{if(!history.length)return showToast("Nothing to undo");const restored=JSON.parse(history.pop());if(currentLang==="zulu")current.zulu_segments=restored;else current.english_segments=restored;renderTranscript();scheduleSave()};$("#findBtn").onclick=()=>{const term=prompt("Find in transcript:");if(term)showToast($("#transcript").innerText.toLowerCase().includes(term.toLowerCase())?`Found “${term}”`:`No match for “${term}”`)};
$("#runAnalysis").onclick=async()=>{const b=$("#runAnalysis");setBusy(b,true,"Analysing…");try{const result=await api("/api/analysis",{method:"POST"}),all=[...result.medical_pluralism,...result.health_belief_model];renderThemes("#medicalThemes",result.medical_pluralism);renderThemes("#healthThemes",result.health_belief_model);$("#codedCount").textContent=all.length;$("#themeCount").textContent=new Set(all.map(x=>x.name)).size;showToast("Framework suggestions generated for researcher review")}catch(e){showToast(e.message,true)}finally{setBusy(b,false)}};
$("#exportBtn").onclick=()=>download("txt");$$(".export-option").forEach(b=>b.onclick=()=>download(b.dataset.type));$(".mobile-menu").onclick=()=>$(".sidebar").classList.toggle("open");
paintWave();loadRecordings();
