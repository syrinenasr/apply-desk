// Shared by the browser (preview) and the server (PDF via Gotenberg).

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- tiny markdown renderer for resumes ---------- */
function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+|mailto:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
export function md(src) {
  const out = []; let list = false, para = [];
  // Resume lines are meaningful (one skill category or one degree per line), so keep line breaks instead of joining lines.
  const flushP = () => { if (para.length) { out.push("<p>" + para.map(inline).join("<br>") + "</p>"); para = []; } };
  const flushL = () => { if (list) { out.push("</ul>"); list = false; } };
  for (const raw of String(src || "").split("\n")) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushP(); flushL(); continue; }
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { flushP(); flushL(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { flushP(); flushL(); out.push("<hr>"); continue; }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { flushP(); if (!list) { out.push("<ul>"); list = true; } out.push("<li>" + inline(m[1]) + "</li>"); continue; }
    flushL(); para.push(line.trim());
  }
  flushP(); flushL();
  return out.join("\n");
}


export function cvName(j) {
  const name = ((j.resume.match(/^#\s+(.+)$/m) || [])[1] || "Resume").replace(/[^\p{L}\p{N} -]/gu, "").trim().replace(/\s+/g, "-");
  const co = (j.company || "").replace(/[^\p{L}\p{N} -]/gu, "").trim().replace(/\s+/g, "-");
  return `${name}_Resume${co ? "_" + co : ""}`;
}
// ATS-friendly: one column, Arial, real text only, standard headings, no ligatures or colour.
export const CV_CSS = `
@page { size: A4; margin: 15mm 17mm; }
body { margin: 0; background: #fff; color: #000; font-family: Arial, "Liberation Sans", Helvetica, sans-serif; font-size: 10pt; line-height: 1.35; font-variant-ligatures: none; font-feature-settings: "liga" 0, "clig" 0; }
h1 { font-size: 20pt; font-weight: 700; margin: 0 0 4px; }
h1 + p { margin: 0 0 2px; }
h2 { font-size: 11pt; font-weight: 700; text-transform: uppercase; margin: 14px 0 5px; padding-bottom: 2px; border-bottom: 1px solid #000; break-after: avoid; }
h3 { font-size: 10.5pt; font-weight: 700; margin: 8px 0 1px; break-after: avoid; }
p { margin: 0 0 3px; } ul { margin: 2px 0 4px; padding-left: 16px; } li { margin: 1px 0; break-inside: avoid; }
a { color: #000; text-decoration: none; } hr { display: none; }`;

export function cvTitle(j) {
  const name = (j.resume.match(/^#\s+(.+)$/m) || [])[1] || "Resume";
  return `${name} - Resume${j.company ? " - " + j.company : ""}`;
}

export function cvHtml(j) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(cvTitle(j))}</title>
<style>${CV_CSS}</style></head><body>${md(j.resume)}</body></html>`;
}
