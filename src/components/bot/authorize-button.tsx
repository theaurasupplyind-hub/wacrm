'use client';

// Botón reutilizable "Autorizar en el bot" / badge "Bot activo".
// Se usa en contactos, detalle de contacto y sidebar del inbox para agregar
// el teléfono a la whitelist (`bot_allowed_numbers`) con un click.

import { useState } from 'react';
import { toast } from 'sonner';
import { Bot, Loader2, ShieldOff } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useCan } from '@/hooks/use-can';
import { cn } from '@/lib/utils';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import {
  loadWhitelist,
  setWhitelistEntry,
  useWhitelistStatus,
} from '@/lib/bot/whitelist-client';

interface AuthorizeBotButtonProps {
  phone: string;
  name?: string | null;
  className?: string;
}

export function AuthorizeBotButton({ phone, name, className }: AuthorizeBotButtonProps) {
  const canEdit = useCan('edit-settings');
  const { status, id } = useWhitelistStatus(phone);
  const norm = normalizePhone(phone);
  const [busy, setBusy] = useState(false);

  // Solo admin+, teléfonos válidos, y una vez resuelto el estado.
  if (!canEdit || norm.length < 7 || status === 'loading') return null;

  async function authorize() {
    setBusy(true);
    try {
      if (status === 'inactive' && id != null) {
        const res = await fetch(`/api/bot/whitelist/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: true }),
        });
        if (!res.ok) {
          const p = await res.json().catch(() => ({}));
          toast.error(p.error || 'No se pudo autorizar');
          return;
        }
        setWhitelistEntry(norm, { id, active: true });
      } else {
        const res = await fetch('/api/bot/whitelist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: norm, label: name?.trim() || undefined }),
        });
        if (!res.ok) {
          const p = await res.json().catch(() => ({}));
          toast.error(p.error || 'No se pudo autorizar');
          return;
        }
        await loadWhitelist(true);
      }
      toast.success('Número autorizado en el bot');
    } catch {
      toast.error('No se pudo conectar con el servidor');
    } finally {
      setBusy(false);
    }
  }

  async function deactivate() {
    if (id == null) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/bot/whitelist/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: false }),
      });
      if (!res.ok) {
        const p = await res.json().catch(() => ({}));
        toast.error(p.error || 'No se pudo desactivar');
        return;
      }
      setWhitelistEntry(norm, { id, active: false });
      toast.success('Bot desactivado para este número');
    } catch {
      toast.error('No se pudo conectar con el servidor');
    } finally {
      setBusy(false);
    }
  }

  if (status === 'active') {
    return (
      <div className={cn('flex items-center gap-1.5', className)}>
        <Badge className="gap-1 bg-primary/15 text-primary">
          <Bot className="size-3" />
          Bot activo
        </Badge>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={deactivate}
          disabled={busy}
          title="Quitar del bot"
          aria-label="Quitar del bot"
          className="text-muted-foreground hover:text-red-400"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ShieldOff className="size-3.5" />}
        </Button>
      </div>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={authorize}
      disabled={busy}
      className={cn('border-border text-muted-foreground hover:bg-muted', className)}
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Bot className="size-3.5" />}
      Autorizar en el bot
    </Button>
  );
}
