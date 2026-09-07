# P13 — Diseño del Prompt Dinámico para ChefGPT

Context Engineering: cómo se construye el prompt que recibe Haiku para generar recetas desde el inventario.

---

## 1. Estructura del prompt

El prompt se compone de dos mensajes: **system** (fijo) y **user** (dinámico).

### System prompt — rol y restricciones

```
Eres un chef profesional que genera recetas en formato JSON.

REGLAS INVARIABLES:
1. SOLO puedes usar ingredientes de la lista "disponibles" y la lista "básicos".
2. Si un ingrediente no está en ninguna de las dos listas, NO lo incluyas. Sin excepciones.
3. NO inventes, infieras ni asumas ingredientes que no aparecen explícitamente.
4. No uses sal, pimienta ni aceite a menos que estén en la lista "básicos".
5. Prioriza los ingredientes marcados como "por_vencer" — úsalos en al menos una receta.
6. Indica la cantidad exacta de cada ingrediente según lo disponible. Nunca pidas más de lo que hay.
7. Respeta el tipo de cocina y las restricciones alimentarias del usuario.
8. Responde EXCLUSIVAMENTE con un objeto JSON válido. Sin texto antes, sin texto después, sin bloques de código markdown, sin explicaciones.
9. Si no puedes generar recetas con los ingredientes dados, devuelve: {"error": "Insufficient ingredients"}
```

### User prompt — plantilla con variables

```
Tipo de cocina: {{cuisine_type}}
Restricciones: {{restrictions}}
Comensales: {{servings}}

INGREDIENTES DISPONIBLES:
{{#each expiring}}
- {{name}} ({{quantity}} {{unit}}) [POR_VENCER — vence {{expiration_date}}]
{{/each}}
{{#each stable}}
- {{name}} ({{quantity}} {{unit}})
{{/each}}

BÁSICOS PERMITIDOS:
{{#each basics}}
- {{name}}
{{/each}}

Devuelve un JSON con el esquema especificado. Sin texto adicional.
```

---

## 2. Variables del template

| Variable | Tipo | Origen | Ejemplo |
|---|---|---|---|
| `cuisine_type` | `string` | Request del usuario | `"Mediterránea"` |
| `restrictions` | `string[]` joined | Request del usuario | `"sin gluten, sin lactosa"` |
| `servings` | `number` | Request del usuario | `4` |
| `expiring[]` | `{ name, quantity, unit, expiration_date }` | Query al inventario (ingredientes que vencen en ≤48h) | Ver abajo |
| `stable[]` | `{ name, quantity, unit }` | Query al inventario (resto de ingredientes) | Ver abajo |
| `basics[]` | `{ name }` | Constante de configuración | `["sal", "pimienta", "aceite de oliva", "agua"]` |

### Cálculo de "por vencer"

Ingredientes donde `expiration_date - now <= 48h`. Se marcan con `[POR_VENCER]` en el prompt para que el modelo los priorice sin necesidad de instrucciones adicionales.

---

## 3. Esquema JSON de respuesta

```jsonc
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["recipes"],
  "additionalProperties": false,
  "properties": {
    "recipes": {
      "type": "array",
      "minItems": 1,
      "maxItems": 3,
      "items": {
        "type": "object",
        "required": ["name", "servings", "prep_minutes", "cook_minutes", "ingredients", "steps", "uses_expiring"],
        "additionalProperties": false,
        "properties": {
          "name":             { "type": "string", "minLength": 2, "maxLength": 80 },
          "servings":         { "type": "integer", "minimum": 1 },
          "prep_minutes":     { "type": "integer", "minimum": 1 },
          "cook_minutes":     { "type": "integer", "minimum": 0 },
          "ingredients": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "object",
              "required": ["name", "quantity", "unit"],
              "additionalProperties": false,
              "properties": {
                "name":     { "type": "string" },
                "quantity":  { "type": "number", "minimum": 0 },
                "unit":      { "type": "string" }
              }
            }
          },
          "steps": {
            "type": "array",
            "minItems": 1,
            "items": { "type": "string", "minLength": 5 }
          },
          "uses_expiring": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Nombres de ingredientes por vencer usados en esta receta"
          }
        }
      }
    },
    "error": {
      "type": "string",
      "description": "Solo presente si no se pueden generar recetas"
    }
  }
}
```

### Reglas de validación post-parseo

| Regla | Check |
|---|---|
| Todo ingrediente en `ingredients[].name` debe existir en la unión de `disponibles` + `básicos` | `ingredients[].name ∈ available_names ∪ basics_names` |
| `quantity` en cada ingrediente ≤ cantidad disponible en inventario | Comparar contra el valor del inventario |
| Al menos una receta debe tener `uses_expiring` no vacío (si hay ingredientes por vencer) | `recipes.some(r => r.uses_expiring.length > 0)` cuando `expiring.length > 0` |
| No debe existir la key `error` junto con `recipes` | Mutuamente excluyentes |

Si alguna regla falla, se descarta la respuesta y se ejecuta la capa 3 de reintento (ver `ai-openrouter.md`).

---

## 4. Ejemplo de respuesta válida

