# Duplicate detection: the plan after the first spike was challenged

`DUPLICATES-NOTES.md` records what the first spike measured. This file records what it got wrong, what we
are building instead, and the order to build it in. Code stays in `spike/duplicates/`, which is
gitignored.

## What the first spike assumed, and why each assumption failed

The retrieval was sound. Three assumptions underneath it were not.

**It treated duplication as symmetric.** Recall was scored against Linear's `duplicate` relation, which
reads as "these two are the same report". The relation the team actually records is directional and about
work coverage. Mined from ticket comments: "superseded by", "subsumed by", "handled by", "covered in",
"closing in favor of". Only 26 such comments exist so the wording alone is thin evidence, but the pairs
are unambiguous. "Add commitment status dashboard filters" was closed by "Implement org-wide commitment
listview", and "Investigate failed document indexing in assessments" was closed by two separate fixes
("Handle image-only PDFs" and "Reject .msg files"). Neither is a duplicate report. Both are work already
covered. This is why adjudication found 118 RELATED against 18 DUP: the target relation was wrong, so
everything real landed in the consolation bucket.

**It trusted the labels.** 664 tickets sit in a `Duplicate` workflow state and only 113 carry a link, so
83% of known duplicates are invisible to the eval. The rot is not uniform, which matters for what we
harvest:

| Population                           | Count | Linked    |
| ------------------------------------ | ----- | --------- |
| `watchdoggo-triage`, Duplicate state | 44    | 44 (100%) |
| Old DEV backlog, Duplicate state     | 547   | ~0        |
| Whole workspace, Duplicate state     | 664   | 113 (17%) |

The new intake flow labels itself well and the old backlog does not. 376 of the 551 unlinked tickets have
no description at all, so they cannot be labeled from text even by hand. Fetching comments for all 769
candidates recovered only 16 more links, so harvesting existing signal is a dead end for volume. Human
judgment is the bottleneck and the plan has to be built around spending it well.

**It used labels as a feature, not just as a target.** The boilerplate guard excluded a batch tag only
when the tag's family shared one dominant label set, which is what let it spare `[Coinbase]` while
catching `[N+1]`. Linear assigns labels automatically and nobody corrects them, so that condition rests
on data we have agreed not to trust. It has to be replaced.

### The trap that replacing it nearly walked into

Creation-burst membership looked like the label-free substitute. 3,274 tickets sit in a burst (4 or more
filed by one account inside 15 minutes), and a human decomposing an epic produces textually similar
siblings that are deliberately distinct, so suppressing bursts looked free.

It is the opposite of free. 13 of the 112 gold pairs are same-burst, and they are the watch-doggo intake
batches: DEV-8451/8452, DEV-8169/8170/8171, DEV-8283/8284. Burst membership cannot suppress candidates,
because for watch-doggo the burst is the set we are being asked to scan inside. The signal splits by who
made the burst, not by the burst existing.

One label-free signal does survive and goes in immediately: a title appearing in 3 or more distinct
projects covers 503 tickets at zero gold-pair cost, which replaces the onboarding-checklist half of the
guard outright.

## What we are building

Two questions, one retriever, one set of labels.

**Pre-submission.** watch-doggo drafts several tickets from several Pylon threads in one run. Before
filing, does each draft collapse into another draft in the same batch, or into work already tracked? Some
of these are the same customer reporting once through two channels, and some are separate symptoms of one
underlying fix. Both should collapse.

**Triage-time.** For a ticket already in Triage, is this work already covered? This is the CLI question
the first spike answered, restated so the answer can be "covered by" rather than "duplicate of".

The reason they share a labeling pass is that batch siblings appear inside the candidate lists for
triage-time queries anyway. Labeling the `watchdoggo-triage` population as query-plus-ranked-list over
the full corpus produces both a clustering ground truth for the batch case and a ranked-relevance
ground truth for the triage case. Choosing one target would have discarded the other for nothing.

## What a label means

