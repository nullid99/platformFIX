-- Per-lesson Q&A discussion prompts (curator-written), replacing the hardcoded demo text that
-- used to be identical for every lesson. See Module.qaQuestions in schema.prisma.
ALTER TABLE "Module" ADD COLUMN "qaQuestions" JSONB;
