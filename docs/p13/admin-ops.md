# P13 — Operaciones ChefGPT sin Frontend

Guía para administrar ChefGPT usando solo Swagger y una colección HTTP. Sin panel visual, sin UI.

---

## 1. Swagger como panel base

### URL

```
http://localhost:3000/api/docs
```

### Limitaciones conocidas de Swagger UI

| Limitación | Workaround |
|---|---|
| No guarda estado entre recargas | Usar colección Postman/Bruno para persistencia |
| No soporta variables de entorno | Colección con variables `{baseUrl}`, `{apiKey}` |
| No ejecuta flujos encadenados | Ejecutar requests manualmente en orden |
| No muestra diffs de inventario | Comparar respuestas GET sucesivas visualmente |

### Cuándo usar cada herramienta

| Tarea | Herramienta |
|---|---|
| Probar un endpoint rápido | Swagger UI |
| Ejecutar checklist diario completo | Colección "Ops ChefGPT" |
| Depurar un error específico | `curl` o Swagger con respuesta raw |
| Verificar health | `curl /health` directo |

---

## 2. Colección "Ops ChefGPT"

### Estructura de carpetas

```
Ops ChefGPT/
├── 0-Health/
│   ├── GET /health
│   └── GET /health/ai
├── 1-Inventory/
│   ├── GET /inventory
│   ├── POST /inventory (crear ingrediente)
│   ├── PATCH /inventory/:id (actualizar cantidad)
│   └── DELETE /inventory/:id
├── 2-AI/
│   └── POST /ai/recipes
└── 3-Daily-Check/
    ├── Step 1 — Inventario completo
    ├── Step 2 — Críticos por vencer
    └── Step 3 — Generar sugerencias
```

### Variables de la colección

| Variable | Valor | Uso |
|---|---|---|
| `baseUrl` | `http://localhost:3000` | Prefijo de todos los requests |
| `sampleIngredientId` | *(se copia tras crear ingrediente)* | Para PATCH/DELETE |

### Requests mínimos

#### 0-Health

**GET `{{baseUrl}}/health`**

```
Sin body. Verificar status 200.
```

**GET `{{baseUrl}}/health/ai`**

```
Sin body. Verificar que el campo "ai" indique "configured" o "not_configured".
```

#### 1-Inventory

**GET `{{baseUrl}}/inventory`**

```
Sin body. Lista completa de ingredientes con cantidades y fechas de vencimiento.
```

**POST `{{baseUrl}}/inventory`**

```json
{
  "name": "Pollo",
  "quantity": 500,
  "unit": "g",
  "category": "protein",
  "expirationDate": "2026-05-18"
}
```

**PATCH `{{baseUrl}}/inventory/{{sampleIngredientId}}`**

```json
{
  "quantity": 250
}
```

**DELETE `{{baseUrl}}/inventory/{{sampleIngredientId}}`**

```
Sin body. Status 200 = eliminado.
```

#### 2-AI

**POST `{{baseUrl}}/ai/recipes`**

```json
{
  "cuisineType": "Mediterránea",
  "restrictions": "sin frutos secos",
  "servings": 4
}
```

Verificar que `meta.traceId` esté presente y `recipes` contenga 1-3 recetas.

---

## 3. Endpoints de health y status

### GET /health

Indica si el servidor está vivo y la base de datos responde.

```json
{
  "status": "ok",
  "db": "connected",
  "ai": "configured",
  "timestamp": "2026-05-16T10:30:00.000Z"
}
```

| Campo | Valores posibles | Significado |
|---|---|---|
| `status` | `ok` \| `degraded` | `ok` = todo funcional, `degraded` = algún componente falla |
| `db` | `connected` \| `error` | Si la DB no responde, el estado general es `degraded` |
| `ai` | `configured` \| `not_configured` | `not_configured` = `GROQ_API_KEY` vacía, recetas no disponibles |
| `timestamp` | ISO 8601 | Momento del check |

### GET /health/ai

Indica si la integración con Groq está operativa, sin hacer una llamada real al modelo.

```json
{
  "ai": "configured",
  "model": "anthropic/claude-3-5-haiku-20241022",
  "timeoutMs": 15000,
  "maxRetries": 2
}
```

