import { EventEmitter } from 'node:events';
import type { ServerEvent } from '@encore/shared';

/** In-process pub/sub feeding the SSE endpoint (single-instance deployment). */
export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(200);
  }

  publish(event: ServerEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(fn: (event: ServerEvent) => void): () => void {
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }
}
