/* =========================================================================
   CandidLens — client-side AI mock interview coach
   No backend. PDF parsing (pdf.js), face analysis (MediaPipe Face Mesh),
   speech-to-text (Web Speech API), and rule-based / optional-LLM scoring.
   ========================================================================= */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.js";

/* ---------------------------------------------------------------------
   STATE
--------------------------------------------------------------------- */
const state = {
  resumeText: "",
  skills: [],
  questions: [],      // [{ text, keywords }]
  currentQ: 0,
  answers: [],         // per-question results
  apiKey: localStorage.getItem("candidlens_key") || "",

  // live interview trackers
  recognizing: false,
  transcriptFinal: "",
  transcriptInterim: "",
  answerStartTime: null,
  lastSpeechTime: null,
  pauseCount: 0,
  silenceMs: 0,
  fillerCount: 0,

  // vision trackers (reset per question)
  frameCount: 0,
  eyeContactFrames: 0,
  smileFrames: 0,
  liveEyeContact: false,
  liveSmile: false,
};

const FILLERS = ["um", "uh", "umm", "uhh", "erm", "you know", "i mean", "like", "actually", "basically"];

const SKILL_DICTIONARY = [
  "Python","JavaScript","TypeScript","Java","C++","C#","Go","Rust","SQL","R",
  "React","Vue","Angular","Node.js","Express","Django","Flask","FastAPI","Spring",
  "TensorFlow","PyTorch","Keras","Scikit-learn","Pandas","NumPy","OpenCV",
  "RAG","LLM","GPT","Transformer","BERT","LangChain","LlamaIndex","Hugging Face",
  "ChromaDB","Pinecone","Qdrant","Weaviate","FAISS","Vector Database","Embeddings",
  "Docker","Kubernetes","AWS","Azure","GCP","Terraform","CI/CD","Jenkins",
  "MongoDB","PostgreSQL","MySQL","Redis","Kafka","Spark","Airflow","ETL",
  "REST API","GraphQL","Microservices","WebSocket","gRPC",
  "MediaPipe","Computer Vision","NLP","Deep Learning","Machine Learning",
  "Data Science","A/B Testing","Statistics","Tableau","Power BI",
  "Git","GitHub","Agile","Scrum","Unit Testing","System Design"
];

const GENERIC_QUESTIONS = [
  { text: "Tell me about yourself and what draws you to this kind of role.", keywords: [] },
  { text: "Describe a time you disagreed with a teammate's technical decision. What did you do?", keywords: ["listened","compromise","discussed","data","team"] },
  { text: "What's a project you're most proud of, and what was your specific contribution?", keywords: ["built","designed","implemented","led","owned"] },
  { text: "How do you approach debugging a problem you've never seen before?", keywords: ["logs","reproduce","isolate","hypothesis","test"] },
  { text: "Where do you want to be in your career three years from now?", keywords: [] },
];

/* ---------------------------------------------------------------------
   VIEW NAVIGATION
--------------------------------------------------------------------- */
function goToView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("is-active"));
  document.getElementById(`view-${name}`).classList.add("is-active");
  document.querySelectorAll(".rail-step").forEach(s => {
    s.classList.toggle("is-active", s.dataset.view === name);
  });
}

/* ---------------------------------------------------------------------
   RESUME UPLOAD + PARSING
--------------------------------------------------------------------- */
const dropzone = document.getElementById("dropzone");
const resumeInput = document.getElementById("resume-input");

document.getElementById("browse-btn").addEventListener("click", () => resumeInput.click());
dropzone.addEventListener("click", (e) => { if (e.target.id !== "browse-btn") resumeInput.click(); });
resumeInput.addEventListener("change", (e) => e.target.files[0] && handleResumeFile(e.target.files[0]));

["dragenter","dragover"].forEach(evt =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add("is-drag"); }));
["dragleave","drop"].forEach(evt =>
  dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove("is-drag"); }));
dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file && file.type === "application/pdf") handleResumeFile(file);
});

