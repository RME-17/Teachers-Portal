-- Migration: Voice Memory — session summaries table + semantic search RPC
-- Run in Supabase SQL Editor

-- 1. Session summaries table
CREATE TABLE IF NOT EXISTS voice_session_summaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_email TEXT NOT NULL,
    session_id TEXT NOT NULL,
    summary TEXT,
    user_name TEXT,
    embedding VECTOR(384),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_vss_email ON voice_session_summaries(user_email);
CREATE INDEX IF NOT EXISTS idx_vss_created ON voice_session_summaries(created_at DESC);

-- RLS
ALTER TABLE voice_session_summaries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users see own summaries" ON voice_session_summaries;
CREATE POLICY "Users see own summaries" ON voice_session_summaries
    FOR SELECT USING (auth.uid()::text = user_email OR auth.role() = 'service_role');
DROP POLICY IF EXISTS "Admins insert summaries" ON voice_session_summaries;
CREATE POLICY "Admins insert summaries" ON voice_session_summaries
    FOR INSERT WITH CHECK (auth.role() = 'service_role' OR true);

-- 2. Semantic search RPC for summaries
CREATE OR REPLACE FUNCTION match_voice_summaries(
    query_embedding VECTOR(384),
    match_count INT DEFAULT 3,
    user_email_filter TEXT DEFAULT NULL
)
RETURNS TABLE(
    id UUID,
    summary TEXT,
    session_id TEXT,
    created_at TIMESTAMPTZ,
    similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        vss.id,
        vss.summary,
        vss.session_id,
        vss.created_at,
        1 - (vss.embedding <=> query_embedding) AS similarity
    FROM voice_session_summaries vss
    WHERE vss.embedding IS NOT NULL
        AND (user_email_filter IS NULL OR vss.user_email = user_email_filter)
    ORDER BY vss.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- 3. Verify existing tables (already present, just confirm)
-- voice_conversations: id, user_email, turn_role, content, cid, user_name, speaker_id, embedding, created_at
-- voice_facts: id, user_email, fact_key, fact_value, confidence, source_cid, user_name, speaker_id, embedding, created_at, updated_at
-- match_voice_memories RPC: already exists for voice_conversations semantic search
