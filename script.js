/* =========================================================================
   HRGoggle — client-side AI mock interview coach
   No backend. PDF parsing (pdf.js), face analysis (MediaPipe Face Mesh),
   speech-to-text (Web Speech API), and rule-based / optional-LLM scoring.
   ========================================================================= */

const PDF_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

if (typeof pdfjsLib === "undefined") {
  console.error("pdf.js failed to load from CDN — resume upload will not work until this is fixed.");
}

/* Some browsers refuse to spin up a Worker() pointed at a cross-origin CDN
   URL directly. Fetching the worker script ourselves and handing pdf.js a
   same-origin blob: URL sidesteps that, with a fallback to the raw CDN URL
   if the fetch itself fails (e.g. offline). */
let pdfWorkerReady = null;
function ensurePdfWorker() {
  if (!pdfWorkerReady) {
    pdfWorkerReady = fetch(PDF_WORKER_URL)
      .then(res => { if (!res.ok) throw new Error(`worker fetch returned ${res.status}`); return res.text(); })
      .then(code => {
        const blobUrl = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
        pdfjsLib.GlobalWorkerOptions.workerSrc = blobUrl;
      })
      .catch(err => {
        console.warn("Blob-URL worker setup failed, falling back to direct CDN URL:", err);
        pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
      });
  }
  return pdfWorkerReady;
}

/* Multi-color palette used across all charts — light, distinct, not just a two-tone scheme */
const PALETTE = ["#7FA8C9", "#C79A54", "#7FAE8E", "#CE93A0", "#A79BC9", "#E0895F", "#6FA8A0", "#D9B25C"];
const MUTED = "#D8D2C0"; // skipped / empty bars

/* ---------------------------------------------------------------------
   STATE
--------------------------------------------------------------------- */
const state = {
  resumeText: "",
  skills: [],
  questions: [],      // [{ text, keywords, isFollowUp?, skill? }]
  currentQ: 0,
  answers: [],         // per-question results

  interviewStartTime: null,
  interviewEndTime: null,

  // live interview trackers
  recognizing: false,
  transcriptFinal: "",
  transcriptInterim: "",
  answerStartTime: null,
  lastSpeechTime: null,
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

document.querySelectorAll(".rail-step").forEach(btn => {
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    const view = btn.dataset.view;
    // Manual escape hatch: jumping to the report tab builds it from whatever
    // answers exist so far, so it's never a dead end.
    if (view === "report") {
      if (state.recognizing) finishAnswer();
      try { buildReport(); } catch (e) { console.error("buildReport failed:", e); }
    }
    goToView(view);
  });
});

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

  if (typeof pdfjsLib === "undefined") {
    alert("The PDF reader library didn't load (likely a slow connection or a blocked CDN). Refresh the page and try again.");
    return;
  }

  document.getElementById("parse-status").hidden = false;
  document.getElementById("ready-status").hidden = true;

  try {
    await ensurePdfWorker();
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(it => it.str).join(" ") + "\n";
    }
    if (!text.trim()) throw new Error("No extractable text found (likely a scanned/image-only PDF).");
    state.resumeText = text;
    await buildInterviewFromResume(text);
  } catch (err) {
    console.error("Resume parsing failed:", err);
    document.getElementById("parse-status").hidden = true;
    alert(`Couldn't read that PDF.\n\nDetails: ${err.message || err}\n\nOpen the browser console (F12) for more, or try re-exporting the PDF.`);
  }
}

async function buildInterviewFromResume(text) {
  state.skills = extractSkills(text);
  state.questions = generateQuestionsLocally(text, state.skills);

  document.getElementById("parse-status").hidden = true;
  const readyEl = document.getElementById("ready-status");
  const followUps = state.questions.filter(q => q.isFollowUp).length;
  readyEl.textContent = `✓ Resume analyzed — ${state.questions.length} questions ready` +
    (followUps ? ` (including ${followUps} follow-up${followUps > 1 ? "s" : ""}).` : ".");
  readyEl.hidden = false;
  document.getElementById("to-interview-btn").disabled = false;
}