async function handleResumeFile(file) {
  document.getElementById("dz-filename").textContent = file.name;
  document.getElementById("parse-status").hidden = false;

  try {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(it => it.str).join(" ") + "\n";
    }
    state.resumeText = text;
    await buildInterviewFromResume(text);
  } catch (err) {
    console.error(err);
    document.getElementById("parse-status").hidden = true;
    alert("Couldn't read that PDF. Try a different export (avoid scanned/image-only PDFs).");
  }
}

async function buildInterviewFromResume(text) {
  state.skills = extractSkills(text);

  if (state.apiKey) {
    try {
      state.questions = await generateQuestionsWithLLM(text, state.skills);
    } catch (err) {
      console.warn("LLM question generation failed, falling back to local generation.", err);
      state.questions = generateQuestionsLocally(text, state.skills);
    }
  } else {
    state.questions = generateQuestionsLocally(text, state.skills);
  }

  document.getElementById("parse-status").hidden = true;
  renderExtracted();
}

function extractSkills(text) {
  const found = new Set();
  const lower = text.toLowerCase();
  SKILL_DICTIONARY.forEach(skill => {
    if (lower.includes(skill.toLowerCase())) found.add(skill);
  });
  return [...found];
}

/* Pull short bullet-like lines that mention a known skill, to ground follow-up questions */
function findSkillContextLines(text, skill) {
  const lines = text.split(/\n|(?<=[.])\s+/).map(l => l.trim()).filter(Boolean);
  return lines.filter(l => l.toLowerCase().includes(skill.toLowerCase()) && l.length > 25 && l.length < 220);
}

function generateQuestionsLocally(text, skills) {
  const questions = [];
  const usedSkills = skills.slice(0, 5); // cap so the interview stays a reasonable length

  usedSkills.forEach(skill => {
    const contextLines = findSkillContextLines(text, skill);
    const context = contextLines[0];
    const q = context
      ? `I see you worked with ${skill} — you mentioned "${truncate(context, 110)}". Walk me through the technical decisions behind that and any trade-offs you hit.`
      : `Your resume mentions ${skill}. Tell me about a specific project where you used it, and one thing that was harder than expected.`;
    questions.push({ text: q, keywords: [skill.toLowerCase(), "because","challenge","result","learned"] });
  });

  // Fill remaining slots with generic behavioral questions
  const remaining = GENERIC_QUESTIONS.slice(0, Math.max(2, 6 - questions.length));
  return [...questions, ...remaining].slice(0, 6);
}

function truncate(s, n) { return s.length > n ? s.slice(0, n).trim() + "…" : s; }

/* ---------------------------------------------------------------------
   OPTIONAL: LLM-POWERED QUESTIONS (only if user pastes an API key)
--------------------------------------------------------------------- */
async function callOpenAI(messages, jsonMode = false) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${state.apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.6,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {})
    })
  });
  if (!res.ok) throw new Error(`OpenAI request failed: ${res.status}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

async function generateQuestionsWithLLM(resumeText, skills) {
  const prompt = `You are a technical interviewer. Given this resume text, write 6 interview questions
specific to the candidate's actual projects and skills (not generic). For each question also give 4-6
short keywords that a strong answer would likely include (for scoring). Resume:
"""${resumeText.slice(0, 6000)}"""
Respond ONLY with JSON: {"questions":[{"text":"...","keywords":["...","..."]}]}`;
  const content = await callOpenAI([{ role: "user", content: prompt }], true);
  const parsed = JSON.parse(content);
  return parsed.questions.slice(0, 6);
}

async function getLLMFeedback(question, transcript) {
  const prompt = `Interview question: "${question}"
Candidate's spoken answer (transcribed): "${transcript}"
In 2 short sentences, give direct, specific, encouraging-but-honest feedback on the content of this answer.`;
  return callOpenAI([{ role: "user", content: prompt }]);
}

/* ---------------------------------------------------------------------
   RENDER: extracted skills + editable question list
--------------------------------------------------------------------- */
function renderExtracted() {
  const card = document.getElementById("extracted-card");
  card.hidden = false;

  const chipRow = document.getElementById("skill-chips");
  chipRow.innerHTML = state.skills.length
    ? state.skills.map(s => `<span class="chip">${escapeHtml(s)}</span>`).join("")
    : `<span class="chip">No known tech keywords detected — using general questions</span>`;

  renderQuestionList();
  document.getElementById("to-interview-btn").disabled = false;
}

function renderQuestionList() {
  const list = document.getElementById("question-list");
  list.innerHTML = "";
  state.questions.forEach((q, i) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <textarea data-idx="${i}">${escapeHtml(q.text)}</textarea>
      <div class="q-tools"><button class="q-remove" data-idx="${i}">remove</button></div>`;
    list.appendChild(li);
  });
  list.querySelectorAll("textarea").forEach(t =>
    t.addEventListener("input", (e) => state.questions[e.target.dataset.idx].text = e.target.value));
  list.querySelectorAll(".q-remove").forEach(b =>
    b.addEventListener("click", (e) => {
      state.questions.splice(e.target.dataset.idx, 1);
      renderQuestionList();
    }));
}

