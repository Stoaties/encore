import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { AppSettings } from '@encore/shared';
import type { Db } from '../db/index.js';
import { schema } from '../db/index.js';

export const DEFAULT_SETTINGS: AppSettings = {
  autoApprove: { admins: true, users: false },
  quotaPerUserPerDay: 0,
  quality: { preferredFormats: ['flac', 'mp3'], minBitrateKbps: 192 },
  shuffle: { favoriteBoost: 2, skipPenalty: 3, recencyHours: 48, recencyPenalty: 2, playCountWeight: 0.5 },
  acquisition: { maxConcurrentDownloads: 2, searchTimeoutSec: 45, stallTimeoutMin: 5, maxRetriesPerRequest: 3 },
};

export const SettingsPatch = z.object({
  autoApprove: z.object({ admins: z.boolean(), users: z.boolean() }).partial().optional(),
  quotaPerUserPerDay: z.number().int().min(0).optional(),
  quality: z
    .object({ preferredFormats: z.array(z.string().min(1)).min(1), minBitrateKbps: z.number().int().min(0) })
    .partial()
    .optional(),
  shuffle: z
    .object({
      favoriteBoost: z.number().min(0),
      skipPenalty: z.number().min(0),
      recencyHours: z.number().min(0),
      recencyPenalty: z.number().min(0),
      playCountWeight: z.number().min(0),
    })
    .partial()
    .optional(),
  acquisition: z
    .object({
      maxConcurrentDownloads: z.number().int().min(1).max(10),
      searchTimeoutSec: z.number().int().min(5),
      stallTimeoutMin: z.number().int().min(1),
      maxRetriesPerRequest: z.number().int().min(0).max(10),
    })
    .partial()
    .optional(),
});
export type SettingsPatchInput = z.infer<typeof SettingsPatch>;

const KEY = 'app';

function merge(base: AppSettings, patch: SettingsPatchInput): AppSettings {
  return {
    autoApprove: { ...base.autoApprove, ...patch.autoApprove },
    quotaPerUserPerDay: patch.quotaPerUserPerDay ?? base.quotaPerUserPerDay,
    quality: { ...base.quality, ...patch.quality },
    shuffle: { ...base.shuffle, ...patch.shuffle },
    acquisition: { ...base.acquisition, ...patch.acquisition },
  };
}

export async function getSettings(db: Db): Promise<AppSettings> {
  const row = await db.query.settings.findFirst({ where: eq(schema.settings.key, KEY) });
  if (!row) return DEFAULT_SETTINGS;
  return merge(DEFAULT_SETTINGS, SettingsPatch.parse(row.value));
}

export async function updateSettings(db: Db, patch: SettingsPatchInput): Promise<AppSettings> {
  const next = merge(await getSettings(db), SettingsPatch.parse(patch));
  await db
    .insert(schema.settings)
    .values({ key: KEY, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: next, updatedAt: new Date() } });
  return next;
}
