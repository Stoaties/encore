import type { AlbumSummary, ArtistSummary, TrackSummary, PlaylistSummary } from '@encore/shared';
import type { JfItem } from './client.js';

const ticksToSec = (ticks?: number) => (ticks ? Math.round(ticks / 10_000_000) : 0);

export function toArtistSummary(i: JfItem): ArtistSummary {
  return {
    id: i.Id,
    name: i.Name,
    imageTag: i.ImageTags?.Primary ?? null,
  };
}

export function toAlbumSummary(i: JfItem): AlbumSummary {
  return {
    id: i.Id,
    name: i.Name,
    albumArtist: i.AlbumArtist || i.AlbumArtists?.[0]?.Name || i.Artists?.[0] || 'Unknown Artist',
    artistId: i.AlbumArtists?.[0]?.Id ?? i.ArtistItems?.[0]?.Id ?? null,
    year: i.ProductionYear ?? null,
    imageTag: i.ImageTags?.Primary ?? null,
    trackCount: i.ChildCount ?? null,
    runtimeSec: ticksToSec(i.RunTimeTicks) || null,
    isFavorite: i.UserData?.IsFavorite ?? false,
  };
}

export function toTrackSummary(i: JfItem): TrackSummary {
  return {
    id: i.Id,
    name: i.Name,
    album: i.Album ?? null,
    albumId: i.AlbumId ?? null,
    artists: i.Artists?.length ? i.Artists : i.ArtistItems?.map((a) => a.Name) ?? [],
    albumArtist: i.AlbumArtist ?? null,
    artistId: i.ArtistItems?.[0]?.Id ?? null,
    durationSec: ticksToSec(i.RunTimeTicks),
    trackNumber: i.IndexNumber ?? null,
    discNumber: i.ParentIndexNumber ?? null,
    imageItemId: i.AlbumId ?? i.Id,
    imageTag: i.AlbumPrimaryImageTag ?? i.ImageTags?.Primary ?? null,
    isFavorite: i.UserData?.IsFavorite ?? false,
    playlistEntryId: i.PlaylistItemId ?? null,
  };
}

export function toPlaylistSummary(i: JfItem, viewerJfUserId?: string): PlaylistSummary {
  const p: PlaylistSummary = {
    id: i.Id,
    name: i.Name,
    trackCount: i.ChildCount ?? null,
    imageTag: i.ImageTags?.Primary ?? null,
  };
  // Jellyfin 10.10+ replaced IsPublic with an OpenAccess enum ("None" = private).
  // Older/newer builds may return either — treat any truthy IsPublic or non-None
  // OpenAccess as public.
  const openAccess = i.OpenAccess;
  if (openAccess !== undefined) p.isPublic = openAccess !== 'None';
  else if (i.IsPublic !== undefined) p.isPublic = !!i.IsPublic;
  if (viewerJfUserId && i.OwnerUserId) p.isOwner = i.OwnerUserId === viewerJfUserId;
  return p;
}

// PlaylistUserAccess pulls OwnerUserId + OpenAccess out; needed to figure out
// whether the requesting user owns each playlist and whether it's public.
export const ITEM_FIELDS =
  'PrimaryImageAspectRatio,ProductionYear,ChildCount,RunTimeTicks,ParentId,ProviderIds,DateCreated,OwnerUserId,OpenAccess';
