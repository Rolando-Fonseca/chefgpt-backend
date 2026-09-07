import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, QueryFailedError } from 'typeorm';
import { Ingredient } from './ingredient.entity';
import { CreateIngredientDto } from './dto/create-ingredient.dto';
import { UpdateIngredientDto } from './dto/update-ingredient.dto';

@Injectable()
export class InventoryService {
  constructor(
    @InjectRepository(Ingredient)
    private readonly repo: Repository<Ingredient>,
  ) {}

  async create(dto: CreateIngredientDto): Promise<Ingredient> {
    const ingredient = this.repo.create(dto);
    try {
      return await this.repo.save(ingredient);
    } catch (error) {
      if (error instanceof QueryFailedError && this.isUniqueViolation(error)) {
        throw new BadRequestException('Ingredient name must be unique');
      }
      throw error;
    }
  }

  async findAll(): Promise<Ingredient[]> {
    return this.repo.find({ order: { createdAt: 'DESC' } });
  }

  async findOne(id: string): Promise<Ingredient> {
    const ingredient = await this.repo.findOneBy({ id });
    if (!ingredient) {
      throw new NotFoundException('Ingredient not found');
    }
    return ingredient;
  }

  async update(id: string, dto: UpdateIngredientDto): Promise<Ingredient> {
    const ingredient = await this.findOne(id);
    Object.assign(ingredient, dto);
    try {
      return await this.repo.save(ingredient);
    } catch (error) {
      if (error instanceof QueryFailedError && this.isUniqueViolation(error)) {
        throw new BadRequestException('Ingredient name must be unique');
      }
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    const ingredient = await this.findOne(id);
    await this.repo.remove(ingredient);
  }

  private isUniqueViolation(error: QueryFailedError): boolean {
    const msg = (error.driverError as Error)?.message ?? '';
    return msg.includes('UNIQUE constraint failed') || msg.includes('duplicate key');
  }
}
