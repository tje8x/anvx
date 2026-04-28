from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", case_sensitive=False, extra="ignore")

    supabase_url: str
    supabase_service_role_key: str
    supabase_jwt_secret: str
    anvx_master_encryption_key: str | None = None

    # ── Clerk auth ────────────────────────────────────
    clerk_jwks_url: str = "https://clerk.anvx.io/.well-known/jwks.json"

    # ── Stripe / billing ──────────────────────────────
    stripe_secret_key: str | None = None
    stripe_close_pack_price_id: str | None = None
    stripe_ai_audit_pack_price_id: str | None = None
    stripe_metered_price_id: str | None = None
    webapp_base_url: str = "http://localhost:3000"

    # ── Notifications ──────────────────────────────────
    resend_api_key: str | None = None
    resend_from: str | None = None


settings = Settings()
