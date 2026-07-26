// Layout for the relationships plane. Pure: no DOM, no I/O, no randomness, so the same issues always
// produce the same coordinates and tests can assert positions directly.
//
// Three layouts, one card set. Card geometry never depends on the detail level, because a level that
// resizes the box forces a re-layout and makes fit-to-content and auto-detail chase each other.

export const GEOMETRY = {
  cardW: 168,
  cardMinH: 54,
  cardMaxH: 88,
  gap: 8,
  laneGap: 90,
  bandGap: 56,
  headerH: 22,
  pad: 40,
}

export const cardHeight = (issue, g = GEOMETRY) =>
  Math.max(g.cardMinH, Math.min(g.cardMaxH, g.cardMinH + (issue.estimate ?? 2) * 2.4))

const present = (ids, byId) => (ids ?? []).filter((id) => byId.has(id))

// ---------------------------------------------------------------- similarity placement

/**
 * Shortest-path distance over the k-nearest-neighbour similarity graph.
 *
 * Plain `1 - similarity` is unusable: most pairs score at or near zero, so the distance matrix is
 * nearly constant and any projection of it collapses. Walking the kNN graph gives between-cluster
 * distance real spread. Pairs in different components are pushed past the largest finite distance.
 */
export function geodesicDistances(issues, sim, k = 6, floor = 0.15) {
  const n = issues.length
  const adj = Array.from({ length: n }, () => [])
  for (let i = 0; i < n; i++) {
    const row = []
    for (let j = 0; j < n; j++) {
      if (j !== i && sim[i * n + j] >= floor) row.push({ j, score: sim[i * n + j] })
    }
    row.sort((a, b) => b.score - a.score || a.j - b.j)
    for (const { j, score } of row.slice(0, k)) {
      adj[i].push({ to: j, w: 1 - score })
      adj[j].push({ to: i, w: 1 - score })
    }
  }

  const dist = new Float64Array(n * n).fill(Infinity)
  for (let src = 0; src < n; src++) {
    const d = new Float64Array(n).fill(Infinity)
    const seen = new Uint8Array(n)
    d[src] = 0
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
      for (const { to, w } of adj[u]) {
        if (d[u] + w < d[to]) d[to] = d[u] + w
      }
    }
    dist.set(d, src * n)
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

function powerIteration(mat, n, exclude, iters = 200) {
  let v = new Float64Array(n)
  for (let i = 0; i < n; i++) v[i] = Math.sin(i * 12.9898)
  const orthogonalize = (x) => {
    for (const e of exclude) {
      let dot = 0
      for (let i = 0; i < n; i++) dot += x[i] * e[i]
      for (let i = 0; i < n; i++) x[i] -= dot * e[i]
    }
  }
  orthogonalize(v)
  let value = 0
  for (let step = 0; step < iters; step++) {
    const next = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      let acc = 0
      for (let j = 0; j < n; j++) acc += mat[i * n + j] * v[j]
      next[i] = acc
    }
    orthogonalize(next)
    let norm = 0
    for (let i = 0; i < n; i++) norm += next[i] * next[i]
    norm = Math.sqrt(norm)
    if (norm < 1e-12) break
    for (let i = 0; i < n; i++) next[i] /= norm
    value = norm
    v = next
  }
  return { vector: v, value }
}

/** Classical MDS on a distance matrix. Used only to seed the majorization pass below. */
export function mdsCoords(issues, dist) {
  const n = issues.length
  if (n === 0) return []
  if (n < 3) return issues.map((it, i) => ({ id: it.id, x: i * GEOMETRY.cardW, y: 0 }))

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
 * SMACOF stress majorization from a seed embedding.
 *
 * Classical MDS on geodesic distances puts nearly all the variance on the first eigenvector, so the
 * plane comes out as a line. Majorization optimises the two-dimensional embedding directly.
 */
export function stressMajorize(issues, dist, seed, iters = 140) {
  const n = issues.length
  if (n < 3) return seed.map((s) => ({ ...s }))

  let mean = 0
  let pairs = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      mean += dist[i * n + j]
      pairs++
    }
  }
  mean = pairs ? mean / pairs : 1

  const x = new Float64Array(n)
  const y = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    x[i] = seed[i].x
    // Deterministically break the degenerate second axis so majorization has room to move.
    y[i] = seed[i].y + Math.sin(i * 2.399963229728653) * mean * 0.01
  }

  const nx = new Float64Array(n)
  const ny = new Float64Array(n)
  for (let step = 0; step < iters; step++) {
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

/** Push overlapping boxes apart in place along their shallower axis of intersection. */
export function relaxOverlaps(nodes, padX = GEOMETRY.gap, padY = GEOMETRY.gap, rounds = 120) {
  for (let round = 0; round < rounds; round++) {
    let moved = 0
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]
        const b = nodes[j]
        const dx = b.x - a.x
        const dy = b.y - a.y
        const ox = (a.w + b.w) / 2 + padX - Math.abs(dx)
        const oy = (a.h + b.h) / 2 + padY - Math.abs(dy)
        if (ox <= 0 || oy <= 0) continue
        moved++
        if (ox / (a.w + b.w) < oy / (a.h + b.h)) {
          const push = (ox / 2) * (dx < 0 ? -1 : 1)
          a.x -= push
          b.x += push
        } else {
          const push = (oy / 2) * (dy < 0 ? -1 : 1)
          a.y -= push
          b.y += push
        }
      }
    }
    if (!moved) break
  }
  return nodes
}

