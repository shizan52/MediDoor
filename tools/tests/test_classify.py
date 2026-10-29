from _bootstrap import ROOT, BACKEND, DB_PATH, ASSETS  # noqa: F401,E402
import asyncio, sys, io, os
os.chdir("backend")
sys.path.insert(0, ".")

from app.api.routes.ai import classify_product, _gemini_json, PRODUCT_MODERATION_SYSTEM
from app.core.config import settings

async def main():
    print("API key present:", bool(settings.GEMINI_API_KEY), "len=", len(settings.GEMINI_API_KEY or ""))
    print("Model:", settings.GEMINI_MODEL)
    r = await classify_product("Napa 500mg Paracetamol Tablet", "Common pain reliever / fever medicine. OTC.", None, "Pain & Fever")
    print("Napa:", r)
    r2 = await classify_product("Basmati Rice 5kg", "Premium long-grain rice for daily cooking", None, None)
    print("Rice:", r2)
    r3 = await classify_product("Red Bull Energy Drink 250ml", "Energy drink with caffeine and taurine", None, None)
    print("Red Bull:", r3)

asyncio.run(main())
