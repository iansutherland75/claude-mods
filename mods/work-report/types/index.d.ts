export type Kind = 'emails' | 'media' | 'documents' | 'research' | 'other'

// One calendar day: how many tasks of each kind, and how many each model did.
export type DayRecord = {
  kinds: Partial<Record<Kind, number>>
  models: Record<string, number>
}

export type Settings = {
  rate: number
  minutes: Record<Kind, number>
}

export type Tab = 'today' | 'week' | 'month' | 'year'

declare module 'claude-code' {
  interface PluginState {
    'work-report': {
      days: Record<string, DayRecord>
      settings: Settings
      tab: Tab
    }
  }
}
