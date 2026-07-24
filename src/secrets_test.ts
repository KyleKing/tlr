import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert"
import {
  deleteSecret,
  describeSecret,
  getSecret,
  isSecretName,
  normalizeSecretValue,
  secretStatus,
  setSecret,
} from "@/secrets.ts"

Deno.test("getSecret returns the env var when set, trimmed", async () => {
  Deno.env.set("LINEAR_API_KEY", "  lin_abc  ")
  try {
    assertEquals(await getSecret("linear"), "lin_abc")
  } finally {
    Deno.env.delete("LINEAR_API_KEY")
  }
})

Deno.test("getSecret keeps the demo key on its own env var", async () => {
  Deno.env.set("LINEAR_DEMO_API_KEY", "lin_demo")
  try {
    assertEquals(await getSecret("linear-demo"), "lin_demo")
  } finally {
    Deno.env.delete("LINEAR_DEMO_API_KEY")
  }
})

Deno.test("getSecret errors with a store-it hint when nothing is set", async () => {
  // No env var and no keychain entry for this made-up service in CI.
  Deno.env.delete("INCIDENT_IO_TOKEN")
  const err = await assertRejects(() => getSecret("incidentio"), Error)
  assert(err.message.includes("INCIDENT_IO_TOKEN"))
  assert(err.message.includes("security add-generic-password"))
})

Deno.test("isSecretName accepts only the known names", () => {
  assert(isSecretName("linear"))
  assert(isSecretName("incidentio"))
  assert(!isSecretName("linear-prod"))
  assert(!isSecretName(7))
})

Deno.test("normalizeSecretValue trims and rejects what the keychain cannot hold", () => {
  assertEquals(normalizeSecretValue("  lin_abc\n"), "lin_abc")
  assertThrows(() => normalizeSecretValue(""), Error, "empty")
  assertThrows(() => normalizeSecretValue("   "), Error, "empty")
  assertThrows(() => normalizeSecretValue(42), Error, "string")
  assertThrows(() => normalizeSecretValue("lin\u0007abc"), Error, "control character")
  assertThrows(() => normalizeSecretValue("x".repeat(4097)), Error, "longer than")
})

Deno.test("normalizeSecretValue never echoes the value it rejected", () => {
  const err = assertThrows(() => normalizeSecretValue("lin_supersecret"), Error)
  assert(!err.message.includes("lin_supersecret"))
})

Deno.test("secretStatus reports an env-sourced secret as read-only and says why", () => {
  const status = secretStatus("linear", { env: true, keychain: true }, true)
  assertEquals(status.source, "env")
  assertEquals(status.editable, false)
  assert(status.note.includes("LINEAR_API_KEY"))
})

Deno.test("secretStatus marks a keychain-backed secret editable on macOS", () => {
  const status = secretStatus("incidentio", { env: false, keychain: true }, true)
  assertEquals(status.source, "keychain")
  assertEquals(status.editable, true)
  assert(status.note.includes("tlr-incidentio"))
})

Deno.test("secretStatus refuses editing where there is no keychain to write to", () => {
  const status = secretStatus("incidentio", { env: false, keychain: false }, false)
  assertEquals(status.source, "unset")
  assertEquals(status.editable, false)
  assert(status.note.includes("macOS-only"))
})

Deno.test("describeSecret reports presence without the value", async () => {
  Deno.env.set("LINEAR_API_KEY", "lin_abc")
  try {
    const status = await describeSecret("linear")
    assertEquals(status.source, "env")
    assertEquals(status.editable, false)
    assert(!JSON.stringify(status).includes("lin_abc"))
  } finally {
    Deno.env.delete("LINEAR_API_KEY")
  }
})

Deno.test("writes are refused while the env var shadows the keychain", async () => {
  Deno.env.set("LINEAR_API_KEY", "lin_abc")
  try {
    const onSet = await assertRejects(() => setSecret("linear", "lin_other"), Error)
    assert(onSet.message.includes("LINEAR_API_KEY"))
    assert(!onSet.message.includes("lin_other"))
    const onDelete = await assertRejects(() => deleteSecret("linear"), Error)
    assert(onDelete.message.includes("LINEAR_API_KEY"))
  } finally {
    Deno.env.delete("LINEAR_API_KEY")
  }
})
