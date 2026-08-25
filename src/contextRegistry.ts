// Which context sources a run has. One line per adapter, so a new source is a new file plus an entry
// here and nothing else changes (ADR 0011).
//
// A factory returns null when the source has no credential configured, which is not an error: a
// machine with a Pylon token and no GitHub token should still get its Pylon answers.

import type { ContextSource } from "@/contextSource.ts"

type Factory = () => Promise<ContextSource | null>

const ADAPTERS: Record<string, Factory> = {}

export function adapterNames(): string[] {
  return Object.keys(ADAPTERS).sort()
}

export async function configuredSources(
  names: string[] = adapterNames(),
): Promise<{ sources: ContextSource[]; unconfigured: string[] }> {
  const sources: ContextSource[] = []
  const unconfigured: string[] = []
  for (const name of names) {
    const factory = ADAPTERS[name]
    if (!factory) throw new Error(`unknown context source: ${name} (have ${adapterNames().join(", ") || "none"})`)
    const source = await factory()
    if (source) sources.push(source)
    else unconfigured.push(name)
  }
  return { sources, unconfigured }
}