const percentile = (sorted, f) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(f * (sorted.length - 1))))]

// ---------------------------------------------------------------- sequence

/**
 * Longest-path layering over the blocking graph, ordered within each layer by neighbour barycentre.
 *
 * Issues with no blocking relation come back separately rather than sitting in layer 0. Layer 0 means
 * "blocks something and nothing blocks it"; unrelated work is not the start of a chain.
 */
export function layerDag(issues) {
  const byId = new Map(issues.map((it) => [it.id, it]))
  const connected = issues.filter((it) => present(it.blocks, byId).length || present(it.blockedBy, byId).length)
  const isolated = issues.filter((it) => !present(it.blocks, byId).length && !present(it.blockedBy, byId).length)

  const depth = new Map(connected.map((it) => [it.id, 0]))
  for (let pass = 0; pass < connected.length; pass++) {
    let changed = false
    for (const it of connected) {
      for (const blocker of present(it.blockedBy, byId)) {
        const want = (depth.get(blocker) ?? 0) + 1
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
  for (let i = 0; i < layers.length; i++) layers[i] ??= []

  const order = new Map()
  for (const layer of layers) {
    layer.forEach((it, i) => {
      order.set(it.id, i)
    })
  }
  for (let sweep = 0; sweep < 14; sweep++) {
    const dir = sweep % 2 === 0 ? "blockedBy" : "blocks"
    for (const layer of layers) {
      const bary = new Map()
      for (const it of layer) {
        const vals = present(it[dir], byId).map((id) => order.get(id)).filter((v) => v !== undefined)
        bary.set(it.id, vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : order.get(it.id))
      }
      layer.sort((a, b) => (bary.get(a.id) - bary.get(b.id)) || a.id.localeCompare(b.id))
      layer.forEach((it, i) => {
        order.set(it.id, i)
      })
    }
  }
  return { layers, isolated, depth }
}

function layoutSequence(issues, g) {
  const { layers, isolated } = layerDag(issues)
  const nodes = []
  const bands = []
  let x = g.pad
  layers.forEach((layer, d) => {
    let y = g.pad + g.headerH
    for (const issue of layer) {
      const h = cardHeight(issue, g)
      nodes.push({ id: issue.id, issue, x, y, w: g.cardW, h })
      y += h + g.gap
    }
    bands.push({ key: d === 0 ? "Wave 0 · unblocked" : `Wave ${d}`, x, y: g.pad, w: g.cardW, h: 0 })
    x += g.cardW + g.laneGap
  })

  const startY = Math.max(g.pad, ...nodes.map((n) => n.y + n.h)) + g.bandGap + g.headerH
  const cols = Math.max(4, Math.round(Math.sqrt(isolated.length * 1.8)))
  const rowH = Math.max(0, ...isolated.map((it) => cardHeight(it, g))) + g.gap
  isolated.forEach((issue, i) => {
    nodes.push({
      id: issue.id,
      issue,
      x: g.pad + (i % cols) * (g.cardW + g.gap),
      y: startY + Math.floor(i / cols) * rowH,
      w: g.cardW,
      h: cardHeight(issue, g),
    })
  })
  if (isolated.length) {
    bands.push({ key: "No dependency", x: g.pad, y: startY - g.headerH, w: cols * (g.cardW + g.gap), h: 0 })
  }
  return { nodes, regions: [], bands, edges: blockingEdges(issues) }
}

/** One edge per blocking relation whose blocker is also on the plane. */
export function blockingEdges(issues) {
  const byId = new Map(issues.map((it) => [it.id, it]))
  const edges = []
  for (const it of issues) {
    for (const blocker of present(it.blockedBy, byId)) {
      edges.push({ from: blocker, to: it.id, kind: "block" })
    }
  }
  return edges
}

// ---------------------------------------------------------------- grouping

export function groupKeyOf(issue, groupBy) {
  if (groupBy === "cycle") return issue.cycle == null ? "No cycle" : `Cycle ${issue.cycle}`
  if (groupBy === "assignee") return issue.assignee ?? "Unassigned"
  if (groupBy === "parent") return issue.parentId ?? "No parent"
  if (groupBy === "label") return issue.labels?.[0] ?? "No label"
  return issue.milestone ?? "No milestone"
}

/**
 * Horizontal bands, one per group, widest group first.
 *
 * Bands beat a treemap here: a treemap sized by ticket count leaves dead space inside the larger
 * regions, and bands scan top to bottom like every other page in the product.
 */
function layoutGrouping(issues, g, { groupBy = "milestone", width = 1600 } = {}) {
  const groups = new Map()
  for (const issue of issues) {
    const key = groupKeyOf(issue, groupBy)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(issue)
  }
  const ordered = [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))

  const cols = Math.max(1, Math.floor((width - g.pad * 2 + g.gap) / (g.cardW + g.gap)))
  const nodes = []
  const regions = []
  let y = g.pad
  for (const [key, list] of ordered) {
    const rowH = Math.max(...list.map((it) => cardHeight(it, g))) + g.gap
    const rows = Math.ceil(list.length / cols)
    const h = g.headerH + rows * rowH
    regions.push({ key, x: g.pad, y, w: cols * (g.cardW + g.gap) - g.gap, h })
    list.forEach((issue, i) => {
      nodes.push({
        id: issue.id,
        issue,
        x: g.pad + (i % cols) * (g.cardW + g.gap),
        y: y + g.headerH + Math.floor(i / cols) * rowH,
        w: g.cardW,
        h: cardHeight(issue, g),
      })
    })
    y += h + g.bandGap
  }
  return { nodes, regions, bands: [], edges: [] }
}

// ---------------------------------------------------------------- similarity

function layoutSimilarity(issues, g, { coords, neighbors }) {
  const byIndex = new Map(coords.map((c, i) => [c.id, i]))
  const xs = coords.map((c) => c.x).sort((a, b) => a - b)
  const ys = coords.map((c) => c.y).sort((a, b) => a - b)
  // Robust span: coincident points make a nearest-neighbour scale explode and lone outliers make an
  // extent-based scale collapse, so take the middle 96% and size to a target area instead.
  const spanX = Math.max(percentile(xs, 0.98) - percentile(xs, 0.02), 1e-6)
  const spanY = Math.max(percentile(ys, 0.98) - percentile(ys, 0.02), 1e-6)
  const avgH = issues.reduce((a, it) => a + cardHeight(it, g), 0) / (issues.length || 1)
  const targetArea = issues.length * (g.cardW + g.gap) * (avgH + g.gap) * 3.2
  const k = Math.sqrt(targetArea / (spanX * spanY))

  const nodes = issues.map((issue) => {
    const c = coords[byIndex.get(issue.id)]
    return { id: issue.id, issue, x: c.x * k, y: c.y * k * 0.72, w: g.cardW, h: cardHeight(issue, g) }
  })
  relaxOverlaps(nodes, g.gap, g.gap)

  const edges = []
  const seen = new Set()
  for (const { id, neighbors: list } of neighbors) {
    for (const n of list.slice(0, 3)) {
      const key = id < n.id ? `${id}|${n.id}` : `${n.id}|${id}`
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ from: id, to: n.id, kind: "sim", score: n.score })
    }
  }
  return { nodes, regions: [], bands: [], edges }
}

