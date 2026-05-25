-- Migration: add speaker_id columns and indexes
alter table voice_conversations add column if not exists speaker_id text;
alter table voice_page_refs add column if not exists speaker_id text;
create index if not exists voice_conversations_speaker_idx on voice_conversations(speaker_id);
create index if not exists voice_page_refs_speaker_idx on voice_page_refs(speaker_id);
