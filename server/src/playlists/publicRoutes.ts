// Public (unauthenticated) endpoints backing share links. A share token in the
// URL is the only credential — Encore proxies both the playlist metadata AND
// the audio bytes using its server-side Jellyfin API key so the anonymous
// listener never sees any real Jellyfin credentials.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { SharedPlaylistView, SharedTrack } from '@encore/shared';
import type { AppDeps } from '../app.js';
import { schema } from '../db/index.js';
import { toTrackSummary, ITEM_FIELDS } from '../jellyfin/mappers.js';
import { JellyfinError } from '../jellyfin/client.js';

async function resolveShare(deps: AppDeps, token: string) {
  return deps.db.query.playlistShares.findFirst({
    where: eq(schema.playlistShares.token, token),
  });
}

/** Forward Range/If-Range headers so the browser can seek; pipe the upstream body. */
async function proxyJellyfin(
  deps: AppDeps,
  req: FastifyRequest,
  reply: FastifyReply,
  path: string,
  query: Record<string, string | number | undefined> = {},
) {
  const apiKey = deps.config.jellyfinApiKey;
  if (!apiKey) return reply.code(500).send({ error: 'Server missing Jellyfin API key for anonymous sharing' });
  const search = new URLSearchParams({ api_key: apiKey });
  for (const [k, v] of Object.entries(query)) if (v !== undefined) search.set(k, String(v));
  const upstream = `${deps.config.jellyfinUrl}${path}?${search}`;
  const headers: Record<string, string> = {};
  const range = req.headers.range;
  if (typeof range === 'string') headers.Range = range;
  const res = await fetch(upstream, { headers });
  reply.code(res.status);
  // pass content-type/length/range headers straight through so the browser
  // treats this exactly like a native Jellyfin stream
  for (const h of ['content-type', 'content-length', 'accept-ranges', 'content-range', 'last-modified', 'etag']) {
    const v = res.headers.get(h);
    if (v) reply.header(h, v);
  }
  if (!res.body) return reply.send(null);
  return reply.send(res.body);
}

export function publicPlaylistRoutes(deps: AppDeps) {
  const { jellyfin } = deps;
  return async (app: FastifyInstance) => {
    // deliberately NO auth hook — this is the public share surface

    app.get('/:token', async (req, reply) => {
      const { token } = z.object({ token: z.string().min(8) }).parse(req.params);
      const share = await resolveShare(deps, token);
      // reply.code(...); throw new Error(...) gets rewritten to 500 by the
      // default error handler — use reply.send() so the status sticks
      if (!share) return reply.code(404).send({ error: 'Share link not found or revoked' });
      if (!deps.config.jellyfinApiKey)
        return reply.code(500).send({ error: 'Server missing Jellyfin API key for anonymous sharing' });
      // fetch with the admin API key — the owner's session token might be
      // stale, and sharing shouldn't depend on the owner staying logged in
      const [playlist, itemsRes] = await Promise.all([
        jellyfin.getItem(deps.config.jellyfinApiKey, share.playlistId).catch((err: unknown) => {
          if (err instanceof JellyfinError && err.status === 404) return null;
          throw err;
        }),
        jellyfin
          .playlistItems(deps.config.jellyfinApiKey, share.playlistId, '', { Fields: ITEM_FIELDS })
          .catch((err: unknown) => {
            if (err instanceof JellyfinError && err.status === 404) return null;
            throw err;
          }),
      ]);
      if (!playlist || !itemsRes) return reply.code(404).send({ error: 'The shared playlist has been deleted' });
      const owner = await deps.db.query.users.findFirst({
        where: eq(schema.users.id, share.ownerId),
        columns: { username: true },
      });
      const proto = ([] as string[]).concat(req.headers['x-forwarded-proto'] ?? 'https')[0] ?? 'https';
      const origin = req.headers.host ? `${proto}://${req.headers.host}` : '';
      const publicImage = (itemId: string | null | undefined) =>
        itemId ? `${origin}/api/public/playlists/${token}/image/${itemId}` : null;
      const tracks: SharedTrack[] = itemsRes.Items.map((raw) => {
        const t = toTrackSummary(raw);
        return {
          id: t.id,
          name: t.name,
          artists: t.artists,
          album: t.album ?? null,
          durationSec: t.durationSec,
          audioUrl: `${origin}/api/public/playlists/${token}/audio/${t.id}`,
          imageUrl: publicImage(t.imageItemId),
        };
      });
      const view: SharedPlaylistView = {
        id: playlist.Id,
        name: playlist.Name,
        ownerName: owner?.username ?? 'Someone',
        tracks,
        imageUrl: publicImage(playlist.Id),
      };
      return reply.send(view);
    });

    app.get('/:token/audio/:itemId', async (req, reply) => {
      const { token, itemId } = z.object({ token: z.string().min(8), itemId: z.string() }).parse(req.params);
      const share = await resolveShare(deps, token);
      if (!share) return reply.code(404).send({ error: 'Share not found' });
      // membership check — a valid token can only stream tracks that belong to ITS playlist
      const items = await jellyfin
        .playlistItems(deps.config.jellyfinApiKey!, share.playlistId, '', { Fields: 'Id' })
        .catch(() => null);
      if (!items || !items.Items.some((i) => i.Id === itemId)) {
        return reply.code(403).send({ error: 'Track is not part of this shared playlist' });
      }
      // universal audio picks a codec the browser can play; direct-stream flac
      // when possible so we're not paying transcoding CPU on the k8s pod
      return proxyJellyfin(deps, req, reply, `/Audio/${itemId}/universal`, {
        userId: '',
        deviceId: `encore-share-${token.slice(0, 8)}`,
        maxStreamingBitrate: 320000,
        container: 'opus,mp3,aac,m4a,flac,webma,webm,wav',
        audioCodec: 'aac',
        transcodingContainer: 'ts',
        transcodingProtocol: 'hls',
      });
    });

    app.get('/:token/image/:itemId', async (req, reply) => {
      const { token, itemId } = z.object({ token: z.string().min(8), itemId: z.string() }).parse(req.params);
      const share = await resolveShare(deps, token);
      if (!share) return reply.code(404).send({ error: 'Share not found' });
      // no track-membership check for images — album art tends to be reused
      // across items and 404-ing on obscure paths would break the UI
      return proxyJellyfin(deps, req, reply, `/Items/${itemId}/Images/Primary`, { fillHeight: 400, fillWidth: 400 });
    });
  };
}
