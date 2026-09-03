import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Download, ExternalLink, Loader2, Music, Play } from 'lucide-react';
import type { ImportItem } from '@encore/shared';
import { useImport, useRequestAllMissing, useRequestImportItem } from '../api/queries';
import { ImportStatusChip } from './Playlists';
import { PageSpinner } from './Home';

export function ImportPage() {
  const { id } = useParams<{ id: string }>();
  const { data: batch, isLoading } = useImport(id);
  const request = useRequestImportItem();
  const requestAll = useRequestAllMissing();
  const [errorItemId, setErrorItemId] = useState<string | null>(null);
  const [errorText, setErrorText] = useState('');
  const [banner, setBanner] = useState<string | null>(null);
  if (isLoading || !batch) return <PageSpinner />;

  const inLibraryCount = batch.items.filter((i) => i.inLibrary).length;
  const missingCount = batch.items.filter((i) => !i.inLibrary).length;
  const requestedCount = batch.items.filter((i) => !i.inLibrary && i.requestId).length;
  const requestableCount = batch.items.filter(
    (i) => !i.inLibrary && !i.requestId && i.matchMbRecordingId,
  ).length;

  const onRequest = (item: ImportItem) => {
    setErrorItemId(null);
    setErrorText('');
    request.mutate(
      { batchId: batch.id, itemId: item.id },
      {
        onError: (e) => {
          setErrorItemId(item.id);
          setErrorText(e.message);
        },
      },
    );
  };

  const onRequestAll = () => {
    if (!requestableCount) return;
    if (!window.confirm(`Fire ${requestableCount} download request(s)? They'll show up in the Requests tab and grab off Soulseek.`))
      return;
    setBanner(null);
    requestAll.mutate(batch.id, {
      onSuccess: ({ requested, skipped, error }) => {
        setBanner(
          `Requested ${requested} track(s); skipped ${skipped}${
            error ? ` — stopped: ${error}` : ''
          }`,
        );
      },
      onError: (e) => setBanner(`Request-all failed: ${e.message}`),
    });
  };

  return (
    <div className="mx-auto max-w-4xl">
      {/* header — Spotify-style with big cover, title, meta */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end">
        <ImportCover coverUrl={batch.coverUrl} title={batch.title ?? 'Playlist'} />
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
            Imported {batch.source} playlist
          </div>
          <h2 className="mt-1 truncate text-3xl font-extrabold sm:text-4xl">{batch.title ?? '—'}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-zinc-400">
            <ImportStatusChip status={batch.status} />
            <span>
              {batch.items.length} track(s) · {inLibraryCount} in library · {missingCount} missing
              {requestedCount > 0 ? ` · ${requestedCount} requested` : ''}
            </span>
            <a
              href={batch.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-zinc-500 hover:text-white"
              title="Open source playlist"
            >
              <ExternalLink className="size-3.5" />
            </a>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {batch.jellyfinPlaylistId && (
              <Link
                to={`/playlists/${batch.jellyfinPlaylistId}`}
                className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-semibold text-black hover:bg-accent-dim"
              >
                <Play className="size-4" /> Open playlist
              </Link>
            )}
            {requestableCount > 0 && (
              <button
                onClick={onRequestAll}
                disabled={requestAll.isPending}
                className="inline-flex items-center gap-2 rounded-full bg-panel-hover px-5 py-2 text-sm font-semibold text-zinc-100 hover:bg-zinc-700 disabled:opacity-50"
              >
                {requestAll.isPending ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                Request {requestableCount} missing
              </button>
            )}
          </div>
        </div>
      </div>

      {batch.status === 'resolving' && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-zinc-800 bg-panel p-3 text-sm text-zinc-300">
          <Loader2 className="size-4 animate-spin text-accent" />
          Matching tracks against MusicBrainz and your Jellyfin library…
        </div>
      )}
      {batch.status === 'failed' && (
        <div className="mb-4 rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
          {batch.error ?? 'Import failed'}
        </div>
      )}
      {batch.status === 'done' && batch.truncated && (
        <div className="mb-4 rounded-lg border border-amber-900 bg-amber-950/30 p-3 text-sm text-amber-200">
          Spotify’s public embed only exposes the first 100 tracks — anything beyond that isn’t here.
        </div>
      )}
      {banner && (
        <div className="mb-4 rounded-lg border border-zinc-700 bg-panel p-3 text-sm text-zinc-200">{banner}</div>
      )}

      <div className="flex flex-col gap-1">
        {batch.items.map((item) => (
          <ImportRow
            key={item.id}
            item={item}
            busy={request.isPending && request.variables?.itemId === item.id}
            onRequest={() => onRequest(item)}
            error={errorItemId === item.id ? errorText : null}
          />
        ))}
      </div>
    </div>
  );
}

function ImportCover({ coverUrl, title }: { coverUrl?: string | null; title: string }) {
  const [failed, setFailed] = useState(false);
  if (!coverUrl || failed) {
    return (
      <div className="flex size-40 shrink-0 items-center justify-center rounded-md bg-panel-hover text-zinc-600 sm:size-48">
        <Music className="size-1/3" />
      </div>
    );
  }
  return (
    <img
      src={coverUrl}
      alt={title}
      onError={() => setFailed(true)}
      className="size-40 shrink-0 rounded-md object-cover sm:size-48"
    />
  );
}

function ImportRow({
  item,
  busy,
  onRequest,
  error,
}: {
  item: ImportItem;
  busy: boolean;
  onRequest: () => void;
  error: string | null;
}) {
  const missing = !item.inLibrary;
  return (
    <div
      className={`flex items-center gap-3 rounded-md border border-zinc-800/60 bg-panel/60 px-3 py-2 ${
        missing ? 'text-zinc-400' : 'text-zinc-100'
      }`}
    >
      <span className="w-6 shrink-0 text-right text-xs tabular-nums text-zinc-500">{item.position + 1}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{item.sourceTitle}</span>
        <span className="block truncate text-xs text-zinc-500">{item.sourceArtist ?? '—'}</span>
        {error && <span className="mt-1 block truncate text-xs text-red-400">{error}</span>}
      </span>
      <RowStatus item={item} busy={busy} onRequest={onRequest} />
    </div>
  );
}

function RowStatus({
  item,
  busy,
  onRequest,
}: {
  item: ImportItem;
  busy: boolean;
  onRequest: () => void;
}) {
  if (item.inLibrary) {
    return (
      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
        In library
      </span>
    );
  }
  if (item.requestId) {
    return (
      <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] font-semibold text-sky-300">
        Requested
      </span>
    );
  }
  if (!item.matchMbRecordingId) {
    return (
      <span className="rounded-full bg-zinc-700/50 px-2 py-0.5 text-[11px] font-semibold text-zinc-400">
        No MusicBrainz match
      </span>
    );
  }
  return (
    <button
      onClick={onRequest}
      disabled={busy}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-black hover:bg-accent-dim disabled:opacity-50"
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
      Request
    </button>
  );
}