// ---------------------------------------------------------------- entry point

/**
 * Place `issues` for one relationship mode.
 *
 * `similarity` requires `coords` and `neighbors` from web/lib/similarity.js; they are computed once
 * per snapshot rather than per render, because the projection does not depend on the filter.
 */
export function relationshipsLayout(mode, issues, options = {}) {
  const g = { ...GEOMETRY, ...(options.geometry ?? {}) }
  if (!issues.length) return { nodes: [], regions: [], bands: [], edges: [], width: g.pad * 2, height: g.pad * 2 }

  const laid = mode === "sequence"
    ? layoutSequence(issues, g)
    : mode === "grouping"
    ? layoutGrouping(issues, g, options)
    : layoutSimilarity(issues, g, options)

  const minX = Math.min(...laid.nodes.map((n) => n.x), g.pad)
  const minY = Math.min(...laid.nodes.map((n) => n.y), g.pad)
  const dx = g.pad - minX
  const dy = g.pad - minY
  for (const n of laid.nodes) {
    n.x += dx
    n.y += dy
  }
  for (const r of [...laid.regions, ...laid.bands]) {
    r.x += dx
    r.y += dy
  }

  return {
    ...laid,
    width: Math.max(...laid.nodes.map((n) => n.x + n.w)) + g.pad,
    height: Math.max(...laid.nodes.map((n) => n.y + n.h)) + g.pad,
  }
}
