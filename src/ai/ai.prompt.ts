import { Ingredient } from '../inventory/ingredient.entity';
import { GenerateRecipesDto } from './dto/generate-recipes.dto';
import { OpenRouterMessage } from './ai.types';

export const EXPIRY_WINDOW_HOURS = 48;
export const MAX_RECIPES = 3;
export const DEFAULT_CUISINE = 'Cualquiera';
export const DEFAULT_RESTRICTIONS = 'Ninguna';
export const DEFAULT_SERVINGS = 2;
export const DEFAULT_BASICS = ['sal', 'pimienta', 'aceite de oliva', 'agua'];

const SYSTEM_PROMPT = `Eres un chef profesional que genera recetas en formato JSON.

REGLAS INVARIABLES:
1. SOLO puedes usar ingredientes de la lista "disponibles" y la lista "básicos".
2. Si un ingrediente no está en ninguna de las dos listas, NO lo incluyas. Sin excepciones.
3. NO inventes, infieras ni asumas ingredientes que no aparecen explícitamente.
4. No uses sal, pimienta ni aceite a menos que estén en la lista "básicos".
5. Prioriza los ingredientes marcados como "POR_VENCER" — úsalos en al menos una receta.
6. Indica la cantidad exacta de cada ingrediente según lo disponible. Nunca pidas más de lo que hay.
7. Respeta el tipo de cocina y las restricciones alimentarias del usuario.
8. Responde EXCLUSIVAMENTE con un objeto JSON válido. Sin texto antes, sin texto después, sin bloques de código markdown, sin explicaciones.
9. Si no puedes generar recetas con los ingredientes dados, devuelve: {"error": "Insufficient ingredients"}`;

interface IngredientForPrompt {
  name: string;
  quantity: number;
  unit: string;
  expirationDate: string | null;
}

export function buildMessages(
  ingredients: Ingredient[],
  dto: GenerateRecipesDto,
  basics: string[] = DEFAULT_BASICS,
): OpenRouterMessage[] {
  const now = new Date();
  const threshold = new Date(now.getTime() + EXPIRY_WINDOW_HOURS * 60 * 60 * 1000);

  const mapped: IngredientForPrompt[] = ingredients.map((i) => ({
    name: i.name,
    quantity: i.quantity,
    unit: i.unit,
    expirationDate: i.expirationDate,
  }));

  const expiring = mapped.filter(
    (i) => i.expirationDate && new Date(i.expirationDate) <= threshold,
  );
  const stable = mapped.filter(
    (i) => !i.expirationDate || new Date(i.expirationDate) > threshold,
  );

  const cuisineType = dto.cuisineType || DEFAULT_CUISINE;
  const restrictions = dto.restrictions || DEFAULT_RESTRICTIONS;
  const servings = dto.servings || DEFAULT_SERVINGS;

  const expiringLines = expiring
    .map((i) => `- ${i.name} (${i.quantity} ${i.unit}) [POR_VENCER — vence ${i.expirationDate}]`)
    .join('\n');

  const stableLines = stable
    .map((i) => `- ${i.name} (${i.quantity} ${i.unit})`)
    .join('\n');

  const basicsLines = basics.map((b) => `- ${b}`).join('\n');

  const userPrompt = `Tipo de cocina: ${cuisineType}
Restricciones: ${restrictions}
Comensales: ${servings}

INGREDIENTES DISPONIBLES:
${expiringLines}
${stableLines}

BÁSICOS PERMITIDOS:
${basicsLines}

Devuelve un JSON con el esquema especificado. Sin texto adicional.`;

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];
}

export const RETRY_CORRECTION_PROMPT =
  'Tu respuesta anterior no fue JSON válido. Responde SOLO con JSON, sin texto adicional ni bloques de código.';
