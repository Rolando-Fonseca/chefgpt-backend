# P13 — Runbook: Deploy ChefGPT en Render + Neon

Procedimiento operativo para desplegar, verificar y revertir ChefGPT usando servicios
100% gratuitos: **Render** (hosting) + **Neon** (Postgres serverless) + **Groq** (IA).

> **Nota de migración:** el plan original usaba Easypanel (requiere VPS pago) + SQLite en
> volumen persistente. Se cambió a Render + Neon porque no requieren tarjeta de crédito
> ni servidor propio. Mover la DB a Neon también eliminó la dependencia de un volumen
> persistente, que era la razón por la que se necesitaba un servicio tipo VPS.

---

## 1. Arquitectura de despliegue

```
GitHub Repo (chefgpt-backend)
       │
       ▼
  Render Web Service (free tier)
  ┌──────────────────────────┐
  │  npm ci && npm run build │
  │  ┌────────────────────┐  │
  │  │  NestJS :3000      │  │
  │  │  TypeORM (pg)      │  │
  │  └────────┬───────────┘  │
  └───────────┼───────────────┘
              │
              ▼
        Neon Postgres            Groq API
     (conexión remota,          (external)
      sin volumen local)
```

Servicio *stateless*: no hay disco persistente que gestionar. La base de datos vive en
Neon, fuera del contenedor/proceso de Render — por eso ya no hace falta un VPS.

---

## 2. Build en Render

Render puede construir de dos formas. Recomendado: **build nativo** (sin Docker), porque
ahora que la DB usa `pg` (driver puro JS, sin compilación nativa) ya no hay motivo para
pagar el costo de un multi-stage Docker build.

### Opción A — Build nativo (recomendado)

En la configuración del servicio en Render:

| Campo | Valor |
|---|---|
| Build Command | `npm ci && npm run build` |
| Start Command | `node dist/main.js` |
| Environment | Node |

### Opción B — Docker (si se prefiere reproducibilidad exacta)

El `Dockerfile` del repo sigue siendo válido (ya no declara `VOLUME` ni `DATABASE_PATH`,
esas líneas se quitaron al migrar a Neon). Render detecta el Dockerfile automáticamente
si se selecciona "Docker" como Environment.

---

## 3. Configuración en Render

### Opción A — Blueprint (recomendado, usa `render.yaml` del repo)

El repo incluye `render.yaml` en la raíz con el build/start command, el health check
y las variables plain ya definidas. Los dos secrets (`DATABASE_URL`, `GROQ_API_KEY`)
están marcados `sync: false` a propósito — Render los pide en el momento del setup
en vez de leerlos del archivo (el repo es público, nunca deben quedar en el YAML).

