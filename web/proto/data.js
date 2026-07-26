// Prototype-only synthetic project. Deterministic: same seed, same project, every load.
// The shipped seed (web/data/seed-b.json) has 34 issues, 8 edges, no labels and no parents, which is
// too thin to judge a relationship layout. This produces the shape the redesign has to survive.

const THEMES = [
  {
    key: "auth",
    label: "auth",
    milestone: "M1",
    nouns: ["session", "token", "login", "sso", "password", "mfa", "cookie", "refresh", "logout", "oauth"],
    verbs: ["expire", "rotate", "validate", "revoke", "issue", "verify"],
    subject: "sign-in",
  },
  {
    key: "matching",
    label: "matchmaking",
    milestone: "M1",
    nouns: ["candidate", "score", "ranking", "breed", "temperament", "compatibility", "queue", "pool", "weighting"],
    verbs: ["rank", "score", "filter", "boost", "penalize", "tune"],
    subject: "matchmaking",
  },
  {
    key: "profile",
    label: "profiles",
    milestone: "M2",
    nouns: ["profile", "photo", "bio", "avatar", "upload", "crop", "gallery", "field", "draft"],
    verbs: ["upload", "resize", "validate", "publish", "moderate", "edit"],
    subject: "profile",
  },
  {
    key: "chat",
    label: "chat",
    milestone: "M3",
    nouns: ["message", "thread", "typing", "receipt", "socket", "delivery", "unread", "notification", "presence"],
    verbs: ["deliver", "retry", "mark", "stream", "reconnect", "batch"],
    subject: "chat",
  },
  {
    key: "safety",
    label: "trust-safety",
    milestone: "M4",
    nouns: ["report", "block", "ban", "appeal", "review", "flag", "abuse", "queue", "audit"],
    verbs: ["flag", "escalate", "review", "suspend", "restore", "log"],
    subject: "moderation",
  },
  {
    key: "infra",
    label: "platform",
    milestone: "M2",
    nouns: ["migration", "index", "cache", "job", "worker", "backup", "replica", "shard", "metric"],
    verbs: ["migrate", "reindex", "warm", "drain", "shard", "instrument"],
    subject: "platform",
  },
  {
    key: "mobile",
    label: "mobile",
    milestone: "M3",
    nouns: ["screen", "gesture", "offline", "sync", "push", "deeplink", "layout", "keyboard"],
    verbs: ["sync", "cache", "handle", "render", "route", "restore"],
    subject: "mobile",
  },
]

const PEOPLE = [
  "Ada Lovelace",
  "Alan Turing",
  "Grace Hopper",
  "Katherine Johnson",
  "Barbara Liskov",
  "Unassigned",
]

const STATUSES = [
  { status: "Done", statusType: "completed", weight: 3 },
  { status: "In progress", statusType: "started", weight: 3 },
  { status: "Todo", statusType: "unstarted", weight: 5 },
  { status: "Backlog", statusType: "backlog", weight: 5 },
  { status: "Triage", statusType: "triage", weight: 4 },
  { status: "Canceled", statusType: "canceled", weight: 1 },
]

const ESTIMATES = [1, 1, 2, 2, 3, 3, 5, 5, 8, 13]

function mulberry32(a) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = (rnd, list) => list[Math.floor(rnd() * list.length)]

function weightedStatus(rnd) {
  const pool = STATUSES.flatMap((s) => Array(s.weight).fill(s))
  return pick(rnd, pool)
}

function sentence(rnd, theme, n) {
  const parts = []
  for (let i = 0; i < n; i++) parts.push(`${pick(rnd, theme.verbs)} the ${pick(rnd, theme.nouns)}`)
  return `${parts.join(", ")} so the ${theme.subject} path stays correct under load.`
}

/**
 * Build a synthetic project of roughly `count` issues across seven themes.
 *
 * Themes overlap deliberately: a fraction of issues borrow vocabulary from a neighbouring theme, so
 * text similarity finds clusters that milestone grouping does not.
 */