Directional, six values. Direction is recorded as query-covers-candidate or candidate-covers-query.

| Verdict           | Meaning                                                          | Scored as |
| ----------------- | ---------------------------------------------------------------- | --------- |
| `same-fix`        | One change closes both, whatever the wording                     | hit       |
| `subsumed-by`     | This work is contained in the other, which is larger             | hit       |
| `same-root-cause` | Different symptoms, one investigation, possibly separate changes | hit       |
| `related`         | Same area, worth reading first, not the same work                | context   |
| `unrelated`       | No                                                               | miss      |
| `unsure`          | Cannot tell without investigating the code or asking someone     | unjudged  |

`unsure` is a verdict, not a skip. Knowing whether two symptoms share a root cause sometimes needs
CloudWatch logs, which is exactly how DEV-6788 was confirmed against DEV-6715. Scoring it as unjudged
follows TREC pooling practice: it counts as neither a hit nor a false alarm, and the share of `unsure` is
reported alongside every metric so a number resting on thin judgment is visible as one. Rounding
uncertainty toward `unrelated` would manufacture false alarms and quietly punish the cases we most want
found.

The `related` bucket is scored separately rather than folded in, because the first spike's finding stands:
118 of 205 surfaced candidates were genuinely related work, and that is the common case. A ranking that
puts real context above noise is useful even when nothing collapses.

## The failure modes, named

From the 35 gold pairs the current pipeline misses at top-10. This taxonomy drives the technique ladder,
and the labeling UI records which mode caused each near-miss so it becomes measured rather than anecdotal.

| Mode                       | Example                                                                                           | Addressed by             |
| -------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------ |
| Spelling and typos         | "Migrate Coinbase issues into Findings" against "Migrate PU Findings into Coverbase for Coinabse" | nothing yet (see S1)     |
| Ask against implementation | "different templates for document submission instructions" against "Add `type` to portals"        | index-time doc expansion |
| Internal jargon            | "Nth Party Wireframes" against "Depth of T Radar Designs"                                         | mined alias table        |
| Symptom against root cause | "Quiet Dagster RDS warnings" against "missing weekend runs for BleepingComputer monitoring"       | out of scope             |

The last one is out of scope on purpose. A human needed logs to confirm the one instance we have a record
of, so a text pipeline claiming to find these would be claiming something it cannot do. The honest
handling is `unsure` plus a link, not a confidence score.

## Techniques, cheapest first

Everything runs on this laptop. An Anthropic key stays a later option, revisited with numbers rather than
in the abstract.

| Technique                       | Fixes                       | Cost                                | Needs           |
| ------------------------------- | --------------------------- | ----------------------------------- | --------------- |
| Character n-gram BM25 channel   | typos, truncation           | ~60 lines, milliseconds             | nothing         |
| Label-free guard rewrite        | untrusted label dependence  | ~40 lines                           | nothing         |
| Candidate pooling               | honest precision at all     | three retrievers, one pass          | nothing         |
| Pseudo-relevance feedback (RM3) | partial vocabulary mismatch | ~80 lines, one extra retrieval pass | nothing         |
| Mined alias table               | internal jargon             | co-occurrence pass plus your review | 10 min of yours |
| Real embedding model            | semantic reach              | one-time index build                | local runtime   |
| Index-time doc expansion        | ask against implementation  | overnight batch, incremental after  | local runtime   |
| Local judge for label scaling   | labeling throughput         | minutes per batch                   | local runtime   |
| Cross-encoder rerank            | the measured 20-point gap   | per-query, hundreds of ms           | local runtime   |

Index-time doc expansion is the one that targets the failure mode you named. For each ticket, generate a
canonical form (normalized problem statement, suspected surface area, and a couple of alternate phrasings
a different filer would use), then embed that instead of the raw text. Putting it at index time rather
than query time means the index speaks both customer and engineer, queries stay local and free, and the
expensive pass runs once and then only over new tickets.

