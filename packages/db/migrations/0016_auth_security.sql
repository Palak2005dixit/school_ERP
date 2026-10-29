-- 0016 Password reset tokens and TOTP multi-factor authentication.
--
-- Reset tokens are stored only as SHA-256 hashes. TOTP secrets are stored so
-- the server can verify codes; they are never returned by any read endpoint
-- after setup. Recovery codes are intentionally out of scope for this build.

CREATE TABLE password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  requested_ip VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_password_reset_tokens_hash UNIQUE (token_hash),
  CONSTRAINT chk_password_reset_tokens_expiry CHECK (expires_at > created_at)
);
CREATE INDEX ix_password_reset_tokens_user
  ON password_reset_tokens (user_id, created_at DESC);

CREATE TABLE user_mfa (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret VARCHAR(64) NOT NULL,
  confirmed_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_user_mfa_updated_at BEFORE UPDATE ON user_mfa
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
