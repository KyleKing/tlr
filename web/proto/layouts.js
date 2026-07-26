// Pure layout logic for the relationships prototype. No DOM, no I/O, no randomness: every function
// here is deterministic so a card lands in the same place on every render.

const STOP = new Set(
  ("the a an so that this on in of and or to for is are be by with under it its as at from stays path" +
    " correct load which when we our their they them")
    .split(" "),
)

const tokenize = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((t) => t.length > 2 && !STOP.has(t))

// ---------------------------------------------------------------- similarity

/**
 * Structural + lexical similarity for every pair, returned as a dense row-major Float64Array.
 *
 * This is the deterministic adapter described in RELATIONSHIPS-PLAN.md. The real one reads fused
 * BM25F + embedding scores from the duplicates engine; the view cannot tell which ran.
 */
export function similarityMatrix(issues) {
  const n = issues.length
  const docs = issues.map((it) => tokenize(`${it.title} ${it.description ?? ""}`))

  const df = new Map()
  for (const doc of docs) for (const t of new Set(doc)) df.set(t, (df.get(t) ?? 0) + 1)

  const vecs = docs.map((doc) => {
    const tf = new Map()
    for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1)
    const v = new Map()
    let norm = 0
    for (const [t, c] of tf) {
      const w = (1 + Math.log(c)) * Math.log(1 + n / (df.get(t) ?? 1))
      v.set(t, w)
      norm += w * w
    }
    norm = Math.sqrt(norm) || 1
    for (const [t, w] of v) v.set(t, w / norm)
    return v
  })

  const cosine = (a, b) => {
    const [small, big] = a.size < b.size ? [a, b] : [b, a]
    let s = 0
    for (const [t, w] of small) {
      const o = big.get(t)
      if (o !== undefined) s += w * o
    }
    return s
  }

  const labels = issues.map((it) => new Set(it.labels ?? []))
  const jaccard = (a, b) => {
    if (!a.size && !b.size) return 0
    let inter = 0
    for (const x of a) if (b.has(x)) inter++
    return inter / (a.size + b.size - inter)
  }

  const nbrs = issues.map((it) => new Set([...(it.blocks ?? []), ...(it.blockedBy ?? [])]))

  const sim = new Float64Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = issues[i]
      const b = issues[j]
      let shared = 0
      for (const x of nbrs[i]) if (nbrs[j].has(x)) shared++

      const score = 0.55 * cosine(vecs[i], vecs[j]) +
        0.25 * jaccard(labels[i], labels[j]) +
        0.10 * (a.parentId && a.parentId === b.parentId ? 1 : 0) +
        0.05 * (a.milestone && a.milestone === b.milestone ? 1 : 0) +
        0.05 * Math.min(1, shared / 2)

      const v = Math.min(1, score)
      sim[i * n + j] = v
      sim[j * n + i] = v
    }
    sim[i * n + i] = 1
  }
  return sim
}

/** Top-k neighbours per issue, the sparse shape the snapshot would actually store. */
export function topNeighbors(issues, sim, k = 6, floor = 0.18) {
  const n = issues.length
  return issues.map((it, i) => {
    const row = []
    for (let j = 0; j < n; j++) {
      if (j === i) continue
      const s = sim[i * n + j]
      if (s >= floor) row.push({ id: issues[j].id, score: s })
    }
    row.sort((a, b) => b.score - a.score)
    return { id: it.id, neighbors: row.slice(0, k) }
  })
}

// ---------------------------------------------------------------- similarity layout (MDS)

function powerIteration(mat, n, exclude, iters = 200) {
  let v = new Float64Array(n)
  for (let i = 0; i < n; i++) v[i] = Math.sin(i * 12.9898) // deterministic, non-degenerate seed
  const orth = (x) => {
    for (const e of exclude) {
      let d = 0
      for (let i = 0; i < n; i++) d += x[i] * e[i]
      for (let i = 0; i < n; i++) x[i] -= d * e[i]
    }
  }
  orth(v)
  let lambda = 0
  for (let s = 0; s < iters; s++) {
    const next = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      let acc = 0
      for (let j = 0; j < n; j++) acc += mat[i * n + j] * v[j]
      next[i] = acc
    }
    orth(next)
    let norm = 0
    for (let i = 0; i < n; i++) norm += next[i] * next[i]
    norm = Math.sqrt(norm)
    if (norm < 1e-12) break
    for (let i = 0; i < n; i++) next[i] /= norm
    lambda = norm
    v = next
  }
  return { vector: v, value: lambda }
}

/**
 * Shortest-path distance over the k-nearest-neighbour similarity graph.
 *
 * Straight `1 - similarity` is unusable here: roughly half of all pairs score exactly zero, so the
 * distance matrix is nearly constant and classical MDS collapses it to a blob. Walking the kNN graph
 * instead gives the between-cluster distances real spread, which is what puts daylight between
 * clusters on the plane. Disconnected pairs are pushed beyond the largest finite distance.
 */