Rough feasibility on an M4 Pro with 24GB, to be measured rather than trusted: a 137M embedding model
indexes 9k tickets in single-digit minutes, and a 3B instruct model generating ~120 tokens per ticket
covers the corpus in roughly 3 to 4 hours, so expansion is an overnight job that afterward only touches
new tickets. An 8B model roughly doubles that. If the measured quality gap between 3B and 8B is small,
the smaller model wins because re-running the whole corpus after a prompt change stops being a
weekend-sized decision.

## Spikes, in order

Each spike answers one question and has a condition under which we stop rather than push on.

1. **S1: n-gram channel and guard rewrite. Done, one result each way.** The guard rewrite holds: it reads
   no label, excludes 862 of 8,986 tickets (9.6%), and still costs zero recorded pairs. The n-gram channel
   does not earn a place in the ranker, which is a negative result worth not retrying. Fused as a third
   channel it gains 1.8 points at recall@5 and loses 3.6 at recall@10, and it reaches only two pairs that
   word matching misses at top-10. It does not even fix the case that motivated it, because
   "Coinbase" against "Coinabse" is a transposition, and a transposition breaks nearly as many grams as
   it preserves. It stays in the pipeline as a **pooling** retriever only, since pool diversity and
   ranking quality are separate requirements and 24% of pooled candidates come from a single retriever
2. **S2: labeling UI and the seed set. Tool built and exercised, labels pending.** The pool is 218 queries
   and 2,616 candidate pairs from three retrievers, chronologically scoped so each query sees only what
   existed when it was filed. The tool commits a screen at a time and appends to JSONL, so a session can end
   anywhere. Still open is the rate: stop and shed a distinction from the schema if it comes in under 2
   labels per minute, which the tool measures and displays rather than leaving to impression

   The queue is ordered by the best candidate's cosine, densest first, and each verdict records which band
   it came from. Ordering by retriever agreement was tried first and rejected: with three retrievers over
   twelve candidates drawn from twenty-deep lists, two agreeing is the common case, so it flagged 181 of 218
   queries and concentrated known duplicates at only 19%. The cosine band flags 42 and concentrates them at
   64%. Recording the band is what keeps a front-loaded queue from quietly biasing a precision figure
3. **S3: real embedding model against the static table. Done, stop condition not met, decision deferred.**
   nomic-embed-text-v1.5 embeds all 8,986 tickets in 56s, so cost is not the question. Quality moves in the
   right direction but not far enough to have earned the swap on this evidence:

   | Arm                       | recall@3 | recall@5 | recall@10 | recall@50 |   MRR |
   | ------------------------- | -------: | -------: | --------: | --------: | ----: |
   | static potion-32M alone   |    54.5% |    59.8% |     67.0% |     81.3% | 0.470 |
   | nomic alone, doc prefix   |    50.9% |    57.1% |     66.1% |     81.3% | 0.488 |
   | nomic alone, query prefix |    57.1% |    62.5% |     65.2% |     80.4% | 0.505 |
   | words + static (current)  |    58.9% |    67.0% |     76.8% |     88.4% | 0.527 |
   | words + nomic             |    61.6% |    66.1% |     74.1% |     85.7% | 0.549 |
   | words + static + nomic    |    65.2% |    71.4% |     75.0% |     86.6% | 0.559 |

   Replacing static with nomic buys 2.2 MRR points, and keeping both buys 3.2. The bar was 5, so neither
   clears it, and both cost about 2 points of recall@50. Spending deep recall is worse than it sounds
   because that tail is exactly what a reranker in S7 would work on.

   The result worth keeping is the third row against the second. The only difference between them is
   whether the query was marked as a query, and that alone is worth 1.7 MRR points and 5.4 points of
   recall@5. **That is the first direct evidence that query-document asymmetry is real on this corpus**,
   which is the hypothesis S5 rests on, arrived at far more cheaply than S5 will.

   The swap decision is deferred to the seed labels rather than settled here. A 2-to-3 point move on the
   recorded pairs is not decisive when those pairs are the wrong objective, and the shape of the
   disagreement (better at ranks 3 and 5, worse at 50) is precisely the shape that a directional label
   schema and an honest pool would resolve differently from a symmetric one
