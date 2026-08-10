# HRGoggle — AI Mock Interview Coach

**Live demo:** https://itsmittalharshit.github.io/HRGoggle/

A browser-based mock interview platform. Upload a resume, get interview
questions written about the things you've actually built, answer them on
camera, and get a scored, chart-based report on your content, pace, filler
words, and eye contact — all running client-side, no backend, no signup.

## About this project

Most mock-interview tools either ask static, generic questions or require
a paid backend to feel personalized. HRGoggle explores how far a purely
client-side app can go toward the real thing: reading a resume, writing
questions specific to it, watching and listening while someone answers,
and turning that into a genuinely useful, chart-based report — all inside
a static site that costs nothing to run and needs no server.

It was built to combine four normally-separate pieces of an ML/AI product
— document understanding, question generation, real-time computer vision,
and applied signal analysis — into one working tool, and to be honest
about exactly which parts are the full version of that idea and which
parts are a lighter stand-in for it.

## What it does

1. **Upload a resume (PDF).** Read entirely in the browser — nothing is
   uploaded anywhere.
2. **Get resume-specific questions.** Each one is written around a real
   skill and project line from the resume, paired with a natural
   follow-up question, and validated for basic sentence quality before
   it's shown. Question selection and phrasing are shuffled each run, so
   re-running an interview on the same resume doesn't repeat itself.
3. **Interview on camera, with a voice reading each question aloud** (and
   repeatable on demand) using the browser's built-in speech synthesis.
   While you answer, the app tracks whether you're facing the camera,
   your speaking pace, and filler-word use, shown live on a confidence
   dial.
4. **Get a scored report** — a radar chart, a per-question score chart,
   and a time-per-question chart, plus specific written feedback per
   answer (e.g. "8 filler words is on the high side" or "you looked away
   from the camera often").
5. **Compare attempts.** Every completed interview in the current browser
   tab is kept in session storage, so you can run the interview multiple
   times and see your scores side by side — cleared automatically when
   you close the tab.

## Achievements

A few things this project actually pulled off, worth calling out
specifically:

- **A real-time computer vision pipeline running entirely in the
  browser** — no server round-trip, no GPU required on the user's end —
  using MediaPipe Face Mesh to track head position frame-by-frame during
  a live camera feed.
- **A working PDF-to-interview pipeline** that reliably extracts text
  from real-world resume exports (tested against LaTeX/pdfTeX output,
  among others) and grounds generated questions in the actual sentence a
  skill appears in, with a validation layer that catches and discards
  garbled extractions rather than asking a broken question.
- **Zero-backend speech analysis** — live transcription, words-per-minute,
  filler-word detection, and per-question timing, all computed from
  nothing but the browser's own Speech Recognition API.
- **A resilient front end**: the interview flow is built so that a
  single failed script, a slow CDN, or a skipped question can't strand
  the person mid-interview — there's always a path forward to a result.
- **Session-level analytics**, not just single-interview scoring: results
  persist across multiple attempts in one sitting so a person can
  practice repeatedly and watch their own numbers move.

## Honest limitations — and why they exist

These aren't design flaws so much as the direct consequence of one
constraint: **there is no backend.** Everything below is a limitation
because the alternative requires a server, and a server requires hosting
costs, API costs, or both — which a free static-site project doesn't
have. Listed here because I'd rather explain the trade-off than have
someone assume it wasn't considered.

- **Question grounding is keyword matching, not real retrieval.** There's
  no vector database or embedding model — a skill is matched by checking
  if the word appears in the resume text, then the surrounding sentence
  is pulled in as context. A hosted version would chunk the resume,
  embed it, and do similarity search instead. That's a small, well-understood
  backend service (FastAPI + a vector store) — the main blocker is that
  embeddings aren't free to compute, so it needs somewhere to run.
- **Eye-contact tracking is a geometric heuristic, not a trained model.**
  MediaPipe's landmark positions are used to estimate head direction
  directly, rather than running a model trained on labeled face data.
  This is genuinely a reasonable, defensible signal — head yaw is a
  well-established proxy for gaze — but it's not the same as a
  purpose-trained classifier, which again would need a server to host.
- **Speech-to-text depends on the browser** (Chrome/Edge only, requires
  an internet connection) rather than a self-hosted Whisper model, since
  running Whisper at usable speed needs a GPU somewhere — not something
  a static site can provide.
- **Scoring weights are hand-set, not learned from data.** There's no
  labeled dataset of real interviews scored by real interviewers to fit
  a model against — that data plainly doesn't exist for a personal
  project — so the weights (pace bands, filler penalties, and so on)
  are a considered judgment call rather than a statistically fit result.

The common fix across all four: one small backend. That's the natural
next step if this became more than a portfolio project — the front end
here is already structured so that swap is additive, not a rewrite.

## Tech stack

Vanilla HTML/CSS/JS · PDF.js · MediaPipe Face Mesh · Web Speech API
(recognition + synthesis) · Chart.js. No build step, no framework, no
backend — deployed as a static site on GitHub Pages.

## Running it

```bash
git clone https://github.com/itsmittalharshit/HRGoggle.git
cd HRGoggle
python3 -m http.server 8000
# open http://localhost:8000
```

Camera/mic access is blocked on `file://` by most browsers, so it needs
to be served (locally via the command above, or via GitHub Pages, which
is HTTPS by default). **Use Chrome or Edge** for live speech
transcription — Safari/Firefox will parse resumes and run the vision
tracking, but speech-to-text won't work.

License: MIT
