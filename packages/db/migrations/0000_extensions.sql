-- The user table stores email as citext, so the extension has to exist before
-- any table does. It ships in the standard contrib modules and is present in
-- the official Postgres image, but a self-hoster on an unusual base image has
-- to have installed it.
CREATE EXTENSION IF NOT EXISTS citext;
