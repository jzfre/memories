-- Migration: store embedding model name per chunk
ALTER TABLE "chunks" ADD COLUMN "embedding_model" TEXT;