4. **S4: mined alias table.** Do workspace-internal terms have stable engineering co-occurrences worth
   expanding? Ends with a list for you to confirm or reject in 10 minutes. Stop if under 30 of the mined
   pairs survive your review
5. **S5: index-time doc expansion.** This is the main event and the one aimed at ask-against-implementation.
   Measured on the seed-set pairs that the local ladder misses. Stop if it gains under 8 points of
   recall@10 on that subset, because the overnight rebuild is a standing cost
6. **S6: local judge.** Does a local model agree with you closely enough to scale labeling? Measured as
   agreement against your seed labels, reported per verdict rather than overall, because agreement on
   `unrelated` is easy and agreement on `same-root-cause` is what matters. Stop if agreement on the
   collapse verdicts is under 0.6
7. **S7: cross-encoder rerank.** Closes the measured gap between recall@50 of 88% and recall@5 of 68%.
   Last because it is per-query cost and the earlier steps change what needs reranking

S1 and S2 are built. S3 through S7 wait on a local runtime.

### Running the labeling tool

```
deno run --allow-read --allow-write --allow-env --allow-ffi --node-modules-dir=auto spike/duplicates/pool.ts
deno run --allow-read --allow-write --allow-net spike/duplicates/label/server.ts
```

Then open <http://localhost:8777> and press `?`. It binds loopback only, because the pool holds real
customer report text and Deno's default host would offer it to the local network. Verdicts land in
`spike/duplicates/verdicts.jsonl`, which is gitignored along with the rest of the spike.

The screen is one query against up to twelve candidates. Mark the few that matter and press Enter, which
records the rest as unrelated. That is the shape a triager already works in, and it is what makes ten
minutes worth roughly a hundred labels instead of ten.

## What I need from you

Roughly an hour total, in ten-minute pieces. The runtime is installed.

1. **Three ten-minute seed sessions**, roughly 150 labels. Query-plus-ranked-list, one keystroke per
   verdict, resumable, so a session can end mid-list without losing anything
2. **Three ten-minute review sessions** over what the local judge proposes, once S6 has a judge worth
   reviewing. Same UI, pre-filled with the judge's verdict and its reasoning, so the action is agreeing or
   overriding rather than deciding from scratch
3. **One ten-minute glossary pass** confirming or rejecting mined internal terms
4. **Answers to the open decisions below**, whenever they come up

### The local runtime

llama.cpp, by way of `brew install llama.cpp`, chosen over ollama because it exposes a reranking endpoint
that S7 needs and ollama does not. It also covers embeddings and generation, so it serves S3, S5, and S6
without a second tool.

```
llama-server -hf nomic-ai/nomic-embed-text-v1.5-GGUF --embeddings \
  --port 8899 --host 127.0.0.1 -c 4096 -b 4096 -ub 4096
```

The batch flags are not optional. The default physical batch is 512 tokens and it rejects any single input
above that outright, which a handful of tickets exceed.

Your seed labels are the anchor for everything else. The judge is calibrated against them, and its
agreement rate is reported next to every number it produced, so a metric resting on machine labels never
reads as one resting on yours.

## What we are deliberately not doing

- **A vector index.** Brute-force cosine over 9k vectors takes milliseconds. This corpus grows by roughly
  40 tickets a week, so it will not need one for years
- **Symptom-to-root-cause inference.** It needs code and log knowledge that this pipeline has no access
  to, and the one confirmed instance required a human reading CloudWatch
- **A hosted API, for now.** Revisited after S5 and S6 report numbers, so the tradeoff is priced
- **Writes to Linear.** Per ADR 0009 those happen only from the web app. The labeling UI writes JSONL to
  disk and nothing else, and the CLI stays read-only

