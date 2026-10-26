ALTER TABLE "dip_embeddings" ADD COLUMN "query_instruction" TEXT NOT NULL
    DEFAULT 'Given a German or English query, retrieve relevant German parliamentary proceedings and steps';
