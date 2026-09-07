import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { HealthService } from './health.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly service: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Overall health check (DB + AI)' })
  check() {
    return this.service.check();
  }

  @Get('ai')
  @ApiOperation({ summary: 'AI configuration status (no model call)' })
  checkAi() {
    return this.service.checkAi();
  }
}