| Campo | Significado |
|---|---|
| `ai` | `configured` si hay API key, `not_configured` si no |
| `model` | Modelo que se usaría en la llamada |
| `timeoutMs` | Timeout configurado |
| `maxRetries` | Reintentos configurados |

### Criterios de estado

| Condición | `status` global | Acción |
|---|---|---|
| DB conectada + AI configurada | `ok` | Operación normal |
| DB conectada + AI no configurada | `degraded` | Inventario OK, recetas no disponibles |
| DB sin conexión | `degraded` | Reiniciar o verificar archivo `.db` |

---

## 4. Checklist diario de operación

Ejecutar en orden cada día (o antes de cocinar).

### Paso 1 — Revisar inventario completo

```
GET /inventory
```

**Verificar:**
- [ ] La lista devuelve ingredientes (no está vacía sin razón)
- [ ] Las cantidades son razonables (nadie registró 999999 g de sal)
- [ ] No hay duplicados (mismo nombre, distinto ID)

### Paso 2 — Identificar críticos por vencer

```
GET /inventory → filtrar visualmente por expirationDate ≤ hoy+2
```

**Verificar:**
- [ ] Hay ingredientes con vencimiento en ≤48h
- [ ] Anotar nombres para el paso 3

**Si hay críticos:** continuar al paso 3.
**Si no hay críticos:** se puede saltear al paso 3 con cualquier ingrediente.

### Paso 3 — Generar sugerencias de recetas

```
POST /ai/recipes
{
  "cuisineType": "<preferencia>",
  "restrictions": "<restricciones>",
  "servings": <comensales>
}
```

**Verificar:**
- [ ] Status 200 con `recipes` no vacío
- [ ] Al menos una receta usa ingredientes por vencer (`uses_expiring` no vacío)
- [ ] Ningún ingrediente en las recetas está fuera del inventario + básicos
- [ ] `meta.traceId` está presente (para referencia en caso de soporte)

### Paso 4 — Ajustar inventario post-decisión

```
PATCH /inventory/:id → quantity: <nueva_cantidad>
```

Por cada ingrediente usado en la receta elegida:
- [ ] Descontar la cantidad usada del inventario
- [ ] Si la cantidad llega a 0, eliminar el ingrediente (`DELETE /inventory/:id`)
- [ ] Si se agotó un básico, agregarlo al inventario como recordatorio de compra

### Paso 5 — Registrar novedades de compra

```
POST /inventory → agregar ingredientes nuevos
```

- [ ] Cargar ingredientes comprados con cantidad, unidad, categoría y fecha de vencimiento
- [ ] Verificar que no hay duplicados (el endpoint rechaza nombres repetidos)

### Resumen del checklist

| # | Acción | Endpoint | Frecuencia |
|---|---|---|---|
| 1 | Revisar inventario | `GET /inventory` | Diario |
| 2 | Identificar críticos | `GET /inventory` (filtro visual) | Diario |
| 3 | Generar sugerencias | `POST /ai/recipes` | Diario / antes de cocinar |
| 4 | Descontar usados | `PATCH /inventory/:id` | Post-cocción |
| 5 | Cargar compras | `POST /inventory` | Post-compra |

---

## 5. Respuesta ante incidentes

| Síntoma | Diagnóstico | Acción |
|---|---|---|
| `GET /health` devuelve `db: error` | Archivo `.db` corrupto o bloqueado | Detener servidor, verificar permisos, reiniciar |
| `POST /ai/recipes` devuelve 503 | API key no configurada | Verificar `GROQ_API_KEY` en `.env` |
| `POST /ai/recipes` devuelve 502 con traceId | Modelo no responde o devuelve JSON inválido | Revisar logs con el traceId, verificar estado del servicio en status.groq.com |
| `POST /ai/recipes` devuelve 429 | Rate limit de Groq | Esperar y reintentar — el free tier tiene límites por minuto/día, ver console.groq.com |
| `POST /inventory` devuelve 400 "must be unique" | Ingrediente ya existe | Usar `PATCH` para actualizar cantidad |
| Swagger no carga en `/api/docs` | Servidor no arrancó o puerto ocupado | Verificar consola, chequear `PORT` en `.env` |
