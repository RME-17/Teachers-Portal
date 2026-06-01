-- 022_memory_speaker_scoping_and_hnsw.sql
-- Adds speaker scoping to voice memory search + standardizes vector indexes on HNSW (matches planner, migration 021).
-- NOTE: live DB drifted (user_name + voice_facts.speaker_id applied by hand). All column adds use IF NOT EXISTS for safety.

-- 1) Speaker-scoping columns (idempotent)
alter table voice_facts add column if not exists speaker_id text;
alter table voice_facts add column if not exists user_name text;
alter table voice_conversations add column if not exists user_name text;
alter table voice_page_refs add column if not exists user_name text;
create index if not exists voice_facts_speaker_idx on voice_facts(speaker_id);

-- 2) Rewrite match_voice_memories: optional speaker_filter arg + speaker_id in results.
-- RETURNS TABLE shape changes (adds speaker_id), so drop first -- create or replace cannot change the out columns.
drop function if exists match_voice_memories(vector, int, text);

create function match_voice_memories(
  query_embedding vector(384),
  match_count int default 5,
  user_email_filter text default '',
  speaker_filter text default null
)
returns table (
  source_table text,
  id uuid,
  content text,
  similarity double precision,
  created_at timestamptz,
  speaker_id text
)
language plpgsql
as $$
begin
  return query
  select * from (
    select
      'voice_conversations'::text as source_table,
      vc.id,
      vc.content,
      1 - (vc.embedding <=> query_embedding) as similarity,
      vc.created_at,
      coalesce(vc.speaker_id, vc.user_name) as speaker_id
    from voice_conversations vc
    where vc.user_email = user_email_filter
      and vc.embedding is not null
      and (speaker_filter is null or coalesce(vc.speaker_id, vc.user_name) = speaker_filter)

    union all

    select
      'voice_facts'::text as source_table,
      vf.id,
      vf.fact_key || ': ' || vf.fact_value as content,
      1 - (vf.embedding <=> query_embedding) as similarity,
      vf.created_at,
      coalesce(vf.speaker_id, vf.user_name) as speaker_id
    from voice_facts vf
    where vf.user_email = user_email_filter
      and vf.embedding is not null
      and (speaker_filter is null or coalesce(vf.speaker_id, vf.user_name) = speaker_filter)
  ) combined
  order by combined.similarity desc
  limit match_count;
end;
$$;

-- 3) Standardize vector indexes: IVFFlat -> HNSW (match planner: m=16, ef_construction=200, migration 021)
drop index if exists idx_voice_conversations_embedding;
create index idx_voice_conversations_embedding on voice_conversations using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 200);

drop index if exists idx_voice_facts_embedding;
create index idx_voice_facts_embedding on voice_facts using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 200);
