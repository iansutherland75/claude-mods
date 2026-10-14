// The shared state of the AI Employee Kit. Other mods read the checklist from
// here: { plugin: 'ai-employee-kit', key: 'checklist' }.

export type CleanViewPhase = 'idle' | 'working' | 'needsYou' | 'stuck' | 'stopped' | 'done'

export type CleanViewTaskStatus = 'done' | 'active' | 'upcoming'

export type CleanViewTask = {
  id: string
  name: string
  status: CleanViewTaskStatus
  percent: number
  hasReported: boolean
}

// Where the rows came from: placeholders until a plan arrives, then Claude's
// plan_steps, or its to-do list (TodoWrite, TaskCreate, the desktop task list).
export type CleanViewSource = 'placeholder' | 'plan' | 'list'

export type CleanViewChecklist = {
  jobId: number
  title: string
  phase: CleanViewPhase
  tasks: CleanViewTask[]
  source: CleanViewSource
  needsYouReason: string | null
  stuckReason: string | null
  startedAt: number
  finishedAt: number | null
  isCollapsed: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'ai-employee-kit': {
      cleanViewEnabled: boolean
      checklist: CleanViewChecklist | null
      tick: number
    }
  }
}
