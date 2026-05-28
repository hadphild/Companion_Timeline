import React, { useMemo, useCallback, useState, useEffect } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  BackgroundVariant,
  type Node,
  type Edge,
  type NodeChange,
  type Connection,
  Handle,
  Position,
  type NodeProps,
  useNodesState,
  useEdgesState,
  useReactFlow,
  MarkerType,
  addEdge,
  reconnectEdge,
  applyNodeChanges,
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

// Group header — compact badge showing the mode, children expanded below it
function GroupHeaderNode({ data }: NodeProps) {
  const d = data as unknown as GroupData
  const modeLabel =
    d.mode === 'sequential' ? 'Sequential' :
    d.mode === 'concurrent' ? 'Concurrent' : 'Inherit'
  const icon = d.mode === 'sequential' ? '↓' : '⇉'
  return (
    <div className={`ne-node ne-group-hdr${d.isSelected ? ' ne-group-hdr--selected' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <span className="ne-group-hdr-icon">{icon}</span>
      <span className="ne-group-hdr-label">{modeLabel} Group</span>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

// Child action — read-only, dimmer than top-level actions
function ChildActionNode({ data }: NodeProps) {
  const d = data as unknown as ActionData
  return (
    <div className="ne-node ne-child-action">
      <Handle type="target" position={Position.Top} />
      <div className="ne-action-name">{d.action.action || '(new)'}</div>
      <div className="ne-action-inst">{d.instanceLabel}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

const nodeTypes = {
  trigger: TriggerNode,
  action: ActionNode,
  wait: WaitNode,
  'group-header': GroupHeaderNode,
  'child-action': ChildActionNode,
}

// ---- Layout constants ----
const COL_WIDTH = 200
const COL_GAP   = 100
const TRIGGER_H    = 52
const ACTION_H     = 72
const WAIT_H       = 42
const GROUP_HDR_H  = 42
const NODE_GAP     = 32
const CHILD_OFFSET = COL_WIDTH + 60  // x offset for child nodes

// ---- Build graph from ButtonControl ----

function buildGraph(
  control: ButtonControl,
  stepKey: string,
  instances: Record<string, CompanionInstance>,
  selectedActionId: string | null
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = []
  const edges: Edge[] = []

  const step = control.steps[stepKey]
  if (!step) return { nodes, edges }

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
      deletable: false,
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
        edges.push({
          id: `e-${prevId}-${waitId}`,
          source: prevId,
          target: waitId,
          style: { stroke: '#4a4a4a' },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#4a4a4a' },
        })
        y += WAIT_H + NODE_GAP
        prevId = waitId
      }

      const isGroup = action.instance === 'internal' && action.action === 'action_group'
      const nodeId = `action-${action.id}`
      const instanceLabel = instances[action.instance]?.label ?? (action.instance?.slice(0, 8) ?? '?')
      const isSelected = action.id === selectedActionId

      if (isGroup) {
        const mode = String(action.options?.execution_mode ?? 'concurrent')
        const children = [...(action.children?.default ?? [])].sort((a, b) => a.delay - b.delay)
        const childX = colX + CHILD_OFFSET

        // Group header node — marks start of the group in the main flow
        nodes.push({
          id: nodeId,
          type: 'group-header',
          position: { x: colX, y },
          data: { action, triggerKey, stepKey, isSelected, mode, childCount: children.length } as Record<string, unknown>,
        })
        y += GROUP_HDR_H + NODE_GAP

        if (mode === 'sequential') {
          // Children chained vertically to the right of the main column
          let childY = y - NODE_GAP
          let childPrevId = nodeId
          let childPrevDelay = 0

          for (const child of children) {
            if (child.delay > childPrevDelay) {
              const wid = `child-wait-${child.id}`
              nodes.push({ id: wid, type: 'wait', position: { x: childX, y: childY }, data: { ms: child.delay - childPrevDelay } as Record<string, unknown> })
              edges.push({ id: `e-${childPrevId}-${wid}`, source: childPrevId, target: wid, data: { childEdge: true }, style: { stroke: '#3a3a3a' }, markerEnd: { type: MarkerType.ArrowClosed, color: '#3a3a3a' } })
              childY += WAIT_H + NODE_GAP
              childPrevId = wid
            }
            const cid = `child-${child.id}`
            const cInstLabel = instances[child.instance]?.label ?? (child.instance?.slice(0, 8) ?? '?')
            nodes.push({ id: cid, type: 'child-action', position: { x: childX, y: childY }, data: { action: child, triggerKey, stepKey, instanceLabel: cInstLabel, isSelected: false } as Record<string, unknown>, deletable: false })
            edges.push({ id: `e-${childPrevId}-${cid}`, source: childPrevId, target: cid, data: { childEdge: true }, style: { stroke: '#3a3a3a' }, markerEnd: { type: MarkerType.ArrowClosed, color: '#3a3a3a' } })
            childY += ACTION_H + NODE_GAP
            childPrevId = cid
            childPrevDelay = child.delay
          }
          // Main column y must clear the child area
          y = Math.max(y, childY)

        } else {
          // Concurrent/Inherit: children fan out horizontally to the right
          children.forEach((child, ci) => {
            const cid = `child-${child.id}`
            const cInstLabel = instances[child.instance]?.label ?? (child.instance?.slice(0, 8) ?? '?')
            nodes.push({ id: cid, type: 'child-action', position: { x: childX + ci * (COL_WIDTH + NODE_GAP), y: y - NODE_GAP }, data: { action: child, triggerKey, stepKey, instanceLabel: cInstLabel, isSelected: false } as Record<string, unknown>, deletable: false })
            edges.push({ id: `e-${nodeId}-${cid}`, source: nodeId, target: cid, data: { childEdge: true }, style: { stroke: '#3a3a3a' }, markerEnd: { type: MarkerType.ArrowClosed, color: '#3a3a3a' } })
          })
          y += ACTION_H + NODE_GAP
        }
      } else {
        nodes.push({
          id: nodeId,
          type: 'action',
          position: { x: colX, y },
          data: { action, triggerKey, stepKey, instanceLabel, isSelected } as Record<string, unknown>,
        })
        y += ACTION_H + NODE_GAP
      }

      edges.push({
        id: `e-${prevId}-${nodeId}`,
        source: prevId,
        target: nodeId,
        style: { stroke: '#4a4a4a' },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#4a4a4a' },
      })

      prevId = nodeId
      prevDelay = action.delay
    }
  })

  return { nodes, edges }
}

// ---- Derive action list from graph topology ----
// Walks edges from a trigger node, accumulating delay through Wait nodes.

function deriveActions(
  nodes: Node[],
  edges: Edge[],
  triggerNodeId: string
): CompanionAction[] {
  // Exclude child edges (they branch off group headers, not part of main flow)
  const mainEdges = edges.filter(e => !(e.data as Record<string, unknown>)?.childEdge)
  const nextOf = new Map(mainEdges.map(e => [e.source, e.target]))
  const actions: CompanionAction[] = []
  let currentId = triggerNodeId
  let delay = 0
  const visited = new Set<string>([triggerNodeId])

  while (nextOf.has(currentId)) {
    const nextId = nextOf.get(currentId)!
    if (visited.has(nextId)) break
    visited.add(nextId)
    currentId = nextId
    const node = nodes.find(n => n.id === nextId)
    if (!node) break
    if (node.type === 'wait') {
      delay += (node.data as unknown as WaitData).ms
    } else if (node.type === 'action' || node.type === 'group-header') {
      const d = node.data as unknown as ActionData
      actions.push({ ...d.action, delay })
    }
  }
  return actions
}

// ---- Props ----

interface Props {
  control: ButtonControl | null
  instances: Record<string, CompanionInstance>
  selectedActionId: string | null
  onActionSelect: (actionId: string | null, triggerKey: TriggerKey, stepKey: string) => void
  onActionDrop?: (stepKey: string, triggerKey: TriggerKey, delay: number, template: { connectionId: string; definitionId: string; options: Record<string, unknown> }) => void
  onActionDelete?: (stepKey: string, triggerKey: TriggerKey, actionId: string) => void
  onActionsUpdate?: (stepKey: string, triggerKey: TriggerKey, actions: CompanionAction[]) => void
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
  onActionDelete,
  onActionsUpdate,
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

  const { nodes: builtNodes, edges: builtEdges } = useMemo(
    () =>
      control
        ? buildGraph(control, currentStepKey, instances, selectedActionId)
        : { nodes: [], edges: [] },
    [control, currentStepKey, instances, selectedActionId]
  )

  const [nodes, setNodes, onNodesChange] = useNodesState(builtNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(builtEdges)

  useEffect(() => {
    setNodes(builtNodes)
    setEdges(builtEdges)
  }, [builtNodes, builtEdges, setNodes, setEdges])

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

  // Helper: re-derive all trigger action lists from current nodes+edges and push updates
  const pushGraphUpdate = useCallback((currentNodes: Node[], currentEdges: Edge[]) => {
    if (!control) return
    const triggerNodes = currentNodes.filter(n => n.type === 'trigger')
    for (const tn of triggerNodes) {
      const d = tn.data as unknown as TriggerData
      const newActions = deriveActions(currentNodes, currentEdges, tn.id)
      onActionsUpdate?.(d.stepKey, d.triggerKey, newActions)
    }
  }, [control, onActionsUpdate])

  // Intercept node changes — handle deletes before the node leaves state
  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    const removes = changes.filter(c => c.type === 'remove')

    if (removes.length > 0 && control) {
      const removedIds = new Set(removes.map(c => (c as { type: 'remove'; id: string }).id))
      const remainingNodes = nodes.filter(n => !removedIds.has(n.id))
      const remainingEdges = edges.filter(e => !removedIds.has(e.source) && !removedIds.has(e.target))

      let hasWait = false
      for (const id of removedIds) {
        const node = nodes.find(n => n.id === id)
        if (!node) continue
        if (node.type === 'action' || node.type === 'group') {
          const d = node.data as unknown as ActionData
          onActionDelete?.(d.stepKey, d.triggerKey, d.action.id)
        } else if (node.type === 'wait') {
          hasWait = true
        }
      }
      // Wait deletions need full re-derive (delays shift)
      if (hasWait) pushGraphUpdate(remainingNodes, remainingEdges)
    }

    // Always apply positional/selection/etc. changes to React Flow state
    setNodes(n => applyNodeChanges(changes, n))
  }, [control, nodes, edges, onActionDelete, pushGraphUpdate, setNodes])

  // Reconnect an existing edge endpoint to a new node
  const handleReconnect = useCallback((oldEdge: Edge, newConnection: Connection) => {
    const newEdges = reconnectEdge(oldEdge, newConnection, edges)
    setEdges(newEdges)
    pushGraphUpdate(nodes, newEdges)
  }, [edges, nodes, setEdges, pushGraphUpdate])

  // Create a new connection between nodes
  const handleConnect = useCallback((connection: Connection) => {
    const newEdges = addEdge({
      ...connection,
      style: { stroke: '#4a4a4a' },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#4a4a4a' },
    }, edges)
    setEdges(newEdges)
    pushGraphUpdate(nodes, newEdges)
  }, [edges, nodes, setEdges, pushGraphUpdate])

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
          edges={edges}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={handleNodeClick}
          onReconnect={handleReconnect}
          onConnect={handleConnect}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          colorMode="dark"
          deleteKeyCode={['Backspace', 'Delete']}
          edgesReconnectable
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
