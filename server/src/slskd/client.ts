export interface SlskdSearchFile {
  filename: string;
  size: number;
  bitRate?: number | null;
  bitDepth?: number | null;
  sampleRate?: number | null;
  /** duration in seconds */
  length?: number | null;
}

export interface SlskdSearchResponse {
  username: string;
  hasFreeUploadSlot: boolean;
  queueLength: number;
  uploadSpeed: number;
  files: SlskdSearchFile[];
}

export interface SlskdTransfer {
  id: string;
  username: string;
  filename: string;
  size: number;
  bytesTransferred: number;
  /** e.g. "Queued, Remotely" | "InProgress" | "Completed, Succeeded" | "Completed, Errored" */
  state: string;
}

interface RawTransferUser {
  username: string;
  directories?: { directory: string; files?: Omit<SlskdTransfer, 'username'>[] }[];
}

export class SlskdError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(`slskd ${status}: ${message}`);
    this.name = 'SlskdError';
  }
}

export class SlskdClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'X-API-Key': this.apiKey };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.fetchImpl(`${this.baseUrl}/api/v0${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new SlskdError(res.status, (await res.text().catch(() => '')) || res.statusText);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Runs a search and waits for it to complete (or the timeout), then returns peer responses. */
  async search(searchText: string, timeoutSec: number): Promise<SlskdSearchResponse[]> {
    const created = await this.request<{ id: string }>('POST', '/searches', {
      searchText,
      searchTimeout: Math.min(timeoutSec, 30) * 1000,
      filterResponses: true,
      minimumResponseFileCount: 1,
    });
    const id = created.id;
    const deadline = Date.now() + timeoutSec * 1000;
    try {
      for (;;) {
        const s = await this.request<{ state: string }>('GET', `/searches/${id}`);
        if (s.state.includes('Completed')) break;
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      const responses = await this.request<SlskdSearchResponse[]>('GET', `/searches/${id}/responses`);
      return responses.map((r) => ({ ...r, files: r.files ?? [] }));
    } finally {
      void this.request('DELETE', `/searches/${id}`).catch(() => {});
    }
  }

  enqueueDownloads(username: string, files: { filename: string; size: number }[]): Promise<void> {
    return this.request('POST', `/transfers/downloads/${encodeURIComponent(username)}`, files);
  }

  async downloads(): Promise<SlskdTransfer[]> {
    const users = await this.request<RawTransferUser[]>('GET', '/transfers/downloads');
    const out: SlskdTransfer[] = [];
    for (const u of users) {
      for (const d of u.directories ?? []) {
        for (const f of d.files ?? []) out.push({ ...f, username: u.username });
      }
    }
    return out;
  }

  cancelDownload(username: string, id: string, remove = false): Promise<void> {
    return this.request(
      'DELETE',
      `/transfers/downloads/${encodeURIComponent(username)}/${encodeURIComponent(id)}?remove=${remove}`,
    );
  }
}
