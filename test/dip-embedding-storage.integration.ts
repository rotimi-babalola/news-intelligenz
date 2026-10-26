import assert from "node:assert/strict";
import { test } from "node:test";
import { QUERY_INSTRUCTION } from "../src/dip/embedding.js";
import { isolatedDatabase } from "./dip-test-db.js";

test("DIP embeddings retain versions and reject duplicate model records", async () => {
  const prisma = await isolatedDatabase();
  try {
    const schema = new URL(process.env.DATABASE_URL!).searchParams.get(
      "schema",
    )!;
    const table = `"${schema}"."dip_embeddings"`;
    const insert = (version: number) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO ${table} (id, source_entity, source_api_id, source_version_no, model, document_instruction, embedding)
         VALUES (gen_random_uuid(), 'vorgang', '123', $1, 'qwen3-embedding:0.6b', '', array_fill(0.1::real, ARRAY[1024])::public.vector)`,
        version,
      );

    await insert(1);
    await insert(2);
    await assert.rejects(insert(2));
    await assert.rejects(
      prisma.$executeRawUnsafe(
        `INSERT INTO ${table} (id, source_entity, source_api_id, source_version_no, model, document_instruction, embedding)
         VALUES (gen_random_uuid(), 'vorgang', '124', 1, 'qwen3-embedding:0.6b', '', '[0.1,0.2,0.3]'::public.vector)`,
      ),
    );
    const rows = await prisma.$queryRawUnsafe<
      { source_version_no: number; dimensions: number }[]
    >(
      `SELECT source_version_no, vector_dims(embedding) AS dimensions FROM ${table} ORDER BY source_version_no`,
    );
    assert.deepEqual(rows, [
      { source_version_no: 1, dimensions: 1024 },
      { source_version_no: 2, dimensions: 1024 },
    ]);
    const queryInstructions = await prisma.$queryRawUnsafe<
      { query_instruction: string }[]
    >(`SELECT query_instruction FROM ${table} ORDER BY source_version_no`);
    assert.deepEqual(
      queryInstructions.map((row) => row.query_instruction),
      [QUERY_INSTRUCTION, QUERY_INSTRUCTION],
    );
  } finally {
    await prisma.$disconnect();
  }
});
