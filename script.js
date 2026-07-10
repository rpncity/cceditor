(function(){
  const video = document.getElementById('video');
  const stage = document.getElementById('stage');
  const emptyStage = document.getElementById('emptyStage');
  const cueList = document.getElementById('cueList');
  const cueCountEl = document.getElementById('cueCount');
  const timeline = document.getElementById('timeline');
  const captionOverlay = document.getElementById('captionOverlay');
  const clockCurrent = document.getElementById('clockCurrent');
  const clockDuration = document.getElementById('clockDuration');
  const videoNameEl = document.getElementById('videoName');
  const toastEl = document.getElementById('toast');
  const playBtn = document.getElementById('playBtn');
  const prevCueBtn = document.getElementById('prevCueBtn');
  const nextCueBtn = document.getElementById('nextCueBtn');
  const seekBar = document.getElementById('seekBar');
  const muteBtn = document.getElementById('muteBtn');
  const volumeBar = document.getElementById('volumeBar');
  const speedSelect = document.getElementById('speedSelect');

  let cues = [];       // {id, start, end, text}
  let nextId = 1;
  let hasVideo = false;
  let virtualTime = 0;      // used when no video is loaded
  let virtualDuration = 60;
  let virtualPlaying = false;
  let virtualRate = 1;
  let virtualRAF = null;
  let virtualLastFrame = null;
  let isScrubbing = false;
  let draggingBlock = null; // {mode:'move'|'l'|'r', id, startX, origStart, origEnd}
  let rangeStart = 0;
  let rangeEnd = null; // null = end of transcript
  let draggingMarker = null; // {type:'start'|'end', startX, orig, railWidth}
  let sourceFileName = 'captions';

  function toast(msg){
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(()=>toastEl.classList.remove('show'), 1800);
  }

  // ---------- time helpers ----------
  function fmt(sec){
    if(!isFinite(sec) || sec < 0) sec = 0;
    const h = Math.floor(sec/3600);
    const m = Math.floor((sec%3600)/60);
    const s = Math.floor(sec%60);
    const ms = Math.round((sec - Math.floor(sec))*1000);
    return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')+'.'+String(ms).padStart(3,'0');
  }
  function fmtShort(sec){
    if(!isFinite(sec) || sec < 0) sec = 0;
    const h = Math.floor(sec/3600);
    const m = Math.floor((sec%3600)/60);
    const s = Math.floor(sec%60);
    const pad = n => String(n).padStart(2,'0');
    return h > 0 ? (h + ':' + pad(m) + ':' + pad(s)) : (pad(m) + ':' + pad(s));
  }
  function parseFlexible(str){
    str = (str||'').trim();
    if(/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);
    const m = str.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d{1,3})?)$/);
    if(!m) return null;
    const h = m[1] ? parseInt(m[1],10) : 0;
    const mm = parseInt(m[2],10);
    const ss = parseFloat(m[3]);
    return h*3600 + mm*60 + ss;
  }

  function getDuration(){
    if(hasVideo && isFinite(video.duration) && video.duration > 0) return video.duration;
    const maxEnd = cues.reduce((a,c)=>Math.max(a,c.end), 0);
    return Math.max(virtualDuration, maxEnd + 5, 10);
  }
  function getCurrentTime(){
    return hasVideo ? video.currentTime : virtualTime;
  }
  function setCurrentTime(t){
    t = Math.max(0, Math.min(getDuration(), t));
    if(hasVideo){ video.currentTime = t; }
    else { virtualTime = t; updatePlayback(); }
  }

  function effectiveRangeEnd(){
    return rangeEnd === null ? getDuration() : rangeEnd;
  }
  function syncRangeInputs(){
    document.getElementById('rangeStartInput').value = fmt(rangeStart);
    document.getElementById('rangeEndInput').value = rangeEnd === null ? 'end' : fmt(rangeEnd);
  }

  // ---------- subtitle parse / serialize (WebVTT + SRT) ----------
  function parseSubtitleBlocks(text){
    const norm = text.replace(/^\uFEFF/, '').replace(/\r\n?/g,'\n');
    const blocks = norm.split(/\n\s*\n/);
    const parsed = [];
    for(let block of blocks){
      const lines = block.split('\n').filter(l=>l.trim().length || l==='');
      if(!lines.length) continue;
      if(/^WEBVTT/.test(lines[0])) continue;
      if(/^NOTE/.test(lines[0])) continue;
      let timingLineIdx = lines.findIndex(l=>l.includes('-->'));
      if(timingLineIdx === -1) continue;
      const timingLine = lines[timingLineIdx];
      const m = timingLine.match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
      if(!m) continue;
      const start = parseFlexible(m[1].replace(',','.'));
      const end = parseFlexible(m[2].replace(',','.'));
      const text = lines.slice(timingLineIdx+1).join('\n').trim();
      if(start === null || end === null) continue;
      parsed.push({ id: nextId++, start, end, text });
    }
    return parsed;
  }
  // WebVTT and SRT share the same cue-block shape (index / timing / text lines
  // separated by a blank line); the only real difference is the header line and
  // the timestamp decimal separator, both already handled above.
  function parseVTT(text){ return parseSubtitleBlocks(text); }
  function parseSRT(text){ return parseSubtitleBlocks(text); }

  function detectFormat(text, filename){
    if(filename){
      if(/\.srt$/i.test(filename)) return 'srt';
      if(/\.vtt$/i.test(filename)) return 'vtt';
    }
    return /^\uFEFF?\s*WEBVTT/.test(text) ? 'vtt' : 'srt';
  }

  function serializeVTT(){
    const sorted = [...cues].sort((a,b)=>a.start-b.start);
    let out = 'WEBVTT\n\n';
    sorted.forEach((c,i)=>{
      out += (i+1) + '\n';
      out += fmt(c.start) + ' --> ' + fmt(c.end) + '\n';
      out += (c.text || '') + '\n\n';
    });
    return out;
  }
  function fmtSRT(sec){
    return fmt(sec).replace('.', ',');
  }
  function serializeSRT(){
    const sorted = [...cues].sort((a,b)=>a.start-b.start);
    let out = '';
    sorted.forEach((c,i)=>{
      out += (i+1) + '\n';
      out += fmtSRT(c.start) + ' --> ' + fmtSRT(c.end) + '\n';
      out += (c.text || '') + '\n\n';
    });
    return out;
  }
  function downloadFile(content, filename, mime){
    const blob = new Blob([content], {type:mime});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('Exported ' + filename);
  }

  // ---------- rendering ----------
  function escapeHtml(s){
    return (s||'').replace(/[&<>]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[ch]));
  }

  function sortCuesInPlace(){
    cues.sort((a,b)=> a.start - b.start);
  }

  function renderCueList(){
    cueCountEl.textContent = cues.length;
    if(!cues.length){
      cueList.innerHTML = '<div class="empty-cues">No cues yet.<br>Load a .vtt file or add a new cue to begin.</div>';
      return;
    }
    const sorted = [...cues].sort((a,b)=>a.start-b.start);
    cueList.innerHTML = sorted.map((c,i)=>`
      <div class="cue-row" data-id="${c.id}">
        <div class="cue-num">${String(i+1).padStart(2,'0')}</div>
        <div class="cue-body">
          <div class="cue-times">
            <input class="time-input" data-field="start" value="${fmt(c.start)}">
            <span class="arrow">→</span>
            <input class="time-input" data-field="end" value="${fmt(c.end)}">
            <span class="cue-dur">${(c.end-c.start).toFixed(2)}s</span>
          </div>
          <textarea class="cue-text" data-field="text" rows="2">${escapeHtml(c.text)}</textarea>
        </div>
        <div class="cue-actions">
          <button class="btn-icon seek" title="Jump to cue">▶</button>
          <button class="btn-icon dup" title="Duplicate">⧉</button>
          <button class="btn-icon del" title="Delete">✕</button>
        </div>
      </div>
    `).join('');
  }

  function renderTimeline(){
    const dur = getDuration();
    const width = timeline.clientWidth || 800;
    let html = '';
    // ticks — aim for ~8 divisions
    const tickCount = 8;
    for(let i=0;i<=tickCount;i++){
      const t = (dur/tickCount)*i;
      const left = (t/dur)*100;
      html += `<div class="tl-tick" style="left:${left}%"><span>${fmt(t).slice(0,-4)}</span></div>`;
    }
    const rEnd = effectiveRangeEnd();
    const rLeft = (rangeStart/dur)*100;
    const rWidth = Math.max(((rEnd-rangeStart)/dur)*100, 0);
    html += `<div class="tl-range" style="left:${rLeft}%;width:${rWidth}%;"></div>`;
    cues.forEach(c=>{
      const left = (c.start/dur)*100;
      const w = Math.max(((c.end-c.start)/dur)*100, 0.4);
      html += `<div class="tl-block" data-id="${c.id}" style="left:${left}%;width:${w}%;">
                 <div class="handle l" data-id="${c.id}"></div>
                 <div class="handle r" data-id="${c.id}"></div>
               </div>`;
    });
    html += `<div class="tl-marker" data-marker="start" style="left:${(rangeStart/dur)*100}%;"><span class="line"></span><span class="flag">S</span></div>`;
    if(rangeEnd !== null){
      html += `<div class="tl-marker" data-marker="end" style="left:${(rangeEnd/dur)*100}%;"><span class="line"></span><span class="flag">E</span></div>`;
    }
    html += `<div class="tl-playhead" id="playhead" style="left:0%"></div>`;
    timeline.innerHTML = html;
    updatePlayheadPosition();
  }

  function updatePlayheadPosition(){
    const dur = getDuration();
    const t = getCurrentTime();
    const ph = document.getElementById('playhead');
    if(ph) ph.style.left = Math.min(100,(t/dur)*100) + '%';
  }

  function findActiveCue(t){
    return cues.find(c => t >= c.start && t < c.end);
  }

  function updatePlayback(){
    const t = getCurrentTime();
    const dur = getDuration();
    clockCurrent.textContent = fmtShort(t);
    clockDuration.textContent = fmtShort(dur);
    if(!isScrubbing) seekBar.value = Math.min(1000, (t/dur)*1000);
    updatePlayheadPosition();
    // caption overlay
    const active = findActiveCue(t);
    captionOverlay.innerHTML = active ? `<span>${escapeHtml(active.text).replace(/\n/g,'<br>')}</span>` : '';
    // active row highlight
    document.querySelectorAll('.cue-row').forEach(row=>{
      row.classList.toggle('active', active && String(active.id) === row.dataset.id);
    });
    document.querySelectorAll('.tl-block').forEach(b=>{
      b.classList.toggle('active', active && String(active.id) === b.dataset.id);
    });
  }

  function renderAll(){
    sortCuesInPlace();
    renderCueList();
    renderTimeline();
    updatePlayback();
  }

  // ---------- cue list interactions ----------
  cueList.addEventListener('change', e=>{
    const row = e.target.closest('.cue-row');
    if(!row) return;
    const id = Number(row.dataset.id);
    const cue = cues.find(c=>c.id===id);
    if(!cue) return;
    const field = e.target.dataset.field;
    if(field === 'start' || field === 'end'){
      const val = parseFlexible(e.target.value);
      if(val === null){ toast('Could not read that timestamp'); renderCueList(); return; }
      cue[field] = Math.max(0, val);
      if(cue.start >= cue.end) {
        if(field === 'start') cue.end = cue.start + 0.5;
        else cue.start = Math.max(0, cue.end - 0.5);
      }
      renderAll();
    }
  });
  cueList.addEventListener('input', e=>{
    if(e.target.dataset.field === 'text'){
      const row = e.target.closest('.cue-row');
      const id = Number(row.dataset.id);
      const cue = cues.find(c=>c.id===id);
      if(cue){ cue.text = e.target.value; updatePlayback(); }
    }
  });
  cueList.addEventListener('click', e=>{
    const row = e.target.closest('.cue-row');
    if(!row) return;
    const id = Number(row.dataset.id);
    const idx = cues.findIndex(c=>c.id===id);
    if(idx === -1) return;
    if(e.target.closest('.seek')){
      setCurrentTime(cues[idx].start);
    } else if(e.target.closest('.dup')){
      const c = cues[idx];
      const dur = c.end - c.start;
      cues.push({ id: nextId++, start: c.end, end: c.end+dur, text: c.text });
      renderAll();
      toast('Cue duplicated');
    } else if(e.target.closest('.del')){
      cues.splice(idx,1);
      renderAll();
      toast('Cue deleted');
    }
  });

  // ---------- timeline interactions ----------
  timeline.addEventListener('mousedown', e=>{
    const marker = e.target.closest('.tl-marker');
    if(marker){
      const type = marker.dataset.marker;
      draggingMarker = {
        type,
        startX: e.clientX,
        orig: type === 'start' ? rangeStart : effectiveRangeEnd(),
        railWidth: timeline.clientWidth
      };
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const block = e.target.closest('.tl-block');
    if(!block){
      // click on empty timeline background = seek
      const rect = timeline.getBoundingClientRect();
      const frac = (e.clientX - rect.left) / rect.width;
      setCurrentTime(frac * getDuration());
      return;
    }
    const id = Number(block.dataset.id);
    const cue = cues.find(c=>c.id===id);
    if(!cue) return;
    let mode = 'move';
    if(e.target.classList.contains('handle')){
      mode = e.target.classList.contains('l') ? 'l' : 'r';
    }
    draggingBlock = { mode, id, startX: e.clientX, origStart: cue.start, origEnd: cue.end, railWidth: timeline.clientWidth };
    e.preventDefault();
  });
  window.addEventListener('mousemove', e=>{
    if(draggingMarker){
      const dur = getDuration();
      const deltaT = ((e.clientX - draggingMarker.startX) / draggingMarker.railWidth) * dur;
      let t = Math.max(0, Math.min(dur, draggingMarker.orig + deltaT));
      if(draggingMarker.type === 'start'){
        rangeStart = Math.min(t, effectiveRangeEnd());
      } else {
        rangeEnd = Math.max(t, rangeStart);
      }
      syncRangeInputs();
      renderTimeline();
      return;
    }
    if(!draggingBlock) return;
    const cue = cues.find(c=>c.id===draggingBlock.id);
    if(!cue) return;
    const dur = getDuration();
    const deltaT = ((e.clientX - draggingBlock.startX) / draggingBlock.railWidth) * dur;
    if(draggingBlock.mode === 'move'){
      const span = draggingBlock.origEnd - draggingBlock.origStart;
      let newStart = Math.max(0, draggingBlock.origStart + deltaT);
      newStart = Math.min(newStart, dur - span);
      cue.start = newStart;
      cue.end = newStart + span;
    } else if(draggingBlock.mode === 'l'){
      let newStart = Math.max(0, draggingBlock.origStart + deltaT);
      cue.start = Math.min(newStart, cue.end - 0.2);
    } else if(draggingBlock.mode === 'r'){
      let newEnd = Math.min(dur, draggingBlock.origEnd + deltaT);
      cue.end = Math.max(newEnd, cue.start + 0.2);
    }
    renderTimeline();
    renderCueList();
  });
  window.addEventListener('mouseup', ()=>{
    if(draggingBlock){ draggingBlock = null; updatePlayback(); }
    if(draggingMarker){ draggingMarker = null; }
  });

  // ---------- toolbar ----------
  document.getElementById('btnNewCue').addEventListener('click', ()=>{
    const t = getCurrentTime();
    cues.push({ id: nextId++, start: t, end: t+2, text: 'New caption' });
    renderAll();
    toast('Cue added');
  });
  document.getElementById('btnSort').addEventListener('click', ()=>{ renderAll(); toast('Sorted by start time'); });

  // ---------- range offset ----------
  const rangeStartInput = document.getElementById('rangeStartInput');
  const rangeEndInput = document.getElementById('rangeEndInput');
  document.getElementById('btnMarkStart').addEventListener('click', ()=>{
    rangeStart = Math.min(getCurrentTime(), effectiveRangeEnd());
    syncRangeInputs();
    renderTimeline();
    toast('Start marker set to ' + fmtShort(rangeStart));
  });
  document.getElementById('btnMarkEnd').addEventListener('click', ()=>{
    rangeEnd = Math.max(getCurrentTime(), rangeStart);
    syncRangeInputs();
    renderTimeline();
    toast('End marker set to ' + fmtShort(rangeEnd));
  });
  document.getElementById('btnResetRange').addEventListener('click', ()=>{
    rangeStart = 0;
    rangeEnd = null;
    syncRangeInputs();
    renderTimeline();
    toast('Range reset to the whole transcript');
  });
  rangeStartInput.addEventListener('change', e=>{
    const val = parseFlexible(e.target.value);
    if(val === null){ toast('Could not read that timestamp'); syncRangeInputs(); return; }
    rangeStart = Math.max(0, Math.min(val, effectiveRangeEnd()));
    syncRangeInputs();
    renderTimeline();
  });
  rangeEndInput.addEventListener('change', e=>{
    const raw = e.target.value.trim().toLowerCase();
    if(raw === 'end' || raw === ''){ rangeEnd = null; }
    else {
      const val = parseFlexible(e.target.value);
      if(val === null){ toast('Could not read that timestamp'); syncRangeInputs(); return; }
      rangeEnd = Math.max(rangeStart, Math.min(val, getDuration()));
    }
    syncRangeInputs();
    renderTimeline();
  });
  document.getElementById('btnApplyOffset').addEventListener('click', ()=>{
    const offset = parseFloat(document.getElementById('offsetAmount').value);
    if(isNaN(offset) || offset === 0){ toast('Enter a non-zero offset in seconds'); return; }
    const rEnd = effectiveRangeEnd();
    let count = 0;
    cues.forEach(c=>{
      if(c.start >= rangeStart - 1e-6 && c.start <= rEnd + 1e-6){
        let newStart = c.start + offset;
        let newEnd = c.end + offset;
        if(newStart < 0){ const shift = -newStart; newStart = 0; newEnd += shift; }
        c.start = newStart;
        c.end = Math.max(newEnd, newStart + 0.05);
        count++;
      }
    });
    if(count === 0){ toast('No cues fall inside that range'); return; }
    renderAll();
    toast('Shifted ' + count + ' cue' + (count===1?'':'s') + ' by ' + (offset>0?'+':'') + offset.toFixed(3) + 's');
  });

  document.getElementById('btnExportVtt').addEventListener('click', ()=>{
    const base = sourceFileName.replace(/\.[^.]+$/, '');
    downloadFile(serializeVTT(), base + '.vtt', 'text/vtt');
  });
  document.getElementById('btnExportSrt').addEventListener('click', ()=>{
    const base = sourceFileName.replace(/\.[^.]+$/, '');
    downloadFile(serializeSRT(), base + '.srt', 'application/x-subrip');
  });

  document.getElementById('btnLoadVideo').addEventListener('click', ()=> document.getElementById('fileVideo').click());
  document.getElementById('fileVideo').addEventListener('change', e=>{
    const file = e.target.files[0];
    if(!file) return;
    if(virtualPlaying){ virtualPlaying = false; if(virtualRAF) cancelAnimationFrame(virtualRAF); }
    const url = URL.createObjectURL(file);
    video.src = url;
    hasVideo = true;
    emptyStage.style.display = 'none';
    videoNameEl.textContent = file.name;
    video.playbackRate = parseFloat(speedSelect.value);
    video.load();
    updatePlayIcon();
    toast('Video loaded');
  });

  document.getElementById('btnLoadVtt').addEventListener('click', ()=> document.getElementById('fileVtt').click());
  const formatBadge = document.getElementById('formatBadge');
  document.getElementById('fileVtt').addEventListener('change', e=>{
    const file = e.target.files[0];
    if(!file) return;
    sourceFileName = file.name;
    const reader = new FileReader();
    reader.onload = ()=>{
      const format = detectFormat(reader.result, file.name);
      const parsed = format === 'srt' ? parseSRT(reader.result) : parseVTT(reader.result);
      cues = parsed;
      renderAll();
      formatBadge.textContent = format.toUpperCase();
      formatBadge.style.display = 'inline';
      toast(parsed.length + ' cues loaded from ' + format.toUpperCase());
    };
    reader.readAsText(file);
  });

  // ---------- playback controls ----------
  function updatePlayIcon(){
    const playing = hasVideo ? !video.paused && !video.ended : virtualPlaying;
    playBtn.textContent = playing ? '⏸' : '▶';
  }

  function stepVirtual(now){
    if(!virtualPlaying) return;
    const dt = (now - virtualLastFrame) / 1000;
    virtualLastFrame = now;
    virtualTime = Math.min(getDuration(), virtualTime + dt * virtualRate);
    updatePlayback();
    if(virtualTime >= getDuration()){
      virtualPlaying = false;
      updatePlayIcon();
      return;
    }
    virtualRAF = requestAnimationFrame(stepVirtual);
  }

  function togglePlay(){
    if(hasVideo){
      if(video.paused){ video.play(); } else { video.pause(); }
    } else {
      virtualPlaying = !virtualPlaying;
      if(virtualPlaying){
        if(virtualTime >= getDuration()) virtualTime = 0;
        virtualLastFrame = performance.now();
        virtualRAF = requestAnimationFrame(stepVirtual);
      } else if(virtualRAF){
        cancelAnimationFrame(virtualRAF);
      }
      updatePlayIcon();
    }
  }

  function jumpToCue(dir){
    const t = getCurrentTime();
    const sorted = [...cues].sort((a,b)=>a.start-b.start);
    if(dir > 0){
      const nxt = sorted.find(c => c.start > t + 0.05);
      if(nxt) setCurrentTime(nxt.start);
    } else {
      const prevs = sorted.filter(c => c.start < t - 0.05);
      if(prevs.length) setCurrentTime(prevs[prevs.length-1].start);
    }
  }

  playBtn.addEventListener('click', togglePlay);
  prevCueBtn.addEventListener('click', ()=> jumpToCue(-1));
  nextCueBtn.addEventListener('click', ()=> jumpToCue(1));

  seekBar.addEventListener('mousedown', ()=> isScrubbing = true);
  seekBar.addEventListener('touchstart', ()=> isScrubbing = true, {passive:true});
  seekBar.addEventListener('input', e=>{
    setCurrentTime((e.target.value/1000) * getDuration());
  });
  ['mouseup','touchend','change'].forEach(evt=>{
    seekBar.addEventListener(evt, ()=> isScrubbing = false);
  });

  muteBtn.addEventListener('click', ()=>{
    if(hasVideo){
      video.muted = !video.muted;
    }
    muteBtn.textContent = (hasVideo ? video.muted : volumeBar.value == 0) ? '🔇' : '🔊';
  });
  volumeBar.addEventListener('input', e=>{
    const v = e.target.value / 100;
    if(hasVideo){ video.volume = v; video.muted = false; }
    muteBtn.textContent = v == 0 ? '🔇' : '🔊';
  });

  speedSelect.addEventListener('change', e=>{
    const rate = parseFloat(e.target.value);
    virtualRate = rate;
    if(hasVideo) video.playbackRate = rate;
  });

  window.addEventListener('keydown', e=>{
    if(e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if(e.code === 'Space'){ e.preventDefault(); togglePlay(); }
  });

  // ---------- video events ----------
  video.addEventListener('timeupdate', updatePlayback);
  video.addEventListener('loadedmetadata', ()=>{ renderTimeline(); updatePlayback(); });
  video.addEventListener('play', updatePlayIcon);
  video.addEventListener('pause', updatePlayIcon);
  video.addEventListener('ended', updatePlayIcon);
  video.addEventListener('volumechange', ()=>{
    muteBtn.textContent = video.muted || video.volume === 0 ? '🔇' : '🔊';
  });

  window.addEventListener('resize', renderTimeline);

  // ---------- transcript comparison ----------
  const compareOverlay = document.getElementById('compareOverlay');
  const compareBody = document.getElementById('compareBody');
  const compareAName = document.getElementById('compareAName');
  const compareBName = document.getElementById('compareBName');
  const statEqual = document.getElementById('statEqual');
  const statChanged = document.getElementById('statChanged');
  const statAdded = document.getElementById('statAdded');
  const statRemoved = document.getElementById('statRemoved');
  const btnUseB = document.getElementById('btnUseB');
  const MAX_SENTENCES = 2000; // safety cap so the alignment DP stays fast in-browser

  let comparisonB = null; // { filename, rawCues, sentences }

  function tokenize(str){
    return (str||'').toLowerCase()
      .replace(/[^\p{L}\p{N}\s']/gu, '')
      .split(/\s+/)
      .filter(Boolean);
  }

  // Splits a cue list into sentence-ish units (independent of original cue
  // boundaries) so two transcripts segmented differently can still be compared.
  function buildSentences(cuesArr){
    const sentences = [];
    [...cuesArr].sort((a,b)=>a.start-b.start).forEach(cue=>{
      const clean = (cue.text||'').replace(/\n+/g,' ').trim();
      if(!clean) return;
      const parts = clean.match(/[^.!?]+[.!?]*/g) || [clean];
      parts.forEach(p=>{
        const text = p.trim();
        if(text) sentences.push({ text, start: cue.start, tokens: tokenize(text) });
      });
    });
    return sentences.length ? sentences.slice(0, MAX_SENTENCES) : sentences;
  }

  // Bag-of-words Dice coefficient — cheap O(n) similarity used to decide which
  // sentences in A and B correspond to each other.
  function bagSimilarity(tokensA, tokensB){
    if(!tokensA.length && !tokensB.length) return 1;
    if(!tokensA.length || !tokensB.length) return 0;
    const bag = new Map();
    tokensA.forEach(t => bag.set(t, (bag.get(t)||0)+1));
    let common = 0;
    tokensB.forEach(t=>{
      const c = bag.get(t);
      if(c){ common++; bag.set(t, c-1); }
    });
    return (2*common) / (tokensA.length + tokensB.length);
  }

  // Needleman-Wunsch style global alignment over the two sentence arrays.
  // Diagonal = matched pair (equal or changed), up = sentence only in A,
  // left = sentence only in B. This assumes overall reading order is preserved
  // between the two transcripts, which holds for AI vs human takes on the same recording.
  function alignSentences(A, B){
    const n = A.length, m = B.length;
    const GAP = 0.6;
    const w = m+1;
    const dp = new Float64Array((n+1)*w);
    const bp = new Uint8Array((n+1)*w); // 0=diag 1=up 2=left
    for(let i=1;i<=n;i++){ dp[i*w] = i*GAP; bp[i*w] = 1; }
    for(let j=1;j<=m;j++){ dp[j] = j*GAP; bp[j] = 2; }
    for(let i=1;i<=n;i++){
      for(let j=1;j<=m;j++){
        const sim = bagSimilarity(A[i-1].tokens, B[j-1].tokens);
        const costMatch = sim < 0.15 ? Infinity : (1-sim);
        const dDiag = dp[(i-1)*w+(j-1)] + costMatch;
        const dUp = dp[(i-1)*w+j] + GAP;
        const dLeft = dp[i*w+(j-1)] + GAP;
        let best = dDiag, dir = 0;
        if(dUp < best){ best = dUp; dir = 1; }
        if(dLeft < best){ best = dLeft; dir = 2; }
        dp[i*w+j] = best;
        bp[i*w+j] = dir;
      }
    }
    const ops = [];
    let i=n, j=m;
    while(i>0 || j>0){
      const dir = (i>0 && j>0) ? bp[i*w+j] : (i>0 ? 1 : 2);
      if(dir === 0){
        const sim = bagSimilarity(A[i-1].tokens, B[j-1].tokens);
        ops.push({ type: sim > 0.95 ? 'equal' : 'changed', a:A[i-1], b:B[j-1] });
        i--; j--;
      } else if(dir === 1){
        ops.push({ type:'removed', a:A[i-1], b:null });
        i--;
      } else {
        ops.push({ type:'added', a:null, b:B[j-1] });
        j--;
      }
    }
    ops.reverse();
    return ops;
  }

  // Word-level LCS diff for a matched (but not identical) sentence pair.
  function wordDiffOps(aWords, bWords){
    const norm = w => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    const na = aWords.length, nb = bWords.length;
    const dp = Array.from({length: na+1}, ()=> new Array(nb+1).fill(0));
    for(let i=1;i<=na;i++){
      for(let j=1;j<=nb;j++){
        dp[i][j] = norm(aWords[i-1]) === norm(bWords[j-1]) ? dp[i-1][j-1]+1 : Math.max(dp[i-1][j], dp[i][j-1]);
      }
    }
    const ops = [];
    let i=na, j=nb;
    while(i>0 || j>0){
      if(i>0 && j>0 && norm(aWords[i-1]) === norm(bWords[j-1])){
        ops.push({ type:'equal', word:aWords[i-1] }); i--; j--;
      } else if(j>0 && (i===0 || dp[i][j-1] >= dp[i-1][j])){
        ops.push({ type:'add', word:bWords[j-1] }); j--;
      } else {
        ops.push({ type:'del', word:aWords[i-1] }); i--;
      }
    }
    ops.reverse();
    return ops;
  }

  function renderComparison(ops){
    const counts = { equal:0, changed:0, added:0, removed:0 };
    let html = '';
    ops.forEach(op=>{
      counts[op.type]++;
      if(op.type === 'equal'){
        html += `<div class="compare-row equal">
          <div class="compare-col clickable" data-time="${op.a.start}">${escapeHtml(op.a.text)}</div>
          <div class="compare-col">${escapeHtml(op.b.text)}</div>
        </div>`;
      } else if(op.type === 'changed'){
        const wordsA = op.a.text.split(/\s+/).filter(Boolean);
        const wordsB = op.b.text.split(/\s+/).filter(Boolean);
        const diff = wordDiffOps(wordsA, wordsB);
        const colA = diff.filter(o=>o.type!=='add').map(o=> o.type==='del' ? `<span class="w-del">${escapeHtml(o.word)}</span>` : escapeHtml(o.word)).join(' ');
        const colB = diff.filter(o=>o.type!=='del').map(o=> o.type==='add' ? `<span class="w-add">${escapeHtml(o.word)}</span>` : escapeHtml(o.word)).join(' ');
        html += `<div class="compare-row changed">
          <div class="compare-col clickable" data-time="${op.a.start}"><span class="compare-time">${fmtShort(op.a.start)}</span>${colA}</div>
          <div class="compare-col"><span class="compare-time">${fmtShort(op.b.start)}</span>${colB}</div>
        </div>`;
      } else if(op.type === 'removed'){
        html += `<div class="compare-row removed">
          <div class="compare-col clickable" data-time="${op.a.start}"><span class="compare-time">${fmtShort(op.a.start)}</span>${escapeHtml(op.a.text)}</div>
          <div class="compare-col empty-side">— not present —</div>
        </div>`;
      } else {
        html += `<div class="compare-row added">
          <div class="compare-col empty-side">— not present —</div>
          <div class="compare-col"><span class="compare-time">${fmtShort(op.b.start)}</span>${escapeHtml(op.b.text)}</div>
        </div>`;
      }
    });
    compareBody.innerHTML = html || '<div class="compare-empty">Nothing to compare yet.</div>';
    statEqual.textContent = counts.equal;
    statChanged.textContent = counts.changed;
    statAdded.textContent = counts.added;
    statRemoved.textContent = counts.removed;
  }

  function runComparison(){
    compareAName.textContent = cues.length ? (sourceFileName + ' · ' + cues.length + ' cues') : 'no cues yet';
    if(!comparisonB){
      compareBody.innerHTML = '<div class="compare-empty">Load a second transcript (.vtt or .srt) to compare it, sentence by sentence, against what\'s currently in the editor.</div>';
      statEqual.textContent = statChanged.textContent = statAdded.textContent = statRemoved.textContent = '0';
      return;
    }
    const sentencesA = buildSentences(cues);
    const sentencesB = comparisonB.sentences;
    if(!sentencesA.length || !sentencesB.length){
      compareBody.innerHTML = '<div class="compare-empty">One of the transcripts has no readable text to compare.</div>';
      return;
    }
    const ops = alignSentences(sentencesA, sentencesB);
    renderComparison(ops);
  }

  document.getElementById('btnCompare').addEventListener('click', ()=>{
    compareOverlay.classList.add('show');
    runComparison();
  });
  document.getElementById('closeCompare').addEventListener('click', ()=> compareOverlay.classList.remove('show'));
  compareOverlay.addEventListener('click', e=>{ if(e.target === compareOverlay) compareOverlay.classList.remove('show'); });
  window.addEventListener('keydown', e=>{ if(e.key === 'Escape') compareOverlay.classList.remove('show'); });

  document.getElementById('btnLoadCompare').addEventListener('click', ()=> document.getElementById('fileCompare').click());
  document.getElementById('fileCompare').addEventListener('change', e=>{
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = ()=>{
      const format = detectFormat(reader.result, file.name);
      const rawCues = format === 'srt' ? parseSRT(reader.result) : parseVTT(reader.result);
      const sentences = buildSentences(rawCues);
      comparisonB = { filename: file.name, rawCues, sentences };
      compareBName.textContent = file.name + ' · ' + rawCues.length + ' cues';
      btnUseB.style.display = 'inline-flex';
      if(sentences.length >= MAX_SENTENCES){
        toast('Transcript B is long — comparing the first ' + MAX_SENTENCES + ' sentences');
      }
      runComparison();
    };
    reader.readAsText(file);
  });

  btnUseB.addEventListener('click', ()=>{
    if(!comparisonB) return;
    cues = comparisonB.rawCues.map(c => ({ id: nextId++, start: c.start, end: c.end, text: c.text }));
    sourceFileName = comparisonB.filename;
    renderAll();
    compareOverlay.classList.remove('show');
    toast('Switched working transcript to ' + comparisonB.filename);
  });

  compareBody.addEventListener('click', e=>{
    const col = e.target.closest('.compare-col.clickable');
    if(!col) return;
    const t = parseFloat(col.dataset.time);
    if(!isNaN(t)){
      compareOverlay.classList.remove('show');
      setCurrentTime(t);
    }
  });

  // seed with a short example cue so the UI isn't empty on first load
  cues = [
    { id: nextId++, start: 0.5, end: 2.8, text: 'Load a video and a .vtt file to begin —' },
    { id: nextId++, start: 3.0, end: 5.6, text: 'or start typing cues right here.' }
  ];
  renderAll();
  syncRangeInputs();
})();
