import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { SessionInfo } from '@encore/shared';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';
import type { Config } from '../config.js';

export type UserRow = typeof schema.users.$inferSelect;

export function deviceIdFor(username: string): string {
  return 'encore-' + createHash('sha256').update(username.toLowerCase()).digest('hex').slice(0, 12);
}

export async function getUserRow(db: Db, appUserId: string): Promise<UserRow | undefined> {
  return db.query.users.findFirst({ where: eq(schema.users.id, appUserId) });
}

export class NoJellyfinSessionError extends Error {
  constructor() {
    super('No valid Jellyfin session for user — please log in again');
    this.name = 'NoJellyfinSessionError';
  }
}

/** Jellyfin auth context for making calls on behalf of a user. */
export async function jfContext(db: Db, appUserId: string): Promise<{ token: string; jfUserId: string; user: UserRow }> {
  const user = await getUserRow(db, appUserId);
  if (!user?.jellyfinToken) throw new NoJellyfinSessionError();
  return { token: user.jellyfinToken, jfUserId: user.jellyfinUserId, user };
}

export function buildSessionInfo(config: Config, appToken: string, user: UserRow): SessionInfo {
  return {
    token: appToken,
    user: { id: user.id, username: user.username, isAdmin: user.isAdmin },
    jellyfin: {
      baseUrl: config.jellyfinPublicUrl,
      token: user.jellyfinToken ?? '',
      userId: user.jellyfinUserId,
      deviceId: deviceIdFor(user.username),
    },
  };
}
