'use client';

// ============================================================
// /glosario — Glosario de términos de pedido (aprendido).
//
// El bot pregunta cuando no entiende una forma de nombrar un producto
// ("moldura de 4") y guarda el significado; en pedidos futuros lo aplica solo.
// Acá se revisa/administra. Cualquier miembro ve la lista; admin+ edita
// (gate en UI por `canEditSettings` y en el server por `requireRole('admin')`).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { BookMarked, Info, Loader2, Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/use-auth';

type MeaningType = 'grosor' | 'alias';

interface GlossaryMeaning {
  type: MeaningType;
  value: number | string;
}

interface GlossaryEntry {
  id: number;
  term_norm: string;
  term_display: string;
  meaning: GlossaryMeaning;
  created_at: string;
  updated_at: string;
}

function meaningLabel(m: GlossaryMeaning): string {
  if (m.type === 'grosor') return `Grosor ${m.value} cm`;
  return `→ "${m.value}"`;
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('es-AR');
  } catch {
    return iso;
  }
}

export default function GlosarioPage() {
  const { canEditSettings } = useAuth();

  const [entries, setEntries] = useState<GlossaryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [tableMissing, setTableMissing] = useState(false);
  const [term, setTerm] = useState('');
  const [type, setType] = useState<MeaningType>('grosor');
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/order-glossary', { cache: 'no-store' });
      const payload = await res.json().catch(() => ({}));
      if (res.status === 503) {
        setTableMissing(true);
        return;
      }
      if (!res.ok) {
        toast.error(payload.error || 'No se pudo cargar el glosario');
        return;
      }
      setTableMissing(false);
      setEntries((payload.entries ?? []) as GlossaryEntry[]);
    } catch {
      toast.error('No se pudo conectar con el servidor');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    const t = term.trim();
    const v = value.trim();
    if (!t) {
      toast.error('Ingresá el término');
      return;
    }
    if (!v) {
      toast.error(type === 'grosor' ? 'Ingresá el grosor en cm' : 'Ingresá el texto canónico');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/order-glossary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          term: t,
          type,
          value: type === 'grosor' ? Number(v.replace(',', '.')) : v,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || 'No se pudo guardar el término');
        return;
      }
      toast.success('Término guardado');
      setTerm('');
      setValue('');
      await load();
    } catch {
      toast.error('No se pudo conectar con el servidor');
    } finally {
      setSaving(false);
    }
  }

  async function remove(e: GlossaryEntry) {
    setBusyId(e.id);
    try {
      const res = await fetch(`/api/order-glossary?id=${e.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'No se pudo eliminar');
        return;
      }
      setEntries((prev) => prev.filter((x) => x.id !== e.id));
      toast.success('Término eliminado');
    } catch {
      toast.error('No se pudo conectar con el servidor');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-foreground">
          <BookMarked className="h-5 w-5" /> Glosario
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Cómo el bot interpreta las formas de nombrar productos en los pedidos.
          Cuando no entiende un término, lo pregunta y lo guarda acá para los
          próximos presupuestos.
        </p>
      </div>

      {tableMissing && (
        <div className="mt-5 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          <Info className="mt-0.5 size-4 shrink-0" />
          <p>
            La tabla <code>order_glossary</code> no existe. Ejecutá la migración{' '}
            <code>051_order_glossary.sql</code> en Supabase.
          </p>
        </div>
      )}

      {canEditSettings && !tableMissing && (
        <div className="mt-5 rounded-lg border border-border bg-card p-4">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px_minmax(0,1fr)_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Término</Label>
              <Input
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="moldura"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Significado</Label>
              <div className="flex gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant={type === 'grosor' ? 'default' : 'outline'}
                  onClick={() => setType('grosor')}
                >
                  Grosor
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={type === 'alias' ? 'default' : 'outline'}
                  onClick={() => setType('alias')}
                >
                  Alias
                </Button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                {type === 'grosor' ? 'Grosor (cm)' : 'Texto canónico'}
              </Label>
              <Input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={type === 'grosor' ? '4' : 'doble 4cm'}
                inputMode={type === 'grosor' ? 'decimal' : 'text'}
              />
            </div>
            <Button
              onClick={add}
              disabled={saving || !term.trim() || !value.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Guardar
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            <strong>Grosor</strong>: “moldura de 4” → grosor 4 cm (activa reglas por
            grosor). <strong>Alias</strong>: otra forma de decir un producto del
            catálogo (ej: “moldura” → “doble 4cm”).
          </p>
        </div>
      )}

      <div className="mt-5 overflow-hidden rounded-lg border border-border">
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="size-5 animate-spin text-primary" />
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10">
            <BookMarked className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Todavía no hay términos aprendidos.
            </p>
            <p className="max-w-md text-center text-xs text-muted-foreground">
              Escribí un pedido con un término nuevo y el bot te va a preguntar qué
              significa; queda guardado acá.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {entries.map((e) => (
              <li key={e.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-sm text-foreground">
                      {e.term_display}
                    </span>
                    <Badge className="bg-primary/15 text-primary">
                      {meaningLabel(e.meaning)}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {e.meaning.type === 'grosor' ? 'Grosor' : 'Alias'} · actualizado{' '}
                    {formatDate(e.updated_at)}
                  </p>
                </div>
                {canEditSettings && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busyId === e.id}
                    onClick={() => remove(e)}
                    className="shrink-0 text-muted-foreground hover:text-red-400"
                    aria-label={`Eliminar ${e.term_display}`}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
