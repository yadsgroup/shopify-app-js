import pg from 'pg';
import {Session} from '@shopify/shopify-api';
import {SessionStorage} from '@shopify/shopify-app-session-storage';

export interface PostgreSQLSessionStorageOptions {
  sessionTableName: string;
  port: number;
}
const defaultPostgreSQLSessionStorageOptions: PostgreSQLSessionStorageOptions =
  {
    sessionTableName: 'shopify_sessions',
    port: 3211,
  };

export class PostgreSQLSessionStorage implements SessionStorage {
  static withCredentials(
    host: string,
    dbName: string,
    username: string,
    password: string,
    opts: Partial<PostgreSQLSessionStorageOptions>,
  ) {
    return new PostgreSQLSessionStorage(
      new URL(
        `postgres://${encodeURIComponent(username)}:${encodeURIComponent(
          password,
        )}@${host}/${encodeURIComponent(dbName)}`,
      ),
      opts,
    );
  }

  public readonly ready: Promise<void>;
  private options: PostgreSQLSessionStorageOptions;
  private client: pg.Client;

  constructor(
    private dbUrl: URL,
    opts: Partial<PostgreSQLSessionStorageOptions> = {},
  ) {
    if (typeof this.dbUrl === 'string') {
      this.dbUrl = new URL(this.dbUrl);
    }
    this.options = {...defaultPostgreSQLSessionStorageOptions, ...opts};
    this.ready = this.init();
  }

  public async storeSession(session: Session): Promise<boolean> {
    await this.ready;

    // Note milliseconds to seconds conversion for `expires` property
    const entries = session
      .toPropertyArray()
      .map(([key, value]) =>
        key === 'expires'
          ? [key, Math.floor((value as number) / 1000)]
          : [key, value],
      );
    const query = `
      INSERT INTO ${this.options.sessionTableName}
      (${entries.map(([key]) => key).join(', ')})
      VALUES (${entries.map((_, i) => `$${i + 1}`).join(', ')})
      ON CONFLICT (id) DO UPDATE SET ${entries
        .map(([key]) => `${key} = Excluded.${key}`)
        .join(', ')};
    `;
    await this.query(
      query,
      entries.map(([_key, value]) => value),
    );
    return true;
  }

  public async loadSession(id: string): Promise<Session | undefined> {
    await this.ready;
    const query = `
      SELECT * FROM ${this.options.sessionTableName}
      WHERE id = $1;
    `;
    const rows = await this.query(query, [id]);
    if (!Array.isArray(rows) || rows?.length !== 1) return undefined;
    const rawResult = rows[0] as any;
    return this.databaseRowToSession(rawResult);
  }

  public async deleteSession(id: string): Promise<boolean> {
    await this.ready;
    const query = `
      DELETE FROM ${this.options.sessionTableName}
      WHERE id = $1;
    `;
    await this.query(query, [id]);
    return true;
  }

  public async deleteSessions(ids: string[]): Promise<boolean> {
    await this.ready;
    const query = `
      DELETE FROM ${this.options.sessionTableName}
      WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(', ')});
    `;
    await this.query(query, ids);
    return true;
  }

  public async findSessionsByShop(shop: string): Promise<Session[]> {
    await this.ready;

    const query = `
      SELECT * FROM ${this.options.sessionTableName}
      WHERE shop = $1;
    `;
    const rows = await this.query(query, [shop]);
    if (!Array.isArray(rows) || rows?.length === 0) return [];

    const results: Session[] = rows.map((row: any) => {
      return this.databaseRowToSession(row);
    });
    return results;
  }

  public disconnect(): Promise<void> {
    return this.client.end();
  }

  private async init() {
    this.client = new pg.Client({connectionString: this.dbUrl.toString()});
    await this.connectClient();
    await this.createTable();
  }

  private async connectClient(): Promise<void> {
    await this.client.connect();
  }

  private async hasSessionTable(): Promise<boolean> {
    const query = `
      SELECT tablename FROM pg_catalog.pg_tables WHERE tablename = $1 AND schemaname = $2
    `;

    // Allow multiple apps to be on the same host with separate DB and querying the right
    // DB for the session table exisitence
    const rows = await this.query(query, [
      this.options.sessionTableName,
      this.client.database,
    ]);
    return Array.isArray(rows) && rows.length === 1;
  }

  private async createTable() {
    const hasSessionTable = await this.hasSessionTable();
    if (!hasSessionTable) {
      const query = `
        CREATE TABLE IF NOT EXISTS ${this.options.sessionTableName} (
          id varchar(255) NOT NULL PRIMARY KEY,
          shop varchar(255) NOT NULL,
          state varchar(255) NOT NULL,
          isOnline boolean NOT NULL,
          scope varchar(255),
          expires integer,
          onlineAccessInfo varchar(255),
          accessToken varchar(255)
        )
      `;
      await this.query(query);
    }
  }

  private async query(sql: string, params: any[] = []): Promise<any> {
    const result = await this.client.query(sql, params);
    return result.rows;
  }

  private databaseRowToSession(row: any): Session {
    // convert seconds to milliseconds prior to creating Session object
    if (row.expires) row.expires *= 1000;
    return Session.fromPropertyArray(Object.entries(row));
  }
}
