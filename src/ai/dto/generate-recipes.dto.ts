import { IsOptional, IsString, IsInt, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class GenerateRecipesDto {
  @ApiPropertyOptional({ example: 'Mediterránea' })
  @IsOptional()
  @IsString()
  cuisineType?: string;

  @ApiPropertyOptional({ example: 'sin gluten, sin lactosa' })
  @IsOptional()
  @IsString()
  restrictions?: string;

  @ApiPropertyOptional({ example: 4 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  servings?: number;
}
