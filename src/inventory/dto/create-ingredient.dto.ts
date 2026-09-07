import {
  IsString,
  IsNumber,
  IsEnum,
  IsOptional,
  IsDateString,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IngredientUnit, IngredientCategory } from '../ingredient.entity';

export class CreateIngredientDto {
  @ApiProperty({ example: 'Chicken breast' })
  @IsString()
  name: string;

  @ApiProperty({ example: 500 })
  @IsNumber()
  @Min(0)
  quantity: number;

  @ApiProperty({ enum: IngredientUnit, example: IngredientUnit.G })
  @IsEnum(IngredientUnit)
  unit: IngredientUnit;

  @ApiProperty({ enum: IngredientCategory, example: IngredientCategory.PROTEIN })
  @IsEnum(IngredientCategory)
  category: IngredientCategory;

  @ApiPropertyOptional({ example: '2026-05-20' })
  @IsOptional()
  @IsDateString()
  expirationDate?: string;
}