## Picking this up in a new session

Everything below is on disk already. Nothing here needs to be rebuilt to get started.

**Start the labeling tool and do the first session.** This is the one thing blocking S4 onward, because
the seed labels are what S3's deferred decision and S6's judge both get measured against.

```
cd /Users/kyleking/Developer/kyleking/tlr
deno run --allow-read --allow-write --allow-net spike/duplicates/label/server.ts
```

Open <http://localhost:8777> and press `?` for the keys. Click into the page before typing, because the
first keystroke after a page load goes to the browser rather than the document. Ten minutes is enough;
the queue is ordered densest-first so the early screens are the ones worth judging, and it resumes from
`verdicts.jsonl` wherever it stopped.

**Bring the embedding server back only when S5 or S7 needs it.** S3's vectors are cached, so re-running
S3 reads from disk instead of re-embedding.

```
llama-server -hf nomic-ai/nomic-embed-text-v1.5-GGUF --embeddings \
  --port 8899 --host 127.0.0.1 -c 4096 -b 4096 -ub 4096
```

### What is on disk

| Path                                       | Size | What it is                                                         |
| ------------------------------------------ | ---- | ------------------------------------------------------------------ |
| `spike/duplicates/corpus.json`             | 9.8M | All 8,986 tickets, fetched by `corpus.ts`. Refetch to refresh      |
| `spike/duplicates/pool.json`               | 2.8M | 218 queries, 2,616 candidate pairs, cosine-ordered. From `pool.ts` |
| `spike/duplicates/verdicts.jsonl`          | 0B   | Your labels. Empty, append-only, the durable record                |
| `spike/duplicates/nomic-docs.bin`          | 26M  | S3's cached document vectors, keyed to model and prefix            |
| `spike/duplicates/models/`                 | 155M | The static potion tables, still the shipped semantic channel       |
| `spike/duplicates/verdicts.txt`            | —    | The **first** spike's 215 adjudications, symmetric DUP/RELATED/NO  |
| `~/.cache/huggingface/hub/models--nomic-*` | —    | The GGUF, pulled by `llama-server -hf`                             |

`verdicts.txt` and `verdicts.jsonl` are different things and should not be merged. The first is the old
symmetric adjudication that led to the reframing; the second is the directional schema.

### Rebuilding, if the corpus is refreshed

```
deno run --allow-read --allow-write --allow-env --allow-net --allow-run spike/duplicates/corpus.ts
deno run --allow-read --allow-write --allow-env --allow-ffi --node-modules-dir=auto spike/duplicates/pool.ts
```

Rebuilding `pool.json` can renumber the queue but does not invalidate existing verdicts, which are keyed
by ticket identifier rather than position. Delete `nomic-docs.bin` after a refetch, or it will hold vectors
for the old row order.

### Checks before any commit

```
deno lint spike/duplicates/ && deno fmt spike/duplicates/
deno test --allow-read --allow-env --allow-ffi --node-modules-dir=auto spike/duplicates/duplicates_test.ts
deno task test
```

`spike/` is gitignored in full, so only `DUPLICATES-PLAN.md` and `DUPLICATES-NOTES.md` are ever
commit-eligible from this work. No real ticket text belongs in either, per ADR 0003.

## Open decisions

- Whether `subsumed-by` should surface differently in the CLI from `same-fix`. They imply different
  actions (close this one against fold this into that one) and the distinction is only worth carrying if
  the output uses it
- Whether the old DEV backlog is ever worth labeling. 376 of 551 have no description, so it is mostly
  unrecoverable, and the value is statistical power on a population you said you are unlikely to act on
- Whether watch-doggo should be filing non-requests at all. 24 of its 218 tickets are out-of-office
  autoreplies, meeting reschedules, or "no content provided", and 22 of those sit in Backlog. Suppressing
  them upstream would be worth more than anything downstream detection can do with them, and it is a
  watch-doggo change rather than a duplicate-detection one
