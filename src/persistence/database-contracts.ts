export interface DatabaseQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[];
}

export interface TenantQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<DatabaseQueryResult<Row>>;
}

export interface DatabaseConnection extends TenantQueryClient {
  release(): void;
}

export interface DatabasePool {
  connect(): Promise<DatabaseConnection>;
}
