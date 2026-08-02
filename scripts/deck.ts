// Scaffolds and drives Slidev decks under presentations/decks/. Slidev is npm/Vite, so every
// command here is a thin wrapper around npm run inside the deck directory; nothing about a deck
// is checked, linted, or typed by Deno (see the presentations/** excludes in hk.pkl).

const ROOT = new URL("../presentations/", import.meta.url)
const TEMPLATE = new URL("template/", ROOT)
const DECKS = new URL("decks/", ROOT)
const THEME = new URL("slidev-theme-roughdraft/", ROOT)

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/

function deckDir(name: string): URL {
  return new URL(`${name}/`, DECKS)
}

async function exists(path: URL): Promise<boolean> {
  return await Deno.stat(path).then(() => true).catch(() => false)
}

async function listDecks(): Promise<string[]> {
  const names: string[] = []
  try {
    for await (const entry of Deno.readDir(DECKS)) {
      if (entry.isDirectory) names.push(entry.name)
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }
  return names.sort()
}

async function copyTree(from: URL, to: URL): Promise<void> {
  await Deno.mkdir(to, { recursive: true })
  for await (const entry of Deno.readDir(from)) {
    const source = new URL(entry.name, from)
    const target = new URL(entry.name, to)
    if (entry.isDirectory) {
      await copyTree(new URL(`${entry.name}/`, from), new URL(`${entry.name}/`, to))
    } else {
      await Deno.copyFile(source, target)
    }
  }
}

async function run(command: string, args: string[], cwd: URL): Promise<number> {
  const child = new Deno.Command(command, { args, cwd, stdout: "inherit", stderr: "inherit" }).spawn()
  return (await child.status).code
}

async function install(dir: URL, label: string): Promise<void> {
  if (await exists(new URL("node_modules/", dir))) return
  console.log(`installing ${label} dependencies...`)
  const code = await run("npm", ["install"], dir)
  if (code !== 0) throw new Error(`npm install failed in ${dir.pathname}`)
}

// The theme is linked with `file:`, and npm does not install a linked package's own
// dependencies into the consumer. Without this the build fails to resolve @fontsource.
async function ensureInstalled(dir: URL): Promise<void> {
  await install(THEME, "theme")
  await install(dir, "deck")
}

async function newDeck(name: string): Promise<void> {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`"${name}" is not a usable directory name (lowercase, digits, and dashes)`)
  }
  const dir = deckDir(name)
  if (await exists(dir)) throw new Error(`presentations/decks/${name} already exists`)

  await copyTree(TEMPLATE, dir)

  const manifestPath = new URL("package.json", dir)
  const manifest = JSON.parse(await Deno.readTextFile(manifestPath))
  manifest.name = `deck-${name}`
  await Deno.writeTextFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  console.log(`created presentations/decks/${name}`)
  console.log("write the content in plain markdown first, then pick a layout per slide")
  console.log(`present it with: deno task deck dev ${name}`)
}

async function inDeck(name: string, script: string): Promise<number> {
  const dir = deckDir(name)
  if (!(await exists(dir))) throw new Error(`no deck named "${name}" (try: deno task deck list)`)
  await ensureInstalled(dir)
  return await run("npm", ["run", script], dir)
}

const USAGE = `usage: deno task deck <command> [name]

  new <name>      scaffold presentations/decks/<name> from the template
  dev <name>      run the Slidev dev server and open it
  build <name>    build the static deck into the deck's dist/
  export <name>   export the deck to PDF
  list            show every deck under presentations/decks/`

if (import.meta.main) {
  const [command, name] = Deno.args
  try {
    if (command === "list") {
      const names = await listDecks()
      console.log(names.length ? names.join("\n") : "no decks yet (try: deno task deck new <name>)")
    } else if (command === "new" && name) {
      await newDeck(name)
    } else if ((command === "dev" || command === "build" || command === "export") && name) {
      Deno.exit(await inDeck(name, command))
    } else {
      console.log(USAGE)
      Deno.exit(command ? 1 : 0)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    Deno.exit(1)
  }
}