export function geodesicDistances(issues, sim, k = 6, floor = 0.15) {
  const n = issues.length
  const adj = Array.from({ length: n }, () => [])
  for (let i = 0; i < n; i++) {
    const row = []
    for (let j = 0; j < n; j++) {
      if (j !== i && sim[i * n + j] >= floor) row.push({ j, s: sim[i * n + j] })
    }
    row.sort((a, b) => b.s - a.s)
    for (const { j, s } of row.slice(0, k)) {
      const w = 1 - s
      adj[i].push({ j, w })
      adj[j].push({ j: i, w })
    }
  }

  const dist = new Float64Array(n * n).fill(Infinity)
  for (let src = 0; src < n; src++) {
    const d = new Float64Array(n).fill(Infinity)
    d[src] = 0
    const seen = new Uint8Array(n)
    for (let step = 0; step < n; step++) {
      let u = -1
      let best = Infinity
      for (let i = 0; i < n; i++) {
        if (!seen[i] && d[i] < best) {
          best = d[i]
          u = i
        }
      }
      if (u === -1) break
      seen[u] = 1
      for (const { j, w } of adj[u]) {
        if (d[u] + w < d[j]) d[j] = d[u] + w
      }
    }
    for (let i = 0; i < n; i++) dist[src * n + i] = d[i]
  }

  let maxFinite = 0
  for (let i = 0; i < n * n; i++) {
    if (Number.isFinite(dist[i]) && dist[i] > maxFinite) maxFinite = dist[i]
  }
  const far = (maxFinite || 1) * 1.15
  for (let i = 0; i < n * n; i++) {
    if (!Number.isFinite(dist[i])) dist[i] = far
  }
  return dist
}

/** Classical MDS on an arbitrary distance matrix. Coordinates are centred on the origin. */
export function mdsCoords(issues, dist) {
  const n = issues.length
  if (n === 0) return []
  if (n === 1) return [{ id: issues[0].id, x: 0, y: 0 }]

  const d2 = new Float64Array(n * n)
  for (let i = 0; i < n * n; i++) d2[i] = dist[i] * dist[i]

  const rowMean = new Float64Array(n)
  let grand = 0
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let j = 0; j < n; j++) s += d2[i * n + j]
    rowMean[i] = s / n
    grand += s
  }
  grand /= n * n

  const b = new Float64Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      b[i * n + j] = -0.5 * (d2[i * n + j] - rowMean[i] - rowMean[j] + grand)
    }
  }

  const first = powerIteration(b, n, [])
  const second = powerIteration(b, n, [first.vector])
  const s1 = Math.sqrt(Math.max(first.value, 0))
  const s2 = Math.sqrt(Math.max(second.value, 0))

  return issues.map((it, i) => ({ id: it.id, x: first.vector[i] * s1, y: second.vector[i] * s2 }))
}

/**
 * SMACOF stress majorization, seeded from the MDS projection.
 *
 * Classical MDS on geodesic distances puts almost all the variance on the first eigenvector here, so
 * the plane comes out as a line. Majorization optimises the 2D embedding directly and spreads the
 * clusters into an actual map. Deterministic: same seed coordinates, same result.
 */
export function stressMajorize(issues, dist, seed, iters = 140) {
  const n = issues.length
  if (n < 3) return seed.map((s) => ({ ...s }))

  let scale = 0
  let count = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      scale += dist[i * n + j]
      count++
    }
  }
  scale = count ? scale / count : 1

  const x = new Float64Array(n)
  const y = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    x[i] = seed[i].x
    // Break the near-degenerate second axis deterministically so majorization has room to work.
    y[i] = seed[i].y + Math.sin(i * 2.399963229728653) * scale * 0.01
  }

  const nx = new Float64Array(n)
  const ny = new Float64Array(n)
  for (let it = 0; it < iters; it++) {
    nx.fill(0)
    ny.fill(0)
    for (let i = 0; i < n; i++) {
      let ax = 0
      let ay = 0
      for (let j = 0; j < n; j++) {
        if (i === j) continue
        const dx = x[i] - x[j]
        const dy = y[i] - y[j]
        const cur = Math.hypot(dx, dy) || 1e-9
        const target = dist[i * n + j]
        ax += x[j] + (target * dx) / cur
        ay += y[j] + (target * dy) / cur
      }
      nx[i] = ax / (n - 1)
      ny[i] = ay / (n - 1)
    }
    x.set(nx)
    y.set(ny)
  }

  let cx = 0
  let cy = 0
  for (let i = 0; i < n; i++) {
    cx += x[i]
    cy += y[i]
  }
  cx /= n
  cy /= n
  return issues.map((it, i) => ({ id: it.id, x: x[i] - cx, y: y[i] - cy }))
}

