export interface JfUser {
  Id: string;
  Name: string;
  Policy?: { IsAdministrator?: boolean };
}
export interface JfAuthResult {
  User: JfUser;
  AccessToken: string;
}
export interface JfNamedRef {
  Id: string;
  Name: string;
}
export interface JfItem {
  Id: string;
  Name: string;
  Type?: string;
  AlbumArtist?: string;
  AlbumArtists?: JfNamedRef[];
  Artists?: string[];
  ArtistItems?: JfNamedRef[];
  Album?: string;
  AlbumId?: string;
  AlbumPrimaryImageTag?: string;
  ImageTags?: Record<string, string>;
  RunTimeTicks?: number;
  ProductionYear?: number;
  IndexNumber?: number;
  ParentIndexNumber?: number;
  ChildCount?: number;
  UserData?: { IsFavorite?: boolean; PlayCount?: number };
  ProviderIds?: Record<string, string>;
  Path?: string;
  DateCreated?: string;
  PlaylistItemId?: string;
  OwnerUserId?: string;
  /** 10.10+ playlist visibility: "None" (private) | "Full" | user-scoped */
  OpenAccess?: string;
  /** legacy playlist visibility (older Jellyfin builds) */
  IsPublic?: boolean;
}
export interface JfItemsResult {
  Items: JfItem[];
  TotalRecordCount: number;
  StartIndex: number;
}

export class JellyfinError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(`Jellyfin ${status}: ${message}`);
    this.name = 'JellyfinError';
  }
}

export type JfQuery = Record<string, string | number | boolean | undefined>;

const CLIENT_VERSION = '0.1.0';

export class JellyfinClient {
  constructor(
    private baseUrl: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private authHeader(token?: string, deviceId = 'encore-server'): string {
    let h = `MediaBrowser Client="Encore", Device="Encore Server", DeviceId="${deviceId}", Version="${CLIENT_VERSION}"`;
    if (token) h += `, Token="${token}"`;
    return h;
  }

  async request<T>(
    method: string,
    path: string,
    opts: { token?: string; deviceId?: string; body?: unknown; query?: JfQuery } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { Authorization: this.authHeader(opts.token, opts.deviceId) };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      throw new JellyfinError(res.status, (await res.text().catch(() => '')) || res.statusText);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  authenticateByName(username: string, password: string, deviceId: string): Promise<JfAuthResult> {
    return this.request('POST', '/Users/AuthenticateByName', {
      deviceId,
      body: { Username: username, Pw: password },
    });
  }

  me(token: string): Promise<JfUser> {
    return this.request('GET', '/Users/Me', { token });
  }

  items(token: string, query: JfQuery): Promise<JfItemsResult> {
    return this.request('GET', '/Items', { token, query });
  }

  albumArtists(token: string, query: JfQuery): Promise<JfItemsResult> {
    return this.request('GET', '/Artists/AlbumArtists', { token, query });
  }

  getItem(token: string, itemId: string, userId?: string): Promise<JfItem> {
    return this.request('GET', `/Items/${itemId}`, { token, query: { userId } });
  }

  refreshLibrary(token: string): Promise<void> {
    return this.request('POST', '/Library/Refresh', { token });
  }

  setFavorite(token: string, userId: string, itemId: string, favorite: boolean): Promise<unknown> {
    return this.request(favorite ? 'POST' : 'DELETE', `/UserFavoriteItems/${itemId}`, {
      token,
      query: { userId },
    });
  }

  createPlaylist(
    token: string,
    body: { Name: string; UserId: string; Ids?: string[]; MediaType?: string; IsPublic?: boolean },
  ): Promise<{ Id: string }> {
    // Jellyfin defaults IsPublic=true — we override to false so playlists are
    // private to their creator unless they explicitly toggle public later
    return this.request('POST', '/Playlists', {
      token,
      body: { MediaType: 'Audio', Ids: [], IsPublic: false, ...body },
    });
  }

  updatePlaylist(
    token: string,
    playlistId: string,
    body: { Name?: string; IsPublic?: boolean },
  ): Promise<void> {
    return this.request('POST', `/Playlists/${playlistId}`, { token, body });
  }

  addPlaylistItems(token: string, playlistId: string, itemIds: string[], userId: string): Promise<void> {
    return this.request('POST', `/Playlists/${playlistId}/Items`, {
      token,
      query: { ids: itemIds.join(','), userId },
    });
  }

  removePlaylistItems(token: string, playlistId: string, entryIds: string[]): Promise<void> {
    return this.request('DELETE', `/Playlists/${playlistId}/Items`, {
      token,
      query: { EntryIds: entryIds.join(',') },
    });
  }

  playlistItems(token: string, playlistId: string, userId: string, query: JfQuery = {}): Promise<JfItemsResult> {
    return this.request('GET', `/Playlists/${playlistId}/Items`, { token, query: { UserId: userId, ...query } });
  }

  deleteItem(token: string, itemId: string): Promise<void> {
    return this.request('DELETE', `/Items/${itemId}`, { token });
  }

  markPlayed(token: string, userId: string, itemId: string): Promise<unknown> {
    return this.request('POST', `/UserPlayedItems/${itemId}`, { token, query: { userId } });
  }
}
