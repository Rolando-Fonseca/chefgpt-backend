import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum IngredientUnit {
  G = 'g',
  KG = 'kg',
  ML = 'ml',
  L = 'l',
  UNITS = 'units',
}

export enum IngredientCategory {
  PROTEIN = 'protein',
  VEGETABLE = 'vegetable',
  FRUIT = 'fruit',
  GRAIN = 'grain',
  DAIRY = 'dairy',
  SPICE = 'spice',
  OTHER = 'other',
}

@Entity('ingredients')
export class Ingredient {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  name: string;

  @Column({ type: 'float', default: 0 })
  quantity: number;

  @Column({ type: 'simple-enum', enum: IngredientUnit, default: IngredientUnit.UNITS })
  unit: IngredientUnit;

  @Column({ type: 'simple-enum', enum: IngredientCategory, default: IngredientCategory.OTHER })
  category: IngredientCategory;

  @Column({ type: 'date', nullable: true })
  expirationDate: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
