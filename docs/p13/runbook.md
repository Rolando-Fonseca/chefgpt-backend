# P13 — Runbook: Deploy ChefGPT en Easypanel

Procedimiento operativo para desplegar, verificar y revertir ChefGPT en Easypanel.

---

## 1. Arquitectura de despliegue

```
GitHub Repo (chefgpt-backend)
       │
       ▼
  Easypanel App Service
  ┌──────────────────────────┐
  │  Dockerfile build        │
  │  ┌────────────────────┐  │
  │  │  NestJS :3000      │  │
  │  │  TypeORM           │  │
  │  │  better-sqlite3    │  │
  │  └────────┬───────────┘  │
  │           │               │
  │     /data/chefgpt.db      │  ← Persistent Volume
  └──────────────────────────┘
       │
       ▼
  OpenRouter API (external)
```

Un solo servicio. Sin contenedores separados para DB — SQLite vive en un volumen persistente montado dentro del contenedor.

---

## 2. Dockerfile

Crear en la raíz del proyecto:

```dockerfile
FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN npm run build

# Runtime: SQLite writes here
VOLUME /data

ENV NODE_ENV=production
ENV DATABASE_PATH=/data/chefgpt.db

EXPOSE 3000

CMD ["node", "dist/main.js"]
```

### Notas

- `npm ci --omit=dev` instala solo dependencias de producción.
- `better-sqlite3` requiere compilación nativa. La imagen `node:20-slim` incluye las herramientas necesarias. Si falla, usar `node:20` (full) como fallback.
- `VOLUME /data` declara el punto de montaje. En Easypanel se mapea a un persistent volume.
- `DATABASE_PATH` apunta al volumen para que la DB sobreviva rebuilds.

---

## 3. Configuración en Easypanel

### Crear servicio

1. **New Service → App Service**
2. **Source:** GitHub repository → seleccionar `chefgpt-backend`
3. **Branch:** `main`
4. **Build:** Detecta el Dockerfile automáticamente
5. **Port:** `3000`

### Volumen persistente

| Montaje en contenedor | Tipo | Propósito |
|---|---|---|
| `/data` | Persistent Volume | Base de datos SQLite |

Sin este volumen, cada deploy destruye la DB.

### Health check

| Campo | Valor |
|---|---|
| Path | `/health` |
| Interval | 30s |
| Timeout | 5s |
| Start period | 15s |

Easypanel marca el servicio como healthy/unhealthy según este check.

---

## 4. Variables y secretos

### Variables de entorno (no sensibles)

| Variable | Valor en producción | Tipo |
|---|---|---|
| `NODE_ENV` | `production` | Plain |
| `PORT` | `3000` | Plain |
| `DATABASE_PATH` | `/data/chefgpt.db` | Plain |
| `OPENROUTER_MODEL` | `anthropic/claude-3-5-haiku-20241022` | Plain |
| `AI_TIMEOUT_MS` | `15000` | Plain |
| `AI_MAX_RETRIES` | `2` | Plain |
| `AI_TEMPERATURE` | `0.7` | Plain |
| `AI_MAX_TOKENS` | `1024` | Plain |
| `AI_BASICS` | `sal,pimienta,aceite de oliva,agua` | Plain |
| `OPENROUTER_REFERER` | `https://chefgpt.tudominio.com` | Plain |
| `OPENROUTER_TITLE` | `ChefGPT Production` | Plain |

### Secretos (no loguear, no committear)

| Variable | Cómo obtener | Tipo |
|---|---|---|
| `OPENROUTER_API_KEY` | Dashboard de OpenRouter → API Keys | **Secret** |

En Easypanel: marcar como "Secret" (icono de candado) para que no aparezca en logs de build.

### Orden de configuración

1. Crear el servicio con la URL del repo.
2. Configurar el volumen persistente en `/data`.
3. Agregar todas las variables plain.
4. Agregar `OPENROUTER_API_KEY` como secreto.
5. Trigger deploy.

---

## 5. DB y migraciones/seed (conceptual)

### Esquema actual

TypeORM con `synchronize: true` cuando `NODE_ENV !== production`. En producción:

