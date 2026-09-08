# P13 — Integración Groq

Arquitectura de la llamada LLM para generar recetas desde el inventario de ChefGPT.

> **Nota de migración:** este proyecto usaba originalmente OpenRouter + Claude Haiku.
> Se migró a Groq por su tier gratuito (OpenRouter requiere créditos pagos sin free
> tier real). La API de Groq es compatible con el formato de OpenAI Chat Completions,
> así que el diseño de la llamada, el pipeline de reintentos y la trazabilidad no
> cambiaron — solo el endpoint, la API key y el modelo.

---

## 1. Variables de entorno

| Variable | Requerida | Descripción |
|---|---|---|
| `GROQ_API_KEY` | Sí | Clave de API de Groq (`gsk_…`), gratis en [console.groq.com](https://console.groq.com/keys) |
| `GROQ_MODEL` | Sí | ID del modelo, ej. `llama-3.3-70b-versatile` |
| `AI_TIMEOUT_MS` | No | Timeout por llamada (default `15000`) |

### Reglas

- `GROQ_API_KEY` **nunca** se loguea, se envía al frontend ni se incluye en respuestas de error.
- Si la key falta al arrancar, el módulo AI se registra pero lanza error al invocar, no impide boot (patrón fail-open para salud del servidor).
- `GROQ_MODEL` se valida contra los modelos disponibles en la cuenta de Groq — ver [console.groq.com/docs/models](https://console.groq.com/docs/models) para la lista vigente (cambia con el tiempo, algunos modelos se deprecan).

---

## 2. Diseño de la llamada

### Endpoint

```
POST https://api.groq.com/openai/v1/chat/completions
```

### Headers

| Header | Valor | Nota |
|---|---|---|
| `Authorization` | `Bearer <GROQ_API_KEY>` | — |
| `Content-Type` | `application/json` | — |

Groq no usa headers de ranking/dashboard como `HTTP-Referer` o `X-Title` (eso era específico de OpenRouter).

### Body — parámetros controlables

| Parámetro | Valor recomendado | Criterio |
|---|---|---|
| `model` | desde env `GROQ_MODEL` | Permite cambiar de modelo sin deploy |
| `messages` | system + user (ver abajo) | — |
| `temperature` | `0.7` | Balance creatividad/coherencia. Subir a 0.9 para explorar, bajar a 0.3 para determinismo |
| `max_tokens` | `1024` | Suficiente para 1-2 recetas con pasos. Ajustar si se generan menús semanales |
| `top_p` | `0.9` | Nucleus sampling. No combinar cambios simultáneos con temperature |
| `response_format` | `{ "type": "json_object" }` | Fuerza JSON siempre que el prompt lo pida explícitamente. Soportado por los modelos Llama 3.x de Groq |
| `stop` | No usar | Sin secuencias de parada; confiar en `response_format` |

### Política de timeout

- `AI_TIMEOUT_MS` (default 15 000 ms) se aplica como `AbortController.signal` sobre el fetch.
- Si el timeout se alcanza, se devuelve `504 Gateway Timeout` al cliente con mensaje genérico, sin exponer detalles del proveedor.

### Rate limits del free tier

Groq tiene límites por minuto y por día en la cuenta gratuita (varían por modelo — ver el dashboard en
[console.groq.com](https://console.groq.com/)). Si `POST /ai/recipes` devuelve 429 seguido, es el rate
limit, no un bug — esperar o espaciar las llamadas de la demo.

---

## 3. Trazabilidad sin exponer secretos

### Principio

Cada llamada LLM genera un **trace ID** interno (`uuid v4`). Toda referencia en logs y respuestas usa ese ID, nunca la API key.

### Qué se registra por llamada

| Campo | Ejemplo | Nota |
|---|---|---|
| `traceId` | `a1b2c3d4-…` | UUID generado por request |
| `model` | `llama-3.3-70b-versatile` | Modelo efectivo usado |
| `promptTokens` | `312` | Del campo `usage.prompt_tokens` de la respuesta |
| `completionTokens` | `487` | Del campo `usage.completion_tokens` |
| `latencyMs` | `2340` | Delta entre envío y recepción |
| `status` | `success` \| `timeout` \| `error` | — |
| `retryCount` | `1` | Veces que se reintentó antes de éxito o fallo final |
| `errorCode` | `rate_limit` \| `json_parse` \| `network` | Solo en error, sin cuerpo de respuesta |

### Qué NO se registra

- API key (ni parcial: no `gsk_…***`).
- Cuerpo completo del prompt (puede contener datos de usuario sensibles).
- Respuesta cruda del modelo (se loguea solo si falla parseo, truncada a 500 chars).
- Headers de respuesta del proveedor.

### Almacenamiento

- En development: `console.log` estructurado (JSON lines).
- En production: delegar al logger de NestJS (`Logger`) con contexto `AiService`.
- Opcionalmente persistir en tabla `ai_logs` (id, traceId, model, tokens, latencyMs, status, createdAt) para dashboards de costo.

### Correlación con el cliente

- El `traceId` se devuelve en la respuesta HTTP como `meta.traceId`.
- El frontend puede mostrarlo al usuario para soporte, sin comprometer secretos.

---

## 4. Estrategia de reintento ante JSON no estricto

### Problema

El modelo puede:
- Devolver texto antes/después del JSON (ej. "¡Claro! Aquí tienes:\n```json\n…\n```").
- Devolver JSON válido pero que no matchea el schema esperado.
- Devolver un objeto de error del proveedor en vez de la respuesta esperada.

### Pipeline de recuperación (3 capas)

```
Respuesta cruda
  │
  ├─ Capa 1: Extractor de JSON
  │    Intentar parsear directamente.
  │    Si falla, buscar primer '{' y último '}' y extraer substring.
  │    Si falla, buscar bloque ```json ... ``` y extraer contenido.
  │
  ├─ Capa 2: Validación de schema
  │    Parsear el JSON extraído contra el schema esperado
  │    (validar que `recipes` existe y es array, que cada receta tiene
  │     name, ingredients, steps).
  │    Si es válido → éxito.
  │
  └─ Capa 3: Reintento con prompt corregido
       Si Capa 1 o 2 fallan:
       - Reintentar hasta N_RETRIES veces (default 2).
       - En cada reintento, anteponer al user message:
         "Tu respuesta anterior no fue JSON válido. Responde SOLO con JSON,
          sin texto adicional ni bloques de código."
       - Incrementar `retryCount` en el trace.
       - Si agota reintentos → devolver 502 con traceId.
```

### Reglas del reintento

| Regla | Valor |
|---|---|
| Máximo de reintentos | 2 (total 3 intentos) |
| Backoff entre reintentos | Fijo 1 segundo (no exponencial — el problema es de formato, no de carga) |
| No reintentar si | Status HTTP 401/403 (key inválida), 429 rate-limit (dejar que el cliente decida) |
| Reintentar si | 200 con JSON inválido, 500/502/503 del proveedor (error transitorio) |

### Flujo de decisión completo

```
Llamada LLM
  │
  ├─ Timeout → 504 + traceId (no reintentar)
  │
  ├─ HTTP 401/403 → 500 + traceId (key mal configurada, no reintentar)
  │
  ├─ HTTP 429 → 429 + traceId + header Retry-After (no reintentar automáticamente)
  │
  ├─ HTTP 5xx → reintentar hasta N_RETRIES con backoff
  │
  └─ HTTP 200
       ├─ Capa 1 (extract) → falla → Capa 3 (reintento)
       ├─ Capa 2 (validate) → falla → Capa 3 (reintento)
       └─ Capa 2 ok → respuesta al cliente
```

---

## 5. Configuración resumida para `.env`

```env
# AI — Groq
GROQ_API_KEY=gsk_xxxxxxxxxxxxx
GROQ_MODEL=llama-3.3-70b-versatile
AI_TIMEOUT_MS=15000
AI_MAX_RETRIES=2
AI_TEMPERATURE=0.7
AI_MAX_TOKENS=1024
```

---

## 6. Dependencias adicionales

No se necesita SDK propietario. Groq es compatible con la API de OpenAI, por lo que basta con `fetch` nativo (Node 18+). No agregar `openai` ni `groq-sdk` como dependencia para evitar sobrecarga.
