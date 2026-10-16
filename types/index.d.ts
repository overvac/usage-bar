export type Limit = {
  /** `five_hour`, `seven_day`, or a gateway's `spend_limit`. */
  kind: string
  percentUsed: number
  /** ISO 8601 time the window resets. */
  resetsAt?: string
}

export type Usage = {
  costUsd?: number
  contextPercent?: number
  limits: Limit[]
  /** `$.clock.now()` milliseconds when any figure last changed. */
  changedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-bar': { usage: Usage | null; isHidden: boolean }
  }
}
