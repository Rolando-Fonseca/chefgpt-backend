import {
  Injectable,
  Logger,
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { InventoryService } from '../inventory/inventory.service';
import { Ingredient } from '../inventory/ingredient.entity';
import { GenerateRecipesDto } from './dto/generate-recipes.dto';
import {
  AiRecipe,
  AiRecipesResponse,
  AiTrace,
  GenerateRecipesResponse,
  ChatMessage,
  ChatCompletionResponse,
} from './ai.types';
import {
  buildMessages,
  RETRY_CORRECTION_PROMPT,
  DEFAULT_BASICS,
} from './ai.prompt';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly basics: string[];

  constructor(
    private readonly config: ConfigService,
    private readonly inventoryService: InventoryService,
  ) {
    this.apiKey = config.get<string>('GROQ_API_KEY', '');
    this.model = config.get<string>(
      'GROQ_MODEL',
      'qwen/qwen3.8-27b',
    );
    // ConfigService.get<number>() does NOT cast at runtime — env vars are always
    // strings, and sending e.g. max_tokens:"1024" makes Groq reject the request
    // with 400 ('max_tokens' : value must be an integer). Force real numbers.
    this.timeoutMs = Number(config.get<string>('AI_TIMEOUT_MS', '15000'));
    this.maxRetries = Number(config.get<string>('AI_MAX_RETRIES', '2'));
    this.temperature = Number(config.get<string>('AI_TEMPERATURE', '0.7'));
    this.maxTokens = Number(config.get<string>('AI_MAX_TOKENS', '1024'));

    const basicsStr = config.get<string>(
      'AI_BASICS',
      'sal,pimienta,aceite de oliva,agua',
    );
    this.basics = basicsStr.split(',').map((b) => b.trim());
  }

  async generateRecipes(
    dto: GenerateRecipesDto,
  ): Promise<GenerateRecipesResponse> {
    if (!this.apiKey) {
      throw new ServiceUnavailableException(
        'Groq API key not configured',
      );
    }

    const traceId = randomUUID();
    const startTime = Date.now();
    const ingredients = await this.inventoryService.findAll();
    const messages = buildMessages(ingredients, dto, this.basics);

    const availableNames = new Set([
      ...ingredients.map((i) => i.name.toLowerCase()),
      ...this.basics.map((b) => b.toLowerCase()),
    ]);
    const expiringNames = new Set(
      ingredients
        .filter((i) => i.expirationDate && this.isExpiring(i))
        .map((i) => i.name.toLowerCase()),
    );

    let retryCount = 0;

    while (retryCount <= this.maxRetries) {
      try {
        const result = await this.callGroq(messages, traceId);
        const content = result.choices[0]?.message?.content ?? '';

        // Capa 1: extract JSON
        const extracted = this.extractJson(content);
        if (!extracted) {
          retryCount = await this.retryWithCorrection(
            messages,
            content,
            retryCount,
            'JSON extraction failed',
          );
          continue;
        }

        // Capa 2: parse + validate schema
        let parsed: AiRecipesResponse;
        try {
          parsed = JSON.parse(extracted);
        } catch {
          retryCount = await this.retryWithCorrection(
            messages,
            content,
            retryCount,
            'JSON parse failed',
          );
          continue;
        }

        if (parsed.error) {
          throw new ServiceUnavailableException(parsed.error);
        }

        const validation = this.validateRecipes(parsed, availableNames, expiringNames);
        if (!validation.valid) {
          retryCount = await this.retryWithCorrection(
            messages,
            content,
            retryCount,
            `Schema invalid: ${validation.errors.join(', ')}`,
          );
          continue;
        }

        // Success
        const latencyMs = Date.now() - startTime;
        this.logTrace({
          traceId,
          model: this.model,
          promptTokens: result.usage.prompt_tokens,
          completionTokens: result.usage.completion_tokens,
          latencyMs,
          status: 'success',
          retryCount,
        });

        return {
          recipes: parsed.recipes,
          meta: {
            traceId,
            model: this.model,
            tokens: {
              prompt: result.usage.prompt_tokens,
              completion: result.usage.completion_tokens,
            },
            latencyMs,
          },
        };
      } catch (error) {
        if (error instanceof ServiceUnavailableException) throw error;

        const aiError = error as AiCallError;
        if (aiError.nonRetryable) {
          this.logTrace({
            traceId,
            model: this.model,
            promptTokens: 0,
            completionTokens: 0,
            latencyMs: Date.now() - startTime,
            status: 'error',
            retryCount,
            errorCode: aiError.errorCode,
          });
          throw new BadGatewayException(
            `AI service error. Trace: ${traceId}`,
          );
        }

        retryCount = await this.retryWithCorrection(
          messages,
          '',
          retryCount,
          aiError.errorCode || 'unknown',
        );
      }
    }

    // Exhausted retries
    this.logTrace({
      traceId,
      model: this.model,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - startTime,
      status: 'error',
      retryCount,
      errorCode: 'max_retries',
    });

    throw new BadGatewayException(
      `AI service unavailable. Trace: ${traceId}`,
    );
  }

  private async callGroq(
    messages: ChatMessage[],
    traceId: string,
  ): Promise<ChatCompletionResponse> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.timeoutMs,
    );

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: this.temperature,
          max_tokens: this.maxTokens,
          top_p: 0.9,
          response_format: { type: 'json_object' },
        }),
      });

      if (response.status === 401 || response.status === 403) {
        const err: AiCallError = new Error('Auth error');
        err.nonRetryable = true;
        err.errorCode = 'auth';
        throw err;
      }

      if (response.status === 429) {
        const err: AiCallError = new Error('Rate limited');
        err.nonRetryable = true;
        err.errorCode = 'rate_limit';
        throw err;
      }

      if (response.status >= 500) {
        const err: AiCallError = new Error(`Provider ${response.status}`);
        err.nonRetryable = false;
        err.errorCode = `http_${response.status}`;
        throw err;
      }

      if (!response.ok) {
        const err: AiCallError = new Error(`HTTP ${response.status}`);
        err.nonRetryable = true;
        err.errorCode = `http_${response.status}`;
        throw err;
      }

      return (await response.json()) as ChatCompletionResponse;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        const err: AiCallError = new Error('Timeout');
        err.nonRetryable = true;
        err.errorCode = 'timeout';
        throw err;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private extractJson(content: string): string | null {
    // Try direct parse
    const trimmed = content.trim();
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      // continue
    }

    // Extract from ```json ... ``` block
    const codeBlockMatch = trimmed.match(/```json\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      const inner = codeBlockMatch[1].trim();
      try {
        JSON.parse(inner);
        return inner;
      } catch {
        // continue
      }
    }

    // Find first { to last }
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first !== -1 && last > first) {
      const candidate = trimmed.slice(first, last + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        // continue
      }
    }

    return null;
  }

  private validateRecipes(
    parsed: AiRecipesResponse,
    availableNames: Set<string>,
    expiringNames: Set<string>,
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!Array.isArray(parsed.recipes) || parsed.recipes.length === 0) {
      errors.push('recipes array missing or empty');
      return { valid: false, errors };
    }

    if (parsed.recipes.length > 3) {
      errors.push('too many recipes (max 3)');
    }

    for (const recipe of parsed.recipes as AiRecipe[]) {
      if (!recipe.name) errors.push(`recipe missing name`);
      if (!Array.isArray(recipe.ingredients) || recipe.ingredients.length === 0) {
        errors.push(`recipe "${recipe.name}" missing ingredients`);
      }
      if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) {
        errors.push(`recipe "${recipe.name}" missing steps`);
      }

      for (const ing of recipe.ingredients ?? []) {
        if (!availableNames.has(ing.name.toLowerCase())) {
          errors.push(
            `ingredient "${ing.name}" not in available list`,
          );
        }
      }
    }

    // At least one recipe should use expiring ingredients
    if (expiringNames.size > 0) {
      const anyUsesExpiring = parsed.recipes.some(
        (r) => Array.isArray(r.uses_expiring) && r.uses_expiring.length > 0,
      );
      if (!anyUsesExpiring) {
        errors.push('no recipe uses expiring ingredients');
      }
    }

    return { valid: errors.length === 0, errors };
  }

  private async retryWithCorrection(
    messages: ChatMessage[],
    lastContent: string,
    currentRetry: number,
    reason: string,
  ): Promise<number> {
    const next = currentRetry + 1;
    this.logger.warn(`Retry ${next}/${this.maxRetries}: ${reason}`);

    if (next > this.maxRetries) return next;

    if (lastContent) {
      messages.push({ role: 'assistant', content: lastContent });
    }
    messages.push({ role: 'user', content: RETRY_CORRECTION_PROMPT });

    await this.sleep(1000);
    return next;
  }

  private logTrace(trace: AiTrace): void {
    this.logger.log(
      JSON.stringify({
        ...trace,
        apiKey: undefined,
      }),
    );
  }

  private isExpiring(ingredient: Ingredient): boolean {
    if (!ingredient.expirationDate) return false;
    const threshold = new Date(
      Date.now() + 48 * 60 * 60 * 1000,
    );
    return new Date(ingredient.expirationDate) <= threshold;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

interface AiCallError extends Error {
  nonRetryable?: boolean;
  errorCode?: string;
}
