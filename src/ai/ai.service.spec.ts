import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import { AiService } from './ai.service';
import { InventoryService } from '../inventory/inventory.service';
import { Ingredient, IngredientCategory, IngredientUnit } from '../inventory/ingredient.entity';

const makeIngredient = (overrides: Partial<Ingredient>): Ingredient =>
  ({
    id: '1',
    quantity: 500,
    unit: IngredientUnit.G,
    category: IngredientCategory.PROTEIN,
    expirationDate: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as Ingredient;

const validRecipesPayload = JSON.stringify({
  recipes: [
    {
      name: 'Pollo al horno',
      servings: 2,
      prep_minutes: 10,
      cook_minutes: 30,
      ingredients: [{ name: 'Pollo', quantity: 500, unit: 'g' }],
      steps: ['Hornear el pollo.'],
      uses_expiring: [],
    },
  ],
});

const groqResponse = (content: string) => ({
  ok: true,
  status: 200,
  json: async () => ({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  }),
});

describe('AiService', () => {
  let service: AiService;
  let inventoryService: { findAll: jest.Mock };
  let envValues: Record<string, string>;
  let originalFetch: typeof global.fetch;

  const setup = async (env: Record<string, string> = {}) => {
    envValues = {
      GROQ_API_KEY: 'gsk_test',
      GROQ_MODEL: 'qwen/qwen3.8-27b',
      AI_TIMEOUT_MS: '15000',
      AI_MAX_RETRIES: '2',
      AI_TEMPERATURE: '0.7',
      AI_MAX_TOKENS: '1024',
      ...env,
    };
    inventoryService = {
      findAll: jest.fn().mockResolvedValue([makeIngredient({ name: 'Pollo' })]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key: string, fb?: string) => envValues[key] ?? fb) },
        },
        { provide: InventoryService, useValue: inventoryService },
      ],
    }).compile();

    service = module.get(AiService);
    // Skip the real 1s backoff between retries — tested behavior is which
    // path runs, not real wall-clock delay.
    jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
  };

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('throws ServiceUnavailableException immediately when GROQ_API_KEY is missing', async () => {
    await setup({ GROQ_API_KEY: '' });

    await expect(
      service.generateRecipes({ servings: 2 } as any),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns schema-valid recipes on the first successful call', async () => {
    await setup();
    (global.fetch as jest.Mock).mockResolvedValueOnce(groqResponse(validRecipesPayload));

    const result = await service.generateRecipes({ servings: 2 } as any);

    expect(result.recipes).toHaveLength(1);
    expect(result.recipes[0].name).toBe('Pollo al horno');
    expect(result.meta.model).toBe('qwen/qwen3.8-27b');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('sends max_tokens and temperature as real numbers, not strings from .env', async () => {
    await setup();
    (global.fetch as jest.Mock).mockResolvedValueOnce(groqResponse(validRecipesPayload));

    await service.generateRecipes({ servings: 2 } as any);

    const [, requestInit] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(requestInit.body);
    expect(body.max_tokens).toBe(1024);
    expect(body.temperature).toBe(0.7);
    expect(typeof body.max_tokens).toBe('number');
    expect(typeof body.temperature).toBe('number');
  });

  it('recovers when the first response is not valid JSON and the retry succeeds', async () => {
    await setup();
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(groqResponse('¡Claro! Aquí tienes tu receta (sin JSON).'))
      .mockResolvedValueOnce(groqResponse(validRecipesPayload));

    const result = await service.generateRecipes({ servings: 2 } as any);

    expect(result.recipes).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('extracts JSON wrapped in a ```json code fence', async () => {
    await setup();
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      groqResponse('```json\n' + validRecipesPayload + '\n```'),
    );

    const result = await service.generateRecipes({ servings: 2 } as any);

    expect(result.recipes).toHaveLength(1);
  });

  it('throws BadGatewayException after exhausting retries on repeated invalid JSON', async () => {
    await setup({ AI_MAX_RETRIES: '1' });
    (global.fetch as jest.Mock).mockResolvedValue(groqResponse('not json at all'));

    await expect(
      service.generateRecipes({ servings: 2 } as any),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(global.fetch).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it('rejects a recipe that uses an ingredient outside the inventory, then retries', async () => {
    await setup();
    const invalidIngredient = JSON.stringify({
      recipes: [
        {
          name: 'Receta imposible',
          servings: 2,
          prep_minutes: 5,
          cook_minutes: 5,
          ingredients: [{ name: 'Langosta', quantity: 1, unit: 'unit' }],
          steps: ['Cocinar langosta.'],
          uses_expiring: [],
        },
      ],
    });
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(groqResponse(invalidIngredient))
      .mockResolvedValueOnce(groqResponse(validRecipesPayload));

    const result = await service.generateRecipes({ servings: 2 } as any);

    expect(result.recipes[0].name).toBe('Pollo al horno');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry on a 401 from the provider — fails fast', async () => {
    await setup();
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 401 });

    await expect(
      service.generateRecipes({ servings: 2 } as any),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('propagates the model\'s own {"error": ...} payload without retrying', async () => {
    await setup();
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      groqResponse(JSON.stringify({ error: 'Insufficient ingredients' })),
    );

    await expect(
      service.generateRecipes({ servings: 2 } as any),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
