import { z } from "zod"

const PROD_ENV = "production"

function isProduction() {
  return (Deno.env.get("NODE_ENV") || "") === PROD_ENV
}

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", PROD_ENV, "test"]).default("development"),
  PORT: z.preprocess(
    (val) => {
      if (val) return val
      return "8000"
    },
    z.coerce.number().int().min(1).max(65535),
  ),
  HOST: z.preprocess(
    (val) => {
      if (val) return val
      return isProduction() ? "0.0.0.0" : "localhost"
    },
    z.string(),
  ),
  LOG_LEVEL: z.preprocess(
    (val) => {
      if (val) return val
      return isProduction() ? "info" : "debug"
    },
    z.enum(["trace", "debug", "info", "warning", "error", "fatal"]),
  ),
  // Demo mode points writes at the free/test workspace (keychain account demo-key) and shows a banner.
  // Live mode (the default) uses the real workspace key (account api-key). Set TLR_DEMO=1 to opt in.
  DEMO: z.preprocess((val) => val === "1" || val === "true", z.boolean()),
})

export type EnvConfig = z.infer<typeof envSchema>

export function getEnvConfig(): EnvConfig {
  return envSchema.parse({
    NODE_ENV: Deno.env.get("NODE_ENV"),
    PORT: Deno.env.get("PORT"),
    HOST: Deno.env.get("HOST"),
    LOG_LEVEL: Deno.env.get("LOG_LEVEL"),
    DEMO: Deno.env.get("TLR_DEMO"),
  })
}
