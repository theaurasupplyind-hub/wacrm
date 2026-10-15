'use client';

/**
 * /bot-map — Grafo de cómo está conectado todo el ecosistema de bots.
 *
 * Vista estática (sin trazas): WhatsApp → webhook → gates → motor de turno →
 * handlers → agente/tools → backend_gal/Supabase → galv2-tauri, con el estado
 * de cada pieza (activo / en prueba / deshabilitado / retirado) para saber qué
 * funciona, qué está en prueba y qué está apagado.
 */

import { useMemo, useState } from 'react';
import { Boxes, Waypoints, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { EcosystemDiagram } from '@/components/bot-map/ecosystem-diagram';
import {
  ECOSYSTEM,
  GROUP_META,
  STATUS_META,
  statusCounts,
  type EcosystemStatus,
} from '@/lib/bot-map/ecosystem';

const STATUS_ORDER: EcosystemStatus[] = ['active', 'beta', 'off', 'retired'];

const STATUS_BADGE_VARIANT: Record<
  EcosystemStatus,
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  active: 'default',
  beta: 'secondary',
  off: 'outline',
  retired: 'destructive',
};

export default function BotMapPage() {
  const [visible, setVisible] = useState<Set<EcosystemStatus>>(
    () => new Set(STATUS_ORDER),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const counts = useMemo(() => statusCounts(), []);
  const selected = useMemo(
    () => ECOSYSTEM.nodes.find((n) => n.id === selectedId) ?? null,
    [selectedId],
  );

  const toggle = (status: EcosystemStatus) => {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(status)) {
        next.delete(status);
      } else {
        next.add(status);
      }
      // Never end up with an empty canvas — re-enable everything instead.
      if (next.size === 0) return new Set(STATUS_ORDER);
      return next;
    });
  };

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Waypoints className="h-5 w-5" /> Mapa del sistema
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Cómo está conectado todo: WhatsApp → webhook → motor de turno →
            handlers → backend. Verde = funciona, ámbar = en prueba, gris =
            apagado, rojo = retirado.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {STATUS_ORDER.map((status) => {
            const meta = STATUS_META[status];
            const on = visible.has(status);
            return (
              <button
                key={status}
                type="button"
                onClick={() => toggle(status)}
                title={meta.description}
                className={cn(
                  'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                  on
                    ? 'border-border bg-card text-foreground'
                    : 'border-dashed border-border bg-transparent text-muted-foreground opacity-60',
                )}
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: meta.color }}
                />
                {meta.label}
                <span className="text-muted-foreground">{counts[status]}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[1fr_340px]">
        {/* Diagrama */}
        <div className="relative min-h-0 overflow-hidden rounded-xl border border-border bg-card">
          <EcosystemDiagram
            visibleStatuses={visible}
            selectedId={selectedId}
            onSelectNode={setSelectedId}
          />
        </div>

        {/* Detalle */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Detalle
            </span>
            {selected && (
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Limpiar selección"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 text-sm">
            {selected ? (
              <>
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">
                    {GROUP_META[selected.group].label}
                  </div>
                  <div className="mt-0.5 font-medium text-foreground">
                    {selected.label}
                  </div>
                  <div className="mt-2">
                    <Badge variant={STATUS_BADGE_VARIANT[selected.status]}>
                      {STATUS_META[selected.status].label}
                    </Badge>
                  </div>
                </div>

                <p className="text-xs leading-relaxed text-muted-foreground">
                  {selected.description}
                </p>

                {selected.env && selected.env.length > 0 && (
                  <div>
                    <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
                      Envs / flags
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {selected.env.map((e) => (
                        <code
                          key={e}
                          className="rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] text-foreground"
                        >
                          {e}
                        </code>
                      ))}
                    </div>
                  </div>
                )}

                {selected.files && selected.files.length > 0 && (
                  <div>
                    <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
                      Archivos
                    </div>
                    <ul className="space-y-1">
                      {selected.files.map((f) => (
                        <li
                          key={f}
                          className="break-all font-mono text-[11px] text-muted-foreground"
                        >
                          {f}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Boxes className="h-4 w-4" />
                  <span className="text-xs">
                    Tocá un nodo para ver qué es, sus envs y sus archivos.
                  </span>
                </div>

                <div>
                  <div className="mb-2 text-xs uppercase tracking-wider text-muted-foreground">
                    Resumen por estado
                  </div>
                  <ul className="space-y-2">
                    {STATUS_ORDER.map((status) => {
                      const meta = STATUS_META[status];
                      return (
                        <li key={status} className="flex items-start gap-2">
                          <span
                            className="mt-1 h-2 w-2 shrink-0 rounded-full"
                            style={{ backgroundColor: meta.color }}
                          />
                          <div>
                            <div className="text-xs font-medium text-foreground">
                              {meta.label}{' '}
                              <span className="text-muted-foreground">
                                ({counts[status]})
                              </span>
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              {meta.description}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