| Modo | Comportamiento |
|---|---|
| `NODE_ENV=development` | `synchronize: true` — crea/altera tablas automáticamente |
| `NODE_ENV=production` | `synchronize: false` — no toca el esquema |

### Primera vez (cold start)

La DB no existe en el volumen vacío. Opciones:

**Opción A — Primer deploy con synchronize temporal:**
1. Deploy inicial con `NODE_ENV=staging` (o cualquier valor que no sea `production`).
2. TypeORM crea las tablas.
3. Cambiar `NODE_ENV=production` y redeploy.
4. Las tablas ya existen, TypeORM no las toca.

**Opción B — Migration en startup (recomendado para producción estable):**
1. Generar migration: `npm run typeorm migration:generate -- -n InitSchema`
2. Ejecutar migration en CMD antes del server: `CMD ["sh", "-c", "npm run typeorm migration:run && node dist/main.js"]`
3. Cada cambio de esquema futuro requiere una migration nueva.

**Opción C — Seed con datos iniciales:**
1. Crear `src/seed.ts` con ingredientes básicos.
2. Ejecutar una vez: `npm run seed` (como comando manual en Easypanel).
3. Eliminar el endpoint de seed en producción.

### Regla de oro

Nunca eliminar el volumen persistente sin backup. Un `rm` del volumen = pérdida total de datos.

### Backup

```bash
# Desde el servidor (no desde el contenedor)
cp /path/to/easypanel/volumes/chefgpt-data/chefgpt.db \
   /backups/chefgpt-$(date +%Y%m%d).db
```

Programar con cron semanal. El archivo SQLite es un solo archivo — copiarlo es un backup completo y consistente si nadie escribe durante la copia.

---

## 6. Verificación post-deploy

Ejecutar en orden tras cada deploy:

### 6.1 Health del servicio

```bash
curl -s https://chefgpt.tudominio.com/health | jq .
```

**Esperado:**
```json
{
  "status": "ok",
  "db": "connected",
  "ai": "configured",
  "timestamp": "..."
}
```

| Si devuelve | Significado | Acción |
|---|---|---|
| `status: "ok"` | Deploy exitoso | Continuar al 6.2 |
| `status: "degraded"` + `db: "error"` | DB no montada o corrupta | Verificar volumen, sección 7.1 |
| `status: "degraded"` + `ai: "not_configured"` | API key falta | Verificar secreto en Easypanel |
| Connection refused | Servicio no arrancó | Ver logs en Easypanel, sección 7.2 |

### 6.2 Swagger accesible

```bash
curl -s -o /dev/null -w "%{http_code}" https://chefgpt.tudominio.com/api/docs
```

**Esperado:** `200`

### 6.3 Inventario responde

```bash
curl -s https://chefgpt.tudominio.com/inventory | jq 'length'
```

**Esperado:** número ≥ 0 (0 es válido si es un deploy limpio).

### 6.4 AI responde (smoke test)

```bash
curl -s -X POST https://chefgpt.tudominio.com/ai/recipes \
  -H "Content-Type: application/json" \
  -d '{"cuisineType":"Cualquiera","servings":2}' | jq '.meta.traceId'
```

**Esperado:** un UUID (string). Si devuelve 502/503, ver sección 7.3.

### Checklist post-deploy

- [ ] `/health` → `status: "ok"`
- [ ] `/api/docs` → 200
- [ ] `/inventory` → 200
- [ ] `/ai/recipes` → 200 con traceId
- [ ] No errores en logs de Easypanel (últimos 5 min)

---

## 7. Troubleshooting

### 7.1 Base de datos

| Síntoma | Diagnóstico | Acción |
|---|---|---|
| `GET /health` → `db: "error"` | Volumen no montado o path incorrecto | Verificar que el volumen está montado en `/data` y `DATABASE_PATH=/data/chefgpt.db` |
| Tablas no existen (errores SQL en logs) | `synchronize: false` y no se corrió migration | Ejecutar migration manual o hacer primer deploy con sync temporal (sección 5) |
| `UNIQUE constraint failed` al hacer seed | Datos duplicados de un seed previo | Eliminar el ingrediente existente o hacer `DELETE` antes de re-seed |
| DB corrupta (errores `SQLITE_CORRUPT`) | Escritura durante shutdown brusco | Restaurar desde backup. Si no hay backup, eliminar `chefgpt.db` y reiniciar (pérdida total) |

