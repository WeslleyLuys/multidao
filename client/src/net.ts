import type { ClientMsg, ServerMsg } from '../../shared/protocol';

type Handler = (msg: ServerMsg) => void;

// Conexão WebSocket com reconexão automática (backoff exponencial com jitter).
export class Net {
  private ws?: WebSocket;
  private handlers = new Set<Handler>();
  private attempts = 0;
  private closed = false;
  onStatus: (online: boolean) => void = () => {};
  onOpen: () => void = () => {};

  constructor() {
    this.connect();
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.onStatus(true);
      this.onOpen();
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      for (const h of this.handlers) h(msg);
    };
    ws.onclose = () => {
      this.onStatus(false);
      if (this.closed) return;
      const delay = Math.min(15000, 800 * 2 ** this.attempts++) * (0.6 + Math.random() * 0.4);
      setTimeout(() => this.connect(), delay);
    };
  }

  get ready() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: ClientMsg) {
    if (this.ready) this.ws!.send(JSON.stringify(msg));
  }

  on(h: Handler) {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }
}
