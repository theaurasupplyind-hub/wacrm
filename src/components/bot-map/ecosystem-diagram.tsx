'use client';

/**
 * Diagrama del ecosistema completo de bots (mapa estático).
 *
 * Pinta `ECOSYSTEM` con React Flow + dagre y colorea cada nodo por estado
 * (activo / en prueba / deshabilitado / retirado). A diferencia de
 * `bot-flow-diagram` (que resalta el recorrido de una traza real), acá no hay
 * ejecución: es el panorama para entender qué está conectado con qué.
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
  ECOSYSTEM,
  GROUP_META,
  STATUS_META,
  type EcosystemEdge,
  type EcosystemNode,
  type EcosystemStatus,
} from '@/lib/bot-map/ecosystem';

const NODE_WIDTH = 230;
const NODE_HEIGHT = 66;

interface NodeData extends Record<string, unknown> {
  node: EcosystemNode;
  selected: boolean;
}

function EcosystemNodeCard({ data }: NodeProps) {
  const { node, selected } = data as NodeData;
  const meta = STATUS_META[node.status];
  const dimmed = node.status === 'off' || node.status === 'retired';

  return (
    <div
      style={{
        borderColor: selected ? meta.color : undefined,
        boxShadow: selected ? `0 0 0 2px ${meta.color}` : undefined,
        opacity: dimmed ? 0.6 : 1,
      }}
      className={cn(
        'w-[230px] rounded-xl border bg-card px-3 py-2 text-left transition-[box-shadow,border-color]',
        node.status === 'retired'
          ? 'border-dashed border-border'
          : 'border-border',
      )}
    >
      <Handle type="target" position={Position.Top} className="!invisible" />
      <div className="flex items-center gap-2">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: meta.color }}
        />
        <span className="truncate text-[9.5px] font-semibold tracking-wide uppercase text-muted-foreground">
          {GROUP_META[node.group].label}
        </span>
        <span
          className="ml-auto shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-medium"
          style={{ borderColor: `${meta.color}80`, color: meta.color }}
        >
          {meta.label}
        </span>
      </div>
      <div
        className={cn(
          'mt-1 truncate text-xs font-medium text-foreground',
          node.status === 'retired' && 'line-through decoration-destructive/60',
        )}
        title={node.label}
      >
        {node.label}
      </div>
      <Handle type="source" position={Position.Bottom} className="!invisible" />
    </div>
  );
}

const NODE_TYPES = { eco: EcosystemNodeCard };

function edgeIsDimmed(edge: EcosystemEdge): boolean {
  const s = ECOSYSTEM.nodes.find((n) => n.id === edge.source);
  const t = ECOSYSTEM.nodes.find((n) => n.id === edge.target);
  const statuses = [s?.status, t?.status];
  return statuses.some((st) => st === 'off' || st === 'retired');
}

export interface EcosystemDiagramProps {
  visibleStatuses: Set<EcosystemStatus>;
  selectedId: string | null;
  onSelectNode?: (nodeId: string | null) => void;
  className?: string;
}

function Inner({
  visibleStatuses,
  selectedId,
  onSelectNode,
  className,
}: EcosystemDiagramProps) {
  const { nodes, edges } = useMemo(() => {
    const visibleNodes = ECOSYSTEM.nodes.filter((n) =>
      visibleStatuses.has(n.status),
    );
    const visibleIds = new Set(visibleNodes.map((n) => n.id));

    const positions = autoLayout(
      visibleNodes.map((n) => ({
        id: n.id,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      })),
      ECOSYSTEM.edges
        .filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
        .map((e) => ({ source: e.source, target: e.target })),
      {
        direction: 'TB',
        rankSep: 110,
        nodeSep: 70,
        ranker: 'network-simplex',
        defaultWidth: NODE_WIDTH,
        defaultHeight: NODE_HEIGHT,
      },
    );

    const rfNodes: RfNode[] = visibleNodes.map((n) => ({
      id: n.id,
      type: 'eco',
      position: positions.get(n.id) ?? { x: 0, y: 0 },
      data: { node: n, selected: n.id === selectedId } satisfies NodeData,
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      draggable: true,
      style: { width: NODE_WIDTH },
    }));

    const rfEdges: RfEdge[] = ECOSYSTEM.edges
      .filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
      .map((e) => {
        const dim = edgeIsDimmed(e);
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          type: 'smoothstep',
          label: e.label,
          style: dim
            ? {
                stroke: '#cbd5e1',
                strokeWidth: 1,
                strokeDasharray: '4 4',
                opacity: 0.5,
              }
            : { stroke: '#94a3b8', strokeWidth: 1.4 },
          labelStyle: { fontSize: 9, fill: '#64748b', opacity: dim ? 0.5 : 0.9 },
          labelBgStyle: { fill: 'var(--card, #fff)', fillOpacity: 0.85 },
        };
      });

    return { nodes: rfNodes, edges: rfEdges };
  }, [visibleStatuses, selectedId]);

  return (
    <div className={cn('h-full w-full', className)}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        minZoom={0.15}
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

export function EcosystemDiagram(props: EcosystemDiagramProps) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
