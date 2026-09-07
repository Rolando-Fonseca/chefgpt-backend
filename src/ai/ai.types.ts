export interface AiRecipeIngredient {
  name: string;
  quantity: number;
  unit: string;
}

export interface AiRecipe {
  name: string;
  servings: number;
  prep_minutes: number;
  cook_minutes: number;
  ingredients: AiRecipeIngredient[];
  steps: string[];
  uses_expiring: string[];
}

export interface AiRecipesResponse {
  recipes: AiRecipe[];
  error?: string;
}

export interface GenerateRecipesResponse {
  recipes: AiRecipe[];
  meta: {
    traceId: string;
    model: string;
    tokens: { prompt: number; completion: number };
    latencyMs: number;
  };
}

export interface AiTrace {
  traceId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  status: 'success' | 'timeout' | 'error';
  retryCount: number;
  errorCode?: string;
}

export interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenRouterUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface OpenRouterResponse {
  choices: { message: { content: string } }[];
  usage: OpenRouterUsage;
}
