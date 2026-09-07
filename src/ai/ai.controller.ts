import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AiService } from './ai.service';
import { GenerateRecipesDto } from './dto/generate-recipes.dto';
import { GenerateRecipesResponse } from './ai.types';

@ApiTags('AI')
@Controller('ai')
export class AiController {
  constructor(private readonly service: AiService) {}

  @Post('recipes')
  @ApiOperation({ summary: 'Generate recipes from inventory using AI' })
  generateRecipes(
    @Body() dto: GenerateRecipesDto,
  ): Promise<GenerateRecipesResponse> {
    return this.service.generateRecipes(dto);
  }
}
