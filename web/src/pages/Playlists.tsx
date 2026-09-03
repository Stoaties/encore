import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Check, Copy, Globe, Heart, Link2, ListMusic, Loader2, Lock, Play, Plus, Trash2, X } from 'lucide-react';
import type { ImportBatch } from '@encore/shared';
import {
  useCreateImport,
  useCreatePlaylist,
  useCreateShare,
  useDeleteImport,
  useDeletePlaylist,
  useFavorites,
  useImports,
  usePlaylist,
  usePlaylists,
  useRemoveFromPlaylist,
  useRevokeShare,
  useUpdatePlaylist,
} from '../api/queries';
import { playQueue } from '../state/audio';
import { SmartShuffleButton } from '../components/SmartShuffleButton';
import { TrackList } from '../components/TrackList';
import { fmtDuration } from '../lib/format';
import { PageSpinner } from './Home';

export function Playlists() {
  const { data: playlists, isLoading } = usePlaylists();
  const { data: favorites } = useFavorites();
  const create = useCreatePlaylist();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  return (
    <div className="flex flex-col gap-8">
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-bold">Playlists</h2>
          {creating ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!name.trim()) return;
                create.mutate(
                  { name: name.trim() },
                  {
                    onSuccess: () => {
                      setName('');
                      setCreating(false);
                    },
                  },
                );
              }}
            >
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Playlist name"
                className="rounded-full border border-zinc-700 bg-panel px-4 py-1.5 text-sm outline-none focus:border-accent"
                aria-label="New playlist name"
              />
              <button
                type="submit"
                disabled={create.isPending}
                className="rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-black disabled:opacity-50"
              >
                Create
              </button>
              <button type="button" onClick={() => setCreating(false)} className="p-1 text-zinc-400" aria-label="Cancel">
                <X className="size-4" />
              </button>
            </form>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="flex items-center gap-2 rounded-full bg-panel-hover px-4 py-1.5 text-sm font-semibold hover:bg-zinc-700"
            >
              <Plus className="size-4" /> New playlist
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          <Link to="/favorites" className="group block rounded-lg bg-panel p-3 transition-colors hover:bg-panel-hover">
            <div className="mb-2 flex aspect-square w-full items-center justify-center rounded-md bg-gradient-to-br from-accent/80 to-purple-800">
              <Heart className="size-1/3 fill-white text-white" />
            </div>
            <div className="truncate text-sm font-medium">Liked Songs</div>
            <div className="truncate text-xs text-zinc-400">{favorites ? `${favorites.length} tracks` : 'Favorites'}</div>
          </Link>
          {(playlists ?? []).map((p) => (
            <Link
              key={p.id}
              to={`/playlists/${p.id}`}
              className="group block rounded-lg bg-panel p-3 transition-colors hover:bg-panel-hover"
            >
              <div className="mb-2 flex aspect-square w-full items-center justify-center rounded-md bg-panel-hover text-zinc-500">
                <ListMusic className="size-1/3" />
              </div>
              <div className="truncate text-sm font-medium">{p.name}</div>
              <div className="flex items-center gap-1.5 truncate text-xs text-zinc-400">
                {p.isPublic === true && <Globe className="size-3" />}
                {p.isPublic === false && <Lock className="size-3" />}
                <span>{p.trackCount} tracks</span>
              </div>
            </Link>
          ))}
        </div>
        {isLoading && <PageSpinner />}
      </section>

      <ImportSection />
    </div>
  );
}

const importStatusStyle: Record<ImportBatch['status'], string> = {
  resolving: 'bg-blue-500/15 text-blue-300',
  review: 'bg-amber-500/15 text-amber-300',
  requesting: 'bg-blue-500/15 text-blue-300',
  done: 'bg-emerald-500/15 text-emerald-300',
  failed: 'bg-red-500/15 text-red-300',
};

