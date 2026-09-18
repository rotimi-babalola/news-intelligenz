import { adminServer } from "./admin.js";
import { database, migrate } from "./db.js";

const pool = database();
try {
  await migrate(pool);
  const server = adminServer(pool);
  server.listen(Number(process.env.PORT ?? 3000), "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address !== "string")
      console.log(`Local inspection: http://127.0.0.1:${address.port}`);
  });
  server.on("error", async (error) => {
    console.error(error.message);
    await pool.end();
    process.exitCode = 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () =>
      server.close(() => {
        void pool.end();
      }),
    );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Server startup failed",
  );
  await pool.end();
  process.exitCode = 1;
}
