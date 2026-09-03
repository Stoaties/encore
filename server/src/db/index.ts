import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from './schema.js';

export type Db = ReturnType<typeof createDb>['db'];

export function createDb(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export async function runMigrations(db: Db, migrationsFolder: string) {
  await migrate(db, { migrationsFolder });
}

export { schema };
