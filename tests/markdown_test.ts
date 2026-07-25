import { assert, assertEquals } from "jsr:@std/assert@1"
import { renderMarkdown } from "../web/lib/markdown.js"

// The renderer's whole reason to be careful: a description is text somebody else wrote, and it is
// dropped straight into innerHTML. Nothing in it may become markup this file did not decide on.
Deno.test("markup in a description is escaped, never executed", () => {
  assertEquals(
    renderMarkdown(`<img src=x onerror="alert(1)"> & <b>bold</b>`),
    `<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &lt;b&gt;bold&lt;/b&gt;</p>`,
  )
})

Deno.test("an entity in the source cannot smuggle a tag back in", () => {
  const html = renderMarkdown("&lt;script&gt;alert(1)&lt;/script&gt;")
  assert(!html.includes("<script"))
  assertEquals(html, "<p>&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;</p>")
})

Deno.test("only http, mailto, root-relative, and anchor links become anchors", () => {
  assertEquals(
    renderMarkdown("[docs](https://linear.app/x)"),
    `<p><a href="https://linear.app/x" target="_blank" rel="noopener noreferrer">docs</a></p>`,
  )
  assertEquals(renderMarkdown("[bad](javascript:alert(1))"), "<p>[bad](javascript:alert(1))</p>")
  assertEquals(renderMarkdown("[bad](data:text/html,<script>)"), "<p>[bad](data:text/html,&lt;script&gt;)</p>")
})

// The dialog owns the page's <h2>, so a description's own headings start below it.
Deno.test("headings start at h3 and stop at h6", () => {
  assertEquals(renderMarkdown("# Top"), "<h3>Top</h3>")
  assertEquals(renderMarkdown("#### Deep"), "<h6>Deep</h6>")
  assertEquals(renderMarkdown("###### Deeper"), "<h6>Deeper</h6>")
})

Deno.test("inline emphasis, code, and a line break inside a paragraph", () => {
  assertEquals(
    renderMarkdown("**bold** and *italic* and _also_ and `code`"),
    "<p><strong>bold</strong> and <em>italic</em> and <em>also</em> and <code>code</code></p>",
  )
  assertEquals(renderMarkdown("one\ntwo"), "<p>one<br />two</p>")
})

Deno.test("emphasis markers inside a code span stay literal", () => {
  assertEquals(renderMarkdown("`**not bold**`"), "<p><code>**not bold**</code></p>")
})

Deno.test("bullet, numbered, and checklist items", () => {
  assertEquals(renderMarkdown("- one\n- two"), "<ul><li>one</li><li>two</li></ul>")
  assertEquals(renderMarkdown("1. one\n2. two"), "<ol><li>one</li><li>two</li></ol>")
  assertEquals(
    renderMarkdown("- [ ] todo\n- [x] done"),
    `<ul><li class="md-task">☐ todo</li><li class="md-task">☑ done</li></ul>`,
  )
})

Deno.test("fenced code keeps its content verbatim and escaped", () => {
  assertEquals(
    renderMarkdown("```ts\nconst a = 1 < 2\n```"),
    "<pre><code>const a = 1 &lt; 2</code></pre>",
  )
})

Deno.test("blockquotes and rules", () => {
  assertEquals(renderMarkdown("> quoted\n> still"), "<blockquote>quoted<br />still</blockquote>")
  assertEquals(renderMarkdown("---"), "<hr />")
})

Deno.test("empty input renders nothing", () => {
  assertEquals(renderMarkdown(""), "")
  assertEquals(renderMarkdown(null), "")
})

Deno.test("a whole description renders block by block", () => {
  assertEquals(
    renderMarkdown("## Why\n\nThe API is slow.\n\n- profile it\n- fix it\n"),
    "<h4>Why</h4><p>The API is slow.</p><ul><li>profile it</li><li>fix it</li></ul>",
  )
})
