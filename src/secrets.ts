// One audited path for every API secret, so no script hand-rolls its own keychain read. A secret comes
// from its environment variable if set, else the macOS keychain via a `security` shell-out. The lookup
// passes an argument array (no shell string), so a service/account value can never inject a command.
// Secrets are returned to callers for an Authorization header and never logged.
//
// This is ADR 0007's SecretStore split in a pragmatic form: the env path IS the backend a Linux/VM
// deploy uses (no keychain there), and `security` being absent off macOS falls through to env cleanly.
//
// Writes (`setSecret`/`deleteSecret`) only ever touch the keychain, so they are macOS-only: an env var
// wins over the keychain on read, which makes writing one behind a set env var a silent no-op, and the
// store refuses it instead. `describeSecret` reports presence and provenance without the value, so a
// UI can render state it must never be allowed to read back.

export type SecretName = "linear" | "linear-demo" | "incidentio"

export type SecretSource = "env" | "keychain" | "unset"

export type SecretStatus = {
  name: SecretName
  label: string
  env: string
  service: string
  account: string
  source: SecretSource
  editable: boolean
  note: string
}

type SecretSpec = { env: string; service: string; account: string; label: string }

const MAX_SECRET_LENGTH = 4096

const SECRETS: Record<SecretName, SecretSpec> = {
  "incidentio": { env: "INCIDENT_IO_TOKEN", service: "tlr-incidentio", account: "api-key", label: "Incident.io token" },
  "linear": { env: "LINEAR_API_KEY", service: "tlr-linear", account: "api-key", label: "Linear key" },
  "linear-demo": {
    env: "LINEAR_DEMO_API_KEY",
    service: "tlr-linear",
    account: "demo-key",
    label: "Linear demo key",
  },
}

async function fromKeychain(service: string, account: string): Promise<string | null> {
  try {
    const cmd = new Deno.Command("security", {
      args: ["find-generic-password", "-s", service, "-a", account, "-w"],
      stdout: "piped",
      stderr: "null",
    })
    const { code, stdout } = await cmd.output()
    if (code !== 0) return null
    return new TextDecoder().decode(stdout).trim()
  } catch {
    // `security` is macOS-only; off macOS (a Linux deploy) there is no keychain, so use env vars.
    return null
  }
}

/** Resolve a secret from its env var, else the macOS keychain. Throws with the store-it hint if unset. */
export async function getSecret(name: SecretName): Promise<string> {
  const spec = SECRETS[name]
  const env = Deno.env.get(spec.env)
  if (env) return env.trim()
  const fromStore = await fromKeychain(spec.service, spec.account)
  if (fromStore) return fromStore
  throw new Error(
    `no ${spec.label}: set ${spec.env} or store one with\n` +
      `  security add-generic-password -s ${spec.service} -a ${spec.account} -w`,
  )
}

export function isSecretName(name: unknown): name is SecretName {
  return typeof name === "string" && name in SECRETS
}

/**
 * Trim a submitted secret and reject what the keychain cannot hold. Never puts the value in the error,
 * because the message travels back to the browser and into the log.
 */
export function normalizeSecretValue(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected the secret as a string")
  const trimmed = value.trim()
  if (!trimmed) throw new Error("the secret is empty")
  if (trimmed.length > MAX_SECRET_LENGTH) throw new Error(`the secret is longer than ${MAX_SECRET_LENGTH} characters`)
  const hasControlChar = [...trimmed].some((ch) => {
    const code = ch.codePointAt(0) ?? 0
    return code < 0x20 || code === 0x7f
  })
  if (hasControlChar) throw new Error("the secret contains a control character")
  return trimmed
}

/** Presence and provenance of one secret, with no I/O. `found` is what the env and keychain lookups saw. */
export function secretStatus(
  name: SecretName,
  found: { env: boolean; keychain: boolean },
  keychainWritable: boolean,
): SecretStatus {
  const spec = SECRETS[name]
  const source: SecretSource = found.env ? "env" : found.keychain ? "keychain" : "unset"
  return {
    name,
    label: spec.label,
    env: spec.env,
    service: spec.service,
    account: spec.account,
    source,
    editable: keychainWritable && source !== "env",
    note: statusNote(spec, source, keychainWritable),
  }
}

function statusNote(spec: SecretSpec, source: SecretSource, keychainWritable: boolean): string {
  if (source === "env") {
    return `Read from the ${spec.env} environment variable, which wins over the keychain. Unset it to edit here.`
  }
  if (!keychainWritable) {
    return `The keychain is macOS-only. On this host, set ${spec.env} in the environment.`
  }
  if (source === "keychain") return `Stored in the macOS keychain as ${spec.service} / ${spec.account}.`
  return `Not set. Paste a value to store it in the macOS keychain as ${spec.service} / ${spec.account}.`
}

function canWriteKeychain(): boolean {
  return Deno.build.os === "darwin"
}

/** Presence and provenance of a secret. Reads the store but never returns the value. */
export async function describeSecret(name: SecretName): Promise<SecretStatus> {
  const spec = SECRETS[name]
  const env = Boolean(Deno.env.get(spec.env)?.trim())
  const keychain = env ? false : (await fromKeychain(spec.service, spec.account)) !== null
  return secretStatus(name, { env, keychain }, canWriteKeychain())
}

// The value goes in on stdin (twice, for `security`'s own confirmation prompt) rather than as an
// argument, so it never appears in the process table.
async function keychainSet(spec: SecretSpec, value: string): Promise<void> {
  const cmd = new Deno.Command("security", {
    args: ["add-generic-password", "-U", "-s", spec.service, "-a", spec.account, "-w"],
    stdin: "piped",
    stdout: "null",
    stderr: "null",
  })
  const child = cmd.spawn()
  const writer = child.stdin.getWriter()
  await writer.write(new TextEncoder().encode(`${value}\n${value}\n`))
  await writer.close()
  const { code } = await child.status
  if (code !== 0) throw new Error(`the keychain refused the write (security exited ${code})`)
}

async function keychainDelete(spec: SecretSpec): Promise<void> {
  const cmd = new Deno.Command("security", {
    args: ["delete-generic-password", "-s", spec.service, "-a", spec.account],
    stdout: "null",
    stderr: "null",
  })
  await cmd.output()
}

/** Store a secret in the macOS keychain. Refuses when the env var already shadows it, or off macOS. */
export async function setSecret(name: SecretName, value: unknown): Promise<SecretStatus> {
  const secret = normalizeSecretValue(value)
  assertWritable(await describeSecret(name))
  await keychainSet(SECRETS[name], secret)
  return await describeSecret(name)
}

/** Remove a secret from the macOS keychain. Succeeds when there was nothing stored. */
export async function deleteSecret(name: SecretName): Promise<SecretStatus> {
  assertWritable(await describeSecret(name))
  await keychainDelete(SECRETS[name])
  return await describeSecret(name)
}

function assertWritable(status: SecretStatus): void {
  if (status.editable) return
  if (status.source === "env") {
    throw new Error(`${status.label} comes from ${status.env}; unset that variable to manage it here`)
  }
  throw new Error(`${status.label} cannot be written on this host: the keychain is macOS-only, so set ${status.env}`)
}
