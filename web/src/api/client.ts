import { useSession } from '../state/session';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ApiOpts {
  method?: string;
  body?: unknown;
  auth?: boolean;
}

export async function api<T>(path: string, opts: ApiOpts = {}): Promise<T> {
  const { session, serverUrl, logout } = useSession.getState();
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.auth !== false && session) headers.Authorization = `Bearer ${session.token}`;
  const res = await fetch(`${serverUrl}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && opts.auth !== false) {
    logout();
    throw new ApiError(401, 'Session expired');
  }
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, message);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
