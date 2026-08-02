-- Deliberately not the real 0000. A migration that has already been applied is
-- immutable; editing one has to be refused rather than silently ignored.
SELECT 'edited after the fact';
