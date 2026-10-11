'use client';

// Cache cliente de la whitelist del bot. Evita que cada botón "Autorizar"
// haga su propio fetch: se carga una vez y se comparte vía suscripción.
// (No usa contexto React para poder usarse desde componentes aislados.)

import { useEffect, useState } from 'react';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';

export interface WhitelistEntry {
  id: number;
  active: boolean;
}

let cache: Map<string, WhitelistEntry> | null = null;
let inflight: Promise<Map<string, WhitelistEntry>> | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function getWhitelistCache(): Map<string, WhitelistEntry> | null {
  return cache;
}

export function subscribeWhitelist(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export async function loadWhitelist(
  force = false,
): Promise<Map<string, WhitelistEntry>> {
  if (cache && !force) return cache;
  if (inflight && !force) return inflight;
  inflight = fetch('/api/bot/whitelist', { cache: 'no-store' })
    .then((r) => r.json())
    .then((p) => {
      const m = new Map<string, WhitelistEntry>();
      for (const n of (p?.numbers ?? []) as {
        id: number;
        phone: string;
        active: boolean;
      }[]) {
        m.set(normalizePhone(n.phone), { id: n.id, active: n.active });
      }
      cache = m;
      emit();
      return m;
    })
    .catch(() => {
      cache = new Map();
      return cache;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Actualiza una entrada del cache local (tras un POST/PATCH). */
export function setWhitelistEntry(phone: string, entry: WhitelistEntry | null) {
  if (!cache) cache = new Map();
  const key = normalizePhone(phone);
  if (entry) cache.set(key, entry);
  else cache.delete(key);
  emit();
}

export type WhitelistStatus = 'active' | 'inactive' | 'none' | 'loading';

export function useWhitelistStatus(phone: string): {
  status: WhitelistStatus;
  id: number | null;
} {
  const key = normalizePhone(phone);
  const [state, setState] = useState<{ status: WhitelistStatus; id: number | null }>({
    status: 'loading',
    id: null,
  });

  useEffect(() => {
    let mounted = true;
    const compute = () => {
      const c = getWhitelistCache();
      if (!c) {
        if (mounted) setState({ status: 'loading', id: null });
        return;
      }
      const e = c.get(key);
      if (!e) {
        if (mounted) setState({ status: 'none', id: null });
      } else {
        if (mounted) setState({ status: e.active ? 'active' : 'inactive', id: e.id });
      }
    };
    compute();
    void loadWhitelist();
    const unsub = subscribeWhitelist(compute);
    return () => {
      mounted = false;
      unsub();
    };
  }, [key]);

  return state;
}
