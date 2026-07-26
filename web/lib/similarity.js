// Similarity between issues, as the deterministic structural adapter behind the SimilaritySource
// port (adr/0007). It reads only what ingest already stores, so it runs with no model, no network,
// and no credential. The embedding-backed adapter replaces this module's neighbors() without any
// caller learning which one ran.

const STOP = new Set(
  ("the a an and or but so that this these those to for of in on at by with from as is are be been" +
    " it its their they them we our you your not no if then than when where which who whom what" +
    " will would can could should may might must do does did done have has had also into over under" +
    " out up down about after before while during per via")
    .split(" "),
)

/** Lowercase word tokens, stopwords and one/two-character fragments dropped. */
export function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((t) => t.length > 2 && !STOP.has(t))
}

function tfidfVectors(issues) {
  const docs = issues.map((it) => tokenize(`${it.title ?? ""} ${it.description ?? ""}`))
  const n = docs.length
  const df = new Map()
  for (const doc of docs) {
    for (const t of new Set(doc)) df.set(t, (df.get(t) ?? 0) + 1)
  }
  return docs.map((doc) => {
    const tf = new Map()
    for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1)
    const vec = new Map()
    let norm = 0
    for (const [t, count] of tf) {
      const w = (1 + Math.log(count)) * Math.log(1 + n / (df.get(t) ?? 1))
      vec.set(t, w)
      norm += w * w
    }
    norm = Math.sqrt(norm) || 1
    for (const [t, w] of vec) vec.set(t, w / norm)
    return vec
  })
}

function cosine(a, b) {
  const [small, big] = a.size < b.size ? [a, b] : [b, a]
  let acc = 0
  for (const [t, w] of small) {
    const other = big.get(t)
    if (other !== undefined) acc += w * other
  }
  return acc
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

// Text carries most of the signal; the structural channels mostly break ties between tickets whose
// wording happens to overlap. Weights sum to 1 so a score is readable as a percentage.
const WEIGHTS = { text: 0.55, labels: 0.25, parent: 0.10, milestone: 0.05, coBlocking: 0.05 }

/**
 * Dense pairwise similarity as a row-major Float64Array, values in [0, 1].
 *
 * Index i corresponds to issues[i]; the diagonal is 1.
 */
export function similarityMatrix(issues) {
  const n = issues.length
  const vecs = tfidfVectors(issues)
  const labels = issues.map((it) => new Set(it.labels ?? []))
  const neighbours = issues.map((it) => new Set([...(it.blocks ?? []), ...(it.blockedBy ?? [])]))

  const sim = new Float64Array(n * n)
  for (let i = 0; i < n; i++) {
    sim[i * n + i] = 1
    for (let j = i + 1; j < n; j++) {
      const a = issues[i]
      const b = issues[j]
      let shared = 0
      for (const id of neighbours[i]) if (neighbours[j].has(id)) shared++

      const score = WEIGHTS.text * cosine(vecs[i], vecs[j]) +
        WEIGHTS.labels * jaccard(labels[i], labels[j]) +
        WEIGHTS.parent * (a.parentId && a.parentId === b.parentId ? 1 : 0) +
        WEIGHTS.milestone * (a.milestone && a.milestone === b.milestone ? 1 : 0) +
        WEIGHTS.coBlocking * Math.min(1, shared / 2)

      const value = Math.min(1, score)
      sim[i * n + j] = value
      sim[j * n + i] = value
    }
  }
  return sim
}

/** Why two issues scored close, as a short phrase for the detail card. Never invents a reason. */
export function explain(a, b) {
  const reasons = []
  const shared = (a.labels ?? []).filter((l) => (b.labels ?? []).includes(l))
  if (shared.length) reasons.push(`shares ${shared.join(", ")}`)
  if (a.parentId && a.parentId === b.parentId) reasons.push("same parent")
  if (a.milestone && a.milestone === b.milestone) reasons.push(`both ${a.milestone}`)

  const words = new Set(tokenize(a.title))
  const overlap = [...new Set(tokenize(b.title))].filter((t) => words.has(t))
  if (overlap.length) reasons.push(overlap.slice(0, 3).join(", "))
  return reasons.join(" · ")
}

/**
 * Top-k neighbours per issue: the sparse shape a snapshot would store, rather than the dense matrix.
 *
 * `floor` drops pairs too weak to be worth showing, so an issue with nothing like it returns an
 * empty list instead of its least-bad match.
 */
export function topNeighbors(issues, sim, k = 6, floor = 0.18) {
  const n = issues.length
  return issues.map((issue, i) => {
    const row = []
    for (let j = 0; j < n; j++) {
      if (j === i) continue
      const score = sim[i * n + j]
      if (score >= floor) row.push({ id: issues[j].id, score, why: explain(issue, issues[j]) })
    }
    row.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    return { id: issue.id, neighbors: row.slice(0, k) }
  })
}
