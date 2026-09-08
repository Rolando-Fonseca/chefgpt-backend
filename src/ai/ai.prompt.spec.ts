import { buildMessages, DEFAULT_BASICS } from './ai.prompt';
import { Ingredient, IngredientCategory, IngredientUnit } from '../inventory/ingredient.entity';

const makeIngredient = (overrides: Partial<Ingredient>): Ingredient =>
  ({
    id: '1',
    name: 'Pollo',
    quantity: 500,
    unit: IngredientUnit.G,
    category: IngredientCategory.PROTEIN,
    expirationDate: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as Ingredient;

describe('buildMessages', () => {
  it('produces a system + user message pair', () => {
    const messages = buildMessages([], { cuisineType: 'Italiana', servings: 2 } as any);

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('embeds the exact JSON schema field names in the system prompt', () => {
    const [system] = buildMessages([], {} as any);

    // Regression guard: the system prompt must literally name these fields —
    // relying on the model to infer an undocumented schema is what caused
    // Qwen to invent its own (see docs/p13/ai-prompt-design.md migration note).
    for (const field of ['recipes', 'prep_minutes', 'cook_minutes', 'uses_expiring']) {
      expect(system.content).toContain(field);
    }
  });

  it('classifies an ingredient expiring within 48h as expiring, not stable', () => {
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const far = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const ingredients = [
      makeIngredient({ name: 'Pollo', expirationDate: soon }),
      makeIngredient({ name: 'Arroz', expirationDate: far }),
    ];

    const [, user] = buildMessages(ingredients, {} as any);

    expect(user.content).toMatch(/Pollo.*POR_VENCER/);
    expect(user.content).not.toMatch(/Arroz.*POR_VENCER/);
  });

  it('falls back to the default cuisine/restrictions/servings when omitted', () => {
    const [, user] = buildMessages([], {} as any);

    expect(user.content).toContain('Tipo de cocina: Cualquiera');
    expect(user.content).toContain('Restricciones: Ninguna');
    expect(user.content).toContain('Comensales: 2');
  });

  it('lists the configured basics, falling back to DEFAULT_BASICS', () => {
    const [, user] = buildMessages([], {} as any, ['miel', 'canela']);

    expect(user.content).toContain('- miel');
    expect(user.content).toContain('- canela');
    expect(user.content).not.toContain(`- ${DEFAULT_BASICS[0]}`);
  });
});
