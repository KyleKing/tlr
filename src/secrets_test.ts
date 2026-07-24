import { assert, assertEquals, assertRejects } from "@std/assert"
import { getSecret } from "@/secrets.ts"

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
