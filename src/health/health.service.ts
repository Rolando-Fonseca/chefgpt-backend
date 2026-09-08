import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

@Injectable()
export class HealthService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  async check() {
    let db: 'connected' | 'error' = 'connected';
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      db = 'error';
    }

    const apiKey = this.config.get<string>('GROQ_API_KEY', '');
    const ai = apiKey ? 'configured' : 'not_configured';

    const status = db === 'connected' ? 'ok' : 'degraded';

    return {
      status,
      db,
      ai,
      timestamp: new Date().toISOString(),
    };
  }

  checkAi() {
    const apiKey = this.config.get<string>('GROQ_API_KEY', '');
    return {
      ai: apiKey ? 'configured' : 'not_configured',
      model: this.config.get<string>(
        'GROQ_MODEL',
        'qwen/qwen3.8-27b',
      ),
      timeoutMs: Number(this.config.get<string>('AI_TIMEOUT_MS', '15000')),
      maxRetries: Number(this.config.get<string>('AI_MAX_RETRIES', '2')),
    };
  }
}