function extractSkills(text) {
  const found = new Set();
  const lower = text.toLowerCase();
  SKILL_DICTIONARY.forEach(skill => {
    if (lower.includes(skill.toLowerCase())) found.add(skill);
  });
  return [...found];
}

/* Pull short bullet-like lines that mention a known skill, to ground follow-up questions.
   Skip lines that are just skill enumerations ("Languages: Python, Dart, C...") rather
   than an actual sentence about a project. */
const LIST_HEADER_RE = /^(languages|technologies|technical skills|concepts|skills|relevant coursework)\s*:/i;
function findSkillContextLines(text, skill) {
  const lines = text.split(/\n|(?<=[.])\s+/).map(l => l.trim()).filter(Boolean);
  return lines.filter(l =>
    l.toLowerCase().includes(skill.toLowerCase()) &&
    l.length > 25 && l.length < 220 &&
    !LIST_HEADER_RE.test(l) &&
    (l.match(/,/g) || []).length < 5 // enumerated lists tend to be comma-heavy
  );
}

/* Several distinct angles per skill, so a multi-skill resume doesn't produce
   the same sentence repeatedly with the noun swapped. */
const SKILL_QUESTION_TEMPLATES = [
  (skill, ctx) => ctx
    ? `You mentioned "${truncate(ctx, 100)}" — what was the hardest technical decision in that piece, and why did you go that way?`
    : `Tell me about a specific project where you used ${skill}. What made it non-trivial?`,
  (skill) => `If you rebuilt your ${skill} work today knowing what you know now, what would you change?`,
  (skill) => `Walk me through a bug or failure you hit while working with ${skill}. How did you track it down?`,
];

/* Each main question gets a linked follow-up, asked right after it — but
   only if the main question wasn't skipped. */
const FOLLOWUP_TEMPLATES = [
  () => `Quick follow-up — how would you know if that decision actually paid off?`,
  () => `Follow-up: was there a moment that approach broke down? What did you do?`,
  () => `One more on that — what would you tell someone about to make the same call?`,
];

function generateQuestionsLocally(text, skills) {
  const questions = [];
  const usedSkills = skills.slice(0, 3); // 3 skills × (main + follow-up) = 6 grounded questions

  usedSkills.forEach((skill, i) => {
    const contextLines = findSkillContextLines(text, skill);
    const context = contextLines[0];
    const mainTemplate = SKILL_QUESTION_TEMPLATES[i % SKILL_QUESTION_TEMPLATES.length];
    const followTemplate = FOLLOWUP_TEMPLATES[i % FOLLOWUP_TEMPLATES.length];
    questions.push({
      text: mainTemplate(skill, context),
      keywords: [skill.toLowerCase(), "because", "challenge", "result", "learned"],
      skill
    });
    questions.push({
      text: followTemplate(),
      keywords: [skill.toLowerCase(), "impact", "measure", "outcome"],
      isFollowUp: true,
      skill
    });
  });

  // Fill remaining slots with generic behavioral questions (no follow-ups on these)
  const remaining = GENERIC_QUESTIONS.slice(0, Math.max(1, 7 - questions.length));
  return [...questions, ...remaining].slice(0, 7);
}

function truncate(s, n) { return s.length > n ? s.slice(0, n).trim() + "…" : s; }

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
  state.interviewStartTime = Date.now();
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
  octx.fillStyle = ok ? "#7FAE8E" : "#CE93A0";
  octx.fill();
}

