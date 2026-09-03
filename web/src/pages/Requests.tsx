import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Disc3,
  Loader2,
  Mic2,
  Music,
  Music2,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Search as SearchIcon,
  Settings2,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  X,
} from 'lucide-react';
import type {
  AppSettings,
  MbArtistResult,
  MbRecordingResult,
  MbReleaseGroupResult,
  MusicRequest,
  RequestStatus,
  RequestType,
} from '@encore/shared';
import {
  useAppSettings,
  useCreateRequest,
  useMbArtist,
  useMbSearch,
  useRequestAction,
  useRequestLogs,
  useRequests,
  useUpdateSettings,
} from '../api/queries';
import { useSession } from '../state/session';
import { PageSpinner } from './Home';

// ---------- small bits ----------

function MbCover({ src, className = 'size-12' }: { src?: string | null; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className={`flex shrink-0 items-center justify-center rounded-md bg-panel-hover text-zinc-600 ${className}`}>
        <Music className="size-1/3" />
      </div>
    );
  }
  return <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} className={`shrink-0 rounded-md object-cover ${className}`} />;
}

const STATUS_STYLE: Record<RequestStatus, string> = {
  pending: 'bg-amber-500/15 text-amber-400',
  approved: 'bg-sky-500/15 text-sky-400',
  denied: 'bg-zinc-500/15 text-zinc-400',
  searching: 'bg-indigo-500/15 text-indigo-400',
  downloading: 'bg-emerald-500/15 text-emerald-400',
  processing: 'bg-violet-500/15 text-violet-400',
  available: 'bg-accent/15 text-accent',
  failed: 'bg-red-500/15 text-red-400',
};

function StatusChip({ status }: { status: RequestStatus }) {
  const busy = status === 'searching' || status === 'downloading' || status === 'processing';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}>
      {busy && <Loader2 className="size-3 animate-spin" />}
      {status}
    </span>
  );
}

function Badge({ kind }: { kind: 'inLibrary' | 'requested' }) {
  return kind === 'inLibrary' ? (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-accent">
      <Check className="size-3.5" /> In library
    </span>
  ) : (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-sky-400">
      <Clock className="size-3.5" /> Requested
    </span>
  );
}

const TYPE_ICON: Record<RequestType, typeof Disc3> = { album: Disc3, track: Music2, artist: Mic2 };

const fmtDur = (ms?: number | null) => {
  if (!ms) return null;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// ---------- search results ----------

function RequestButton({
  type,
  mbid,
  onError,
  label = 'Request',
}: {
  type: RequestType;
  mbid: string;
  onError: (msg: string) => void;
  label?: string;
}) {
  const create = useCreateRequest();
  return (
    <button
      onClick={() => create.mutate({ type, mbid }, { onError: (e) => onError(e.message) })}
      disabled={create.isPending || create.isSuccess}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-black transition-colors hover:bg-accent-dim disabled:opacity-50"
    >
      {create.isPending ? <Loader2 className="size-3.5 animate-spin" /> : create.isSuccess ? <Check className="size-3.5" /> : null}
      {create.isSuccess ? 'Requested' : label}
    </button>
  );
}

function AlbumResult({ rg, onError }: { rg: MbReleaseGroupResult; onError: (m: string) => void }) {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-panel p-2.5">
      <MbCover src={rg.coverUrl} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{rg.title}</div>
        <div className="truncate text-xs text-zinc-400">
          {rg.artistName}
          {rg.year ? ` · ${rg.year}` : ''}
          {rg.primaryType && rg.primaryType !== 'Album' ? ` · ${rg.primaryType}` : ''}
          {rg.secondaryTypes.length > 0 ? ` · ${rg.secondaryTypes.join(', ')}` : ''}
        </div>
      </div>
      {rg.inLibrary ? <Badge kind="inLibrary" /> : rg.requested ? <Badge kind="requested" /> : <RequestButton type="album" mbid={rg.mbid} onError={onError} />}
    </div>
  );
}

