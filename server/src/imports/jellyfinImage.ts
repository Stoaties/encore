import { JellyfinError } from '../jellyfin/client.js';

/**
 * Uploads the given remote image as a Jellyfin item's primary image.
 * Jellyfin's `POST /Items/:id/Images/:type` accepts base64-encoded bytes in
 * the body with a Content-Type header matching the image MIME. We do NOT use
 * `/RemoteImages/Download` because that only accepts URLs from configured
 * metadata providers (Cover Art Archive, TVDB…), and Spotify's `i.scdn.co`
 * isn't on that list.
 */
export async function uploadJellyfinPrimaryImage(
  jellyfinUrl: string,
  token: string,
  itemId: string,
  imageUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const imgRes = await fetchImpl(imageUrl);
  if (!imgRes.ok) throw new Error(`Cover fetch failed (${imgRes.status})`);
  const mime = imgRes.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg';
  const bytes = new Uint8Array(await imgRes.arrayBuffer());
  if (!bytes.byteLength) throw new Error('Cover fetch returned empty body');
  // btoa on binary via Buffer (Node) → base64 string
  const b64 = Buffer.from(bytes).toString('base64');

  const url = `${jellyfinUrl.replace(/\/+$/, '')}/Items/${itemId}/Images/Primary`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `MediaBrowser Client="Encore", Device="Encore Server", DeviceId="encore-server", Version="0.4.0", Token="${token}"`,
      'Content-Type': mime,
    },
    body: b64,
  });
  if (!res.ok) {
    throw new JellyfinError(res.status, (await res.text().catch(() => '')) || res.statusText);
  }
}