document.getElementById("add-question-btn").addEventListener("click", () => {
  state.questions.push({ text: "New question — edit me", keywords: [] });
  renderQuestionList();
});

/* ---------------------------------------------------------------------
   API KEY (optional)
--------------------------------------------------------------------- */
const keyInput = document.getElementById("api-key-input");
keyInput.value = state.apiKey;
document.getElementById("save-key-btn").addEventListener("click", () => {
  state.apiKey = keyInput.value.trim();
  localStorage.setItem("candidlens_key", state.apiKey);
  document.getElementById("key-status").textContent = state.apiKey
    ? "Key saved for this browser. New question generation will use it."
    : "Key cleared — using local keyword-based generation.";
});

/* ---------------------------------------------------------------------
   START INTERVIEW
--------------------------------------------------------------------- */
document.getElementById("to-interview-btn").addEventListener("click", async () => {
  if (!state.questions.length) return;
  document.querySelectorAll('.rail-step[data-view="interview"], .rail-step[data-view="report"]')
    .forEach(s => s.disabled = false);
  goToView("interview");
  await initWebcamAndVision();
  initSpeechRecognition();
  state.currentQ = 0;
  loadQuestion(0);
});

/* ---------------------------------------------------------------------
   WEBCAM + FACE MESH (vision pillar)
--------------------------------------------------------------------- */
let camera, faceMesh;
const videoEl = document.getElementById("webcam");
const overlay = document.getElementById("overlay");
const octx = overlay.getContext("2d");

async function initWebcamAndVision() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    videoEl.srcObject = stream;
  } catch (err) {
    alert("Camera access is required for the vision analysis. You can still continue with audio-only scoring.");
    return;
  }

  faceMesh = new FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
  });
  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
  });
  faceMesh.onResults(onFaceResults);

  camera = new Camera(videoEl, {
    onFrame: async () => { await faceMesh.send({ image: videoEl }); },
    width: 640,
    height: 480
  });
  camera.start();
}

function onFaceResults(results) {
  overlay.width = videoEl.videoWidth || 640;
  overlay.height = videoEl.videoHeight || 480;
  octx.clearRect(0, 0, overlay.width, overlay.height);

  if (!results.multiFaceLandmarks || !results.multiFaceLandmarks.length) {
    state.liveEyeContact = false;
    state.liveSmile = false;
    return;
  }
  const lm = results.multiFaceLandmarks[0];

  // --- Head yaw / gaze proxy: nose tip vs. face-width midpoint ---
  const leftCheek = lm[234], rightCheek = lm[454], nose = lm[1];
  const faceWidth = Math.abs(rightCheek.x - leftCheek.x) || 0.001;
  const mid = (leftCheek.x + rightCheek.x) / 2;
  const yawRatio = (nose.x - mid) / faceWidth; // ~0 = facing camera
  const lookingAtCamera = Math.abs(yawRatio) < 0.12;

  // --- Smile proxy: mouth corners raised relative to mouth center ---
  const leftCorner = lm[61], rightCorner = lm[291], upperLip = lm[13], lowerLip = lm[14];
  const mouthCenterY = (upperLip.y + lowerLip.y) / 2;
  const cornerY = (leftCorner.y + rightCorner.y) / 2;
  const mouthWidth = Math.abs(rightCorner.x - leftCorner.x) || 0.001;
  const smileRatio = (mouthCenterY - cornerY) / mouthWidth; // positive = corners raised = smiling
  const smiling = smileRatio > 0.02;

  state.liveEyeContact = lookingAtCamera;
  state.liveSmile = smiling;

  if (state.recognizing) {
    state.frameCount++;
    if (lookingAtCamera) state.eyeContactFrames++;
    if (smiling) state.smileFrames++;
  }

  drawFaceDot(lm, lookingAtCamera);
  updateLiveDial();
}

