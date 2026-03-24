-- AutoLinks — Migration 016: Add phone column to profiles
-- Stores the user's WhatsApp phone number (required on sign-up).

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS profiles_phone_idx ON profiles(phone) WHERE phone <> '';
