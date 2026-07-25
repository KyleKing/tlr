// A deliberately small markdown renderer for the ticket editor's description preview. It exists
// because the editor stores plain markdown — exactly the text Linear holds — and still wants to show
// what that text means, without pulling in an editor library.
//
// Safety is the whole point of the ordering here: every character of input is HTML-escaped before any
// markup is produced, so nothing a description contains can become a tag, and the only attribute this
// writes is a link href checked against an allowlist of schemes. Anything unrecognized falls through
// as escaped text rather than being guessed at.
//
// What it covers: fenced code, ATX headings, blockquotes, horizontal rules, bullet and numbered lists
// (including `- [ ]` checklists), inline code, bold, italic, and links. Single newlines inside a
// paragraph are kept as line breaks, because a ticket description is written that way.

const SAFE_HREF = /^(?:https?:\/\/|mailto:|\/|#)/i
const FENCE = /^\s*(?:```|~~~)/
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/
const RULE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/
const QUOTE = /^ {0,3}>\s?(.*)$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/
const TASK = /^\[([ xX])\]\s+(.*)$/

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
}

// Code spans are pulled out before the emphasis and link passes run, so `**not bold**` inside
// backticks stays literal, and put back last. The placeholder is a private-use code point, stripped
// from the input first (see renderMarkdown), so a description can never forge one.
function inline(text) {
  const codes = []
  let out = escapeHtml(text).replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code)
    return `\uE000${codes.length - 1}\uE000`
  })
  out = out.replace(
    /\[([^\]]*)\]\(([^)\s]+)\)/g,
    (whole, label, href) =>
      SAFE_HREF.test(href) ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>` : whole,
  )
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
  out = out.replace(/(^|[^_\w])_([^_]+)_/g, "$1<em>$2</em>")
  return out.replace(/\uE000(\d+)\uE000/g, (_, i) => `<code>${codes[Number(i)]}</code>`)
}

function listItem(text) {
  const task = TASK.exec(text)
  if (!task) return `<li>${inline(text)}</li>`
  const box = task[1] === " " ? "☐" : "☑"
  return `<li class="md-task">${box} ${inline(task[2])}</li>`
}

function takeFence(lines, start) {
  const body = []
  let i = start + 1
  while (i < lines.length && !FENCE.test(lines[i])) {
    body.push(lines[i])
    i++
  }
  return [`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`, i + 1]
}

function takeWhile(lines, start, match) {
  const taken = []
  let i = start
  while (i < lines.length) {
    const m = match(lines[i])
    if (m == null) break
    taken.push(m)
    i++
  }
  return [taken, i]
}

function takeList(lines, start, pattern, tag) {
  const [items, next] = takeWhile(lines, start, (line) => pattern.exec(line)?.[1] ?? null)
  return [`<${tag}>${items.map(listItem).join("")}</${tag}>`, next]
}

function takeQuote(lines, start) {
  const [quoted, next] = takeWhile(lines, start, (line) => QUOTE.exec(line)?.[1] ?? null)
  return [`<blockquote>${inline(quoted.join("\n")).replace(/\n/g, "<br />")}</blockquote>`, next]
}

function isBlockStart(line) {
  return line.trim() === "" || FENCE.test(line) || HEADING.test(line) || RULE.test(line) ||
    QUOTE.test(line) || BULLET.test(line) || NUMBERED.test(line)
}

function takeParagraph(lines, start) {
  const [taken, next] = takeWhile(lines, start, (line) => (isBlockStart(line) ? null : line))
  return [`<p>${inline(taken.join("\n")).replace(/\n/g, "<br />")}</p>`, next]
}

// Headings start at <h3> so a description dropped into the editor's dialog (which owns the <h2>)
// cannot break the page's heading order.
function takeHeading(line) {
  const [, hashes, text] = HEADING.exec(line)
  const level = Math.min(6, hashes.length + 2)
  return `<h${level}>${inline(text)}</h${level}>`
}

/** Render plain markdown to a safe HTML string. Every input character is escaped before any markup. */
export function renderMarkdown(text) {
  const lines = String(text ?? "").replace(/\uE000/g, "").replace(/\r\n?/g, "\n").split("\n")
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === "") {
      i++
    } else if (FENCE.test(line)) {
      const [html, next] = takeFence(lines, i)
      out.push(html)
      i = next
    } else if (RULE.test(line)) {
      out.push("<hr />")
      i++
    } else if (HEADING.test(line)) {
      out.push(takeHeading(line))
      i++
    } else if (QUOTE.test(line)) {
      const [html, next] = takeQuote(lines, i)
      out.push(html)
      i = next
    } else if (BULLET.test(line)) {
      const [html, next] = takeList(lines, i, BULLET, "ul")
      out.push(html)
      i = next
    } else if (NUMBERED.test(line)) {
      const [html, next] = takeList(lines, i, NUMBERED, "ol")
      out.push(html)
      i = next
    } else {
      const [html, next] = takeParagraph(lines, i)
      out.push(html)
      i = next
    }
  }
  return out.join("")
}
