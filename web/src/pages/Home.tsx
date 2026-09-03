import { useHome } from '../api/queries';
import { AlbumCard, CardGrid } from '../components/Cards';

export function Home() {
  const { data, isLoading, error } = useHome();
  if (isLoading) return <PageSpinner />;
  if (error || !data) return <p className="text-zinc-400">Could not load the library.</p>;
  return (
    <div className="flex flex-col gap-8">
      <section>
        <h2 className="mb-3 text-xl font-bold">Recently added</h2>
        <CardGrid>
          {data.recentlyAdded.map((a) => (
            <AlbumCard key={a.id} album={a} />
          ))}
        </CardGrid>
      </section>
      <section>
        <h2 className="mb-3 text-xl font-bold">Surprise me</h2>
        <CardGrid>
          {data.random.map((a) => (
            <AlbumCard key={a.id} album={a} />
          ))}
        </CardGrid>
      </section>
    </div>
  );
}

export function PageSpinner() {
  return (
    <div className="flex h-40 items-center justify-center">
      <div className="size-6 animate-spin rounded-full border-2 border-zinc-600 border-t-accent" />
    </div>
  );
}