function drawFaceDot(lm, ok) {
  const p = lm[1];
  octx.beginPath();
  octx.arc(p.x * overlay.width, p.y * overlay.height, 6, 0, Math.PI * 2);
  octx.fillStyle = ok ? "#5F8768" : "#B24E3C";
  octx.fill();
}

/* ---------------------------------------------------------------------
   SPEECH RECOGNITION (audio + data-science pillar)
--------------------------------------------------------------------- */
let recognition;
function initSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    alert("This browser doesn't support live speech recognition. Try Chrome or Edge for the full experience.");
    return;
  }
  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = "en-US";

  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) state.transcriptFinal += t + " ";
      else interim += t;
    }
    state.transcriptInterim = interim;
    state.lastSpeechTime = Date.now();
    countFillers(state.transcriptFinal + " " + interim);
    renderTranscript();
  };
  recognition.onerror = (e) => console.warn("Speech recognition error:", e.error);
  recognition.onend = () => { if (state.recognizing) recognition.start(); }; // auto-restart while active
}

function countFillers(text) {
  const lower = text.toLowerCase();
  let count = 0;
  FILLERS.forEach(f => {
    const re = new RegExp(`\\b${f.replace(" ", "\\s+")}\\b`, "g");
    const m = lower.match(re);
    if (m) count += m.length;
  });
  state.fillerCount = count;
}

function renderTranscript() {
  const el = document.getElementById("transcript");
  el.innerHTML = escapeHtml(state.transcriptFinal) +
    `<span style="color:#8a94a0">${escapeHtml(state.transcriptInterim)}</span>`;
  el.scrollTop = el.scrollHeight;
  updateLiveMetrics();
}

/* ---------------------------------------------------------------------
   LIVE METRICS + DIAL
--------------------------------------------------------------------- */
let metricsTimer;
function updateLiveMetrics() {
  const words = wordCount(state.transcriptFinal + " " + state.transcriptInterim);
  const elapsedMin = state.answerStartTime ? (Date.now() - state.answerStartTime) / 60000 : 0;
  const wpm = elapsedMin > 0.05 ? Math.round(words / elapsedMin) : 0;

  document.getElementById("m-wpm").textContent = wpm || "--";
  document.getElementById("m-filler").textContent = state.fillerCount;
  const eyePct = state.frameCount ? Math.round((state.eyeContactFrames / state.frameCount) * 100) : 0;
  document.getElementById("m-eye").textContent = state.recognizing ? `${eyePct}%` : "--";
}

function updateLiveDial() {
  if (!state.recognizing) return;
  const eyePct = state.frameCount ? (state.eyeContactFrames / state.frameCount) * 100 : 50;
  const smilePct = state.frameCount ? (state.smileFrames / state.frameCount) * 100 : 50;
  const fillerPenalty = Math.min(40, state.fillerCount * 6);
  const score = Math.max(0, Math.min(100, 0.5 * eyePct + 0.3 * smilePct + 0.2 * 100 - fillerPenalty));
  setDial(score);
}

function setDial(score) {
  const circumference = 283;
  const offset = circumference - (circumference * score) / 100;
  document.getElementById("dial-fill").style.strokeDashoffset = offset;
  document.getElementById("dial-fill").style.stroke =
    score >= 70 ? "#5F8768" : score >= 45 ? "#B8905A" : "#B24E3C";
  document.getElementById("dial-num").textContent = Math.round(score);
}

function wordCount(s) { return (s.trim().match(/\S+/g) || []).length; }

/* ---------------------------------------------------------------------
   INTERVIEW FLOW
--------------------------------------------------------------------- */
function loadQuestion(i) {
  const q = state.questions[i];
  document.getElementById("q-counter").textContent = `Question ${i + 1} of ${state.questions.length}`;
  document.getElementById("q-text").textContent = q.text;
  resetPerQuestionState();
  renderTranscript();
  document.getElementById("record-btn").textContent = "Start answer";
  document.getElementById("live-dot").classList.remove("is-live");
  document.getElementById("rec-badge").textContent = "● not recording";
}

