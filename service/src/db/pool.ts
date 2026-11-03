import pg from "pg";

// DATE (oid 1082) comes back as the plain "YYYY-MM-DD" string instead of a local-time Date.
pg.types.setTypeParser(1082, (value: string) => value);
// NUMERIC (oid 1700) is at most 10,2 here, which a JS number represents exactly enough.
pg.types.setTypeParser(1700, (value: string) => Number(value));

export type Pool = pg.Pool;
export type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

export function createPool(databaseUrl: string): Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}