1. [dashboard.render.com](https://dashboard.render.com) → **New → Blueprint**
2. Conectar el repo de GitHub `chefgpt-backend` (autoriza la GitHub App de Render la primera vez)
3. Render detecta `render.yaml` automáticamente y muestra el plan del servicio
4. Completar `DATABASE_URL` y `GROQ_API_KEY` cuando los pida
5. **Apply** → despliega

### Opción B — Servicio manual (si prefieres configurar todo a mano)

1. [dashboard.render.com](https://dashboard.render.com) → **New → Web Service**
2. **Source:** conectar el repo de GitHub `chefgpt-backend`
3. **Branch:** `master`
4. **Region:** la más cercana (Oregon/Frankfurt suelen ser las opciones gratuitas)
5. **Instance Type:** Free
6. **Port:** Render detecta el puerto vía la variable `PORT` que él mismo inyecta — no hace falta fijar `3000`

### Health check

| Campo | Valor |
|---|---|
| Health Check Path | `/health` |

Render usa esto para marcar el deploy como exitoso y para reiniciar el servicio si deja de responder.

### Comportamiento del free tier

El plan gratuito de Render **duerme el servicio tras ~15 min de inactividad**. La
primera petición tras dormir tarda ~30-50s en responder (cold start) mientras el
contenedor arranca de nuevo. Es aceptable para una demo/presentación, pero avisar
de esto antes de la demo en vivo — hacer un `curl /health` unos segundos antes de
presentar para "despertarlo".

---

## 4. Variables y secretos

Configurar en Render → Service → Environment:

### Variables de entorno (no sensibles)

| Variable | Valor en producción | Tipo |
|---|---|---|
| `NODE_ENV` | `production` | Plain |
| `GROQ_MODEL` | `qwen/qwen3.8-27b` | Plain |
| `AI_TIMEOUT_MS` | `15000` | Plain |
| `AI_MAX_RETRIES` | `2` | Plain |
| `AI_TEMPERATURE` | `0.7` | Plain |
| `AI_MAX_TOKENS` | `1024` | Plain |
| `AI_BASICS` | `sal,pimienta,aceite de oliva,agua` | Plain |

`PORT` **no** se configura manualmente — Render la inyecta automáticamente y `main.ts`
ya lee `process.env.PORT`.

### Secretos (no loguear, no committear)

| Variable | Cómo obtener | Tipo |
|---|---|---|
| `DATABASE_URL` | Neon dashboard → Connection string (con `?sslmode=require`) | **Secret** |
| `GROQ_API_KEY` | [console.groq.com/keys](https://console.groq.com/keys) | **Secret** |

En Render, todas las variables de Environment ya están ocultas por defecto en los logs de build.

### Orden de configuración

1. Crear el proyecto en Neon, copiar el connection string.
2. Crear cuenta en Groq, generar API key.
3. Crear el servicio en Render apuntando al repo de GitHub.
4. Agregar todas las variables plain.
5. Agregar `DATABASE_URL` y `GROQ_API_KEY` como secrets.
6. Trigger deploy.

---

## 5. Base de datos (Neon)

### Setup inicial

1. Crear cuenta en [neon.tech](https://neon.tech) (free tier, no requiere tarjeta).
2. **New Project** → nombre `chefgpt` → región cercana.
3. Copiar el **connection string** (incluye usuario, password, host y `?sslmode=require`).
4. En el **SQL Editor** de Neon, habilitar la extensión de UUID una sola vez:
   ```sql
   CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
   ```
   Esto es necesario porque `Ingredient.id` usa `@PrimaryGeneratedColumn('uuid')`, que en
   Postgres depende de esa extensión para generar los UUIDs por defecto.

### Esquema y `synchronize`

TypeORM con `synchronize: true` cuando `NODE_ENV !== production`. En producción:

| Modo | Comportamiento |
|---|---|
| `NODE_ENV=development` | `synchronize: true` — crea/altera tablas automáticamente |
| `NODE_ENV=production` | `synchronize: false` — no toca el esquema |

### Primera vez (cold start)

La tabla `ingredients` no existe en la DB nueva. Opciones:

**Opción A — Primer deploy con synchronize temporal:**
1. Deploy inicial con `NODE_ENV=staging` (o cualquier valor que no sea `production`).
2. TypeORM crea las tablas.
3. Cambiar `NODE_ENV=production` y redeploy.
4. Las tablas ya existen, TypeORM no las toca.

**Opción B — Migration en startup (recomendado para producción estable):**
1. Generar migration: `npm run typeorm migration:generate -- -n InitSchema`
2. Ejecutar migration antes del server: `node dist/main.js` → cambiar Start Command en
   Render a `npm run typeorm migration:run && node dist/main.js`
3. Cada cambio de esquema futuro requiere una migration nueva.

### Regla de oro

Neon hace backups automáticos (point-in-time restore en el free tier, con ventana
limitada — revisar el plan vigente). Aun así, nunca ejecutar `DROP TABLE` o borrar el
proyecto de Neon sin verificar que hay un restore point reciente.

### Branching de Neon (ventaja sobre el setup anterior)

Neon permite crear una "branch" de la base de datos (copia instantánea, copy-on-write)
para probar cambios de esquema sin tocar producción. Útil para probar una migration
antes de aplicarla en la rama principal.

---

## 6. Verificación post-deploy

Ejecutar en orden tras cada deploy (reemplazar `<url>` por la URL que asigna Render,
tipo `https://chefgpt-backend.onrender.com`):

### 6.1 Health del servicio

```bash
curl -s https://<url>/health | jq .
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
| `status: "degraded"` + `db: "error"` | `DATABASE_URL` mal configurada o Neon caído | Verificar la variable en Render, sección 7.1 |
| `status: "degraded"` + `ai: "not_configured"` | `GROQ_API_KEY` falta | Verificar el secreto en Render |
| Sin respuesta / tarda >50s | Cold start del free tier | Normal la primera vez tras inactividad, reintentar |

### 6.2 Swagger accesible

```bash
curl -s -o /dev/null -w "%{http_code}" https://<url>/api/docs
```

**Esperado:** `200`

### 6.3 Inventario responde

```bash
curl -s https://<url>/inventory | jq 'length'
```

**Esperado:** número ≥ 0 (0 es válido si es un deploy limpio).

### 6.4 AI responde (smoke test)

```bash
curl -s -X POST https://<url>/ai/recipes \
  -H "Content-Type: application/json" \
  -d '{"cuisineType":"Cualquiera","servings":2}' | jq '.meta.traceId'
```

**Esperado:** un UUID (string). Si devuelve 502/503, ver sección 7.3. Si el inventario
está vacío, primero cargar unos ingredientes con `POST /inventory` (ver `admin-ops.md`).

### Checklist post-deploy

- [ ] `/health` → `status: "ok"`
- [ ] `/api/docs` → 200
- [ ] `/inventory` → 200
- [ ] `/ai/recipes` → 200 con traceId
- [ ] No errores en logs de Render (Service → Logs)

---

## 7. Troubleshooting

### 7.1 Base de datos

| Síntoma | Diagnóstico | Acción |
|---|---|---|
| `GET /health` → `db: "error"` | `DATABASE_URL` incorrecta o Neon proyecto suspendido (inactividad prolongada en free tier) | Verificar la variable en Render; en Neon, el free tier "suspende" el compute tras inactividad y despierta con la primera query (puede tardar unos segundos) |
| Tablas no existen (errores SQL en logs) | `synchronize: false` y no se corrió migration | Ejecutar migration manual o hacer primer deploy con sync temporal (sección 5) |
| `error: extension "uuid-ossp" does not exist` | No se habilitó la extensión en Neon | Ejecutar `CREATE EXTENSION IF NOT EXISTS "uuid-ossp";` en el SQL Editor de Neon |
| `UNIQUE constraint failed` / `duplicate key value violates unique constraint` al hacer seed | Datos duplicados de un seed previo | Eliminar el ingrediente existente o hacer `DELETE` antes de re-seed |

### 7.2 Logs

**En Render:** Service → Logs tab (streaming en vivo).

**Patrones de búsqueda:**

| Patrón | Significado |
|---|---|
| `AiService` | Trazas de llamadas LLM (traceId, tokens, latencia) |
| `QueryFailedError` | Error de base de datos |
| `NestApplication` | Boot del servidor (puerto, módulos cargados) |
| `SIGTERM` | Shutdown signal (redeploy o el free tier durmiendo el servicio) |

**Log de trace LLM de ejemplo:**
```
[AiService] {"traceId":"a1b2c3d4-...","model":"qwen/qwen3.8-27b","promptTokens":312,"completionTokens":487,"latencyMs":890,"status":"success","retryCount":0}
```

Si el trace muestra `status: "error"` y `errorCode: "auth"`, la API key de Groq es inválida.

### 7.3 Groq

| Síntoma | Diagnóstico | Acción |
|---|---|---|
| 502 + traceId en respuesta | JSON inválido del modelo tras reintentos | Revisar logs con el traceId |
| 503 "Groq API key not configured" | `GROQ_API_KEY` vacía | Configurar en Environment tab de Render |
| 429 Too Many Requests | Rate limit del free tier de Groq (por minuto/día) | Esperar y reintentar. Ver límites vigentes en console.groq.com |
| Timeout (504) | Modelo lento o `AI_TIMEOUT_MS` muy bajo | Aumentar a 25000 |
| `{"error": "Insufficient ingredients"}` | Inventario vacío o insuficiente | Agregar ingredientes vía `POST /inventory` |

### 7.4 Build falla

| Síntoma | Diagnóstico | Acción |
|---|---|---|
| `npm ci` falla | `package-lock.json` desactualizado | Ejecutar `npm install` local, committear el lock, redeploy |
| `nest build` falla | Error de TypeScript | Corregir localmente con `npm run build`, committear, redeploy |
| Deploy nunca pasa a "Live" | Health check `/health` no responde a tiempo | Revisar logs de arranque — probablemente `DATABASE_URL` mal formada bloqueando la conexión |

---

## 8. Rollback

### Estrategia: deploy por commit

Render permite volver a un deploy anterior directamente desde el dashboard
(Service → Deploys → seleccionar un deploy previo → "Rollback to this deploy"),
sin necesidad de manipular tags de Git.

### Procedimiento de rollback

1. Render → Service → **Deploys**
2. Ubicar el último deploy que pasó la verificación post-deploy (sección 6)
3. Click **Rollback to this deploy**
4. Ejecutar verificación post-deploy (sección 6) sobre el rollback

### Alternativa por Git

```bash
git checkout master
git revert HEAD..<commit-estable>
git push origin master
```
Render detecta el push y redeploya automáticamente.

### Regla de rollback

- Si el post-deploy check falla en los puntos 6.1 o 6.2 → rollback inmediato.
- Si falla solo 6.4 (AI) → no rollback, operar en degraded y fix forward (puede ser
  solo el rate limit de Groq, no un bug).
- Nunca hacer rollback de la base de datos sin verificar un restore point en Neon.

---

## 9. Flujo de deploy completo (resumen)

```
1. Local: npm run build → sin errores
2. Local: npm test → sin errores
3. Git: commit → push origin master
4. Render: detecta push → build automático
5. Render: build OK → contenedor nuevo arranca
6. Health check: GET /health → status: "ok"
7. Post-deploy check (sección 6) → todo verde
8. Listo
```

Si falla el paso 4 o 5 → revisar logs de build en Render (sección 7.4).
Si falla el paso 6 o 7 → rollback (sección 8) y fix forward.
