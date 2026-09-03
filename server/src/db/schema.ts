import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  timestamp,
  jsonb,
  integer,
  real,
  bigserial,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const requestTypeEnum = pgEnum('request_type', ['track', 'album', 'artist']);
export const requestStatusEnum = pgEnum('request_status', [
  'pending',
  'approved',
  'denied',
  'searching',
  'downloading',
  'processing',
  'available',
  'failed',
]);
export const jobStatusEnum = pgEnum('job_status', ['pending', 'running', 'completed', 'failed', 'cancelled']);
export const playEventEnum = pgEnum('play_event', ['play', 'complete', 'skip']);
export const importSourceEnum = pgEnum('import_source', ['spotify', 'youtube']);
export const importStatusEnum = pgEnum('import_status', ['resolving', 'review', 'requesting', 'done', 'failed']);
export const matchStatusEnum = pgEnum('match_status', ['auto', 'needs_review', 'confirmed', 'rejected', 'unmatched']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  jellyfinUserId: text('jellyfin_user_id').notNull().unique(),
  username: text('username').notNull(),
  isAdmin: boolean('is_admin').notNull().default(false),
  jellyfinToken: text('jellyfin_token'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
});

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const mbCache = pgTable('mb_cache', {
  key: text('key').primaryKey(),
  payload: jsonb('payload').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
});

export const requests = pgTable(
  'requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: requestTypeEnum('type').notNull(),
    status: requestStatusEnum('status').notNull().default('pending'),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    parentId: uuid('parent_id'),
    mbArtistId: text('mb_artist_id'),
    artistName: text('artist_name').notNull(),
    mbReleaseGroupId: text('mb_release_group_id'),
    albumTitle: text('album_title'),
    mbRecordingId: text('mb_recording_id'),
    trackTitle: text('track_title'),
    meta: jsonb('meta').notNull().default({}),
    errorMessage: text('error_message'),
    progress: real('progress'),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    availableAt: timestamp('available_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('requests_status_idx').on(t.status),
    index('requests_requested_by_idx').on(t.requestedBy),
    index('requests_parent_idx').on(t.parentId),
    index('requests_rg_idx').on(t.mbReleaseGroupId),
    index('requests_rec_idx').on(t.mbRecordingId),
  ],
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull().default({}),
    status: jobStatusEnum('status').notNull().default('pending'),
    priority: integer('priority').notNull().default(0),
    runAt: timestamp('run_at', { withTimezone: true }).notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    lastError: text('last_error'),
    requestId: uuid('request_id').references(() => requests.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('jobs_poll_idx').on(t.status, t.runAt, t.priority), index('jobs_request_idx').on(t.requestId)],
);

export const jobLogs = pgTable(
  'job_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    level: text('level').notNull().default('info'),
    message: text('message').notNull(),
  },
  (t) => [index('job_logs_job_idx').on(t.jobId, t.id)],
);

export const trackPlays = pgTable(
  'track_plays',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    itemId: text('item_id').notNull(),
    event: playEventEnum('event').notNull(),
    positionSec: real('position_sec'),
    durationSec: real('duration_sec'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('track_plays_user_item_idx').on(t.userId, t.itemId), index('track_plays_at_idx').on(t.at)],
);

export const importBatches = pgTable('import_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  source: importSourceEnum('source').notNull(),
  url: text('url').notNull(),
  title: text('title'),
  status: importStatusEnum('status').notNull().default('resolving'),
  error: text('error'),
  coverUrl: text('cover_url'),
  jellyfinPlaylistId: text('jellyfin_playlist_id'),
  truncated: boolean('truncated').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const playlistShares = pgTable(
  'playlist_shares',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Jellyfin playlist id (string, not FK — playlists live in Jellyfin, not our DB)
    playlistId: text('playlist_id').notNull(),
    token: text('token').notNull().unique(),
    // owner (Encore user); when the owner is deleted the share goes with them
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // one active share per (owner, playlist) — creating another rotates the token instead
    uniqueIndex('playlist_shares_owner_playlist_idx').on(t.ownerId, t.playlistId),
    index('playlist_shares_token_idx').on(t.token),
  ],
);

export const importItems = pgTable(
  'import_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => importBatches.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    sourceTitle: text('source_title').notNull(),
    sourceArtist: text('source_artist'),
    sourceAlbum: text('source_album'),
    durationMs: integer('duration_ms'),
    matchMbRecordingId: text('match_mb_recording_id'),
    matchTitle: text('match_title'),
    matchArtist: text('match_artist'),
    matchMbReleaseGroupId: text('match_mb_release_group_id'),
    matchAlbum: text('match_album'),
    matchScore: real('match_score'),
    matchStatus: matchStatusEnum('match_status').notNull().default('unmatched'),
    inLibrary: boolean('in_library').notNull().default(false),
    requestId: uuid('request_id').references(() => requests.id, { onDelete: 'set null' }),
  },
  (t) => [uniqueIndex('import_items_batch_pos_idx').on(t.batchId, t.position)],
);
