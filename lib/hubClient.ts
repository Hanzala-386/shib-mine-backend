/* ────────────────────────────────────────────────────────────────────────────
 * HubSocket — thin client for the server-authoritative Game Hub WebSocket.
 *
 * The WS host is derived from getApiUrl() (http→ws) so it always points at the
 * same backend the REST calls use (prod Railway via backend.webcod.in, or a
 * custom dev domain). All match logic is server-side; this just ships intents
 * (JOIN_QUEUE / SHOT / RESUME…) and surfaces authoritative results.
 * ──────────────────────────────────────────────────────────────────────────── */

import { getApiUrl } from '@/lib/query-client';
import { HUB_WS_PATH, type HubClientMsg, type HubServerMsg } from '@shared/gamehub';

export function makeHubUrl(): string {
  const base = getApiUrl();
  return base.replace(/^http/i, 'ws') + HUB_WS_PATH;
}

export interface HubHandlers {
  onOpen?: () => void;
  onMessage: (msg: HubServerMsg) => void;
  onClose?: (ev?: any) => void;
  onError?: (ev?: any) => void;
}

export class HubSocket {
  private ws: WebSocket | null = null;
  private handlers: HubHandlers;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(handlers: HubHandlers) {
    this.handlers = handlers;
  }

  connect() {
    try {
      this.ws = new WebSocket(makeHubUrl());
    } catch (e) {
      this.handlers.onError?.(e);
      return;
    }
    this.ws.onopen = () => {
      this.handlers.onOpen?.();
      this.pingTimer = setInterval(() => this.send({ type: 'PING' }), 20000);
    };
    this.ws.onmessage = (ev: any) => {
      try {
        const raw = typeof ev.data === 'string' ? ev.data : '';
        if (!raw) return;
        this.handlers.onMessage(JSON.parse(raw) as HubServerMsg);
      } catch {
        /* ignore malformed frames */
      }
    };
    this.ws.onclose = (ev: any) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.handlers.onClose?.(ev);
    };
    this.ws.onerror = (ev: any) => this.handlers.onError?.(ev);
  }

  send(msg: HubClientMsg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
    this.ws = null;
  }
}
