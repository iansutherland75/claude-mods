export type Kind = 'emails' | 'media' | 'building' | 'documents' | 'research' | 'other'

// One project's share of a day: tasks of each kind, and the lines of code
// each Building task wrote (one number per task, so the size estimate can be
// worked out again when the settings change).
export type ProjectDay = {
  kinds: Partial<Record<Kind, number>>
  buildLines?: number[]
}

// One calendar day: how many tasks of each kind, how many each model did,
// the lines each Building task wrote, and the same split by project.
export type DayRecord = {
  kinds: Partial<Record<Kind, number>>
  models: Record<string, number>
  buildLines?: number[]
  projects?: Record<string, ProjectDay>
}

// Hours the person added by hand for work older than the session history.
export type ManualEntry = {
  id: string
  project: string
  hours: number
  date: string
}

export type Settings = {
  rate: number
  minutes: Record<Kind, number>
  buildRate: number
}

export type Tab = 'today' | 'week' | 'month' | 'year'

declare module 'claude-code' {
  interface PluginState {
    'work-report': {
      days: Record<string, DayRecord>
      settings: Settings
      tab: Tab
      manual: ManualEntry[]
    }
  }
}
