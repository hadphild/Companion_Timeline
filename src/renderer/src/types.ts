export type ExecutionMode = 'concurrent' | 'sequential' | 'inherit'

export interface CompanionAction {
  id: string
  action: string
  instance: string
  options: Record<string, unknown>
  delay: number
  disabled?: boolean
  // action_group: nested child actions keyed by set name (always "default")
  children?: Record<string, CompanionAction[]>
}

export interface ActionSets {
  down?: CompanionAction[]
  up?: CompanionAction[]
  rotate_left?: CompanionAction[]
  rotate_right?: CompanionAction[]
  [holdMs: string]: CompanionAction[] | undefined
}

export interface StepOptions {
  runWhileHeld?: number[]
}

export interface Step {
  action_sets: ActionSets
  options?: StepOptions
}

export interface ButtonStyle {
  text?: string
  size?: string | number
  image?: string | null  // data URI extracted from Companion v5 image layer
  png?: string | null
  alignment?: string
  pngalignment?: string
  color?: number
  bgcolor?: number
  show_topbar?: string | boolean
}

export interface ButtonOptions {
  relativeDelay?: boolean
  stepAutoProgress?: boolean
}

export interface Feedback {
  id: string
  type: string
  instance_id: string
  options: Record<string, unknown>
  style?: Partial<ButtonStyle>
}

export interface ButtonControl {
  type: 'button'
  style: ButtonStyle
  options: ButtonOptions
  feedbacks: Feedback[]
  steps: Record<string, Step>
  _v5id?: string  // Companion v5 SQLite control ID, used for live socket sync
}

export interface PageControl {
  type: 'pageup' | 'pagenum' | 'pagedown'
}

export interface TriggerControl {
  type: 'trigger'
  options: {
    name: string
    enabled: boolean
    sortOrder: number
    relativeDelay: boolean
  }
  action_sets: Record<string, CompanionAction[]>
  condition: unknown[]
  events: unknown[]
}

export type Control = ButtonControl | PageControl | TriggerControl

export interface CompanionInstance {
  instance_type: string
  label: string
  isFirstInit?: boolean
  config?: Record<string, unknown>
  enabled?: boolean
  lastUpgradeIndex?: number
}

export interface PageInfo {
  name?: string
  id?: string  // Companion v5 page UUID (stored in pages table value.id)
}

export interface CompanionConfig {
  version?: number
  type?: string
  controls: Record<string, Control>
  page?: Record<string, PageInfo>
  custom_variables?: Record<string, unknown>
  instances?: Record<string, CompanionInstance>
  oldPageNumber?: number
  gridSize?: { columns: number; rows: number }
}

// Parsed bank key: "bank:PAGE-SLOT"
export interface BankRef {
  key: string
  page: number
  slot: number
}

export function parseBankKey(key: string): BankRef | null {
  const m = key.match(/^bank:(\d+)-(\d+)$/)
  if (!m) return null
  return { key, page: parseInt(m[1]), slot: parseInt(m[2]) }
}

export function intToColor(n: number): string {
  const hex = (n >>> 0).toString(16).padStart(6, '0')
  return `#${hex}`
}

// A trigger key (hold duration or named event) for a track row
export type TriggerKey = 'down' | 'up' | 'rotate_left' | 'rotate_right' | `${number}`

export function triggerLabel(key: TriggerKey): string {
  if (key === 'down') return 'Press'
  if (key === 'up') return 'Release'
  if (key === 'rotate_left') return 'Rotate ←'
  if (key === 'rotate_right') return 'Rotate →'
  const ms = parseInt(key)
  if (!isNaN(ms)) {
    if (ms >= 1000) return `Hold ${ms / 1000}s`
    return `Hold ${ms}ms`
  }
  return key
}
