import { useState } from 'react';
import { Music } from 'lucide-react';
import { jfImageUrl } from '@encore/shared';
import { useSession } from '../state/session';

interface Props {
  itemId?: string | null;
  tag?: string | null;
  alt?: string;
  size?: number;
  className?: string;
  rounded?: string;
}

export function Cover({ itemId, tag, alt = '', size = 300, className = '', rounded = 'rounded-md' }: Props) {
  const session = useSession((s) => s.session);
  const [failed, setFailed] = useState(false);
  const src = session && itemId && tag && !failed ? jfImageUrl(session.jellyfin, itemId, { tag, size }) : null;
  if (!src) {
    return (
      <div className={`flex items-center justify-center bg-panel-hover text-zinc-600 ${rounded} ${className}`}>
        <Music className="size-1/3" />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className={`object-cover ${rounded} ${className}`}
    />
  );
}
