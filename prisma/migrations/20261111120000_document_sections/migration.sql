CREATE TABLE "document_sections" (
    "content_id" UUID NOT NULL,
    "section_no" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "start_page" INTEGER NOT NULL,
    "end_page" INTEGER NOT NULL,
    CONSTRAINT "document_sections_pkey" PRIMARY KEY ("content_id", "section_no"),
    CONSTRAINT "document_sections_content_id_fkey" FOREIGN KEY ("content_id") REFERENCES "document_contents"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