export function ImportStatusChip({ status }: { status: ImportBatch['status'] }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${importStatusStyle[status]}`}
    >
      {(status === 'resolving' || status === 'requesting') && <Loader2 className="size-3 animate-spin" />}
      {status === 'review' ? 'needs review' : status}
    </span>
  );
}

function ImportSection() {
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { data: imports } = useImports();
  const create = useCreateImport();
  const del = useDeleteImport();
  const navigate = useNavigate();

  return (
    <section>
      <h2 className="mb-1 text-xl font-bold">Import a playlist</h2>
      <p className="mb-3 text-sm text-zinc-400">
        Paste a public Spotify or YouTube playlist link — tracks are matched to MusicBrainz and requested.
      </p>
      <form
        className="flex max-w-2xl gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!url.trim()) return;
          setError(null);
          create.mutate(url.trim(), {
            onSuccess: (batch) => {
              setUrl('');
              navigate(`/imports/${batch.id}`);
            },
            onError: (err) => setError(err.message),
          });
        }}
      >
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://open.spotify.com/playlist/… or https://youtube.com/playlist?list=…"
          className="w-full rounded-full border border-zinc-700 bg-panel px-4 py-2 text-sm outline-none focus:border-accent"
          aria-label="Playlist URL"
        />
        <button
          type="submit"
          disabled={create.isPending || !url.trim()}
          className="shrink-0 rounded-full bg-accent px-5 py-2 text-sm font-semibold text-black hover:bg-accent-dim disabled:opacity-50"
        >
          Import
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}

      {!!imports?.length && (
        <div className="mt-4 flex max-w-2xl flex-col gap-1">
          {imports.map((b) => (
            <div key={b.id} className="group flex items-center gap-3 rounded-md px-3 py-2 hover:bg-panel-hover">
              <Link to={`/imports/${b.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{b.title ?? b.url}</span>
                  <span className="block truncate text-xs capitalize text-zinc-400">
                    {b.source} · {new Date(b.createdAt).toLocaleDateString()}
                  </span>
                </span>
                <ImportStatusChip status={b.status} />
              </Link>
              <button
                onClick={() => del.mutate(b.id)}
                className="invisible p-1 text-zinc-500 hover:text-white group-hover:visible group-focus-within:visible"
                aria-label={`Delete import ${b.title ?? b.url}`}
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function PlaylistPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading } = usePlaylist(id);
  const remove = useRemoveFromPlaylist();
  const del = useDeletePlaylist();
  const update = useUpdatePlaylist();
  const [shareOpen, setShareOpen] = useState(false);
  if (isLoading || !data) return <PageSpinner />;
  const { playlist, tracks, share } = data;
  const isOwner = playlist.isOwner !== false; // treat unknown as owner (older API responses)

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="flex size-40 shrink-0 items-center justify-center rounded-md bg-panel-hover text-zinc-500 sm:size-48">
          <ListMusic className="size-1/3" />
        </div>
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
            Playlist · {playlist.isPublic ? 'Public' : 'Private'}
          </div>
          <h2 className="truncate text-3xl font-extrabold sm:text-4xl">{playlist.name}</h2>
          <div className="mt-1 text-sm text-zinc-400">
            {tracks.length} tracks · {fmtDuration(tracks.reduce((s, t) => s + t.durationSec, 0))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => playQueue(tracks, 0)}
              disabled={!tracks.length}
              className="flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-semibold text-black hover:bg-accent-dim disabled:opacity-50"
            >
              <Play className="size-4" /> Play
            </button>
            <SmartShuffleButton tracks={tracks} />
            {isOwner && id && (
              <button
                onClick={() =>
                  update.mutate({ id, isPublic: !playlist.isPublic })
                }
                className="flex items-center gap-2 rounded-full bg-panel-hover px-4 py-2 text-sm font-semibold text-zinc-300 hover:bg-zinc-700"
                title={playlist.isPublic ? 'Make private' : 'Make public'}
              >
                {playlist.isPublic ? <Globe className="size-4" /> : <Lock className="size-4" />}
                {playlist.isPublic ? 'Public' : 'Private'}
              </button>
            )}
            {isOwner && id && (
              <button
                onClick={() => setShareOpen(true)}
                className="flex items-center gap-2 rounded-full bg-panel-hover px-4 py-2 text-sm font-semibold text-zinc-300 hover:bg-zinc-700"
              >
                <Link2 className="size-4" /> Share
              </button>
            )}
            {isOwner && (
              <button
                onClick={() => {
                  if (!confirm(`Delete playlist “${playlist.name}”?`)) return;
                  del.mutate(playlist.id, { onSuccess: () => navigate('/playlists') });
                }}
                className="flex items-center gap-2 rounded-full bg-panel-hover px-4 py-2 text-sm font-semibold text-zinc-300 hover:bg-zinc-700"
                aria-label="Delete playlist"
              >
                <Trash2 className="size-4" />
              </button>
            )}
          </div>
        </div>
      </div>
      {tracks.length ? (
        <TrackList
          tracks={tracks}
          onRemove={
            isOwner
              ? (t) => {
                  if (t.playlistEntryId && id) remove.mutate({ playlistId: id, entryIds: [t.playlistEntryId] });
                }
              : undefined
          }
        />
      ) : (
        <p className="text-sm text-zinc-400">This playlist is empty — add tracks from any track list.</p>
      )}
      {shareOpen && id && (
        <ShareDialog playlistId={id} currentShare={share ?? null} onClose={() => setShareOpen(false)} />
      )}
    </div>
  );
}

function ShareDialog({
  playlistId,
  currentShare,
  onClose,
}: {
  playlistId: string;
  currentShare: import('@encore/shared').PlaylistShare | null;
  onClose: () => void;
}) {
  const create = useCreateShare();
  const revoke = useRevokeShare();
  const [copied, setCopied] = useState(false);
  const url = create.data?.url ?? currentShare?.url ?? '';
  const copy = async () => {
    if (!url) return;
    // navigator.clipboard needs a secure context (https or localhost) —
    // works everywhere except plain-http PWA loads
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (rare) — user can select + copy manually */
    }
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-zinc-800 bg-panel p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-bold">Share playlist</h3>
          <button onClick={onClose} className="p-1 text-zinc-400 hover:text-white" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <p className="mb-3 text-sm text-zinc-400">
          Anyone with this link can view and play the playlist — they don't need an account.
        </p>
        {url ? (
          <>
            <div className="mb-3 flex gap-2">
              <input
                readOnly
                value={url}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full rounded-md border border-zinc-700 bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
              />
              <button
                onClick={copy}
                className="flex shrink-0 items-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-semibold text-black hover:bg-accent-dim"
              >
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <button
              onClick={() => revoke.mutate(playlistId, { onSuccess: () => onClose() })}
              disabled={revoke.isPending}
              className="text-sm text-red-400 hover:underline disabled:opacity-50"
            >
              Revoke this link
            </button>
          </>
        ) : (
          <button
            onClick={() => create.mutate(playlistId)}
            disabled={create.isPending}
            className="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-black hover:bg-accent-dim disabled:opacity-50"
          >
            {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
            Create a share link
          </button>
        )}
      </div>
    </div>
  );
}
