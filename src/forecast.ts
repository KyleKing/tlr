// Typed wrapper over the pure milestone slip forecast in web/lib/planning.js, so the CLI and the
// browser board share one implementation. See milestoneForecast there for the model. The forecast is
// always labeled a forecast, never a real date.

import { liveSnapshot } from "../web/lib/issues.js"
import { milestoneForecast as _milestoneForecast } from "../web/lib/planning.js"
import type { Snapshot } from "@/seed.ts"

export type MilestoneForecast = {
  key: string
  name: string
  target: string
  remainingPoints: number
  completedPoints: number
  weeksNeeded: number
  landing: string
  slipDays: number
  status: "ahead" | "on-track" | "at-risk"
}

export type Forecast = {
  asOf: string
  teamWeeklyPoints: number
  milestones: MilestoneForecast[]
}

export function milestoneForecast(snapshot: Snapshot, weeklyPoints?: number): Forecast {
  return _milestoneForecast(liveSnapshot(snapshot), weeklyPoints) as Forecast
}
