import { Pool } from "pg";
import type {
  DatabaseConnection,
  DatabasePool,
  DatabaseQueryResult,
} from "./database-contracts.ts";

export type NodePgPoolConfig =
  | string
  | { connectionString: string }
  | {
      host: string;
      database: string;
      user: string;
      port?: number;
      password?: string;
      ssl?: unknown;
    };

export class NodePgPool implements DatabasePool {
  readonly #pool: Pool;

  constructor(config: NodePgPoolConfig) {
    assertExplicitConfig(config);
    this.#pool = new Pool(typeof config === "string" ? { connectionString: config } : config);
  }

  async connect(): Promise<DatabaseConnection> {
    const client = await this.#pool.connect();
    return {
      query: async <Row extends Record<string, unknown>>(
        text: string,
        values?: readonly unknown[],
      ): Promise<DatabaseQueryResult<Row>> => {
        const result = await client.query(text, values as unknown[] | undefined);
        return { rows: result.rows as Row[] };
      },
      release: () => client.release(),
    };
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

export function createNodePgPool(config: NodePgPoolConfig): NodePgPool {
  return new NodePgPool(config);
}

function assertExplicitConfig(config: NodePgPoolConfig): void {
  if (typeof config === "string") {
    if (config.trim() === "") throw new Error("DATABASE_CONFIG_REQUIRED");
    return;
  }
  if (!config || typeof config !== "object") throw new Error("DATABASE_CONFIG_REQUIRED");
  if ("connectionString" in config) {
    if (typeof config.connectionString !== "string" || config.connectionString.trim() === "") {
      throw new Error("DATABASE_CONFIG_REQUIRED");
    }
    return;
  }
  if (![config.host, config.database, config.user].every(
    (value) => typeof value === "string" && value.trim() !== "",
  )) {
    throw new Error("DATABASE_CONFIG_REQUIRED");
  }
}
