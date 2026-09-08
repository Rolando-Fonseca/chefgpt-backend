# ChefGPT Backend

API en NestJS que sugiere recetas a partir del inventario real de tu cocina, priorizando
lo que está por vencer. El inventario vive en Postgres (Neon); las recetas las genera un
LLM (Groq) a partir de una lista cerrada de ingredientes — nunca inventa lo que no tienes.

**Demo en vivo:** https://chefgpt-backend-fmvt.onrender.com
**Swagger:** https://chefgpt-backend-fmvt.onrender.com/api/docs

## Stack

| Capa | Tecnología |
|---|---|
| Framework | [NestJS](https://nestjs.com/) 11 + TypeScript |
| Base de datos | PostgreSQL vía [Neon](https://neon.tech) (serverless, free tier) + TypeORM |
| IA | [Groq](https://groq.com) (`qwen/qwen3.8-27b`), API compatible con OpenAI Chat Completions |
| Docs de API | Swagger / OpenAPI (`@nestjs/swagger`) |
| Hosting | [Render](https://render.com) (free tier) |

## Funcionalidad

- **Inventario** (`/inventory`) — CRUD completo de ingredientes: nombre, cantidad, unidad,
  categoría y fecha de vencimiento.
- **Recetas con IA** (`/ai/recipes`) — genera hasta 3 recetas usando *solo* los ingredientes
  del inventario + una lista fija de básicos (sal, pimienta, aceite, agua). Prioriza los
  ingredientes que vencen en menos de 48h. Si el modelo devuelve JSON malformado o inventa
  un ingrediente fuera de la lista, se reintenta automáticamente antes de fallar.
- **Health checks** (`/health`, `/health/ai`) — estado de la conexión a la base de datos y
  de la configuración de IA, sin hacer una llamada real al modelo.

## Levantarlo en local

Requiere Node.js 20+.

```bash
npm install
cp .env.example .env
```

Completa `.env` con:
- `DATABASE_URL` — connection string de un proyecto de [Neon](https://neon.tech) (free tier, sin tarjeta)
- `GROQ_API_KEY` — API key de [console.groq.com/keys](https://console.groq.com/keys) (free tier)

```bash
npm run start:dev
```

Abre `http://localhost:3000` — redirige a Swagger (`/api/docs`).

## Tests

```bash
npm test          # unitarios — mockean fetch/DB, no requieren red
npm run test:e2e  # end-to-end — requieren un DATABASE_URL real (Neon)
```

31 tests: el más relevante es la suite de `AiService`, que verifica el pipeline de
recuperación de JSON (extracción, validación de esquema, reintento con prompt corregido)
sin llamar a Groq de verdad.

## Deploy

Guía completa paso a paso en [`docs/p13/runbook.md`](docs/p13/runbook.md) — incluye el
`render.yaml` del repo para desplegar en Render con un clic (Blueprint), más troubleshooting
para los errores más comunes (build, conexión a Neon, rate limits de Groq).

## Documentación técnica

| Doc | Contenido |
|---|---|
| [`docs/p13/ai-groq.md`](docs/p13/ai-groq.md) | Diseño de la llamada a Groq, trazabilidad, estrategia de reintento |
| [`docs/p13/ai-prompt-design.md`](docs/p13/ai-prompt-design.md) | Cómo se construye el prompt dinámico y el esquema JSON exacto |
| [`docs/p13/admin-ops.md`](docs/p13/admin-ops.md) | Cómo operar la API solo con Swagger, sin frontend |
| [`docs/p13/runbook.md`](docs/p13/runbook.md) | Deploy, verificación post-deploy, troubleshooting, rollback |

## Licencia

Proyecto de curso — uso educativo.
