/* ────────────────────────────────────────────────────────────────────────────
 * HubSocket — thin client for the server-authoritative Game Hub WebSocket.
 *
 * The WS host is derived from getApiUrl() (http→ws) so it always points at the
 * same backend the REST calls use (prod Railway via backend.webcod.in, or a
 * custom dev domain). All match logic is server-side; this just ships intents
 * (JOIN_QUEUE / SHOT / RESUME…) and surfaces authoritative results.
 *
 * Reconnect: a mid-match socket drop must NOT cost the player their stake. On an
 * unexpected close the socket auto-reconnects with backoff for ~24s (inside the
 * server's 30s GRACE window). onOpen reports whether it was a reconnect so the
 * consumer can send RESUME (re-attach to the live match) instead of JOIN_QUEUE.
 * An intentional close() (leaving / switching to practice) disables reconnect.
 * ──────────────────────────────────────────────────────────────────────────── */

import { getApiUrl } from '@/lib/query-client';
import { HUB_WS_PATH, type HubClientMsg, type HubServerMsg } from '@shared/gamehub';

export function makeHubUrl(): string {
  const base = getApiUrl();
  return base.replace(/^http/i, 'ws') + HUB_WS_PATH;
}

export interface HubHandlers {
  /** Fired on every successful open. isReconnect=true after a dropped connection. */
  onOpen?: (isReconnect: boolean) => void;
  onMessage: (msg: HubServerMsg) => void;
  onClose?: (ev?: any) => void;
  onError?: (ev?: any) => void;
  /** Fired before each reconnect attempt (1-indexed). */
  onReconnecting?: (attempt: number, max: number) => void;
  /** Fired once reconnect attempts are exhausted — the match is likely forfeited. */
  onReconnectGaveUp?: () => void;
}

const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_BACKOFF_MS = 3000;

export class HubSocket {
  private ws: WebSocket | null = null;
  private handlers: HubHandlers;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;      // set by an intentional close() — suppresses reconnect
  private everOpened = false;  // distinguishes the first connect from a reconnect
  private attempts = 0;

  constructor(handlers: HubHandlers) {
    this.handlers = handlers;
  }

  connect() {
    this.closed = false;
    try {
      this.ws = new WebSocket(makeHubUrl());
    } catch (e) {
      this.handlers.onError?.(e);
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      const isReconnect = this.everOpened;
      this.everOpened = true;
      this.attempts = 0;
      this.handlers.onOpen?.(isReconnect);
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
      if (!this.closed) this.scheduleReconnect();
    };
    this.ws.onerror = (ev: any) => this.handlers.onError?.(ev);
  }

  private scheduleReconnect() {
    if (this.closed) return;
    if (this.attempts >= MAX_RECONNECT_ATTEMPTS) {
      this.handlers.onReconnectGaveUp?.();
      return;
    }
    this.attempts += 1;
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** (this.attempts - 1));
    this.handlers.onReconnecting?.(this.attempts, MAX_RECONNECT_ATTEMPTS);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
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
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
    this.ws = null;
  }
}
