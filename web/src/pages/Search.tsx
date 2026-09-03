import { useState } from 'react';
import { Search as SearchIcon } from 'lucide-react';
import { useLibrarySearch } from '../api/queries';
import { AlbumCard, ArtistCard, CardGrid } from '../components/Cards';
import { TrackList } from '../components/TrackList';
import { useDebounced } from '../lib/useDebounced';

export function Search() {
  const [q, setQ] = useState('');
  const debounced = useDebounced(q, 300);
  const { data, isFetching } = useLibrarySearch(debounced);

  return (
    <div className="flex flex-col gap-6">
      <div className="relative">
        <SearchIcon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-500" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search your library…"
          autoFocus
          className="w-full rounded-full border border-zinc-700 bg-panel py-2.5 pr-4 pl-10 text-sm outline-none focus:border-accent"
        />
      </div>
      {data && (
        <>
          {data.tracks.length > 0 && (
            <section>
              <h3 className="mb-2 text-lg font-bold">Tracks</h3>
              <TrackList tracks={data.tracks} />
            </section>
          )}
          {data.albums.length > 0 && (
            <section>
              <h3 className="mb-2 text-lg font-bold">Albums</h3>
              <CardGrid>
                {data.albums.map((a) => (
                  <AlbumCard key={a.id} album={a} />
                ))}
              </CardGrid>
            </section>
          )}
          {data.artists.length > 0 && (
            <section>
              <h3 className="mb-2 text-lg font-bold">Artists</h3>
              <CardGrid>
                {data.artists.map((a) => (
                  <ArtistCard key={a.id} artist={a} />
                ))}
              </CardGrid>
            </section>
          )}
          {!isFetching && data.tracks.length + data.albums.length + data.artists.length === 0 && (
            <p className="text-sm text-zinc-400">
              Nothing in your library matches “{debounced}”. Try the Requests tab to add it.
            </p>
          )}
        </>
      )}
    </div>
  );
}
