'use client';

/**
 * Diagrama del flujo del bot con overlay de ejecución.
 *
 * Renderiza la topología estática (`BOT_TOPOLOGY`) con React Flow + dagre y
 * resalta, sobre un `BotTrace`, los nodos visitados y las aristas recorridas.
 * Reutilizable por la página `/bot-flow` (trazas de DB) y por el modo live
 * del lab (traza construida en el cliente).
 */

import { useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Node as RfNode,
  type Edge as RfEdge,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { cn } from '@/lib/utils';
import { autoLayout } from '@/lib/flows/layout';
import {
  BOT_TOPOLOGY,
  type TopologyNode,
  type TopologyNodeKind,
} from '@/lib/bot-trace/topology';
import type { BotTrace, TraceStatus } from '@/lib/bot-trace/schema';

const NODE_WIDTH = 210;
const NODE_HEIGHT = 64;

const KIND_COLORS: Record<TopologyNodeKind, string> = {
  entry: 'var(--primary, #3b82f6)',
  context: '#64748b',
  handler: '#0ea5e9',
  brain: '#8b5cf6',
  dispatch: '#f59e0b',
  terminal: '#10b981',
};

const STATUS_RING: Record<TraceStatus, string> = {
  ok: '#10b981',
  skipped: '#94a3b8',
  error: '#ef4444',
  pending: '#f59e0b',
};

interface NodeData extends Record<string, unknown> {
  node: TopologyNode;
  visited: boolean;
  current: boolean;
  stepCount: number;
  worstStatus: TraceStatus | null;
}

function TopoNodeCard({ data }: NodeProps) {
  const { node, visited, current, stepCount, worstStatus } = data as NodeData;
  const color = KIND_COLORS[node.kind];
  const ring = worstStatus ? STATUS_RING[worstStatus] : color;
  return (
    <div
      style={{
        borderColor: visited ? ring : undefined,
        boxShadow: current
          ? `0 0 0 2px ${ring}, 0 12px 30px -12px ${ring}`
          : visited
            ? `0 8px 22px -14px ${ring}`
            : undefined,
        opacity: visited ? 1 : 0.55,
      }}
      className={cn(
        'bg-card w-[210px] rounded-xl border px-3 py-2 text-left transition-[box-shadow,border-color,opacity]',
        visited ? 'border-border' : 'border-dashed border-border',
      )}
    >
      <Handle type="target" position={Position.Top} className="!invisible" />
      <div className="flex items-center gap-2">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
        <span className="truncate text-[10.5px] font-semibold tracking-wide uppercase text-muted-foreground">
          {node.kind}
        </span>
        {stepCount > 0 && (
          <span className="ml-auto rounded-full border border-border px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
            {stepCount} pasos
          </span>
        )}
      </div>
      <div className="mt-1 truncate text-xs font-medium text-foreground" title={node.label}>
        {node.label}
      </div>
      <Handle type="source" position={Position.Bottom} className="!invisible" />
    </div>
  );
}

const NODE_TYPES = { topo: TopoNodeCard };

export interface BotFlowDiagramProps {
  trace?: BotTrace | null;
  onSelectNode?: (nodeId: string | null) => void;
  className?: string;
}

function Inner({ trace, onSelectNode, className }: BotFlowDiagramProps) {
  const { nodes, edges } = useMemo(() => {
    const path = trace?.path ?? [];
    const pathIndex = new Map<string, number>();
    path.forEach((id, i) => {
      if (!pathIndex.has(id)) pathIndex.set(id, i);
    });

    const stepsByNode = new Map<string, { count: number; status: TraceStatus }>();
    for (const step of trace?.steps ?? []) {
      const prev = stepsByNode.get(step.nodeId);
      const status = step.status;
      stepsByNode.set(step.nodeId, {
        count: (prev?.count ?? 0) + 1,
        status: prev?.status === 'error' || status === 'error' ? 'error' : status,
      });
    }

    const positions = autoLayout(
      BOT_TOPOLOGY.nodes.map((n) => ({
        id: n.id,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      })),
      BOT_TOPOLOGY.edges.map((e) => ({ source: e.source, target: e.target })),
      { direction: 'TB', rankSep: 90, nodeSep: 60, ranker: 'tight-tree', defaultWidth: NODE_WIDTH, defaultHeight: NODE_HEIGHT },
    );

    const lastNode = path.length > 0 ? path[path.length - 1] : null;

    const rfNodes: RfNode[] = BOT_TOPOLOGY.nodes.map((n) => {
      const pos = positions.get(n.id) ?? { x: 0, y: 0 };
      const stepInfo = stepsByNode.get(n.id);
      const data: NodeData = {
        node: n,
        visited: pathIndex.has(n.id),
        current: lastNode === n.id,
        stepCount: stepInfo?.count ?? 0,
        worstStatus: stepInfo?.status ?? null,
      };
      return {
        id: n.id,
        type: 'topo',
        position: pos,
        data,
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        draggable: true,
        style: { width: NODE_WIDTH },
      };
    });

    const rfEdges: RfEdge[] = BOT_TOPOLOGY.edges.map((e) => {
      const si = pathIndex.get(e.source);
      const ti = pathIndex.get(e.target);
      const traversed = si !== undefined && ti !== undefined && ti >= si;
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'smoothstep',
        label: e.label,
        animated: traversed,
        style: traversed
          ? { stroke: 'var(--primary, #3b82f6)', strokeWidth: 2 }
          : { stroke: '#cbd5e1', strokeWidth: 1, opacity: 0.4 },
        labelStyle: {
          fontSize: 10,
          fill: '#64748b',
          opacity: traversed ? 1 : 0.35,
        },
        labelBgStyle: { fill: 'var(--card, #fff)', fillOpacity: 0.8 },
      };
    });

    return { nodes: rfNodes, edges: rfEdges };
  }, [trace]);

  return (
    <div className={cn('h-full w-full', className)}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => onSelectNode?.(node.id)}
        onPaneClick={() => onSelectNode?.(null)}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable className="!bg-card" />
      </ReactFlow>
    </div>
  );
}

export function BotFlowDiagram(props: BotFlowDiagramProps) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
