import { useEffect, useRef, useState } from 'react';
import { Check, Heart, ListPlus, Plus } from 'lucide-react';
import { useAddToPlaylist, useCreatePlaylist, useFavoriteIds, usePlaylists, useToggleFavorite } from '../api/queries';

export function HeartButton({ itemId, className = '' }: { itemId: string; className?: string }) {
  const favorites = useFavoriteIds();
  const toggle = useToggleFavorite();
  const isFav = favorites.has(itemId);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        toggle.mutate({ itemId, favorite: !isFav });
      }}
      className={`rounded p-1.5 ${isFav ? 'text-accent' : 'text-zinc-500 hover:text-white'} ${className}`}
      aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'}
      aria-pressed={isFav}
    >
      <Heart className={`size-4 ${isFav ? 'fill-current' : ''}`} />
    </button>
  );
}

export function AddToPlaylistButton({ itemIds, className = '' }: { itemIds: string[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [addedTo, setAddedTo] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const { data: playlists } = usePlaylists();
  const add = useAddToPlaylist();
  const create = useCreatePlaylist();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const pick = (playlistId: string) => {
    add.mutate({ playlistId, itemIds }, { onSuccess: () => setAddedTo(playlistId) });
    setTimeout(() => {
      setOpen(false);
      setAddedTo(null);
    }, 600);
  };

  return (
    // visible! beats a hover-only reveal from the parent — the open dropdown must
    // not vanish (and its input must stay focusable) when the pointer leaves the row
    <div ref={ref} className={`relative ${open ? 'visible!' : ''} ${className}`} onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => {
          setOpen(!open);
          setCreating(false);
        }}
        className={`rounded p-1.5 ${open ? 'text-white' : 'text-zinc-500 hover:text-white'}`}
        aria-label="Add to playlist"
      >
        <ListPlus className="size-4" />
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-lg border border-zinc-700 bg-panel shadow-xl">
          <div className="border-b border-zinc-800 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
            Add to playlist
          </div>
          <div className="max-h-52 overflow-y-auto py-1">
            {creating ? (
              <form
                className="flex gap-1 px-2 py-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!name.trim()) return;
                  create.mutate(
                    { name: name.trim(), itemIds },
                    {
                      onSuccess: () => {
                        setName('');
                        setOpen(false);
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
                  className="w-full rounded border border-zinc-700 bg-black/30 px-2 py-1 text-sm outline-none focus:border-accent"
                  aria-label="New playlist name"
                />
                <button type="submit" className="rounded bg-accent px-2 text-xs font-semibold text-black">
                  Add
                </button>
              </form>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-300 hover:bg-panel-hover"
              >
                <Plus className="size-4" /> New playlist…
              </button>
            )}
            {(playlists ?? []).map((p) => (
              <button
                key={p.id}
                onClick={() => pick(p.id)}
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm text-zinc-300 hover:bg-panel-hover"
              >
                <span className="truncate">{p.name}</span>
                {addedTo === p.id && <Check className="size-4 shrink-0 text-accent" />}
              </button>
            ))}
            {playlists && !playlists.length && !creating && (
              <div className="px-3 py-1.5 text-xs text-zinc-500">No playlists yet</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
