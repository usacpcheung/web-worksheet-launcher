import { Pool } from 'pg';

export function createPool(config) {
  return new Pool({
    connectionString: config.databaseUrl,
  });
}
