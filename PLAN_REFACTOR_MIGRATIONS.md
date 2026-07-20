# Plan: Refactor de Migraciones

## Problema

`run_db_migrations()` (~50 ALTER TABLE / CREATE TABLE / CREATE INDEX) se ejecuta en cada cold start de Render, agregando 1-3s innecesarios.

## Solución

1. **`run_db_migrations()`** se mueve a un script aparte `run_migrations.py`
2. **`lifespan()`** solo queda con:
   - `Base.metadata.create_all(bind=engine)` 
   - Seed Bot user
   - Seed expense categories
3. **Deploy hook**: Render ejecuta `python run_migrations.py` como Release Command
4. **Agregar endpoint `/health`** que haga `SELECT 1` para warm-up

## Archivos a modificar

| Archivo | Cambio |
|---------|--------|
| `main.py` | Eliminar `run_db_migrations()` de `lifespan()`. Agregar endpoint `GET /health` |
| `run_migrations.py` | Nuevo. Copiar `run_db_migrations()` de `main.py`, importar engine de `database.py` |
| Render Dashboard | Agregar Release Command: `python run_migrations.py` |

## Código nuevo: `run_migrations.py`

```python
import os
from dotenv import load_dotenv
from sqlalchemy import create_engine, text

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")
if DATABASE_URL and DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

engine = create_engine(DATABASE_URL)

def run_migrations(conn):
    # Pegar aquí la función run_db_migrations() de main.py líneas 880-1157
    # adaptada para recibir `conn` en lugar de crear uno interno
    pass

with engine.connect() as conn:
    run_migrations(conn)

print("Migrations complete")
```

> **Nota**: No ejecutar hasta tener tiempo de probar el deploy.

## Endpoint /health en main.py

```python
@app.get("/health")
def health_check():
    from database import SessionLocal
    db = SessionLocal()
    try:
        db.execute(text("SELECT 1"))
        return {"status": "ok"}
    finally:
        db.close()
```