function TrackResult({ rec, onError }: { rec: MbRecordingResult; onError: (m: string) => void }) {
  const dur = fmtDur(rec.durationMs);
  return (
    <div className="flex items-center gap-3 rounded-lg bg-panel p-2.5">
      <MbCover src={rec.coverUrl} className="size-10" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{rec.title}</div>
        <div className="truncate text-xs text-zinc-400">
          {rec.artistName}
          {rec.releaseTitle ? ` · ${rec.releaseTitle}` : ''}
          {dur ? ` · ${dur}` : ''}
        </div>
      </div>
      {rec.inLibrary ? <Badge kind="inLibrary" /> : rec.requested ? <Badge kind="requested" /> : <RequestButton type="track" mbid={rec.mbid} onError={onError} />}
    </div>
  );
}

function ArtistResult({ artist, onError }: { artist: MbArtistResult; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const detail = useMbArtist(open ? artist.mbid : null);
  const missing = detail.data?.releaseGroups.filter((rg) => !rg.inLibrary && !rg.requested).length ?? 0;
  return (
    <div className="rounded-lg bg-panel">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 p-2.5 text-left">
        {open ? <ChevronDown className="size-4 shrink-0 text-zinc-500" /> : <ChevronRight className="size-4 shrink-0 text-zinc-500" />}
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-panel-hover text-zinc-500">
          <Mic2 className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{artist.name}</div>
          <div className="truncate text-xs text-zinc-400">
            {[artist.disambiguation, artist.country, artist.type].filter(Boolean).join(' · ') || 'Artist'}
          </div>
        </div>
        <span className="shrink-0 text-xs text-zinc-500">{open ? 'Hide' : 'Discography'}</span>
      </button>
      {open && (
        <div className="border-t border-zinc-800 p-2.5">
          {detail.isLoading && (
            <div className="flex items-center gap-2 p-2 text-sm text-zinc-400">
              <Loader2 className="size-4 animate-spin" /> Loading discography from MusicBrainz…
            </div>
          )}
          {detail.data && (
            <>
              <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-xs text-zinc-400">
                  {detail.data.releaseGroups.length} studio albums &amp; EPs · {missing} missing
                </span>
                {missing > 0 && (
                  <RequestButton type="artist" mbid={artist.mbid} onError={onError} label={`Request all ${missing}`} />
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                {detail.data.releaseGroups.map((rg) => (
                  <AlbumResult key={rg.mbid} rg={rg} onError={onError} />
                ))}
                {detail.data.releaseGroups.length === 0 && (
                  <p className="p-2 text-sm text-zinc-500">No studio albums or EPs on MusicBrainz.</p>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- request list ----------

function RequestLogs({ id }: { id: string }) {
  const { data, isLoading } = useRequestLogs(id);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [data]);
  return (
    <div
      ref={ref}
      className="mt-2 max-h-48 overflow-y-auto rounded-md bg-surface p-2 font-mono text-[11px] leading-relaxed"
    >
      {isLoading && <div className="text-zinc-500">Loading logs…</div>}
      {data?.length === 0 && <div className="text-zinc-500">No activity yet.</div>}
      {data?.map((l, i) => (
        <div
          key={i}
          className={l.level === 'error' ? 'text-red-400' : l.level === 'warn' ? 'text-amber-400' : 'text-zinc-300'}
        >
          <span className="text-zinc-600">{new Date(l.ts).toLocaleTimeString()}</span> {l.message}
        </div>
      ))}
    </div>
  );
}

function RequestCard({ r, onError }: { r: MusicRequest; onError: (m: string) => void }) {
  const session = useSession((s) => s.session);
  const action = useRequestAction();
  const [showChildren, setShowChildren] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const isAdmin = session?.user.isAdmin ?? false;
  const mine = session?.user.id === r.requestedBy.id;
  const Icon = TYPE_ICON[r.type];

  const title =
    r.type === 'track' ? r.trackTitle : r.type === 'album' ? r.albumTitle : `${r.artistName} — discography`;
  const subtitle =
    r.type === 'artist'
      ? `${r.children?.length ?? 0} albums`
      : `${r.artistName}${r.type === 'track' && r.albumTitle ? ` · ${r.albumTitle}` : ''}${r.year ? ` · ${r.year}` : ''}`;

  const act = (a: 'approve' | 'deny' | 'retry' | 'refetch' | 'delete') =>
    action.mutate({ id: r.id, action: a }, { onError: (e) => onError(e.message) });

  const canRetry = r.status === 'failed' || (r.type === 'artist' && r.children?.some((c) => c.status === 'failed'));
  const canRefetch = r.status === 'available' && r.type !== 'artist' && (isAdmin || mine);
  const canDelete = isAdmin || (mine && ['pending', 'denied', 'failed'].includes(r.status));

  const confirmRefetch = () => {
    const label = r.type === 'album' ? `“${r.albumTitle}”` : `“${r.trackTitle}”`;
    if (window.confirm(`Wrong hit? This will delete ${label} from the library and grab a different source.`)) {
      act('refetch');
    }
  };

  const iconBtn = 'rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-panel-hover hover:text-white disabled:opacity-40';

  return (
    <div className="rounded-lg bg-panel p-3">
      <div className="flex items-center gap-3">
        <MbCover src={r.coverUrl} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Icon className="size-3.5 shrink-0 text-zinc-500" />
            <span className="truncate text-sm font-medium">{title}</span>
          </div>
          <div className="truncate text-xs text-zinc-400">{subtitle}</div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <StatusChip status={r.status} />
            <span>
              by {r.requestedBy.username} · {new Date(r.createdAt).toLocaleDateString()}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isAdmin && r.status === 'pending' && (
            <>
              <button onClick={() => act('approve')} disabled={action.isPending} className={iconBtn} aria-label="Approve" title="Approve">
                <ThumbsUp className="size-4 text-accent" />
              </button>
              <button onClick={() => act('deny')} disabled={action.isPending} className={iconBtn} aria-label="Deny" title="Deny">
                <ThumbsDown className="size-4 text-red-400" />
              </button>
            </>
          )}
          {canRetry && (
            <button onClick={() => act('retry')} disabled={action.isPending} className={iconBtn} aria-label="Retry" title="Retry">
              <RotateCcw className="size-4" />
            </button>
          )}
          {canRefetch && (
            <button
              onClick={confirmRefetch}
              disabled={action.isPending}
              className={iconBtn}
              aria-label="Refetch"
              title="Wrong version? Delete and grab a different source"
            >
              <RefreshCw className="size-4" />
            </button>
          )}
          {isAdmin && !['pending', 'denied'].includes(r.status) && (
            <button
              onClick={() => setShowLogs(!showLogs)}
              className={`${iconBtn} ${showLogs ? 'text-white' : ''}`}
              aria-label="Logs"
              title="Acquisition logs"
            >
              <ScrollText className="size-4" />
            </button>
          )}
          {canDelete && (
            <button onClick={() => act('delete')} disabled={action.isPending} className={iconBtn} aria-label="Delete" title="Delete">
              <Trash2 className="size-4" />
            </button>
          )}
        </div>
      </div>
      {r.status === 'downloading' && typeof r.progress === 'number' && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-panel-hover">
          <div className="h-full bg-accent transition-all" style={{ width: `${Math.min(100, r.progress)}%` }} />
        </div>
      )}
      {r.errorMessage && <p className="mt-2 text-xs text-red-400">{r.errorMessage}</p>}
      {showLogs && <RequestLogs id={r.id} />}
      {r.type === 'artist' && (r.children?.length ?? 0) > 0 && (
        <div className="mt-2 border-t border-zinc-800 pt-2">
          <button onClick={() => setShowChildren(!showChildren)} className="flex items-center gap-1 text-xs text-zinc-400 hover:text-white">
            {showChildren ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            {r.children!.length} albums
          </button>
          {showChildren && (
            <div className="mt-2 flex flex-col gap-1.5">
              {r.children!.map((c) => {
                const childCanRefetch = c.status === 'available' && (isAdmin || mine);
                const refetchChild = () => {
                  if (window.confirm(`Wrong hit? This will delete “${c.albumTitle}” and grab a different source.`)) {
                    action.mutate({ id: c.id, action: 'refetch' }, { onError: (e) => onError(e.message) });
                  }
                };
                return (
                  <div key={c.id} className="flex items-center gap-2 rounded-md bg-surface px-2.5 py-1.5">
                    <span className="min-w-0 flex-1 truncate text-xs">{c.albumTitle}</span>
                    {c.errorMessage && <span className="truncate text-xs text-red-400">{c.errorMessage}</span>}
                    <StatusChip status={c.status} />
                    {childCanRefetch && (
                      <button
                        onClick={refetchChild}
                        disabled={action.isPending}
                        className={iconBtn}
                        aria-label="Refetch"
                        title="Wrong version? Delete and grab a different source"
                      >
                        <RefreshCw className="size-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- admin settings ----------

function AdminSettings({ onError }: { onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const { data } = useAppSettings(open);
  const update = useUpdateSettings();
  const [draft, setDraft] = useState<AppSettings | null>(null);
  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  const inputCls = 'w-24 rounded-md border border-zinc-700 bg-surface px-2 py-1 text-sm outline-none focus:border-accent';

  return (
    <div className="rounded-lg bg-panel">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 p-3 text-left text-sm font-medium">
        <Settings2 className="size-4 text-zinc-400" />
        Admin settings
        {open ? <ChevronDown className="ml-auto size-4 text-zinc-500" /> : <ChevronRight className="ml-auto size-4 text-zinc-500" />}
      </button>
      {open && !draft && <div className="p-3 pt-0 text-sm text-zinc-500">Loading…</div>}
      {open && draft && (
        <div className="flex flex-col gap-3 border-t border-zinc-800 p-3 text-sm">
          <label className="flex items-center justify-between gap-3">
            <span>Auto-approve requests from regular users</span>
            <input
              type="checkbox"
              checked={draft.autoApprove.users}
              onChange={(e) => setDraft({ ...draft, autoApprove: { ...draft.autoApprove, users: e.target.checked } })}
              className="size-4 accent-accent"
            />
          </label>
          <label className="flex items-center justify-between gap-3">
            <span>Auto-approve requests from admins</span>
            <input
              type="checkbox"
              checked={draft.autoApprove.admins}
              onChange={(e) => setDraft({ ...draft, autoApprove: { ...draft.autoApprove, admins: e.target.checked } })}
              className="size-4 accent-accent"
            />
          </label>
          <label className="flex items-center justify-between gap-3">
            <span>
              Requests per user per day <span className="text-zinc-500">(0 = unlimited)</span>
            </span>
            <input
              type="number"
              min={0}
              value={draft.quotaPerUserPerDay}
              onChange={(e) => setDraft({ ...draft, quotaPerUserPerDay: Math.max(0, Number(e.target.value) || 0) })}
              className={inputCls}
            />
          </label>
          <label className="flex items-center justify-between gap-3">
            <span>
              Preferred formats <span className="text-zinc-500">(best first)</span>
            </span>
            <input
              type="text"
              value={draft.quality.preferredFormats.join(', ')}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  quality: {
                    ...draft.quality,
                    preferredFormats: e.target.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
                  },
                })
              }
              className="w-40 rounded-md border border-zinc-700 bg-surface px-2 py-1 text-sm outline-none focus:border-accent"
            />
          </label>
          <label className="flex items-center justify-between gap-3">
            <span>Minimum bitrate (kbps, lossy formats)</span>
            <input
              type="number"
              min={0}
              step={32}
              value={draft.quality.minBitrateKbps}
              onChange={(e) => setDraft({ ...draft, quality: { ...draft.quality, minBitrateKbps: Math.max(0, Number(e.target.value) || 0) } })}
              className={inputCls}
            />
          </label>
          <div className="flex justify-end">
            <button
              onClick={() => update.mutate(draft, { onError: (e) => onError(e.message) })}
              disabled={update.isPending}
              className="rounded-full bg-accent px-4 py-1.5 text-xs font-semibold text-black hover:bg-accent-dim disabled:opacity-50"
            >
              {update.isPending ? 'Saving…' : update.isSuccess ? 'Saved' : 'Save settings'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- page ----------

export function Requests() {
  const session = useSession((s) => s.session);
  const isAdmin = session?.user.isAdmin ?? false;
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'all' | 'mine'>('all');
  const [error, setError] = useState<string | null>(null);
  const search = useMbSearch(query);
  const requests = useRequests(scope);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error]);

  const onError = (msg: string) => setError(msg);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h2 className="text-2xl font-bold">Requests</h2>
        <p className="mt-1 text-sm text-zinc-400">Search MusicBrainz for music that's missing from the library.</p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(input.trim());
        }}
        className="flex gap-2"
      >
        <div className="relative flex-1">
          <SearchIcon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-500" />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Artist, album or track…"
            className="w-full rounded-full border border-zinc-700 bg-panel py-2.5 pr-4 pl-10 text-sm outline-none focus:border-accent"
          />
        </div>
        <button
          type="submit"
          disabled={!input.trim() || search.isFetching}
          className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-black hover:bg-accent-dim disabled:opacity-50"
        >
          {search.isFetching ? <Loader2 className="size-4 animate-spin" /> : 'Search'}
        </button>
      </form>

      {error && (
        <div className="flex items-center justify-between rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss">
            <X className="size-4" />
          </button>
        </div>
      )}

      {query && search.isLoading && <PageSpinner />}
      {search.data && (
        <div className="flex flex-col gap-5">
          {search.data.releaseGroups.length > 0 && (
            <section>
              <h3 className="mb-2 text-lg font-bold">Albums</h3>
              <div className="flex flex-col gap-1.5">
                {search.data.releaseGroups.map((rg) => (
                  <AlbumResult key={rg.mbid} rg={rg} onError={onError} />
                ))}
              </div>
            </section>
          )}
          {search.data.recordings.length > 0 && (
            <section>
              <h3 className="mb-2 text-lg font-bold">Tracks</h3>
              <div className="flex flex-col gap-1.5">
                {search.data.recordings.map((rec) => (
                  <TrackResult key={rec.mbid} rec={rec} onError={onError} />
                ))}
              </div>
            </section>
          )}
          {search.data.artists.length > 0 && (
            <section>
              <h3 className="mb-2 text-lg font-bold">Artists</h3>
              <div className="flex flex-col gap-1.5">
                {search.data.artists.map((a) => (
                  <ArtistResult key={a.mbid} artist={a} onError={onError} />
                ))}
              </div>
            </section>
          )}
          {search.data.artists.length + search.data.releaseGroups.length + search.data.recordings.length === 0 && (
            <p className="text-sm text-zinc-400">MusicBrainz found nothing for “{query}”.</p>
          )}
        </div>
      )}

      {isAdmin && <AdminSettings onError={onError} />}

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-bold">Request queue</h3>
          <div className="flex gap-1 rounded-full bg-panel p-1">
            {(['all', 'mine'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setScope(s)}
                className={`rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors ${
                  scope === s ? 'bg-panel-hover text-white' : 'text-zinc-400 hover:text-white'
                }`}
              >
                {s === 'all' ? 'Everyone' : 'Mine'}
              </button>
            ))}
          </div>
        </div>
        {requests.isLoading && <PageSpinner />}
        {requests.data && requests.data.length === 0 && (
          <p className="text-sm text-zinc-500">No requests yet. Search above to add something.</p>
        )}
        <div className="flex flex-col gap-2">
          {requests.data?.map((r) => (
            <RequestCard key={r.id} r={r} onError={onError} />
          ))}
        </div>
      </section>
    </div>
  );
}