**Contexto de entrada:**

```
Tipo de cocina: Mediterránea
Restricciones: sin frutos secos
Comensales: 4

INGREDIENTES DISPONIBLES:
- Pollo (500 g) [POR_VENCER — vence 2026-05-18]
- Tomates (300 g) [POR_VENCER — vence 2026-05-17]
- Arroz (400 g)
- Limón (2 units)
- Ajo (3 units)

BÁSICOS PERMITIDOS:
- Sal
- Pimienta
- Aceite de oliva
- Agua
```

**Respuesta esperada:**

```json
{
  "recipes": [
    {
      "name": "Pollo al limón con arroz",
      "servings": 4,
      "prep_minutes": 15,
      "cook_minutes": 35,
      "ingredients": [
        { "name": "Pollo", "quantity": 500, "unit": "g" },
        { "name": "Limón", "quantity": 2, "unit": "units" },
        { "name": "Arroz", "quantity": 300, "unit": "g" },
        { "name": "Ajo", "quantity": 2, "unit": "units" },
        { "name": "Aceite de oliva", "quantity": 30, "unit": "ml" },
        { "name": "Sal", "quantity": 5, "unit": "g" },
        { "name": "Pimienta", "quantity": 2, "unit": "g" },
        { "name": "Agua", "quantity": 600, "unit": "ml" }
      ],
      "steps": [
        "Cortar el pollo en trozos y sazonar con sal y pimienta.",
        "Exprimir los limones y reservar el jugo.",
        "Calentar aceite en una sartén y dorar el ajo picado.",
        "Incorporar el pollo y cocinar hasta sellar por todos lados.",
        "Verter el jugo de limón y cocinar a fuego medio 25 minutos.",
        "Hervir el arroz en agua con sal durante 18 minutos.",
        "Servir el pollo con el arroz y bañar con la salsa."
      ],
      "uses_expiring": ["Pollo", "Limón"]
    },
    {
      "name": "Tomates asados con ajo",
      "servings": 4,
      "prep_minutes": 10,
      "cook_minutes": 25,
      "ingredients": [
        { "name": "Tomates", "quantity": 300, "unit": "g" },
        { "name": "Ajo", "quantity": 1, "unit": "units" },
        { "name": "Aceite de oliva", "quantity": 20, "unit": "ml" },
        { "name": "Sal", "quantity": 3, "unit": "g" },
        { "name": "Pimienta", "quantity": 1, "unit": "g" }
      ],
      "steps": [
        "Cortar los tomates por la mitad y colocar en bandeja de horno.",
        "Picar el ajo y esparcir sobre los tomates.",
        "Rociar con aceite de oliva, sal y pimienta.",
        "Hornear a 200 °C durante 25 minutos hasta que estén tiernos.",
        "Servir como guarnición."
      ],
      "uses_expiring": ["Tomates"]
    },
    {
      "name": "Arroz con limón",
      "servings": 4,
      "prep_minutes": 5,
      "cook_minutes": 20,
      "ingredients": [
        { "name": "Arroz", "quantity": 100, "unit": "g" },
        { "name": "Limón", "quantity": 0.5, "unit": "units" },
        { "name": "Aceite de oliva", "quantity": 10, "unit": "ml" },
        { "name": "Sal", "quantity": 2, "unit": "g" },
        { "name": "Agua", "quantity": 200, "unit": "ml" }
      ],
      "steps": [
        "Hervir el arroz en agua con sal y un chorrito de aceite.",
        "Una vez cocido, escurrir y rociar con jugo de limón.",
        "Mezclar suavemente y servir."
      ],
      "uses_expiring": ["Limón"]
    }
  ]
}
```

---

## 5. Constantes de configuración

| Constante | Valor por defecto | Ubicación |
|---|---|---|
| `BASICS` | `["sal", "pimienta", "aceite de oliva", "agua"]` | Configurable via env `AI_BASICS` (comma-separated) |
| `EXPIRY_WINDOW_HOURS` | `48` | Constante en servicio |
| `MAX_RECIPES` | `3` | Constante en servicio |
| `CUISINE_DEFAULT` | `"Cualquiera"` | Si el usuario no especifica |
| `RESTRICTIONS_DEFAULT` | `"Ninguna"` | Si el usuario no especifica |
| `SERVINGS_DEFAULT` | `2` | Si el usuario no especifica |

---

## 6. Antipatrones a evitar

| Antipatrón | Por qué es problema | Mitigación |
|---|---|---|
| Poner "puedes usar ingredientes comunes" | El modelo inventa libremente | Lista explícita de básicos, nada implícito |
| No incluir cantidades en el prompt | El modelo sugiere cantidades arbitrarias | Siempre enviar `quantity` + `unit` por ingrediente |
| Pedir explicaciones en la respuesta | Contamina el JSON | System prompt prohíbe texto fuera del JSON |
| Usar "etc." en la lista de básicos | El modelo expande la lista | Lista cerrada, sin abreviaturas |
| No validar `uses_expiring` | El modelo ignora la prioridad | Regla post-parseo obliga al menos una receta con expiring |
