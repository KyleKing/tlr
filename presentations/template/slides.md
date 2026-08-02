---
theme: roughdraft
title: Deck title
titleTemplate: '%s'
info: |
  One sentence on what this deck asks the room to decide.
drawings:
  persist: false
  syncAll: true
layout: cover
meta:
  - 20 min
  - decision
  - draft
---

# The claim, with the <Mark as="underline" pen="red" seed="cover">operative phrase</Mark> marked

One line of context. Who is in the room and why they are here.

::note::

<Note pen="quiet">
right third stays
empty to draw in
</Note>

<!--
Say the ask out loud before slide two. A room that does not know what it is deciding
spends the whole talk guessing.
-->

---
layout: statement
---

# One claim. Nothing else on the slide.

::support::

<Note pen="blue" arrow="up">
the support slot is
for the caveat
</Note>

<!--
This is the most screenshot-able frame in the deck. If a number appears here, it had
better be a measured one, and the source had better be in this note.
-->

---
layout: section
pen: blue
---

# The act break

What changes after this point.

---
layout: default
---

# Ordinary content

- One idea per bullet, and the headline already carries the argument
- A reader who only reads headlines should still follow the whole deck
- Body copy stays in the sans face; the hand face is annotation only

::margin::

<Note pen="quiet">
margin notes are
the aside voice
</Note>

---
layout: two-cols
---

::title::

# Four short labelled blocks

::left::

### Left label

What this side claims, in two lines at most.

### Second left label

Keep both columns the same shape or the slide reads as unbalanced.

::right::

### Right label

The counterpart. Parallel structure does the comparison work.

### Second right label

If a column needs a third block, it needs its own slide.

---
layout: diagram
---

::title::

# The topology

::default::

<div class="grid grid-cols-[1fr_auto_1fr] items-center gap-x-4">

<div class="flex flex-col gap-4">
  <RoughBox class="rd-node" pen="ink" seed="node-a" :radius="11">
    <p class="rd-node__label">Source A</p>
    <p class="rd-node__meta">annotation</p>
  </RoughBox>
  <RoughBox class="rd-node" pen="red" seed="node-b" :radius="11">
    <p class="rd-node__label">Source B</p>
    <p class="rd-node__meta">where it leaks</p>
  </RoughBox>
</div>

<div class="flex flex-col items-center justify-between self-stretch py-6">
  <RoughArrow dir="right" pen="quiet" seed="edge-a" class="!w-16 !h-6" />
  <RoughArrow dir="right" pen="red" seed="edge-b" class="!w-16 !h-6" />
</div>

<div>
  <RoughBox class="rd-node" pen="blue" seed="node-sink" :radius="11" fill>
    <p class="rd-node__label">Where it lands</p>
    <p class="rd-node__meta">and how long it takes</p>
  </RoughBox>
  <Note pen="red" arrow="up" class="mt-4">
  point at this
  and stop talking
  </Note>
</div>

</div>

::foot::

<span>One sentence the diagram cannot say for itself.</span>

---
layout: options
---

::title::

# The choices

::default::

<Choice name="Do nothing" pen="quiet" cost="0">

The baseline. Name it honestly, including what it costs to keep, or the comparison
is rigged.

</Choice>

<Choice name="The recommendation" pen="violet" cost="30 min / 2 weeks" pick>

Set `pick` on exactly one row. Violet is spent here and nowhere else on the slide.

</Choice>

<Choice name="The ambitious one" pen="quiet" cost="1 engineer, 2 weeks">

The option with the highest ceiling and the least evidence. Say which evidence
would change your mind.

</Choice>

::foot::

<RoughArrow dir="right" pen="violet" class="!w-9 !h-5" />
<span>Reversible, and here is what reversing it costs</span>

<!--
Ask which option people would veto before you defend yours. The veto carries more
information than the vote.
-->

---
layout: image-right
image: /placeholder-chart.svg
alt: Describe what the chart shows, not that it is a chart
caption: Placeholder. Replace with the real figure and cite where it came from.
---

# What we would watch

The argument sits on the left and the evidence on the right, so nobody has to
choose which one to read first.

---
layout: board
prompt: What did we miss?
---

<!--
Jump here whenever the room goes sideways. Press p, draw, keep talking. Do not
press d, that is the dark-mode toggle.
-->

---
layout: end
---

# So: which one, and who owns it?

The ask, in the same words you opened with.

::asks::

1. Pick an option
2. Name an owner
3. Agree the date you check whether it worked