/** Push overlapping boxes apart in place. Deterministic, converges fast at these counts. */
export function relaxOverlaps(nodes, padX = 10, padY = 8, rounds = 120) {
  for (let r = 0; r < rounds; r++) {
    let moved = 0
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]
        const c = nodes[j]
        const dx = c.x - a.x
        const dy = c.y - a.y
        const ox = (a.w + c.w) / 2 + padX - Math.abs(dx)
        const oy = (a.h + c.h) / 2 + padY - Math.abs(dy)
        if (ox <= 0 || oy <= 0) continue
        moved++
        if (ox / (a.w + c.w) < oy / (a.h + c.h)) {
          const push = (ox / 2) * (dx < 0 ? -1 : 1)
          a.x -= push
          c.x += push
        } else {
          const push = (oy / 2) * (dy < 0 ? -1 : 1)
          a.y -= push
          c.y += push
        }
      }
    }
    if (!moved) break
  }
  return nodes
}

// ---------------------------------------------------------------- sequence (layered DAG)

/**
 * Longest-path layering over the blocking graph, ordered within each layer by the barycentre of a
 * node's neighbours. Issues with no blocking relation are returned separately rather than dumped
 * into layer 0, which is the wart in the shipped plane.
 */
export function layerDag(issues) {
  const byId = new Map(issues.map((it) => [it.id, it]))
  const present = (ids) => (ids ?? []).filter((id) => byId.has(id))

  const connected = issues.filter((it) => present(it.blocks).length || present(it.blockedBy).length)
  const isolated = issues.filter((it) => !present(it.blocks).length && !present(it.blockedBy).length)

  const depth = new Map(connected.map((it) => [it.id, 0]))
  for (let pass = 0; pass < connected.length; pass++) {
    let changed = false
    for (const it of connected) {
      for (const b of present(it.blockedBy)) {
        const want = (depth.get(b) ?? 0) + 1
        if (want > (depth.get(it.id) ?? 0)) {
          depth.set(it.id, want)
          changed = true
        }
      }
    }
    if (!changed) break
  }

  const layers = []
  for (const it of connected) {
    const d = depth.get(it.id) ?? 0
    ;(layers[d] ??= []).push(it)
  }

  const order = new Map()
  for (const layer of layers) {
    layer?.forEach((it, i) => {
      order.set(it.id, i)
    })
  }
  for (let sweep = 0; sweep < 14; sweep++) {
    const dir = sweep % 2 === 0 ? "blockedBy" : "blocks"
    for (const layer of layers) {
      if (!layer) continue
      const bary = new Map()
      for (const it of layer) {
        const refs = present(it[dir])
        const vals = refs.map((id) => order.get(id)).filter((v) => v !== undefined)
        bary.set(it.id, vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : order.get(it.id))
      }
      layer.sort((a, b) => (bary.get(a.id) - bary.get(b.id)) || a.id.localeCompare(b.id))
      layer.forEach((it, i) => {
        order.set(it.id, i)
      })
    }
  }

  return { layers: layers.map((l) => l ?? []), isolated, depth }
}

// ---------------------------------------------------------------- grouping (squarified treemap)

// Aspect-ratio cost of laying `areas` along a side of length `len`. Lower is squarer.
function worst(areas, len) {
  if (!areas.length || len <= 0) return Infinity
  const sum = areas.reduce((a, b) => a + b, 0)
  if (sum <= 0) return Infinity
  const max = Math.max(...areas)
  const min = Math.min(...areas)
  return Math.max((len * len * max) / (sum * sum), (sum * sum) / (len * len * min))
}

/** Squarified treemap over `items` of `{ key, value }` inside a rect. Returns rects in order. */
export function treemap(items, x, y, w, h) {
  const out = []
  const total = items.reduce((a, b) => a + b.value, 0) || 1
  const scale = (w * h) / total
  const rest = items
    .slice()
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key))
    .map((it) => ({ key: it.key, area: Math.max(it.value * scale, 1) }))

  let rx = x, ry = y, rw = w, rh = h

  while (rest.length && rw > 0 && rh > 0) {
    const vertical = rw < rh
    const len = vertical ? rw : rh
    const row = []
    while (rest.length) {
      const areas = row.map((r) => r.area)
      const next = [...areas, rest[0].area]
      if (row.length && worst(next, len) > worst(areas, len)) break
      row.push(rest.shift())
    }
    const rowArea = row.reduce((a, b) => a + b.area, 0)
    const thick = Math.min(rowArea / len, vertical ? rh : rw)
    let offset = vertical ? rx : ry
    for (const item of row) {
      const share = item.area / thick
      out.push(
        vertical
          ? { key: item.key, x: offset, y: ry, w: share, h: thick }
          : { key: item.key, x: rx, y: offset, w: thick, h: share },
      )
      offset += share
    }
    if (vertical) {
      ry += thick
      rh -= thick
    } else {
      rx += thick
      rw -= thick
    }
  }
  return out
}

/** Pack `count` fixed-size cards into a `w`-wide column, returning per-index offsets. */
export function packGrid(count, w, cardW, cardH, gap = 6) {
  const cols = Math.max(1, Math.floor((w + gap) / (cardW + gap)))
  return Array.from({ length: count }, (_, i) => ({
    x: (i % cols) * (cardW + gap),
    y: Math.floor(i / cols) * (cardH + gap),
  }))
}
