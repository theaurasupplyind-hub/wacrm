'use client';

/**
 * /bot-flow — Diagrama visual del flujo del bot.
 *
 * Dos fuentes de datos:
 *  1. DB: trazas persistidas en `bot_traces` (POST /api/bot-traces).
 *  2. Live: se ejecuta el lab (`POST /api/bot-beta/unified`) y se construye
 *     la traza en el cliente con `buildBotTrace` (misma forma que la DB).
 *
 * El diagrama (React Flow + dagre) resalta el camino recorrido y el panel
 * lateral muestra el detalle de cada nodo.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bot,
  ChevronRight,
  Loader2,
  Play,
  RefreshCw,
  Send,
  Workflow,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { BotFlowDiagram } from '@/components/bot-trace/bot-flow-diagram';
import { buildBotTrace } from '@/lib/bot-trace/build-trace';
import type { BotTrace } from '@/lib/bot-trace/schema';
import { BOT_TOPOLOGY, type TopologyNodeKind } from '@/lib/bot-trace/topology';

const KIND_LABEL: Record<TopologyNodeKind, string> = {
  entry: 'Entrada',
  context: 'Contexto',
  handler: 'Handler',
  brain: 'Cerebro',
  dispatch: 'Dispatch',
  terminal: 'Terminal',
};

const STATUS_VARIANT: Record<
  string,
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  matched: 'default',
  multi_invoice: 'default',
  ambiguous: 'secondary',
  no_match: 'destructive',
};

interface UnifiedResult {
  reply?: string;
  dispatchedTo?: string;
  dispatchReason?: string;
  extraction?: Record<string, unknown> | null;
  logs?: { step: string; data?: unknown }[];
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('es-AR');
  } catch {
    return iso;
  }
}

export default function BotFlowPage() {
  const [traces, setTraces] = useState<BotTrace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const [liveText, setLiveText] = useState('');
  const [liveTrace, setLiveTrace] = useState<BotTrace | null>(null);
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);

  const loadTraces = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/bot-traces?limit=60');
      const data = (await res.json()) as {
        traces?: BotTrace[];
        error?: string;
      };
      if (data.error) setError(data.error);
      setTraces(data.traces ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTraces();
  }, [loadTraces]);

  const activeTrace = useMemo(() => {
    if (liveTrace) return liveTrace;
    return traces.find((t) => t.messageId === selectedId) ?? traces[0] ?? null;
  }, [liveTrace, traces, selectedId]);

  const nodeDetail = useMemo(() => {
    if (!activeTrace || !selectedNode) return null;
    const steps = activeTrace.steps.filter((s) => s.nodeId === selectedNode);
    const node = BOT_TOPOLOGY.nodes.find((n) => n.id === selectedNode) ?? null;
    return { node, steps };
  }, [activeTrace, selectedNode]);

  const runLive = useCallback(async () => {
    const text = liveText.trim();
    if (!text) return;
    setLiveLoading(true);
    setLiveError(null);
    try {
      const res = await fetch('/api/bot-beta/unified', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = (await res.json()) as UnifiedResult & { error?: string };
      if (data.error) {
        setLiveError(data.error);
        return;
      }
      const trace = buildBotTrace({
        messageId: `live-${Date.now()}`,
        source: 'text',
        rawText: text,
        extraction: (data.extraction ?? null) as never,
        dispatchedTo: data.dispatchedTo ?? null,
        dispatchReason: data.dispatchReason ?? null,
        logs: data.logs ?? [],
        finalStatus: data.dispatchedTo ?? null,
        voucherDebug: null,
      });
      setLiveTrace(trace);
      setSelectedNode(null);
    } catch (err) {
      setLiveError(err instanceof Error ? err.message : String(err));
    } finally {
      setLiveLoading(false);
    }
  }, [liveText]);

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Workflow className="h-5 w-5" /> Flujo del bot
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Diagrama visual del recorrido de cada mensaje. Resalta la ruta y el
            detalle por nodo.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <input
            value={liveText}
            onChange={(e) => setLiveText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runLive();
            }}
            placeholder="Probar en vivo: 'Hola', 'Jo pagó 2000'..."
            className="h-9 w-64 rounded-md border border-border bg-card px-3 text-sm outline-none focus:border-primary"
          />
          <Button size="sm" onClick={() => void runLive()} disabled={liveLoading || !liveText.trim()}>
            {liveLoading ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-1 h-4 w-4" />
            )}
            Ejecutar
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setLiveTrace(null);
              void loadTraces();
            }}
          >
            <RefreshCw className="mr-1 h-4 w-4" /> Refrescar
          </Button>
        </div>
      </div>

      {liveError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {liveError}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[280px_1fr_320px]">
        {/* Lista de trazas */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Trazas
            </span>
            <span className="text-xs text-muted-foreground">{traces.length}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading && (
              <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Cargando...
              </div>
            )}
            {!loading && error && (
              <div className="px-3 py-4 text-sm text-muted-foreground">
                {error}
                <div className="mt-2 rounded border border-border bg-muted/40 p-2 text-[11px]">
                  Ejecutá la migración <code>048_bot_traces.sql</code> en Supabase
                  para guardar trazas.
                </div>
              </div>
            )}
            {!loading && !error && traces.length === 0 && (
              <div className="px-3 py-4 text-sm text-muted-foreground">
                Sin trazas todavía. Probá el lab en vivo o enviá un mensaje.
              </div>
            )}
            {traces.map((t) => {
              const active = !liveTrace && (selectedId ? t.messageId === selectedId : activeTrace?.messageId === t.messageId);
              return (
                <button
                  key={t.messageId}
                  onClick={() => {
                    setLiveTrace(null);
                    setSelectedId(t.messageId);
                    setSelectedNode(null);
                  }}
                  className={`flex w-full flex-col gap-1 border-b border-border px-3 py-2 text-left transition-colors hover:bg-muted/40 ${
                    active ? 'bg-primary/10' : ''
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Badge variant={STATUS_VARIANT[t.status] ?? 'outline'} className="text-[10px]">
                      {t.status}
                    </Badge>
                    <span className="truncate text-xs text-muted-foreground">
                      {t.source ?? 'msg'}
                    </span>
                    <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                  <div className="truncate text-xs text-foreground" title={t.rawText ?? ''}>
                    {t.rawText || t.messageId}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {t.path.length} nodos · {formatDate(t.createdAt)}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Diagrama */}
        <div className="relative min-h-0 overflow-hidden rounded-xl border border-border bg-card">
          {liveTrace && (
            <div className="absolute left-3 top-3 z-10">
              <Badge className="gap-1">
                <Send className="h-3 w-3" /> Live (sin persistir)
              </Badge>
            </div>
          )}
          {activeTrace ? (
            <BotFlowDiagram trace={activeTrace} onSelectNode={setSelectedNode} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center text-center text-muted-foreground">
              <Bot className="mb-3 h-10 w-10 opacity-40" />
              <p className="text-sm">Elegí una traza o ejecutá el lab en vivo.</p>
            </div>
          )}
        </div>

        {/* Detalle */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
          <div className="border-b border-border px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Detalle
            </span>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-sm">
            {nodeDetail?.node ? (
              <>
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">
                    {KIND_LABEL[nodeDetail.node.kind]}
                  </div>
                  <div className="mt-0.5 font-medium">{nodeDetail.node.label}</div>
                  {nodeDetail.node.description && (
                    <div className="mt-1 text-xs text-muted-foreground">
                      {nodeDetail.node.description}
                    </div>
                  )}
                </div>
                {nodeDetail.steps.length === 0 ? (
                  <div className="text-xs text-muted-foreground">
                    Este nodo no se ejecutó en la traza.
                  </div>
                ) : (
                  nodeDetail.steps.map((s) => (
                    <div key={s.id} className="rounded-lg border border-border bg-muted/30 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium">{s.label}</span>
                        <Badge
                          variant={s.status === 'error' ? 'destructive' : 'outline'}
                          className="text-[10px]"
                        >
                          {s.status}
                        </Badge>
                      </div>
                      {s.data != null && (
                        <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-2 text-[11px] leading-relaxed text-muted-foreground">
                          {JSON.stringify(s.data, null, 2)}
                        </pre>
                      )}
                    </div>
                  ))
                )}
              </>
            ) : activeTrace ? (
              <>
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">
                    Mensaje
                  </div>
                  <div className="mt-0.5 break-words font-medium">
                    {activeTrace.rawText || activeTrace.messageId}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="text-muted-foreground">Estado</span>
                    <div>
                      <Badge variant={STATUS_VARIANT[activeTrace.status] ?? 'outline'}>
                        {activeTrace.status}
                      </Badge>
                    </div>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Nodos</span>
                    <div>{activeTrace.path.length}</div>
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
                    Ruta
                  </div>
                  <ol className="space-y-1">
                    {activeTrace.path.map((id, i) => {
                      const n = BOT_TOPOLOGY.nodes.find((x) => x.id === id);
                      return (
                        <li key={`${id}-${i}`} className="flex items-center gap-2 text-xs">
                          <span className="text-muted-foreground">{i + 1}.</span>
                          <button
                            className="truncate text-left hover:text-primary"
                            onClick={() => setSelectedNode(id)}
                          >
                            {n?.label ?? id}
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </div>
                {activeTrace.errorMessage && (
                  <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                    {activeTrace.errorMessage}
                  </div>
                )}
              </>
            ) : (
              <div className="text-xs text-muted-foreground">
                Sin traza seleccionada.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
