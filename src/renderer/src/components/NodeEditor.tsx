import React, { useMemo, useCallback, useState, useEffect } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  BackgroundVariant,
  type Node,
  Handle,
  Position,
  type NodeProps,
  useNodesState,
  useEdgesState,
  useReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  ButtonControl,
  CompanionAction,
  TriggerKey,
  triggerLabel,
  CompanionInstance,
} from '../types'

// ---- Node data shapes ----

interface TriggerData { label: string; triggerKey: TriggerKey; stepKey: string }
interface ActionData  { action: CompanionAction; triggerKey: TriggerKey; stepKey: string; instanceLabel: string; isSelected: boolean }
interface WaitData    { ms: number }
interface GroupData   { action: CompanionAction; triggerKey: TriggerKey; stepKey: string; isSelected: boolean; childCount: number; mode: string }

// ---- Custom node components ----

function TriggerNode({ data }: NodeProps) {
  const d = data as unknown as TriggerData
  return (
    <div className="ne-node ne-trigger">
      <div className="ne-trigger-label">{d.label}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

function ActionNode({ data }: NodeProps) {
  const d = data as unknown as ActionData
  return (
    <div className={`ne-node ne-action${d.isSelected ? ' ne-action--selected' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <div className="ne-action-name">{d.action.action || '(new)'}</div>
      <div className="ne-action-inst">{d.instanceLabel}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

function WaitNode({ data }: NodeProps) {
  const d = data as unknown as WaitData
  const label = d.ms >= 1000
    ? `${(d.ms / 1000).toFixed(d.ms % 1000 === 0 ? 0 : 1)}s`
    : `${d.ms}ms`
  return (
    <div className="ne-node ne-wait">
      <Handle type="target" position={Position.Top} />
      <span className="ne-wait-label">⏱ {label}</span>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

function GroupNode({ data }: NodeProps) {
  const d = data as unknown as GroupData
  const modeLabel =
    d.mode === 'sequential' ? 'Sequential' :
    d.mode === 'concurrent' ? 'Concurrent' : 'Inherit'
  return (
    <div className={`ne-node ne-group${d.isSelected ? ' ne-group--selected' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <div className="ne-group-mode">{modeLabel}</div>
      <div className="ne-group-label">Action Group</div>
      <div className="ne-group-count">
        {d.childCount} action{d.childCount !== 1 ? 's' : ''}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

const nodeTypes = {
  trigger: TriggerNode,
  action: ActionNode,
  wait: WaitNode,
  group: GroupNode,
}

// ---- Layout constants ----
const COL_WIDTH = 200
const COL_GAP   = 100
const TRIGGER_H = 52
const ACTION_H  = 72
const WAIT_H    = 42
const GROUP_H   = 90
const NODE_GAP  = 32

// ---- Build graph from ButtonControl ----

function buildGraph(
  control: ButtonControl,
  stepKey: string,
  instances: Record<string, CompanionInstance>,
  selectedActionId: string | null
): { nodes: Node[] } {
  const nodes: Node[] = []

  const step = control.steps[stepKey]
  if (!step) return { nodes }

  const triggerKeys = Object.keys(step.action_sets)
  const STANDARD = ['down', 'up', 'rotate_left', 'rotate_right']
  const ordered = [
    ...STANDARD.filter(t => triggerKeys.includes(t)),
    ...triggerKeys.filter(t => !STANDARD.includes(t)).sort(),
  ] as TriggerKey[]

  ordered.forEach((triggerKey, colIdx) => {
    const actions = [...(step.action_sets[triggerKey] ?? [])].sort((a, b) => a.delay - b.delay)
    const colX = colIdx * (COL_WIDTH + COL_GAP)
    let y = 0
    let prevId = `trigger-${stepKey}-${triggerKey}`
    let prevDelay = 0

    nodes.push({
      id: prevId,
      type: 'trigger',
      position: { x: colX, y },
      data: { label: triggerLabel(triggerKey), triggerKey, stepKey } as Record<string, unknown>,
    })
    y += TRIGGER_H + NODE_GAP

    for (const action of actions) {
      if (action.delay > prevDelay) {
        const waitId = `wait-before-${action.id}`
        nodes.push({
          id: waitId,
          type: 'wait',
          position: { x: colX, y },
          data: { ms: action.delay - prevDelay } as Record<string, unknown>,
        })
        y += WAIT_H + NODE_GAP
        prevId = waitId
      }

      const isGroup = action.instance === 'internal' && action.action === 'action_group'
      const nodeId = `action-${action.id}`
      const instanceLabel = instances[action.instance]?.label ?? (action.instance?.slice(0, 8) ?? '?')
      const isSelected = action.id === selectedActionId

      if (isGroup) {
        nodes.push({
          id: nodeId,
          type: 'group',
          position: { x: colX, y },
          data: {
            action, triggerKey, stepKey, isSelected,
            childCount: action.children?.default?.length ?? 0,
            mode: String(action.options?.execution_mode ?? 'concurrent'),
          } as Record<string, unknown>,
        })
        y += GROUP_H + NODE_GAP
      } else {
        nodes.push({
          id: nodeId,
          type: 'action',
          position: { x: colX, y },
          data: { action, triggerKey, stepKey, instanceLabel, isSelected } as Record<string, unknown>,
        })
        y += ACTION_H + NODE_GAP
      }

      prevId = nodeId
      prevDelay = action.delay
    }
  })

  return { nodes }
}

// ---- Props ----

interface Props {
  control: ButtonControl | null
  instances: Record<string, CompanionInstance>
  selectedActionId: string | null
  onActionSelect: (actionId: string | null, triggerKey: TriggerKey, stepKey: string) => void
  onActionDrop?: (stepKey: string, triggerKey: TriggerKey, delay: number, template: { connectionId: string; definitionId: string; options: Record<string, unknown> }) => void
  onStepAdd: () => void
  onStepRemove: (stepKey: string) => void
}

// ---- Inner component (inside ReactFlowProvider — can use useReactFlow) ----

function NodeEditorInner({
  control,
  instances,
  selectedActionId,
  onActionSelect,
  onActionDrop,
  onStepAdd,
  onStepRemove,
}: Props) {
  const { screenToFlowPosition } = useReactFlow()
  const [activeStepKey, setActiveStepKey] = useState('0')
  const [isDragOver, setIsDragOver] = useState(false)

  const stepKeys = control ? Object.keys(control.steps).sort() : []
  const currentStepKey = stepKeys.includes(activeStepKey) ? activeStepKey : (stepKeys[0] ?? '0')

  // Ordered trigger list for the active step — used to find drop target
  const ordered = useMemo((): TriggerKey[] => {
    if (!control) return []
    const triggerKeys = Object.keys(control.steps[currentStepKey]?.action_sets ?? {})
    const STANDARD = ['down', 'up', 'rotate_left', 'rotate_right']
    return [
      ...STANDARD.filter(t => triggerKeys.includes(t)),
      ...triggerKeys.filter(t => !STANDARD.includes(t)).sort(),
    ] as TriggerKey[]
  }, [control, currentStepKey])

  const { nodes: builtNodes } = useMemo(
    () =>
      control
        ? buildGraph(control, currentStepKey, instances, selectedActionId)
        : { nodes: [] },
    [control, currentStepKey, instances, selectedActionId]
  )

  const [nodes, setNodes, onNodesChange] = useNodesState(builtNodes)
  const [, , onEdgesChange] = useEdgesState([])

  useEffect(() => {
    setNodes(builtNodes)
  }, [builtNodes, setNodes])

  const handleNodeClick = useCallback(
    (_evt: React.MouseEvent, node: Node) => {
      if (node.type === 'action' || node.type === 'group') {
        const d = node.data as unknown as ActionData
        onActionSelect(d.action.id, d.triggerKey, d.stepKey)
      }
    },
    [onActionSelect]
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('application/companion-action')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear when leaving the canvas entirely (not entering a child)
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as HTMLElement)) {
      setIsDragOver(false)
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    setIsDragOver(false)
    if (!control) return
    const raw = e.dataTransfer.getData('application/companion-action')
    if (!raw) return
    e.preventDefault()

    let template: { connectionId: string; definitionId: string; options: Record<string, unknown> }
    try { template = JSON.parse(raw) } catch { return }

    // Convert screen → flow coordinates
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY })

    // Find the closest trigger node by current position (respects user dragging nodes)
    const triggerNodes = nodes.filter(n => n.type === 'trigger')
    let targetTrigger: TriggerKey = ordered[0] ?? 'down'

    if (triggerNodes.length > 0) {
      let closestDist = Infinity
      for (const tn of triggerNodes) {
        const cx = tn.position.x + COL_WIDTH / 2
        const dist = Math.abs(pos.x - cx)
        if (dist < closestDist) {
          closestDist = dist
          targetTrigger = (tn.data as unknown as TriggerData).triggerKey
        }
      }
    }

    // Append after the last action in the chosen trigger
    const existing = control.steps[currentStepKey]?.action_sets[targetTrigger] ?? []
    const delay = existing.length === 0
      ? 0
      : Math.max(...existing.map(a => a.delay)) + 500

    onActionDrop?.(currentStepKey, targetTrigger, delay, template)
  }, [control, nodes, ordered, currentStepKey, screenToFlowPosition, onActionDrop])

  if (!control) {
    return (
      <div className="ne-empty">
        <p>Select a button to view its node graph</p>
      </div>
    )
  }

  return (
    <div className="ne-wrap">
      <div className="step-bar">
        <span className="step-bar-label">Steps</span>
        {stepKeys.map(sk => (
          <button
            key={sk}
            className={`step-tab ${sk === currentStepKey ? 'step-tab--active' : ''}`}
            onClick={() => setActiveStepKey(sk)}
          >
            {parseInt(sk) + 1}
          </button>
        ))}
        <button className="step-tab step-tab--add" onClick={onStepAdd} title="Add step">+</button>
        {stepKeys.length > 1 && (
          <button
            className="step-tab step-tab--remove"
            onClick={() => onStepRemove(currentStepKey)}
            title="Remove current step"
          >−</button>
        )}
      </div>

      <div
        className="ne-canvas"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragOver && (
          <div className="ne-drop-overlay">
            <span>Drop to add action</span>
          </div>
        )}
        <ReactFlow
          nodes={nodes}
          edges={[]}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={handleNodeClick}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          colorMode="dark"
          deleteKeyCode={null}
        >
          <Background variant={BackgroundVariant.Dots} color="#2a2a2a" gap={20} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  )
}

// ---- Outer component — provides ReactFlowProvider context ----

export default function NodeEditor(props: Props) {
  return (
    <ReactFlowProvider>
      <NodeEditorInner {...props} />
    </ReactFlowProvider>
  )
}
