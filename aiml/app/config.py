"""Configuration settings for AI Context Intelligence module."""

import os
from pathlib import Path
from typing import Optional
from dotenv import load_dotenv

# Load local aiml/.env or root .env if present
_aiml_dir = Path(__file__).resolve().parent.parent
_env_path = _aiml_dir / ".env"
if _env_path.exists():
    load_dotenv(dotenv_path=_env_path)
else:
    load_dotenv()


class Settings:
    """Application configuration settings."""

    @property
    def groq_api_key(self) -> Optional[str]:
        key = os.getenv("GROQ_API_KEY", "").strip()
        return key if key else None

    @property
    def groq_model(self) -> str:
        return os.getenv("GROQ_MODEL", "openai/gpt-oss-20b").strip()

    @property
    def groq_timeout(self) -> float:
        try:
            return float(os.getenv("GROQ_TIMEOUT", "30.0"))
        except ValueError:
            return 30.0


settings = Settings()
