import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

// Boots the real AppModule, which connects to whatever DATABASE_URL/GROQ_API_KEY
// are set in .env — same as running the app locally. Requires a reachable
// Postgres (Neon) instance; skipped implicitly if DATABASE_URL is unset,
// since that's exactly the config the deployed app runs with.
describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health reports the DB connection is alive', () => {
    return request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('ok');
        expect(res.body.db).toBe('connected');
      });
  });

  it('GET / redirects to the Swagger docs instead of 404ing', () => {
    return request(app.getHttpServer()).get('/').expect(302).expect('location', '/api/docs');
  });

  it('GET /inventory returns the current ingredient list', () => {
    return request(app.getHttpServer())
      .get('/inventory')
      .expect(200)
      .expect((res) => {
        expect(Array.isArray(res.body)).toBe(true);
      });
  });

  it('POST /inventory rejects a payload with an unknown field (whitelist validation)', () => {
    return request(app.getHttpServer())
      .post('/inventory')
      .send({ name: 'Test e2e ingredient', quantity: 1, notAField: true })
      .expect(400);
  });
});
