"""Wipe all user/transactional data from MediDoor tables (keeps schema).

Removes: accounts, all profiles, medicines, conversations, orders,
rider offers, ai notifications, ai usage, uploaded media files.
Keeps: schema + `category_catalog` (curated system catalog re-seeded
on startup by `seed_category_catalog.py`).

Usage:
    python tools/wipe_db.py            # wipe DB only
    python tools/wipe_db.py --uploads  # also delete backend/uploads/*
"""
import sqlite3, os, sys, shutil
db = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'backend', 'medidoor.db'))
print('DB:', db)
if not os.path.exists(db):
    print('No DB file — nothing to wipe.')
    sys.exit(0)

# Order doesn't matter with FK off, but kept logical (children → parents).
TABLES = [
    'ai_notifications',
    'ai_usage',
    'conversation_messages', 'conversations',
    'rider_offers', 'order_messages', 'orders',
    'medicines', 'medicine_categories',
    'rider_profiles', 'pharmacy_profiles', 'customer_profiles',
    'accounts',
]
con = sqlite3.connect(db)
cur = con.cursor()
cur.execute('PRAGMA foreign_keys = OFF;')
existing = {r[0] for r in cur.execute("select name from sqlite_master where type='table'")}
for t in TABLES:
    if t in existing:
        n = cur.execute(f'select count(*) from {t}').fetchone()[0]
        cur.execute(f'delete from {t};')
        print(f'  wiped {t}: {n} rows')
# reset sqlite autoincrement counters if present
try:
    cur.execute("delete from sqlite_sequence;")
except sqlite3.OperationalError:
    pass
con.commit()
cur.execute('VACUUM;')
con.close()
print('DB wiped.')

if '--uploads' in sys.argv:
    up = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'backend', 'uploads'))
    if os.path.isdir(up):
        removed = 0
        for name in os.listdir(up):
            p = os.path.join(up, name)
            if os.path.isfile(p):
                os.remove(p)
                removed += 1
        print(f'Uploads wiped: {removed} file(s) removed from {up}')
    else:
        print('No uploads/ directory.')

print('Done.')