export function buildProject(count = 180, seed = 20260726) {
  const rnd = mulberry32(seed)
  const issues = []
  const cycles = [47, 48, 49, 50, 51, 52]

  for (let i = 0; i < count; i++) {
    const theme = THEMES[i % THEMES.length]
    const bleed = rnd() < 0.18 ? THEMES[(i + 3) % THEMES.length] : theme
    const st = weightedStatus(rnd)
    const id = `TLR-${(100 + i).toString()}`
    const noun = pick(rnd, theme.nouns)
    const verb = pick(rnd, theme.verbs)
    const title = `${verb[0].toUpperCase()}${verb.slice(1)} ${noun} on the ${bleed.subject} path`
    const labels = [theme.label]
    if (rnd() < 0.35) labels.push(bleed.label)
    if (rnd() < 0.25) labels.push(pick(rnd, ["bug", "chore", "spike", "regression"]))

    issues.push({
      id,
      title,
      url: `https://linear.app/proto/issue/${id}`,
      description: `${sentence(rnd, theme, 2)} ${rnd() < 0.4 ? sentence(rnd, bleed, 1) : ""}`.trim(),
      estimate: rnd() < 0.12 ? null : pick(rnd, ESTIMATES),
      assignee: pick(rnd, PEOPLE),
      status: st.status,
      statusType: st.statusType,
      labels: [...new Set(labels)],
      parentId: null,
      milestone: rnd() < 0.12 ? null : theme.milestone,
      cycle: st.statusType === "backlog" || st.statusType === "triage" ? null : pick(rnd, cycles),
      theme: theme.key,
      blocks: [],
      blockedBy: [],
      related: [],
    })
  }

  // Parents: every fifth theme run gets an epic that owns the next few issues.
  for (let i = 0; i < issues.length; i += 17) {
    const parent = issues[i]
    for (let k = 1; k <= 3 && i + k * 7 < issues.length; k++) {
      issues[i + k * 7].parentId = parent.id
    }
  }

  const byId = new Map(issues.map((it) => [it.id, it]))
  const link = (a, b) => {
    const from = byId.get(a)
    const to = byId.get(b)
    if (!from || !to || a === b) return
    if (!from.blocks.includes(b)) from.blocks.push(b)
    if (!to.blockedBy.includes(a)) to.blockedBy.push(a)
  }

  // Blocking stays sparse and mostly within a theme, which is what the real project measured.
  const themeBuckets = new Map()
  for (const it of issues) {
    if (!themeBuckets.has(it.theme)) themeBuckets.set(it.theme, [])
    themeBuckets.get(it.theme).push(it)
  }
  for (const bucket of themeBuckets.values()) {
    for (let i = 0; i + 1 < bucket.length; i++) {
      if (rnd() < 0.22) link(bucket[i].id, bucket[i + 1].id)
    }
    // one long chain per theme, so Sequence has real depth to show
    for (let i = 0; i + 4 < bucket.length; i += 9) {
      link(bucket[i].id, bucket[i + 2].id)
      link(bucket[i + 2].id, bucket[i + 4].id)
    }
  }

  // A few hand-curated "related" links, the channel Linear gives us and ingest currently discards.
  for (let i = 0; i + 11 < issues.length; i += 23) {
    issues[i].related.push(issues[i + 11].id)
    issues[i + 11].related.push(issues[i].id)
  }

  return {
    project: { name: "Horse Tinder (prototype)", key: "proto" },
    asOf: "2026-07-30",
    currentCycle: 49,
    cycles: cycles.map((n, i) => ({
      n,
      start: `2026-0${6 + Math.floor(i / 2)}-${((i * 14) % 28) + 1}`.replace(/-(\d)$/, "-0$1"),
      end: `2026-0${6 + Math.floor((i + 1) / 2)}-${(((i + 1) * 14) % 28) + 1}`.replace(/-(\d)$/, "-0$1"),
    })),
    milestones: [
      { key: "M1", name: "M1: Matchmaking engine", target: "2026-07-31" },
      { key: "M2", name: "M2: Stable profiles", target: "2026-09-15" },
      { key: "M3", name: "M3: Neigh-bors chat", target: "2026-09-30" },
      { key: "M4", name: "M4: Trust and safety", target: "2026-10-31" },
    ],
    issues,
  }
}
