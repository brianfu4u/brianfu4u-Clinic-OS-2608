import type { DatabasePool, TenantQueryClient } from "./database-contracts.ts";

export async function withTenantTransaction<T>(
  pool: DatabasePool,
  clinicId: string,
  operation: (client: TenantQueryClient) => Promise<T>,
): Promise<T> {
  if (typeof clinicId !== "string" || clinicId.trim() === "") {
    throw new Error("CLINIC_ID_REQUIRED");
  }

  const connection = await pool.connect();
  let began = false;
  let active = false;
  try {
    await connection.query("BEGIN");
    began = true;
    await connection.query("SELECT set_config('app.clinic_id', $1, true)", [clinicId]);
    active = true;
    const client: TenantQueryClient = {
      query: async (text, values) => {
        if (!active) throw new Error("TENANT_TRANSACTION_CLOSED");
        return connection.query(text, values);
      },
    };
    let result: T;
    try {
      result = await operation(client);
    } finally {
      active = false;
    }
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    active = false;
    if (began) await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}
