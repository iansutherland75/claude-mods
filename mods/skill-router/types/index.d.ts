// Where a subagent's card stands: Jev is being asked, the agent runs, it
// finished, it stopped early, or the spawn was refused.
export type CardStage = 'routing' | 'running' | 'done' | 'stopped' | 'denied'

// One subagent on the Agents pane.
export type AgentCard = {
  // This mod's own id for the card. A workflow's agents share one tool_use_id,
  // so that can't be the key.
  id: string
  agentId?: string
  type: string
  task: string
  stage: CardStage
  // The model it runs on, as the spawn resolved it; null while routing.
  model: string | null
  // How the model was chosen; absent when agent routing is off.
  source?: 'pin' | 'jev' | 'kept' | 'explicit'
  // The tiers Jev was offered, its pick and how sure it was.
  offered?: string[]
  pick?: string | null
  probability?: number
  jevMs?: number
  note?: string
  tools: number
  lastTool?: string
  // Tool calls a run of this agent type usually takes, from the log.
  expected: number
  startedAt: number
  endedAt?: number
  tokensIn?: number
  tokensOut?: number
}

// Where agents show unasked: the band above the chat box, the pane, or nowhere.
export type AgentsView = 'band' | 'pane' | 'off'

declare module 'claude-code' {
  interface PluginState {
    'skill-router': {
      agents: AgentCard[]
      view: AgentsView
    }
  }
}
