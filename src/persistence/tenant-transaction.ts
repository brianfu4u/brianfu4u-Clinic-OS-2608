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
  try {
    await connection.query("BEGIN");
    began = true;
    await connection.query("SELECT set_config('app.clinic_id', $1, true)", [clinicId]);
    const client: TenantQueryClient = {
      query: (text, values) => connection.query(text, values),
    };
    const result = await operation(client);
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    if (began) await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}
