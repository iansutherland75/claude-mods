export type Question = { question: string; options: string[] }

export type Answer =
  | { kind: 'option'; text: string }
  | { kind: 'other'; text: string }
  | { kind: 'skip' }

export type Step =
  | 'compose'
  | 'reading'
  | 'questions'
  | 'rewrite'
  | 'review'
  | 'error'

export type Flow = {
  id: string
  original: string
  step: Step
  questions: Question[]
  answers: (Answer | null)[]
  otherOpen: number | null
  upgraded: string
  added: string[]
  pending: 'questions' | 'rewrite' | null
  runId: number
  error: { at: 'questions' | 'rewrite'; message: string } | null
  isEditing: boolean
  copyNote: 'copied' | 'failed' | null
}

export type Outcome = 'ready' | 'ran' | 'copied' | 'cancelled'

export type HistoryEntry = {
  id: string
  at: number
  original: string
  upgraded: string
  added: string[]
  outcome: Outcome
}

export type View = 'flow' | 'history'

declare module 'claude-code' {
  interface PluginState {
    'prompt-upgrade': {
      flow: Flow | null
      view: View
      auto: boolean
      history: HistoryEntry[]
    }
  }
}