/* ---------------------------------------------------------------------
   SPEECH RECOGNITION (audio + data-science pillar)
   Note: the raw transcript is still captured for scoring, it's just not
   rendered on screen anymore — only the derived metrics are shown live.
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
    updateLiveMetrics();
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

/* ---------------------------------------------------------------------
   LIVE METRICS + DIAL
--------------------------------------------------------------------- */
let metricsTimer;
function updateLiveMetrics() {
  const words = wordCount(state.transcriptFinal + " " + state.transcriptInterim);
  const elapsedSec = state.answerStartTime ? (Date.now() - state.answerStartTime) / 1000 : 0;
  const elapsedMin = elapsedSec / 60;
  const wpm = elapsedMin > 0.05 ? Math.round(words / elapsedMin) : 0;

  document.getElementById("m-wpm").textContent = wpm || "--";
  document.getElementById("m-filler").textContent = state.fillerCount;
  document.getElementById("m-time").textContent = formatTime(elapsedSec);
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
    score >= 70 ? "#7FAE8E" : score >= 45 ? "#C79A54" : "#CE93A0";
  document.getElementById("dial-num").textContent = Math.round(score);
}

function wordCount(s) { return (s.trim().match(/\S+/g) || []).length; }
function formatTime(totalSec) {
  const s = Math.max(0, Math.round(totalSec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/* ---------------------------------------------------------------------
   INTERVIEW FLOW
--------------------------------------------------------------------- */
function loadQuestion(i) {
  const q = state.questions[i];
  document.getElementById("q-counter").textContent =
    `Question ${i + 1} of ${state.questions.length}` + (q.isFollowUp ? " · follow-up" : "");
  document.getElementById("q-text").textContent = q.text;
  resetPerQuestionState();
  document.getElementById("record-btn").textContent = "Start answer";
  document.getElementById("cam-listening").hidden = true;
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
  document.getElementById("m-time").textContent = "0:00";
}

document.getElementById("record-btn").addEventListener("click", () => {
  if (!state.recognizing) startAnswer(); else finishAnswer();
});

function startAnswer() {
  state.recognizing = true;
  state.answerStartTime = Date.now();
  document.getElementById("record-btn").textContent = "Finish answer";
  document.getElementById("cam-listening").hidden = false;
  document.getElementById("rec-badge").textContent = "● recording";
  metricsTimer = setInterval(updateLiveMetrics, 1000);
  try { recognition && recognition.start(); } catch (e) {}
}

async function finishAnswer() {
  state.recognizing = false;
  clearInterval(metricsTimer);
  try { recognition && recognition.stop(); } catch (e) {}
  document.getElementById("rec-badge").textContent = "● not recording";
  document.getElementById("cam-listening").hidden = true;
  // Web Speech API often delivers the last "final" result asynchronously,
  // shortly after stop() is called — give it a moment before we score.
  await new Promise(r => setTimeout(r, 350));
  try { await recordAnswerResult(); }
  catch (e) { console.error("Failed to record answer, continuing anyway:", e); }
  advanceQuestion();
}

document.getElementById("skip-btn").addEventListener("click", async () => {
  if (state.recognizing) {
    await finishAnswer(); // preserves whatever was said so far, doesn't discard it
  } else {
    try { await recordAnswerResult(true); }
    catch (e) { console.error(e); }
    advanceQuestion();
  }
});

async function recordAnswerResult(skipped = false) {
  const qIndex = state.currentQ;
  const q = state.questions[qIndex];
  // Include any not-yet-finalized speech: Web Speech API often delivers the
  // last "final" result asynchronously after recognition.stop(), so relying
  // on transcriptFinal alone can drop the last sentence someone just said.
  const transcript = (state.transcriptFinal + " " + state.transcriptInterim).trim();
  const words = wordCount(transcript);
  const timeSec = state.answerStartTime ? (Date.now() - state.answerStartTime) / 1000 : 0;
  const elapsedMin = Math.max(0.05, timeSec / 60);
  const wpm = Math.round(words / elapsedMin);
  const eyePct = state.frameCount ? Math.round((state.eyeContactFrames / state.frameCount) * 100) : 0;
  const smilePct = state.frameCount ? Math.round((state.smileFrames / state.frameCount) * 100) : 0;

  const contentScore = skipped ? 0 : scoreContent(transcript, q.keywords);
  const paceScore = skipped ? 0 : scorePace(wpm, words);
  const fillerScore = skipped ? 0 : scoreFillers(state.fillerCount, words);
  const deliveryScore = Math.round((paceScore + fillerScore + eyePct + smilePct) / 4);
  const overall = skipped ? 0 : Math.round(0.55 * contentScore + 0.45 * deliveryScore);

  state.answers[qIndex] = {
    question: q.text, transcript, skipped, words, wpm, timeSec,
    isFollowUp: !!q.isFollowUp,
    fillerCount: state.fillerCount, eyePct, smilePct,
    contentScore, paceScore, fillerScore, deliveryScore, overall,
  };
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

function clarityLabel(a) {
  if (a.skipped) return "—";
  if (a.words < 6) return "Too brief";
  if (a.wpm > 175) return "Rushed";
  if (a.wpm < 95) return "Hesitant";
  if (a.fillerCount > 5) return "Cluttered";
  if (a.paceScore >= 80 && a.fillerScore >= 80) return "Clear & steady";
  return "Adequate";
}

/* Auto-skip a follow-up without ever showing it, when its main question
   was skipped — records it silently and returns true if it advanced. */
function autoSkipOrphanedFollowUp() {
  const q = state.questions[state.currentQ];
  const prevAnswer = state.answers[state.currentQ - 1];
  if (q && q.isFollowUp && prevAnswer && prevAnswer.skipped) {
    state.answers[state.currentQ] = {
      question: q.text, transcript: "", skipped: true, words: 0, wpm: 0, timeSec: 0,
      isFollowUp: true, fillerCount: 0, eyePct: 0, smilePct: 0,
      contentScore: 0, paceScore: 0, fillerScore: 0, deliveryScore: 0, overall: 0
    };
    return true;
  }
  return false;
}

function advanceQuestion() {
  state.currentQ++;
  while (state.currentQ < state.questions.length && autoSkipOrphanedFollowUp()) {
    state.currentQ++;
  }
  if (state.currentQ < state.questions.length) {
    loadQuestion(state.currentQ);
  } else {
    state.interviewEndTime = Date.now();
    if (camera) { try { camera.stop(); } catch (e) { console.warn(e); } }
    try { buildReport(); } catch (e) { console.error("buildReport failed, showing report anyway:", e); }
    goToView("report"); // always reachable, even if scoring/chart rendering hit an error above
  }
}

/* ---------------------------------------------------------------------
   REPORT
--------------------------------------------------------------------- */
let radarChart, barChart, timeChart;
function buildReport() {
  const valid = state.answers.filter(a => a && !a.skipped);
  const overall = valid.length
    ? Math.round(valid.reduce((s, a) => s + a.overall, 0) / valid.length) : 0;

  document.getElementById("overall-score").textContent = overall;
  document.getElementById("overall-tag").textContent =
    overall >= 80 ? "Strong performance" :
    overall >= 60 ? "Solid, with room to sharpen" :
    overall >= 35 ? "Needs focused practice" : "Let's build from the fundamentals";

  // --- Timing stats ---
  const totalSec = state.interviewStartTime
    ? ((state.interviewEndTime || Date.now()) - state.interviewStartTime) / 1000 : 0;
  const avgSec = valid.length ? valid.reduce((s, a) => s + a.timeSec, 0) / valid.length : 0;
  document.getElementById("total-time").textContent = formatTime(totalSec);
  document.getElementById("avg-time-tag").textContent =
    valid.length ? `~${formatTime(avgSec)} avg per answer` : "No answers recorded";

  const avg = (key) => valid.length ? Math.round(valid.reduce((s, a) => s + a[key], 0) / valid.length) : 0;

  if (typeof Chart === "undefined") {
    console.error("Chart.js failed to load — skipping charts, rest of the report still works.");
    document.querySelectorAll(".chart-box").forEach(box =>
      box.insertAdjacentHTML("beforeend", `<p class="hint">Chart library didn't load — scores are listed below.</p>`));
  } else {
    Chart.defaults.font.family = "'Inter', sans-serif";
    Chart.defaults.color = "#5A6B7A";

    // --- Radar: score profile across dimensions ---
    if (radarChart) radarChart.destroy();
    radarChart = new Chart(document.getElementById("radar-chart"), {
      type: "radar",
      data: {
        labels: ["Content", "Eye contact", "Pace", "Low fillers", "Expression"],
        datasets: [{
          label: "Your score",
          data: [avg("contentScore"), avg("eyePct"), avg("paceScore"), avg("fillerScore"), avg("smilePct")],
          backgroundColor: "rgba(127,168,201,0.28)",
          borderColor: PALETTE[0],
          pointBackgroundColor: PALETTE[1],
          pointRadius: 4
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: { r: { min: 0, max: 100, ticks: { stepSize: 25, backdropColor: "transparent" } } },
        plugins: { legend: { display: false } }
      }
    });

    // --- Bar: overall score per question, multi-color, skipped shown muted ---
    if (barChart) barChart.destroy();
    barChart = new Chart(document.getElementById("bar-chart"), {
      type: "bar",
      data: {
        labels: state.answers.map((a, i) => `Q${i + 1}${a && a.isFollowUp ? " (f/u)" : ""}`),
        datasets: [{
          label: "Overall score",
          data: state.answers.map(a => a ? a.overall : 0),
          backgroundColor: state.answers.map((a, i) => a && a.skipped ? MUTED : PALETTE[i % PALETTE.length]),
          borderRadius: 6
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: { y: { min: 0, max: 100 } },
        plugins: { legend: { display: false } }
      }
    });

    // --- Bar: time spent per question ---
    if (timeChart) timeChart.destroy();
    timeChart = new Chart(document.getElementById("time-chart"), {
      type: "bar",
      data: {
        labels: state.answers.map((a, i) => `Q${i + 1}${a && a.isFollowUp ? " (f/u)" : ""}`),
        datasets: [{
          label: "Seconds spent",
          data: state.answers.map(a => a ? Math.round(a.timeSec) : 0),
          backgroundColor: state.answers.map((a, i) => a && a.skipped ? MUTED : PALETTE[(i + 3) % PALETTE.length]),
          borderRadius: 6
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: { y: { beginAtZero: true, title: { display: true, text: "seconds" } } },
        plugins: { legend: { display: false } }
      }
    });
  }

  const container = document.getElementById("qa-breakdown");
  container.innerHTML = state.answers.map((a, i) => {
    if (!a) return "";
    const followTag = a.isFollowUp ? `<span class="qa-followup-tag">follow-up</span>` : "";
    if (a.skipped) return `
      <div class="qa-item">
        <p class="qa-q">${i + 1}. ${escapeHtml(a.question)}${followTag}</p>
        <p class="qa-ans">Skipped.</p>
      </div>`;
    const fb = ruleBasedFeedback(a);
    return `
      <div class="qa-item">
        <p class="qa-q">${i + 1}. ${escapeHtml(a.question)}${followTag}</p>
        <p class="qa-ans">${escapeHtml(a.transcript) || "<em>(no speech captured)</em>"}</p>
        <div class="qa-scores">
          <div><strong>${a.overall}</strong>Overall</div>
          <div><strong>${a.contentScore}</strong>Content</div>
          <div><strong>${a.eyePct}%</strong>Eye contact</div>
          <div><strong>${a.wpm}</strong>WPM</div>
          <div><strong>${a.fillerCount}</strong>Fillers</div>
          <div><strong>${formatTime(a.timeSec)}</strong>Time</div>
          <div><strong>${clarityLabel(a)}</strong>Clarity</div>
        </div>
        ${fb}
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
