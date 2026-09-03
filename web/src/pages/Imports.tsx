import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { ArrowRight, Check, Loader2, X } from 'lucide-react';
import type { ImportItem } from '@encore/shared';
import { useConfirmImport, useImport } from '../api/queries';
import { ImportStatusChip } from './Playlists';
import { PageSpinner } from './Home';

type Decision = 'confirmed' | 'rejected';

/** The effective decision for an item, given user overrides (mirrors the backend default). */
const effective = (item: ImportItem, overrides: Map<string, Decision>): Decision | null => {
  if (!item.matchMbRecordingId || item.inLibrary) return null;
  return overrides.get(item.id) ?? (item.matchStatus === 'auto' ? 'confirmed' : null);
};

export function ImportPage() {
  const { id } = useParams<{ id: string }>();
  const { data: batch, isLoading } = useImport(id);
  const confirm = useConfirmImport();
  const [overrides, setOverrides] = useState<Map<string, Decision>>(new Map());
  if (isLoading || !batch) return <PageSpinner />;

  const reviewing = batch.status === 'review';
  const toRequest = batch.items.filter((i) => effective(i, overrides) === 'confirmed').length;
  const matched = batch.items.filter((i) => i.matchMbRecordingId || i.inLibrary).length;

  const setDecision = (itemId: string, d: Decision) =>
    setOverrides((prev) => new Map(prev).set(itemId, d));

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-1 flex flex-wrap items-center gap-3">
        <h2 className="truncate text-2xl font-bold">{batch.title ?? 'Playlist import'}</h2>
        <ImportStatusChip status={batch.status} />
      </div>
      <div className="mb-4 truncate text-sm capitalize text-zinc-400">
        {batch.source} · <span className="normal-case">{batch.url}</span>
      </div>

      {batch.status === 'resolving' && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-zinc-800 bg-panel p-3 text-sm text-zinc-300">
          <Loader2 className="size-4 animate-spin text-accent" />
          Matching tracks against MusicBrainz… {matched} of {batch.items.length || '?'} matched so far
        </div>
      )}
      {batch.status === 'failed' && (
        <div className="mb-4 rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
          {batch.error ?? 'Import failed'}
        </div>
      )}
      {batch.status === 'done' && batch.error && (
        <div className="mb-4 rounded-lg border border-amber-900 bg-amber-950/30 p-3 text-sm text-amber-300">
          {batch.error}
        </div>
      )}

      {reviewing && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-panel p-3">
          <span className="text-sm text-zinc-300">
            <strong>{toRequest}</strong> track(s) will be requested — review the uncertain matches below.
          </span>
          <button
            onClick={() =>
              confirm.mutate(
                { id: batch.id, items: [...overrides].map(([oid, status]) => ({ id: oid, status })) },
                { onSuccess: () => setOverrides(new Map()) },
              )
            }
            disabled={confirm.isPending || toRequest === 0}
            className="ml-auto flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-sm font-semibold text-black hover:bg-accent-dim disabled:opacity-50"
          >
            {confirm.isPending && <Loader2 className="size-4 animate-spin" />}
            Request {toRequest} track(s)
          </button>
        </div>
      )}

      <div className="flex flex-col gap-1">
        {batch.items.map((item) => (
          <ImportItemRow
            key={item.id}
            item={item}
            reviewing={reviewing}
            decision={effective(item, overrides)}
            onDecide={(d) => setDecision(item.id, d)}
          />
        ))}
        {!batch.items.length && batch.status !== 'failed' && (
          <p className="text-sm text-zinc-400">Fetching the playlist…</p>
        )}
      </div>
    </div>
  );
}

function scoreColor(score: number): string {
  if (score >= 0.8) return 'bg-emerald-500/15 text-emerald-300';
  if (score >= 0.45) return 'bg-amber-500/15 text-amber-300';
  return 'bg-red-500/15 text-red-300';
}

function ResultChip({ item }: { item: ImportItem }) {
  if (item.inLibrary) return <span className="rounded-full bg-zinc-700/50 px-2 py-0.5 text-[11px] font-semibold text-zinc-300">In library</span>;
  if (item.requestId) return <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">Requested</span>;
  switch (item.matchStatus) {
    case 'confirmed':
      return <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">Covered</span>;
    case 'rejected':
      return <span className="rounded-full bg-zinc-700/50 px-2 py-0.5 text-[11px] font-semibold text-zinc-400">Skipped</span>;
    case 'unmatched':
      return <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-semibold text-red-300">No match</span>;
    default:
      return null;
  }
}

function ImportItemRow({
  item,
  reviewing,
  decision,
  onDecide,
}: {
  item: ImportItem;
  reviewing: boolean;
  decision: Decision | null;
  onDecide: (d: Decision) => void;
}) {
  const decidable = reviewing && !!item.matchMbRecordingId && !item.inLibrary;
  return (
    <div
      className={`flex items-center gap-3 rounded-md border border-zinc-800/60 bg-panel/60 px-3 py-2 ${
        decision === 'rejected' ? 'opacity-50' : ''
      }`}
    >
      <span className="w-6 shrink-0 text-right text-xs tabular-nums text-zinc-500">{item.position + 1}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-zinc-100">{item.sourceTitle}</span>
        <span className="block truncate text-xs text-zinc-400">{item.sourceArtist ?? '—'}</span>
      </span>
      <ArrowRight className="size-4 shrink-0 text-zinc-600" />
      <span className="min-w-0 flex-1">
        {item.matchMbRecordingId ? (
          <>
            <span className="block truncate text-sm text-zinc-100">{item.matchTitle}</span>
            <span className="block truncate text-xs text-zinc-400">
              {item.matchArtist}
              {item.matchAlbum ? ` · ${item.matchAlbum}` : ''}
            </span>
          </>
        ) : (
          <span className="text-sm text-zinc-500">{item.inLibrary ? '—' : 'No match found'}</span>
        )}
      </span>
      {item.matchScore != null && item.matchMbRecordingId && (
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ${scoreColor(item.matchScore)}`}>
          {Math.round(item.matchScore * 100)}%
        </span>
      )}
      {decidable ? (
        <span className="flex shrink-0 gap-1">
          <button
            onClick={() => onDecide('confirmed')}
            className={`rounded-full p-1.5 ${decision === 'confirmed' ? 'bg-emerald-500/20 text-emerald-300' : 'text-zinc-500 hover:text-white'}`}
            aria-label={`Accept match for ${item.sourceTitle}`}
          >
            <Check className="size-4" />
          </button>
          <button
            onClick={() => onDecide('rejected')}
            className={`rounded-full p-1.5 ${decision === 'rejected' ? 'bg-red-500/20 text-red-300' : 'text-zinc-500 hover:text-white'}`}
            aria-label={`Reject match for ${item.sourceTitle}`}
          >
            <X className="size-4" />
          </button>
        </span>
      ) : (
        <ResultChip item={item} />
      )}
    </div>
  );
}