### 7.2 Logs

**En Easypanel:** Service → Logs tab.

**Patrones de búsqueda:**

| Patrón | Significado |
|---|---|
| `AiService` | Trazas de llamadas LLM (traceId, tokens, latencia) |
| `QueryFailedError` | Error de base de datos |
| `NestApplication` | Boot del servidor (puerto, módulos cargados) |
| `SIGTERM` | Shutdown signal (redeploy o escala) |

**Log de trace LLM de ejemplo:**
```
[AiService] {"traceId":"a1b2c3d4-...","model":"anthropic/claude-3-5-haiku-20241022","promptTokens":312,"completionTokens":487,"latencyMs":2340,"status":"success","retryCount":0}
```

Si el trace muestra `status: "error"` y `errorCode: "auth"`, la API key es inválida.

### 7.3 OpenRouter

| Síntoma | Diagnóstico | Acción |
|---|---|---|
| 502 + traceId en respuesta | JSON inválido del modelo tras reintentos | Revisar logs con el traceId. Verificar que el modelo soporta `response_format: json_object` |
| 503 "API key not configured" | `OPENROUTER_API_KEY` vacía o no marcada como secreto | Configurar en Environment tab de Easypanel |
| 429 Too Many Requests | Rate limit del plan de OpenRouter | Verificar créditos en dashboard.openrouter.ai. Considerar upgrade o backoff |
| Timeout (504) | Modelo lento o `AI_TIMEOUT_MS` muy bajo | Aumentar a 25000. Verificar latencia promedio en traces |
| `{"error": "Insufficient ingredients"}` | Inventario vacío o insuficiente | Agregar ingredientes vía `POST /inventory` |

### 7.4 Build falla

| Síntoma | Diagnóstico | Acción |
|---|---|---|
| `npm ci` falla | `package-lock.json` desactualizado | Ejecutar `npm install` local, committear el lock, redeploy |
| `better-sqlite3` build error | Falta python o build-tools en imagen | Cambiar base a `node:20` (full) en Dockerfile |
| `nest build` falla | Error de TypeScript | Corregir localmente con `npm run build`, committear, redeploy |

---

## 8. Rollback

### Estrategia: deploy por tag

Cada deploy estable se etiqueta en Git:

```bash
# Antes de deploy
git tag -a v1.2.0 -m "Stable: inventory + AI recipes"
git push origin v1.2.0
```

### Procedimiento de rollback

**En Easypanel:**

1. Service → Settings → Source
2. Cambiar branch a `v1.2.0` (o el tag anterior estable)
3. Trigger deploy
4. Ejecutar verificación post-deploy (sección 6)

**Si Easypanel no soporta deploy por tag directamente:**

1. En el repo local:
   ```bash
   git checkout main
   git revert HEAD..<commit-estable>
   git push origin main
   ```
2. Easypanel detecta el push y redeploya automáticamente.

### Historial de tags

| Tag | Fecha | Cambios | Notas |
|---|---|---|---|
| `v1.0.0` | — | Inventory CRUD + Swagger | Primer deploy |
| `v1.1.0` | — | + AI recipes (OpenRouter) | Agregar `OPENROUTER_API_KEY` |
| `v1.2.0` | — | + Health endpoints | — |

Mantener esta tabla actualizada en este documento.

### Regla de rollback

- Si el post-deploy check falla en los puntos 6.1 o 6.2 → rollback inmediato.
- Si falla solo 6.4 (AI) → no rollback, operar en degraded y fix forward.
- Nunca hacer rollback sin verificar que el tag anterior despliega correctamente en local.

---

## 9. Flujo de deploy completo (resumen)

```
1. Local: npm run build → sin errores
2. Local: npm test → sin errores
3. Git: commit + tag → push origin
4. Easypanel: detecta push → build automático
5. Easypanel: build OK → contenedor nuevo arranca
6. Health check: GET /health → status: "ok"
7. Post-deploy check (sección 6) → todo verde
8. Listo
```

Si falla el paso 4 o 5 → revisar logs de build en Easypanel (sección 7.4).
Si falla el paso 6 o 7 → rollback (sección 8) y fix forward.
