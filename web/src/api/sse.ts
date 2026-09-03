import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { JobLogLine, ServerEvent } from '@encore/shared';
import { useSession } from '../state/session';

/**
 * Subscribes to the server's SSE stream (fetch-based so we can send the
 * Authorization header) and keeps request-related queries fresh.
 */
export function useServerEvents() {
  const queryClient = useQueryClient();
  const token = useSession((s) => s.session?.token);
  const serverUrl = useSession((s) => s.serverUrl);

  useEffect(() => {
    if (!token) return;
    let stopped = false;
    let ctrl: AbortController | null = null;

    const handle = (event: ServerEvent) => {
      if (event.kind === 'request-updated') {
        void queryClient.invalidateQueries({ queryKey: ['requests'] });
        void queryClient.invalidateQueries({ queryKey: ['mb-search'] });
        void queryClient.invalidateQueries({ queryKey: ['mb-artist'] });
        if (event.request.status === 'available') {
          // new music landed — refresh library views
          void queryClient.invalidateQueries({ queryKey: ['home'] });
          void queryClient.invalidateQueries({ queryKey: ['albums'] });
        }
      }
      if (event.kind === 'import-updated') {
        void queryClient.invalidateQueries({ queryKey: ['imports'] });
        void queryClient.invalidateQueries({ queryKey: ['import', event.batchId] });
        if (event.status === 'done') void queryClient.invalidateQueries({ queryKey: ['requests'] });
      }
      if (event.kind === 'job-log' && event.requestId) {
        queryClient.setQueryData<JobLogLine[]>(['request-logs', event.requestId], (prev = []) =>
          [...prev, { ts: event.ts, level: event.level, message: event.message }].slice(-500),
        );
      }
    };

    const connect = async (attempt: number) => {
      if (stopped) return;
      ctrl = new AbortController();
      try {
        const res = await fetch(`${serverUrl}/api/events`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error(`SSE connect failed (${res.status})`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        attempt = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let sep;
          while ((sep = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const data = frame
              .split('\n')
              .filter((l) => l.startsWith('data: '))
              .map((l) => l.slice(6))
              .join('\n');
            if (!data) continue;
            try {
              handle(JSON.parse(data) as ServerEvent);
            } catch {
              /* ignore malformed frames */
            }
          }
        }
        throw new Error('SSE stream ended');
      } catch {
        if (stopped) return;
        const delay = Math.min(30_000, 1000 * 2 ** attempt);
        setTimeout(() => void connect(attempt + 1), delay);
      }
    };

    void connect(0);
    return () => {
      stopped = true;
      ctrl?.abort();
    };
  }, [token, serverUrl, queryClient]);
}
