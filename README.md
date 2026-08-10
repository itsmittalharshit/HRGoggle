# CandidLens — Multimodal AI Mock Interview Coach

**Live demo:** https://itsmittalharshit.github.io/candidlens/ *(update after publishing — see below)*

A browser-based mock interview platform. Upload a resume, get interview
questions generated from your actual projects and skills, answer on
camera, and get a scored report covering answer content, speaking pace,
filler words, and on-camera presence — all running client-side, no
backend, no signup.

Built to explore how four typically-separate ML/AI workflows — retrieval
over unstructured documents, LLM-driven question generation, real-time
computer vision, and applied data science / scoring — can be combined
into one coherent product, using only what a static site can run in the
browser.

## Demo

https://github.com/itsmittalharshit/candidlens/assets/DEMO-VIDEO-ID

*(See "Adding the demo video" below — replace this line once you've
uploaded a clip.)*

## What it does

1. **Upload a resume (PDF).** The app reads it in-browser and pulls out
   recognized technical skills plus the actual sentence each one appears
   in.
2. **Get resume-specific questions.** Instead of a static question bank,
   each question is written to reference something you actually put on
   your resume — editable before you start.
3. **Interview on camera.** Your webcam and mic turn on. As you answer,
   the app tracks whether you're looking at the camera, whether you're
   smiling or neutral/stressed, your speaking pace, and filler-word
   usage — live, via an on-screen confidence dial.
4. **Get a scored report.** A radar chart and per-question breakdown
   score content accuracy, delivery, and presence, with specific,
   rule-based feedback (e.g. "8 filler words is on the high side" or
   "you looked away from the camera often").

## Architecture

```
[ Resume PDF ]
      │  PDF.js text extraction
      ▼
[ Skill/keyword extraction + sentence matching ]  ← RAG-lite
      │
      ▼
[ Question generator ]  (template-based, or LLM-based if an API key is provided)
      │
      ▼                                    ┌── Webcam ──► MediaPipe Face Mesh ──► eye contact / smile signal
[ Live interview UI ] ◄──────────────────────┤
      │                                    └── Mic ─────► Web Speech API ──► transcript, WPM, filler words
      ▼
[ Scoring engine ]  (content-match + delivery formula → per-question + overall score)
      │
      ▼
[ Report ]  Chart.js radar chart + written feedback
```

## Methodology, pillar by pillar

### 1. Resume understanding (RAG-lite)
`PDF.js` extracts raw text client-side. A curated dictionary of ~100
technical terms (languages, frameworks, ML/RAG-specific tools, cloud,
data engineering) is matched against the extracted text. For each match,
the surrounding sentence is captured and used to write a question that
references it directly, e.g. *"I see you worked with RAG — you
mentioned 'built a pipeline with Qdrant for chunk retrieval'..."*.

This is a deliberate simplification of a full RAG pipeline: no chunking
strategy, no vector database, no embedding-based retrieval — it's
keyword + regex matching over plain text. It approximates the *outcome*
(resume-grounded questions) without the infrastructure. An optional mode
(below) swaps in a real LLM call for this step.

### 2. Question generation & optional LLM mode
By default, questions are assembled from templates filled in with the
matched resume context. If the user supplies their own OpenAI API key
(stored in `localStorage`, sent directly from the browser), the app
instead calls `gpt-4o-mini` to write resume-grounded questions and short
per-answer feedback. This is opt-in and clearly flagged as unsafe for a
public deployment (see Limitations).

### 3. Computer vision
`MediaPipe Face Mesh` runs fully client-side (WASM, no server round
trip) and returns 468 facial landmarks per frame. Two signals are
derived geometrically:
- **Eye contact proxy** — horizontal offset of the nose tip relative to
  the midpoint between the two cheekbones (landmarks 234/454). Small
  offset ⇒ facing the camera.
- **Smile proxy** — vertical position of the mouth corners (61/291)
  relative to the mouth's vertical center, normalized by mouth width.
  Raised corners ⇒ smiling.

These are heuristics, not a trained classifier — see Limitations.

### 4. Data science / signal scoring
From the live transcript and frame-by-frame vision output, the app
computes, per answer:
- Words per minute (word count ÷ elapsed time)
- Filler-word rate (regex match against a filler-word list, normalized
  by word count)
- % of frames with eye contact / smiling
- A content-match score: keyword overlap between the transcript and the
  expected concepts for that question, floor-adjusted for answer length

These combine into a **content score** and a **delivery score** per
question (weighted 55/45), an overall interview score, and the radar
chart in the final report.

## Honest limitations

I'm listing these explicitly because I'd rather a reviewer hear it from
me than find it themselves:

- **Not real RAG.** No vector database, no embedding-based retrieval —
  keyword/regex matching over extracted text. A production version
  would use chunking + a vector store (Chroma/Pinecone/Qdrant) and
  semantic search.
- **Not a trained emotion model.** No DeepFace/FER — smiling and
  eye-contact detection are geometric heuristics off Face Mesh
  landmarks. They're directionally reasonable but not validated against
  a labeled emotion dataset.
- **Speech-to-text depends on the browser.** Uses the Web Speech API,
  which is Chrome/Edge-only and requires an internet connection —
  there's no self-hosted Whisper model here.
- **Scoring is a hand-tuned formula, not a trained model.** Weights
  (55/45 content/delivery, pace bands, filler penalties, etc.) were
  chosen to be directionally sensible, not fit to labeled interview
  outcome data.
- **LLM mode exposes the API key client-side.** Fine for local testing
  on your own machine; unsafe on a public deployment, since anyone
  could read the key out of `localStorage` via dev tools. A real
  deployment would proxy LLM calls through a backend.

The natural next iteration: a small FastAPI/Node backend doing real
chunking + embeddings + vector search, and a proper FER model behind an
API, with this frontend mostly unchanged.

## Tech stack

Vanilla HTML/CSS/JS · PDF.js · MediaPipe Face Mesh · Web Speech API ·
Chart.js · (optional) OpenAI `gpt-4o-mini`. No build step, no framework,
no backend — deployed as a static site on GitHub Pages.

## Running it

```bash
git clone https://github.com/itsmittalharshit/candidlens.git
cd candidlens
python3 -m http.server 8000
# open http://localhost:8000
```

Camera/mic access is blocked on `file://` by most browsers, so it needs
to be served (locally via the command above, or via GitHub Pages, which
is HTTPS by default). **Use Chrome or Edge** for live speech
transcription — Safari/Firefox will parse resumes and run the vision
tracking, but speech-to-text won't work.

## Adding the demo video

1. Record a short screen capture (60–90s is plenty): upload a resume,
   show a generated question, answer one on camera, show the report.
   QuickTime (Mac), Xbox Game Bar (Windows), or [Loom](https://loom.com)
   all work.
2. Go to your GitHub repo → open this `README.md` in the web editor (pencil
   icon) → drag the video file directly into the text box. GitHub
   uploads it and inserts a `https://github.com/user-attachments/assets/...`
   link automatically.
3. Replace the placeholder link near the top of this file with that
   link, commit.

GitHub will render it as an inline playable video on the repo page.

## License

MIT — do whatever you want with it, just don't claim the demo video is
someone else's face.
