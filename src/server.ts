import { adminServer } from "./admin.js";
import { database } from "./db.js";

const prisma = database();
try {
  const server = adminServer(prisma);
  server.listen(Number(process.env.PORT ?? 3000), "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address !== "string")
      console.log(`Local inspection: http://127.0.0.1:${address.port}`);
  });
  server.on("error", async (error) => {
    console.error(error.message);
    await prisma.$disconnect();
    process.exitCode = 1;
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () =>
      server.close(() => {
        void prisma.$disconnect();
      }),
    );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Server startup failed",
  );
  await prisma.$disconnect();
  process.exitCode = 1;
}
