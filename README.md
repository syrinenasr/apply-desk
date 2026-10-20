# Apply Desk

A local web app for a job search across countries: Germany, other EU countries, the UK, French-speaking regions, and remote roles. Paste a job link and it:

1. **reads the posting** (LinkedIn, StepStone, Personio, Greenhouse and most career pages),
2. **labels the language requirement** against the candidate's languages (English and French fluent, German basic): *Language OK* (workable in English or French), *Language a plus* or *Language required* (another language such as German, Dutch or Spanish is a plus or required), with the CEFR level for German postings (A1–C2),
3. **reads the location:** city, country, work mode (*remote*, *hybrid*, *on-site*, or not stated) and any explicit visa-sponsorship or right-to-work line, and sorts the job into a track: *AI, Data & BI* or *Java, Angular & Software*,
4. **scores the match** against your base resume and lists the key requirements and keywords,
5. **writes a tailored, ATS-friendly resume** from your base resume, without inventing experience, and notes the gaps to cover in a cover letter,
6. **makes an A4 PDF** of every tailored resume automatically,
7. **checks whether postings are still open:** once a day automatically, or with **Check postings**. Jobs you haven't applied to move to *Posting closed* when the employer closes them,
8. **prepares the application folder:** **Application folder** on the tailored resume copies its PDF to `applied/<Company>/` and writes a one-page cover letter (HTML and PDF) from your resume, without inventing anything. A folder you made earlier for the same company is reused, and a cover letter already in the folder is kept unless you click **Rewrite cover letter**,
9. **tracks the application:** applied date, replies (interview, rejection, offer), response rate, and a follow-up reminder after 14 days without an answer.

Everything runs on your own machine. Your resume and application data never leave it, except for the text sent to Claude for analysis.

## Filtering the list

The stage strip (All jobs, To apply, Waiting, ...) picks the stage. Above the list, next to **Sort**, the track and location filters narrow it further:

- **Country** (shown once jobs from more than one country are on the desk) and **City**, each listing the values with their job counts, most common first. Picking a country narrows the city list.
- **Work mode:** *Any*, *Remote only*, or *Remote or hybrid*.
- **Track:** *All tracks*, *AI, Data & BI* (data engineering, analytics engineering, BI, data analysis, ML/AI) or *Java, Angular & Software* (backend, full stack, frontend, Java/Spring, Angular). The analysis sets each job's track; a role that mixes both gets the one that matches most of its day-to-day work. Each job shows its track as a chip in the list and on the job page.

The filters combine with the stage and the sort, the stage counts follow them, and the choice is remembered in the browser. Jobs analyzed before these features can be filled in from the job page (**Check** next to "Location and work mode not checked yet", or **Set track**), which asks Claude only for the missing fields.

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
| `applied/` | One folder per company: the resume you sent and the cover letter | No (`.gitignore`) |

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