function resetPerQuestionState() {
  state.transcriptFinal = "";
  state.transcriptInterim = "";
  state.fillerCount = 0;
  state.frameCount = 0;
  state.eyeContactFrames = 0;
  state.smileFrames = 0;
  state.answerStartTime = null;
  setDial(0);
  document.getElementById("m-wpm").textContent = "--";
  document.getElementById("m-filler").textContent = "--";
  document.getElementById("m-eye").textContent = "--";
}

document.getElementById("record-btn").addEventListener("click", () => {
  if (!state.recognizing) startAnswer(); else finishAnswer();
});

function startAnswer() {
  state.recognizing = true;
  state.answerStartTime = Date.now();
  document.getElementById("record-btn").textContent = "Finish answer";
  document.getElementById("live-dot").classList.add("is-live");
  document.getElementById("rec-badge").textContent = "● recording";
  metricsTimer = setInterval(updateLiveMetrics, 1000);
  try { recognition && recognition.start(); } catch (e) {}
}

function finishAnswer() {
  state.recognizing = false;
  clearInterval(metricsTimer);
  try { recognition && recognition.stop(); } catch (e) {}
  document.getElementById("rec-badge").textContent = "● not recording";
  recordAnswerResult();
  advanceQuestion();
}

document.getElementById("skip-btn").addEventListener("click", () => {
  if (state.recognizing) finishAnswer(); else { recordAnswerResult(true); advanceQuestion(); }
});

async function recordAnswerResult(skipped = false) {
  const q = state.questions[state.currentQ];
  const transcript = state.transcriptFinal.trim();
  const words = wordCount(transcript);
  const elapsedMin = state.answerStartTime ? Math.max(0.05, (Date.now() - state.answerStartTime) / 60000) : 0.05;
  const wpm = Math.round(words / elapsedMin);
  const eyePct = state.frameCount ? Math.round((state.eyeContactFrames / state.frameCount) * 100) : 0;
  const smilePct = state.frameCount ? Math.round((state.smileFrames / state.frameCount) * 100) : 0;

  const contentScore = skipped ? 0 : scoreContent(transcript, q.keywords);
  const paceScore = skipped ? 0 : scorePace(wpm, words);
  const fillerScore = skipped ? 0 : scoreFillers(state.fillerCount, words);
  const deliveryScore = Math.round((paceScore + fillerScore + eyePct + smilePct) / 4);
  const overall = skipped ? 0 : Math.round(0.55 * contentScore + 0.45 * deliveryScore);

  state.answers[state.currentQ] = {
    question: q.text, transcript, skipped, words, wpm,
    fillerCount: state.fillerCount, eyePct, smilePct,
    contentScore, paceScore, fillerScore, deliveryScore, overall,
    llmFeedback: null
  };

  if (state.apiKey && !skipped && transcript.length > 0) {
    try { state.answers[state.currentQ].llmFeedback = await getLLMFeedback(q.text, transcript); }
    catch (e) { console.warn("LLM feedback failed", e); }
  }
}

function scoreContent(transcript, keywords) {
  const words = wordCount(transcript);
  const base = Math.min(40, words / 3);
  if (!keywords || !keywords.length) return Math.round(Math.min(100, base + (words > 20 ? 40 : words * 2)));
  const lower = transcript.toLowerCase();
  const matched = keywords.filter(k => lower.includes(k.toLowerCase())).length;
  const ratio = matched / keywords.length;
  return Math.round(Math.min(100, base + ratio * 60));
}

function scorePace(wpm, words) {
  if (words < 5) return 0;
  if (wpm >= 110 && wpm <= 165) return 100;
  const dist = wpm < 110 ? 110 - wpm : wpm - 165;
  return Math.max(0, 100 - dist * 1.2);
}

function scoreFillers(count, words) {
  if (words < 5) return 0;
  const rate = (count / words) * 100;
  return Math.max(0, Math.round(100 - rate * 8));
}

