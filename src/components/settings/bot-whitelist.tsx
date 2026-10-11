'use client';

// ============================================================
// BotWhitelist — Settings → Números autorizados
//
// Administra `bot_allowed_numbers`: solo los teléfonos de esta lista
// disparan el bot determinístico (gastos/asistencia/voucher/asistente).
// Cualquier miembro ve la lista; admin+ agrega/edita/borra (gate en la
// UI por `canEditSettings` y en el server por `requireRole('admin')` + RLS).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Bot, Info, Loader2, Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/hooks/use-auth';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { SettingsPanelHead } from './settings-panel-head';

interface AllowedNumber {
  id: number;
  phone: string;
  label: string | null;
  active: boolean;
  created_at: string;
}

export function BotWhitelist() {
  const { canEditSettings } = useAuth();

  const [numbers, setNumbers] = useState<AllowedNumber[]>([]);
  const [loading, setLoading] = useState(true);
  const [phone, setPhone] = useState('');
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/bot/whitelist', { cache: 'no-store' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || 'No se pudo cargar la lista');
        return;
      }
      setNumbers((payload.numbers ?? []) as AllowedNumber[]);
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
    const normalized = normalizePhone(phone);
    if (normalized.length < 7) {
      toast.error('Ingresá un teléfono válido (con código de país)');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/bot/whitelist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: normalized, label: label.trim() || undefined }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || 'No se pudo agregar el número');
        return;
      }
      toast.success('Número agregado');
      setPhone('');
      setLabel('');
      await load();
    } catch {
      toast.error('No se pudo conectar con el servidor');
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(n: AllowedNumber) {
    setBusyId(n.id);
    try {
      const res = await fetch(`/api/bot/whitelist/${n.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !n.active }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'No se pudo actualizar');
        return;
      }
      setNumbers((prev) =>
        prev.map((x) => (x.id === n.id ? { ...x, active: !n.active } : x)),
      );
    } catch {
      toast.error('No se pudo conectar con el servidor');
    } finally {
      setBusyId(null);
    }
  }

  async function remove(n: AllowedNumber) {
    setBusyId(n.id);
    try {
      const res = await fetch(`/api/bot/whitelist/${n.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'No se pudo eliminar');
        return;
      }
      setNumbers((prev) => prev.filter((x) => x.id !== n.id));
      toast.success('Número eliminado');
    } catch {
      toast.error('No se pudo conectar con el servidor');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <SettingsPanelHead
        title="Números autorizados"
        description="Solo estos teléfonos pueden hablarle al bot (gastos, asistencias, comprobantes y consultas). El resto sigue por Flows/auto-reply."
      />

      {!loading && numbers.length === 0 && (
        <div className="mb-5 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          <Info className="mt-0.5 size-4 shrink-0" />
          <p>
            La lista está vacía: el bot <strong>no responde a nadie</strong>. Agregá
            los números del taller para activarlo.
          </p>
        </div>
      )}

      {canEditSettings && (
        <div className="mb-5 rounded-lg border border-border bg-card p-4">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                Teléfono (con código de país)
              </Label>
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="5491125491605"
                inputMode="tel"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Etiqueta (opcional)</Label>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Jesús (dueño)"
              />
            </div>
            <Button
              onClick={add}
              disabled={saving || !phone.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Agregar
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Se normaliza a solo dígitos. Podés pegar con +, espacios o guiones.
          </p>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border">
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="size-5 animate-spin text-primary" />
          </div>
        ) : numbers.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10">
            <Bot className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No hay números autorizados.</p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {numbers.map((n) => (
              <li key={n.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-sm text-foreground">{n.phone}</span>
                    {n.active ? (
                      <Badge className="bg-primary/15 text-primary">Activo</Badge>
                    ) : (
                      <Badge variant="secondary" className="text-muted-foreground">
                        Inactivo
                      </Badge>
                    )}
                  </div>
                  {n.label && (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{n.label}</p>
                  )}
                </div>
                {canEditSettings && (
                  <div className="flex shrink-0 items-center gap-3">
                    <Switch
                      checked={n.active}
                      disabled={busyId === n.id}
                      onCheckedChange={() => toggleActive(n)}
                      aria-label={`Activar ${n.phone}`}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busyId === n.id}
                      onClick={() => remove(n)}
                      className="text-muted-foreground hover:text-red-400"
                      aria-label={`Eliminar ${n.phone}`}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
