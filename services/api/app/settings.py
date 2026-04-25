from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    supabase_url: str
    supabase_service_role_key: str
    supabase_jwt_secret: str
    anvx_master_encryption_key: str | None = None

    # ── Stripe / billing ──────────────────────────────
    stripe_secret_key: str | None = None
    stripe_close_pack_price_id: str | None = None
    stripe_ai_audit_pack_price_id: str | None = None
    stripe_metered_price_id: str | None = None
    webapp_base_url: str = "http://localhost:3000"


settings = Settings()
