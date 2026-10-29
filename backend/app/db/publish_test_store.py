"""
publish_test_store.py  —  local-dev helper (safe, idempotent)

Makes the already-seeded "Test Pharmacy" + its 5 test medicines visible in the
customer storefront, so you can preview how categories & product cards look.

Why a script?  The storefront hides a pharmacy until it is *published* and
*verified* (DGDA gate). Those flags are normally set through the pharmacy
dashboard / admin verification flow. For local preview we just flip them
directly on the SQLite dev DB. It ONLY touches the row named 'Test Pharmacy'
and that pharmacy's medicines — nothing else.

Run it from the backend folder (same folder as medidoor.db):

    python -m app.db.publish_test_store

The backend can stay running; it will pick up the change on the next request.
"""
from __future__ import annotations

import os
import sqlite3

DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "medidoor.db")

# Local, offline-friendly product art generated alongside this script
# (served by the backend at /uploads/*). Keyed by exact medicine name.
IMAGES = {
    "Napa 500mg": "/uploads/test_napa.svg",
    "Seclo 20mg": "/uploads/test_seclo.svg",
    "Histacin": "/uploads/test_histacin.svg",
    "Vitamin D3 40000 IU": "/uploads/test_vitd3.svg",
    "ORS Saline": "/uploads/test_ors.svg",
}


def main() -> None:
    if not os.path.exists(DB):
        raise SystemExit(f"medidoor.db not found next to this script: {DB}")

    conn = sqlite3.connect(DB, timeout=15)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    row = cur.execute(
        "SELECT id, pharmacy_name FROM pharmacy_profiles WHERE pharmacy_name = 'Test Pharmacy'"
    ).fetchone()
    if not row:
        raise SystemExit("No pharmacy named 'Test Pharmacy' found — nothing to do.")

    pid = row["id"]

    # 1) Publish + verify the test pharmacy and give it a friendly rating so
    #    the product cards show the verified badge + star rating.
    cur.execute(
        """
        UPDATE pharmacy_profiles
           SET is_published = 1,
               is_verified = 1,
               verification_status = 'verified',
               is_blocked = 0,
               closed_until = NULL,
               rating = 4.7,
               rating_count = 128
         WHERE id = ?
        """,
        (pid,),
    )

    # 2) Point each medicine at its local product image (offline-friendly).
    imaged = 0
    for name, url in IMAGES.items():
        cur.execute(
            "UPDATE medicines SET image_url = ? WHERE pharmacy_id = ? AND name = ?",
            (url, pid, name),
        )
        imaged += cur.rowcount

    # 3) Belt-and-braces: make sure every test medicine is live & sellable.
    cur.execute(
        """
        UPDATE medicines
           SET is_active = 1,
               approval_status = 'approved'
         WHERE pharmacy_id = ? AND stock > 0
        """,
        (pid,),
    )

    conn.commit()

    meds = cur.execute(
        "SELECT name, category, price, stock FROM medicines WHERE pharmacy_id = ? ORDER BY category",
        (pid,),
    ).fetchall()
    conn.close()

    print("\n[OK] Test Pharmacy published & verified.")
    print(f"[OK] Product images set on {imaged} medicine(s).")
    print(f"[OK] {len(meds)} medicine(s) now live:")
    for m in meds:
        print(f"       - {m['name']:<22} {m['category']:<18} Tk {m['price']:<6} stock {m['stock']}")
    print(
        "\nOpen the customer app at http://localhost:3100 (location: Barishal / "
        "22.7009, 90.3676) and the categories + product grid will appear.\n"
    )


if __name__ == "__main__":
    main()
