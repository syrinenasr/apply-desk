# Apply Desk

A local web app for English speakers looking for jobs in Germany. Paste a job link and it:

1. **reads the posting** (LinkedIn, StepStone, Personio, Greenhouse and most career pages),
2. **labels the language requirement:** *English friendly*, *English OK, German a plus* or *German required*, with the CEFR level the posting asks for (A1–C2),
3. **scores the match** against your base resume and lists the key requirements and keywords,
4. **writes a tailored, ATS-friendly resume** from your base resume, without inventing experience, and notes the gaps to cover in a cover letter,
5. **makes an A4 PDF** of every tailored resume automatically,
6. **checks whether postings are still open:** once a day automatically, or with **Check postings**. Jobs you haven't applied to move to *Posting closed* when the employer closes them,
7. **tracks the application:** applied date, replies (interview, rejection, offer), response rate, and a follow-up reminder after 14 days without an answer.

Everything runs on your own machine. Your resume and application data never leave it, except for the text sent to Claude for analysis.

## How it works

```
Browser (localhost:4317)            Node.js server (server.js)
public/app.js  ── HTTP/JSON ──►     ├─ fetches postings (LinkedIn guest pages, JSON-LD JobPosting, HTML fallback)
public/cv.js   (shared renderer)    ├─ claude -p  → labels jobs and writes resumes (Claude Code, your subscription)
                                    ├─ Gotenberg (Docker) → HTML-to-PDF
                                    └─ data/db.json (local storage, written atomically)
```

- **No dependencies:** plain Node.js (`http`, `fs`, `child_process`) and plain HTML/CSS/JS. Nothing to `npm install`.
- **Claude through Claude Code:** analysis and resume writing run through `claude -p` with structured prompts and no tools enabled. They use your Claude subscription, so no API key is needed.
- **Shared resume renderer:** `public/cv.js` is used by the browser preview and by the server's PDF generation, so the preview always matches the PDF.

## Requirements

- Node.js 18 or newer
- [Claude Code](https://claude.com/claude-code), installed and logged in (`claude`)
- Docker, for PDF generation with [Gotenberg](https://gotenberg.dev)

## Setup

```sh
git clone <this repo>
cd apply-desk

# Start Gotenberg once; it restarts with Docker afterwards
docker run -d --name gotenberg --restart unless-stopped -p 127.0.0.1:3000:3000 gotenberg/gotenberg:8

npm start
```

Open http://localhost:4317, click **Base resume**, paste your resume as plain text, and add your first job link.

## Options

| Variable        | Default                 | What it does                                   |
| --------------- | ----------------------- | ---------------------------------------------- |
| `PORT`          | `4317`                  | Port to serve on                               |
| `CLAUDE_MODEL`  | (Claude Code default)   | Model for Claude Code, e.g. `sonnet` for speed |
| `CLAUDE_BIN`    | `claude`                | Path to the Claude Code CLI                    |
| `GOTENBERG_URL` | `http://localhost:3000` | Where Gotenberg is listening                   |
| `POSTING_CHECK` | `on`                    | Set to `off` to turn off the daily automatic posting check |

Example: `CLAUDE_MODEL=sonnet npm start`

## Your data

| Path | Contents | In git? |
| --- | --- | --- |
| `data/db.json` | Base resume, jobs, analyses, tailored resumes, replies | No (`.gitignore`) |
| `resumes/` | Generated PDFs, e.g. `Firstname-Lastname_Resume_Company.pdf` | No (`.gitignore`) |

Back up `data/db.json` by copying it somewhere safe.

## Project structure

```
server.js          API routes, storage, Claude calls, posting fetchers, PDF generation
public/index.html  Page layout and styles
public/app.js      Browser app: state, rendering, tracking actions
public/cv.js       Resume renderer shared by the browser and the server (Markdown → ATS-friendly HTML)
```

## Notes

- **Posting checks** look at jobs you might still apply to and applications waiting for an answer, one request every few seconds. A posting counts as closed only on clear evidence: "no longer accepting applications" (or similar wording, in English or German), a 404/410, or an expired `validThrough` date. A rate limit or bot check counts as "couldn't check", never as closed, and stops the run until later.

- The server listens on `127.0.0.1` only, so it isn't reachable from other devices on your network.
- LinkedIn postings are read from LinkedIn's public guest job pages, one link at a time, when you add a job. Check that this fits the terms of the sites you use.
- The language labels and match scores are Claude's judgment of the posting text. Check the posting before you apply.
