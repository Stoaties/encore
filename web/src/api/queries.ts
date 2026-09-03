import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AlbumDetail,
  AlbumSummary,
  AppSettings,
  ArtistDetail,
  ArtistSummary,
  CreateRequestBody,
  HomeData,
  ImportBatch,
  JobLogLine,
  MbArtistDetail,
  MbSearchResults,
  MusicRequest,
  Paged,
  PlaylistDetail,
  PlaylistSummary,
  SearchResults,
  TrackSummary,
} from '@encore/shared';
import { api } from './client';

export const useHome = () =>
  useQuery({ queryKey: ['home'], queryFn: () => api<HomeData>('/api/library/home') });

export const useArtists = (start = 0, limit = 100, search = '') =>
  useQuery({
    queryKey: ['artists', start, limit, search],
    queryFn: () =>
      api<Paged<ArtistSummary>>(
        `/api/library/artists?start=${start}&limit=${limit}${search ? `&search=${encodeURIComponent(search)}` : ''}`,
      ),
  });

export const useArtist = (id: string | undefined) =>
  useQuery({
    queryKey: ['artist', id],
    queryFn: () => api<ArtistDetail>(`/api/library/artists/${id}`),
    enabled: !!id,
  });

export const useAlbums = (sort: 'recent' | 'name' | 'random' | 'year', start = 0, limit = 60) =>
  useQuery({
    queryKey: ['albums', sort, start, limit],
    queryFn: () => api<Paged<AlbumSummary>>(`/api/library/albums?sort=${sort}&start=${start}&limit=${limit}`),
  });

export const useAlbum = (id: string | undefined) =>
  useQuery({
    queryKey: ['album', id],
    queryFn: () => api<AlbumDetail>(`/api/library/albums/${id}`),
    enabled: !!id,
  });

export const useLibrarySearch = (q: string) =>
  useQuery({
    queryKey: ['library-search', q],
    queryFn: () => api<SearchResults>(`/api/library/search?q=${encodeURIComponent(q)}`),
    enabled: q.trim().length > 0,
    placeholderData: (prev) => prev,
  });

// ---------- discovery / requests ----------

export const useMbSearch = (q: string) =>
  useQuery({
    queryKey: ['mb-search', q],
    queryFn: () => api<MbSearchResults>(`/api/mb/search?q=${encodeURIComponent(q)}`),
    enabled: q.trim().length > 0,
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  });

export const useMbArtist = (mbid: string | null) =>
  useQuery({
    queryKey: ['mb-artist', mbid],
    queryFn: () => api<MbArtistDetail>(`/api/mb/artist/${mbid}`),
    enabled: !!mbid,
    staleTime: 5 * 60_000,
  });

export const useRequests = (scope: 'mine' | 'all') =>
  useQuery({
    queryKey: ['requests', scope],
    queryFn: () => api<MusicRequest[]>(`/api/requests?scope=${scope}`),
  });

/**
 * Maps of MB id → request id for available (in-library) non-artist requests.
 * Powers the refetch button on Album/Track views — items with no matching
 * request row (e.g. imported outside Encore) simply don't get the button.
 */
export const useRefetchableRequests = (): {
  albums: Map<string, MusicRequest>;
  tracks: Map<string, MusicRequest>;
} => {
  const { data } = useRequests('all');
  const albums = new Map<string, MusicRequest>();
  const tracks = new Map<string, MusicRequest>();
  for (const r of data ?? []) {
    if (r.status !== 'available' || r.type === 'artist') continue;
    if (r.type === 'album' && r.mbReleaseGroupId) albums.set(r.mbReleaseGroupId, r);
    if (r.type === 'track' && r.mbRecordingId) tracks.set(r.mbRecordingId, r);
  }
  return { albums, tracks };
};

const invalidateRequestData = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: ['requests'] });
  void qc.invalidateQueries({ queryKey: ['mb-search'] });
  void qc.invalidateQueries({ queryKey: ['mb-artist'] });
};

export const useCreateRequest = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateRequestBody) => api<MusicRequest>('/api/requests', { method: 'POST', body }),
    onSettled: () => invalidateRequestData(qc),
  });
};

export const useRequestAction = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      action,
    }: {
      id: string;
      action: 'approve' | 'deny' | 'retry' | 'refetch' | 'delete';
    }) => {
      if (action === 'delete') {
        await api<void>(`/api/requests/${id}`, { method: 'DELETE' });
        return null;
      }
      return api<MusicRequest>(`/api/requests/${id}/${action}`, { method: 'POST' });
    },
    onSettled: () => invalidateRequestData(qc),
  });
};

/** Acquisition logs for a request (admin). SSE appends live lines to the same key. */
export const useRequestLogs = (id: string | null) =>
  useQuery({
    queryKey: ['request-logs', id],
    queryFn: () => api<JobLogLine[]>(`/api/requests/${id}/logs`),
    enabled: !!id,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

// ---------- playlists ----------

export const usePlaylists = () =>
  useQuery({ queryKey: ['playlists'], queryFn: () => api<PlaylistSummary[]>('/api/playlists') });

export const usePlaylist = (id: string | undefined) =>
  useQuery({
    queryKey: ['playlist', id],
    queryFn: () => api<PlaylistDetail>(`/api/playlists/${id}`),
    enabled: !!id,
  });

export const useCreatePlaylist = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; itemIds?: string[]; isPublic?: boolean }) =>
      api<PlaylistSummary>('/api/playlists', { method: 'POST', body }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['playlists'] }),
  });
};

