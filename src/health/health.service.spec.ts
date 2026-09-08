import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { HealthService } from './health.service';

describe('HealthService', () => {
  let service: HealthService;
  let dataSource: { query: jest.Mock };
  let config: { get: jest.Mock };

  const setup = async (envValues: Record<string, string>) => {
    dataSource = { query: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    config = { get: jest.fn((key: string, fallback?: string) => envValues[key] ?? fallback) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: DataSource, useValue: dataSource },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get(HealthService);
  };

  describe('check', () => {
    it('reports ok when the DB responds and Groq is configured', async () => {
      await setup({ GROQ_API_KEY: 'gsk_test' });

      const result = await service.check();

      expect(result.status).toBe('ok');
      expect(result.db).toBe('connected');
      expect(result.ai).toBe('configured');
    });

    it('reports degraded when the DB query throws', async () => {
      await setup({ GROQ_API_KEY: 'gsk_test' });
      dataSource.query.mockRejectedValue(new Error('connection refused'));

      const result = await service.check();

      expect(result.status).toBe('degraded');
      expect(result.db).toBe('error');
    });

    it('reports ai as not_configured when GROQ_API_KEY is empty', async () => {
      await setup({ GROQ_API_KEY: '' });

      const result = await service.check();

      expect(result.ai).toBe('not_configured');
    });
  });

  describe('checkAi', () => {
    it('coerces timeoutMs and maxRetries to real numbers, not strings', async () => {
      await setup({
        GROQ_API_KEY: 'gsk_test',
        AI_TIMEOUT_MS: '20000',
        AI_MAX_RETRIES: '3',
      });

      const result = service.checkAi();

      expect(result.timeoutMs).toBe(20000);
      expect(result.maxRetries).toBe(3);
      expect(typeof result.timeoutMs).toBe('number');
      expect(typeof result.maxRetries).toBe('number');
    });
  });
});