function advanceQuestion() {
  state.currentQ++;
  if (state.currentQ < state.questions.length) {
    loadQuestion(state.currentQ);
  } else {
    if (camera) camera.stop();
    buildReport();
    goToView("report");
  }
}

/* ---------------------------------------------------------------------
   REPORT
--------------------------------------------------------------------- */
let radarChart;
function buildReport() {
  const valid = state.answers.filter(a => a && !a.skipped);
  const overall = valid.length
    ? Math.round(valid.reduce((s, a) => s + a.overall, 0) / valid.length) : 0;

  document.getElementById("overall-score").textContent = overall;
  document.getElementById("overall-tag").textContent =
    overall >= 80 ? "Strong performance" :
    overall >= 60 ? "Solid, with room to sharpen" :
    overall >= 35 ? "Needs focused practice" : "Let's build from the fundamentals";

  const avg = (key) => valid.length ? Math.round(valid.reduce((s, a) => s + a[key], 0) / valid.length) : 0;
  const radarData = {
    labels: ["Content accuracy", "Eye contact", "Speech pace", "Low filler rate", "Expression"],
    datasets: [{
      label: "Your score",
      data: [avg("contentScore"), avg("eyePct"), avg("paceScore"), avg("fillerScore"), avg("smilePct")],
      backgroundColor: "rgba(184,144,90,0.25)",
      borderColor: "#B8905A",
      pointBackgroundColor: "#2E4A66"
    }]
  };

  if (radarChart) radarChart.destroy();
  radarChart = new Chart(document.getElementById("radar-chart"), {
    type: "radar",
    data: radarData,
    options: {
      scales: { r: { min: 0, max: 100, ticks: { stepSize: 25, backdropColor: "transparent" } } },
      plugins: { legend: { display: false } }
    }
  });

  const container = document.getElementById("qa-breakdown");
  container.innerHTML = state.answers.map((a, i) => {
    if (!a) return "";
    if (a.skipped) return `
      <div class="qa-item">
        <p class="qa-q">${i + 1}. ${escapeHtml(a.question)}</p>
        <p class="qa-ans">Skipped.</p>
      </div>`;
    const fb = ruleBasedFeedback(a);
    return `
      <div class="qa-item">
        <p class="qa-q">${i + 1}. ${escapeHtml(a.question)}</p>
        <p class="qa-ans">${escapeHtml(a.transcript) || "<em>(no speech captured)</em>"}</p>
        <div class="qa-scores">
          <div><strong>${a.overall}</strong>Overall</div>
          <div><strong>${a.contentScore}</strong>Content</div>
          <div><strong>${a.eyePct}%</strong>Eye contact</div>
          <div><strong>${a.wpm}</strong>WPM</div>
          <div><strong>${a.fillerCount}</strong>Fillers</div>
        </div>
        ${a.llmFeedback ? `<p class="qa-fb">${escapeHtml(a.llmFeedback)}</p>` : fb}
      </div>`;
  }).join("");
}

function ruleBasedFeedback(a) {
  const notes = [];
  if (a.eyePct < 50) notes.push("you looked away from the camera often — practice anchoring on the lens, not the screen");
  if (a.fillerCount > 4) notes.push(`${a.fillerCount} filler words is on the high side — pausing silently reads as more confident`);
  if (a.wpm > 165) notes.push("you were speaking quite fast — slowing down gives your key points room to land");
  if (a.wpm < 100 && a.words > 10) notes.push("your pace was slow — a touch more energy will help you sound engaged");
  if (a.contentScore < 50) notes.push("try grounding your answer in more specifics from the actual project — names, numbers, outcomes");
  const positive = notes.length === 0;
  const cls = positive ? "" : "warn";
  const text = positive
    ? "Nicely delivered — good pace, steady eye contact, and a focused answer."
    : notes.join("; ") + ".";
  return `<p class="qa-fb ${cls}">${escapeHtml(text)}</p>`;
}

document.getElementById("print-btn").addEventListener("click", () => window.print());
document.getElementById("restart-btn").addEventListener("click", () => location.reload());

/* ---------------------------------------------------------------------
   UTIL
--------------------------------------------------------------------- */
function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[m]));
}