export const useUpdatePlaylist = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; isPublic?: boolean }) =>
      api<PlaylistSummary>(`/api/playlists/${id}`, { method: 'PATCH', body }),
    onSettled: (_d, _e, v) => {
      void qc.invalidateQueries({ queryKey: ['playlists'] });
      void qc.invalidateQueries({ queryKey: ['playlist', v.id] });
    },
  });
};

export const useCreateShare = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<import('@encore/shared').PlaylistShare>(`/api/playlists/${id}/share`, { method: 'POST' }),
    onSettled: (_d, _e, id) => void qc.invalidateQueries({ queryKey: ['playlist', id] }),
  });
};

export const useRevokeShare = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/api/playlists/${id}/share`, { method: 'DELETE' }),
    onSettled: (_d, _e, id) => void qc.invalidateQueries({ queryKey: ['playlist', id] }),
  });
};

export const useAddToPlaylist = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ playlistId, itemIds }: { playlistId: string; itemIds: string[] }) =>
      api<{ ok: true }>(`/api/playlists/${playlistId}/items`, { method: 'POST', body: { itemIds } }),
    onSettled: (_d, _e, v) => {
      void qc.invalidateQueries({ queryKey: ['playlists'] });
      void qc.invalidateQueries({ queryKey: ['playlist', v.playlistId] });
    },
  });
};

export const useRemoveFromPlaylist = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ playlistId, entryIds }: { playlistId: string; entryIds: string[] }) =>
      api<{ ok: true }>(`/api/playlists/${playlistId}/items?entryIds=${entryIds.map(encodeURIComponent).join(',')}`, {
        method: 'DELETE',
      }),
    onSettled: (_d, _e, v) => {
      void qc.invalidateQueries({ queryKey: ['playlists'] });
      void qc.invalidateQueries({ queryKey: ['playlist', v.playlistId] });
    },
  });
};

export const useDeletePlaylist = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (playlistId: string) => api<{ ok: true }>(`/api/playlists/${playlistId}`, { method: 'DELETE' }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['playlists'] }),
  });
};

// ---------- favorites / playback ----------

export const useFavorites = () =>
  useQuery({ queryKey: ['favorites'], queryFn: () => api<TrackSummary[]>('/api/playback/favorites') });

/** Set of favorited item ids, shared by every heart button. */
export const useFavoriteIds = (): Set<string> => {
  const { data } = useFavorites();
  return new Set((data ?? []).map((t) => t.id));
};

export const useToggleFavorite = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, favorite }: { itemId: string; favorite: boolean }) =>
      api<{ isFavorite: boolean }>(`/api/playback/favorites/${itemId}`, { method: 'POST', body: { favorite } }),
    onMutate: async ({ itemId, favorite }) => {
      await qc.cancelQueries({ queryKey: ['favorites'] });
      const prev = qc.getQueryData<TrackSummary[]>(['favorites']);
      if (prev) {
        qc.setQueryData(
          ['favorites'],
          favorite ? prev : prev.filter((t) => t.id !== itemId), // additions need a refetch for full track data
        );
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['favorites'], ctx.prev);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['favorites'] }),
  });
};

export const useSmartShuffle = () =>
  useMutation({
    mutationFn: (itemIds: string[]) =>
      api<{ order: string[] }>('/api/playback/smart-shuffle', { method: 'POST', body: { itemIds } }),
  });

// ---------- playlist imports ----------

export const useImports = () =>
  useQuery({ queryKey: ['imports'], queryFn: () => api<ImportBatch[]>('/api/imports') });

export const useImport = (id: string | undefined) =>
  useQuery({
    queryKey: ['import', id],
    queryFn: () => api<ImportBatch>(`/api/imports/${id}`),
    enabled: !!id,
  });

export const useCreateImport = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (url: string) => api<ImportBatch>('/api/imports', { method: 'POST', body: { url } }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['imports'] }),
  });
};

/** Request a single missing item from an import — fires the normal Encore
 *  request pipeline so it shows up in the Requests tab. */
export const useRequestImportItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ batchId, itemId }: { batchId: string; itemId: string }) =>
      api<ImportBatch>(`/api/imports/${batchId}/items/${itemId}/request`, { method: 'POST' }),
    onSuccess: (data) => qc.setQueryData(['import', data.id], data),
    onSettled: (_d, _e, v) => {
      void qc.invalidateQueries({ queryKey: ['imports'] });
      void qc.invalidateQueries({ queryKey: ['import', v.batchId] });
      void qc.invalidateQueries({ queryKey: ['requests'] });
    },
  });
};

/** Fire requests for every missing item in the import in one shot. */
export const useRequestAllMissing = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (batchId: string) =>
      api<{ batch: ImportBatch; requested: number; skipped: number; error?: string }>(
        `/api/imports/${batchId}/request-all`,
        { method: 'POST' },
      ),
    onSuccess: ({ batch }) => qc.setQueryData(['import', batch.id], batch),
    onSettled: (_d, _e, batchId) => {
      void qc.invalidateQueries({ queryKey: ['imports'] });
      void qc.invalidateQueries({ queryKey: ['import', batchId] });
      void qc.invalidateQueries({ queryKey: ['requests'] });
    },
  });
};

export const useDeleteImport = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/api/imports/${id}`, { method: 'DELETE' }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['imports'] }),
  });
};

export const useAppSettings = (enabled: boolean) =>
  useQuery({
    queryKey: ['settings'],
    queryFn: () => api<AppSettings>('/api/settings'),
    enabled,
  });

export const useUpdateSettings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<AppSettings>) => api<AppSettings>('/api/settings', { method: 'PUT', body: patch }),
    onSuccess: (data) => qc.setQueryData(['settings'], data),
  });
};
