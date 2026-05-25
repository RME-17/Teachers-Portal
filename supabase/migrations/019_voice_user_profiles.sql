-- Voice user profiles: personalized AI responses per founder
-- Seeded with Ayaaz (tech/payroll) and Yushra (recruiting/sales)
-- The AI detects the speaker from their first utterance and tailors tone + suggestions

create table if not exists voice_user_profiles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  display_name text not null,
  title text not null,
  bio text,
  suggestions text not null default '',
  tone text not null default 'direct',
  detection_patterns text[] not null default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Seed Ayaaz
insert into voice_user_profiles (name, display_name, title, bio, suggestions, tone, detection_patterns)
values (
  'ayaaz',
  'Sir Ayaaz',
  'Founder — Tech, Payroll, Accounting',
  'Handles the Teachers Portal app, Notion automation, server infrastructure, Discord, payroll for all teachers, and accounting per school.',
  'Check the payslip archive for pending uploads, review the operations audit action items, update teacher payroll records in the accounting databases, check Discord for support tickets.',
  'direct and technical — concise, data-focused, no fluff, get straight to the numbers.',
  array['it''s ayaaz', 'this is ayaaz', 'hi ayaaz', 'hey ayaaz', 'ayaaz here', 'ayaaz speaking']
)
on conflict (name) do nothing;

-- Seed Yushra
insert into voice_user_profiles (name, display_name, title, bio, suggestions, tone, detection_patterns)
values (
  'yushra',
  'Madam Yushra',
  'Founder — Recruiting, Sales, School Relations',
  'Manages the full recruiting pipeline: Job Application Forms, Interviews & Demos, Teacher Health, applicant screening, school communications, outreach drafts, and employment letters.',
  'Review new applicants in the Job Application Forms database, check upcoming interviews in Interviews & Demos, review outreach drafts pending send, check Teacher Health records for follow-ups.',
  'warm and supportive — encouraging, people-focused, highlight progress before next steps.',
  array['it''s yushra', 'this is yushra', 'hi yushra', 'hey yushra', 'yushra here', 'yushra speaking']
)
on conflict (name) do nothing;

-- Add user_name column to voice_conversations for per-user context
alter table voice_conversations add column if not exists user_name text;

create index if not exists idx_voice_conversations_user_name
  on voice_conversations (user_name);

alter table voice_user_profiles enable row level security;
