import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { QueryFailedError, Repository } from 'typeorm';
import { InventoryService } from './inventory.service';
import { Ingredient, IngredientCategory, IngredientUnit } from './ingredient.entity';

type MockRepo = Partial<Record<keyof Repository<Ingredient>, jest.Mock>>;

const makeIngredient = (overrides: Partial<Ingredient> = {}): Ingredient =>
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

describe('InventoryService', () => {
  let service: InventoryService;
  let repo: MockRepo;

  beforeEach(async () => {
    repo = {
      create: jest.fn((dto) => dto),
      save: jest.fn(),
      find: jest.fn(),
      findOneBy: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: getRepositoryToken(Ingredient), useValue: repo },
      ],
    }).compile();

    service = module.get(InventoryService);
  });

  describe('create', () => {
    it('saves a new ingredient', async () => {
      const saved = makeIngredient();
      (repo.save as jest.Mock).mockResolvedValue(saved);

      const result = await service.create({ name: 'Pollo', quantity: 500 } as any);

      expect(repo.create).toHaveBeenCalledWith({ name: 'Pollo', quantity: 500 });
      expect(result).toBe(saved);
    });

    it('translates a unique-constraint violation into BadRequestException', async () => {
      const sqliteError = new QueryFailedError('insert', [], {
        message: 'UNIQUE constraint failed: ingredients.name',
      } as any);
      (repo.save as jest.Mock).mockRejectedValue(sqliteError);

      await expect(
        service.create({ name: 'Pollo', quantity: 500 } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('also recognizes Postgres unique-violation wording', async () => {
      const pgError = new QueryFailedError('insert', [], {
        message: 'duplicate key value violates unique constraint "UQ_name"',
      } as any);
      (repo.save as jest.Mock).mockRejectedValue(pgError);

      await expect(
        service.create({ name: 'Pollo', quantity: 500 } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rethrows unrelated database errors', async () => {
      const otherError = new QueryFailedError('insert', [], {
        message: 'connection terminated',
      } as any);
      (repo.save as jest.Mock).mockRejectedValue(otherError);

      await expect(
        service.create({ name: 'Pollo', quantity: 500 } as any),
      ).rejects.toBe(otherError);
    });
  });

  describe('findOne', () => {
    it('returns the ingredient when it exists', async () => {
      const ingredient = makeIngredient();
      (repo.findOneBy as jest.Mock).mockResolvedValue(ingredient);

      await expect(service.findOne('1')).resolves.toBe(ingredient);
    });

    it('throws NotFoundException when it does not exist', async () => {
      (repo.findOneBy as jest.Mock).mockResolvedValue(null);

      await expect(service.findOne('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    it('merges the dto onto the existing ingredient and saves it', async () => {
      const existing = makeIngredient({ quantity: 500 });
      (repo.findOneBy as jest.Mock).mockResolvedValue(existing);
      (repo.save as jest.Mock).mockImplementation((i) => Promise.resolve(i));

      const result = await service.update('1', { quantity: 250 } as any);

      expect(result.quantity).toBe(250);
    });
  });

  describe('remove', () => {
    it('removes an existing ingredient', async () => {
      const existing = makeIngredient();
      (repo.findOneBy as jest.Mock).mockResolvedValue(existing);

      await service.remove('1');

      expect(repo.remove).toHaveBeenCalledWith(existing);
    });

    it('propagates NotFoundException for a missing ingredient', async () => {
      (repo.findOneBy as jest.Mock).mockResolvedValue(null);

      await expect(service.remove('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
