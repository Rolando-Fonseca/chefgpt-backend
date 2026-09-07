import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { InventoryService } from './inventory.service';
import { CreateIngredientDto } from './dto/create-ingredient.dto';
import { UpdateIngredientDto } from './dto/update-ingredient.dto';
import { Ingredient } from './ingredient.entity';

@ApiTags('Inventory')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly service: InventoryService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new ingredient' })
  create(@Body() dto: CreateIngredientDto): Promise<Ingredient> {
    return this.service.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List all ingredients' })
  findAll(): Promise<Ingredient[]> {
    return this.service.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get ingredient by ID' })
  findOne(@Param('id') id: string): Promise<Ingredient> {
    return this.service.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an ingredient partially' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateIngredientDto,
  ): Promise<Ingredient> {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an ingredient' })
  remove(@Param('id') id: string): Promise<void> {
    return this.service.remove(id);
  }
}
