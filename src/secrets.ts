// One audited path for every API secret, so no script hand-rolls its own keychain read. A secret comes
// from its environment variable if set, else the macOS keychain via a `security` shell-out. The lookup
// passes an argument array (no shell string), so a service/account value can never inject a command.
// Secrets are returned to callers for an Authorization header and never logged.
//
// This is ADR 0007's SecretStore split in a pragmatic form: the env path IS the backend a Linux/VM
// deploy uses (no keychain there), and `security` being absent off macOS falls through to env cleanly.

export type SecretName = "linear" | "linear-demo" | "incidentio"

type SecretSpec = { env: string; service: string; account: string; label: string }

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
